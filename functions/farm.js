// /functions/farm.js (수정)
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions');
const fs = require('fs').promises;
const path = require('path');

module.exports = (admin) => {
  const db = admin.firestore();
  const { FieldValue, Timestamp } = admin.firestore;

  // 농사 프로필(레벨/경험치) 읽기/업데이트
  async function _getFarmProfile(uid) {
    const ref = db.doc(`farm_profiles/${uid}`);
    const snap = await ref.get();
    if (!snap.exists) return { level: 1, exp: 0, nextExp: 100 };
    const d = snap.data() || {};
    return { level: d.level || 1, exp: d.exp || 0, nextExp: d.nextExp || 100 };
  }

  async function _awardFarmExp(uid, gain) {
    const ref = db.doc(`farm_profiles/${uid}`);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      let { level=1, exp=0, nextExp=100 } = snap.exists ? (snap.data()||{}) : {};
      exp += gain;
      while (exp >= nextExp && level < 30) {
        exp -= nextExp;
        level += 1;
        nextExp = Math.round(100 + 50 * level);
      }
      tx.set(ref, { level, exp, nextExp, updatedAt: Date.now() }, { merge: true });
    });
  }

  // 캐릭터 경험치 지급 및 코인 전환 로직
  async function _awardCharExp(tx, charId, expToAdd, note) {
    if (!charId || expToAdd <= 0) return;
    const charRef = db.doc(`chars/${charId}`);
    const charSnap = await tx.get(charRef);
    if (!charSnap.exists) return;
    
    const charData = charSnap.data();
    const ownerUid = charData.owner_uid;
    if (!ownerUid) return;

    const currentExp = Number(charData.exp || 0);
    const newTotalExp = currentExp + expToAdd;
    const coinsToMint = Math.floor(newTotalExp / 100);
    const finalExp = newTotalExp % 100;

    tx.update(charRef, {
      exp_total: FieldValue.increment(expToAdd),
      exp: finalExp,
      updatedAt: Timestamp.now()
    });

    if (coinsToMint > 0) {
      const userRef = db.doc(`users/${ownerUid}`);
      tx.set(userRef, { coins: FieldValue.increment(coinsToMint) }, { merge: true });
    }
  }

  // [추가] 스킬 경험치 지급 및 레벨업 로직
  async function _awardSkillExp(tx, charId, skillName, expToAdd) {
    if (!charId || !skillName || expToAdd <= 0) return;
    const charRef = db.doc(`chars/${charId}`);
    const charSnap = await tx.get(charRef);
    if (!charSnap.exists) return;
    
    const charData = charSnap.data() || {};
    let skills = charData.skills || {};

    // [설명] 레거시 호환: 스킬 데이터가 숫자(레벨)이면 객체 형태로 변환
    if (typeof skills[skillName] === 'number' || skills[skillName] === undefined) {
      const currentLevel = Number(skills[skillName] || 0);
      skills[skillName] = {
        level: currentLevel,
        exp: 0,
        nextExp: Math.floor(200 ** (Math.sqrt(currentLevel)))
      };
    }
    
    let { level, exp, nextExp } = skills[skillName];
    exp += expToAdd;

    // [설명] 레벨업 처리
    while (exp >= nextExp) {
      exp -= nextExp;
      level += 1;
      // [설명] 레벨업 필요 경험치 공식: floor(200^(sqrt(현재 레벨)))
      nextExp = Math.floor(200 ** (Math.sqrt(level)));
    }

    skills[skillName] = { level, exp, nextExp };
    tx.update(charRef, { skills });
  }


  function plotIdFrom({ mapId, x, y, microX, microY }) {
    return `${mapId}_${x}_${y}_${microX}_${microY}`;
  }

  const RARITY_PLANT_MS = {
    normal:   5 * 60 * 1000,
    rare:    10 * 60 * 1000,
    epic:    20 * 60 * 1000,
    legendary: 40 * 60 * 1000,
    mythic:  80 * 60 * 1000,
    aether: 160 * 60 * 1000,
  };

  function levelSpeedMult(gardeningLv = 0) {
    const lv = Math.max(0, Math.min(30, Number(gardeningLv || 0)));
    return 1 - 0.9 * (lv / 30);
  }

  function deviceSpeedMult(deviceSlots = []) {
    if (!Array.isArray(deviceSlots)) return 1.0;
    return deviceSlots
      .filter(Boolean)
      .map(d => Number(d?.speedMult || 1.0))
      .reduce((a, b) => a * (isFinite(b) && b > 0 ? b : 1.0), 1.0);
  }
  
  async function _isOwner(uid, { mapId, x, y, microX, microY }) {
    if (!uid) return false;
    const microDoc = `${microY}_${microX}`;
    const plotDoc = `${mapId}_${x}_${y}`;
    const ref = db.collection('land_plots').doc(plotDoc).collection('micro_ownership').doc(microDoc);
    const snap = await ref.get();
    return snap.exists && snap.data()?.owner_uid === uid;
  }

  let _seedsDataCache = null;
  const loadSeedsData = async () => {
      if (_seedsDataCache) return _seedsDataCache;
      try {
          const seedsDir = path.join(__dirname, './assets/seeds');
          const files = await fs.readdir(seedsDir);
          const allSeeds = [];
          for (const file of files) {
              if (file.endsWith('.json')) {
                  try {
                      const data = await fs.readFile(path.join(seedsDir, file), 'utf8');
                      const seedsFromFile = JSON.parse(data);
                      if (Array.isArray(seedsFromFile)) {
                          allSeeds.push(...seedsFromFile);
                      }
                  } catch (e) {
                      logger.error(`Failed to parse seed file: ${file}`, e);
                  }
              }
          }
          _seedsDataCache = allSeeds;
          return _seedsDataCache;
      } catch (error) {
          logger.error("Failed to load seeds data from directory", error);
          return [];
      }
  };


  const buySeed = onCall({ region: 'us-central1' }, async (req) => {
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');

    const { seedId, quantity } = req.data;
    const nQty = Math.floor(Number(quantity) || 0);
    if (!seedId || nQty <= 0) {
      throw new HttpsError('invalid-argument', '필수 정보(seedId, quantity)가 누락되었습니다.');
    }
    
    const allSeeds = await loadSeedsData();
    const seedInfo = allSeeds.find(s => s.id === seedId);
    if (!seedInfo) throw new HttpsError('not-found', '존재하지 않는 씨앗입니다.');

    const totalPrice = (seedInfo.price || 10) * nQty;

    return db.runTransaction(async (tx) => {
        const userRef = db.doc(`users/${uid}`);
        const userSnap = await tx.get(userRef);
        if (!userSnap.exists) throw new HttpsError('not-found', '사용자 정보를 찾을 수 없습니다.');

        const userData = userSnap.data();
        const userCoins = userData.coins || 0;
        if (userCoins < totalPrice) throw new HttpsError('failed-precondition', '코인이 부족합니다.');

        let items = userData.items_all || [];
        
        const existingSeedIndex = items.findIndex(item => (item.type === 'seed' && item.seedInfo?.id === seedId) || item.id === seedId);

        if (existingSeedIndex !== -1) {
            items[existingSeedIndex].uses = (items[existingSeedIndex].uses || 1) + nQty;
        } else {
            const newSeedItem = {
                id: seedInfo.isPromptUse ? seedId : `item_seed_${seedId}_${Date.now()}`,
                name: seedInfo.name,
                rarity: seedInfo.rarity,
                description: seedInfo.description,
                isConsumable: true,
                uses: nQty,
                type: 'seed',
                placeable: seedInfo.placeable ?? true,
                ...(seedInfo.mutation && { mutation: seedInfo.mutation }),
                ...(seedInfo.isPromptUse && { isPromptUse: true, promptId: seedInfo.promptId }),
                seedInfo: {
                    id: seedInfo.id,
                    growthTimeMinutes: seedInfo.growthTimeMinutes ?? 30,
                    harvest: seedInfo.harvest ?? [],
                    isPerennial: seedInfo.isPerennial ?? false,
                },
                properties: {
                    appraised: true,
                    category: 'gardening',
                    placeable: seedInfo.placeable ?? true,
                    aestheticValue: seedInfo.aestheticValue ?? 10,
                }
            };
            items.push(newSeedItem);
        }
        
        tx.update(userRef, { 
            coins: FieldValue.increment(-totalPrice),
            items_all: items
        });

        return { ok: true, paid: totalPrice };
    });
  });

  const getFarmPlotDetail = onCall({ region: 'us-central1' }, async (req) => {
    const uid = req.auth?.uid || req.auth?.token?.uid || null;
    const { mapId, x, y, microX, microY } = req.data || {};
    if (mapId==null || x==null || y==null || microX==null || microY==null) {
      throw new HttpsError('invalid-argument', '필수 정보가 누락되었습니다.');
    }

    const plotId = plotIdFrom({ mapId, x, y, microX, microY });
    const docRef = db.doc(`farm_plots/${plotId}`);
    const snap = await docRef.get();

    const d = snap.exists ? (snap.data()||{}) : {};
    return {
      ok: true,
      assigned_char_id: d.assigned_char_id || null,
      tiles: d.tiles || {},
      updatedAt: d.updatedAt || 0
    };
  });

  const plantSeedOnTile = onCall({ region: 'us-central1' }, async (req) => {
    const uid = req.auth?.uid || req.auth?.token?.uid;
    const { mapId, x, y, microX, microY, charId, seedItemId, seedId, tileIndices=[] } = req.data || {};
    if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
    if ([mapId,x,y,microX,microY].some(v=>v==null) || !Array.isArray(tileIndices) || tileIndices.length===0 || !seedItemId || !seedId) {
      throw new HttpsError('invalid-argument', '필수 정보가 누락되었습니다.');
    }

    const isOwner = await _isOwner(uid, { mapId, x, y, microX, microY });
    if (!isOwner) throw new HttpsError('permission-denied', '이 토지에 심을 권한이 없습니다.');

    const allSeeds = await loadSeedsData();
    
    let seed = allSeeds.find(s => s.id === seedId);
    if (!seed) {
      logger.warn(`[plantSeedOnTile] Seed not found in seeds data; will try fallback from inventory seedInfo: "${seedId}"`);
    }

    const n = tileIndices.length;
    const userRef = db.doc(`users/${uid}`);
    const plotId = plotIdFrom({ mapId, x, y, microX, microY });
    const plotRef = db.doc(`farm_plots/${plotId}`);

    await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) throw new HttpsError('not-found', '사용자 정보가 없습니다.');
      const u = userSnap.data() || {};
      const items = Array.isArray(u.items_all) ? u.items_all : [];

      const seedItem = items.find(it => it.id === seedItemId);
      if (!seed) {
        const si = seedItem?.seedInfo;
        if (si && (String(si.id) === String(seedId) || String(seedId).includes(String(si.id)))) {
          seed = {
            id: String(si.id),
            rarity: String(seedItem.rarity || si.rarity || 'normal').toLowerCase(),
            growthTimeMinutes: Math.max(1, Number(si.growthTimeMinutes || si.growMin || 5)),
            harvest: Array.isArray(si.harvest) && si.harvest.length
              ? si.harvest.map(h => ({
                  itemId: String(h.itemId || h.id || 'unknown_crop'),
                  min: Math.max(1, Number(h.min ?? 1)),
                  max: Math.max(1, Number(h.max ?? 1)),
                  probability: Math.min(1, Math.max(0, Number(h.probability ?? 1)))
                }))
              : [{ itemId: String(si.defaultHarvestItemId || seedId), min: 1, max: 1, probability: 1 }],
            season_bonus: si.season_bonus || {}
          };
        }
      }
      if (!seed) throw new HttpsError('not-found', `서버/인벤토리에 씨앗 정의가 없습니다: ${seedId}`);

      if (!seedItem) throw new HttpsError('failed-precondition', '인벤토리에 해당 씨앗이 없습니다.');
      const uses = Number(seedItem.uses ?? 1);
      if (uses < n) throw new HttpsError('failed-precondition', `씨앗 사용 가능 횟수가 부족합니다. (필요: ${n}, 보유: ${uses})`);

      const plotSnap = await tx.get(plotRef);
      const cur = plotSnap.exists ? (plotSnap.data()||{}) : {};
      const tiles = cur.tiles || {};

      // [추가] 심을 타일이 이미 점유되어 있는지 확인
      for (const i of tileIndices) {
        if (tiles[String(i)]) {
          throw new HttpsError('failed-precondition', `이미 작물이 심어져 있는 타일(${i})이 포함되어 있습니다.`);
        }
      }
      
      const now = Date.now();
      const rarity = String(seed.rarity || 'normal').toLowerCase();
      
      let gardeningLv = 0;
      if (charId) {
          try {
              const cSnap = await tx.get(db.doc(`chars/${charId}`));
              if (cSnap.exists) {
                  const skills = cSnap.data()?.skills;
                  // [수정] 스킬 데이터 구조 변경에 따른 레벨 접근 방식 수정
                  gardeningLv = skills?.gardening?.level || (typeof skills?.gardening === 'number' ? skills.gardening : 0);
              }
          } catch (_) {}
      }

      const slotMult = deviceSpeedMult((cur.device_slots || []));
      const plantBaseMs = RARITY_PLANT_MS[rarity] || 5*60*1000;
      const plantMs = Math.floor(plantBaseMs * levelSpeedMult(gardeningLv) * slotMult);
      const growMs = Math.max(1, Number(seed.growthTimeMinutes || 5)) * 60 * 1000;

      let cumulativePlantingTime = 0;
      for (const i of tileIndices) {
        const key = String(i);
        const plantingStartsAt = now + cumulativePlantingTime;
        const plantingEndsAt = plantingStartsAt + plantMs;
        const readyAt = plantingEndsAt + growMs;

        tiles[key] = {
          seedId: String(seed.id),
          rarity,
          plantedByChar: charId || null,
          plantedAt: plantingStartsAt,
          plantingEndsAt: plantingEndsAt,
          readyAt: readyAt,
          status: 'planting',
        };
        cumulativePlantingTime += plantMs;
      }

      if (uses === n) {
        const remain = items.filter(it => it.id !== seedItemId);
        tx.update(userRef, { items_all: remain });
      } else {
        const remain = items.map(it => it.id === seedItemId ? { ...it, uses: uses - n } : it);
        tx.update(userRef, { items_all: remain });
      }

      tx.set(plotRef, { tiles, updatedAt: now }, { merge: true });
    });

    await _awardFarmExp(uid, 5 * n);

    return { ok: true, planted: tileIndices.length };
  });

  const assignCharacterToFarm = onCall({ region: 'us-central1' }, async (req) => {
    const uid = req.auth?.uid || req.auth?.token?.uid;
    const { mapId, x, y, microX, microY, charId } = req.data || {};
    if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
    if ([mapId,x,y,microX,microY].some(v=>v==null)) throw new HttpsError('invalid-argument', '필수 정보가 누락되었습니다.');

    const isOwner = await _isOwner(uid, { mapId, x, y, microX, microY });
    if (!isOwner) throw new HttpsError('permission-denied', '이 토지에 배정할 권한이 없습니다.');

    const plotId = plotIdFrom({ mapId, x, y, microX, microY });
    const plotRef = db.doc(`farm_plots/${plotId}`);

    if (charId) {
      const charRef = db.doc(`chars/${charId}`);
      // [수정] 기본 스킬 구조를 새 포맷(객체)으로 변경
      const DEFAULT_SKILLS = {
        gardening: { level: 0, exp: 0, nextExp: 1 },
        construction: { level: 0, exp: 0, nextExp: 1 },
        art: { level: 0, exp: 0, nextExp: 1 },
        crafting: { level: 0, exp: 0, nextExp: 1 },
        research: { level: 0, exp: 0, nextExp: 1 },
        speech: { level: 0, exp: 0, nextExp: 1 },
        mining: { level: 0, exp: 0, nextExp: 1 },
        cooking: { level: 0, exp: 0, nextExp: 1 },
        processing: { level: 0, exp: 0, nextExp: 1 },
      };

      await db.runTransaction(async (tx) => {
        const now = Date.now();
        const cSnap = await tx.get(charRef);
        const cData = cSnap.exists ? (cSnap.data() || {}) : {};

        let skills = cData.skills || {};
        let needsUpdate = false;

        // [수정] 레거시 호환 및 데이터 구조 정상화 로직 강화
        for (const key of Object.keys(DEFAULT_SKILLS)) {
          if (!skills[key] || typeof skills[key] === 'number') {
            const level = Number(skills[key] || 0);
            skills[key] = {
              level,
              exp: 0,
              nextExp: Math.floor(200 ** (Math.sqrt(level)))
            };
            needsUpdate = true;
          }
        }
        
        if (needsUpdate) {
          tx.set(charRef, { skills, updatedAt: now }, { merge: true });
        }

        tx.set(plotRef, { assigned_char_id: charId, updatedAt: now }, { merge: true });
      });
    } else {
      await plotRef.set({ assigned_char_id: null, updatedAt: Date.now() }, { merge: true });
    }

    return { ok: true, assigned_char_id: charId || null };

  });

  const harvestTiles = onCall({ region: 'us-central1' }, async (req) => {
    const uid = req.auth?.uid || req.auth?.token?.uid;
    const { mapId, x, y, microX, microY, tileIndices=[] } = req.data || {};
    if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
    if ([mapId,x,y,microX,microY].some(v=>v==null) || !Array.isArray(tileIndices) || tileIndices.length===0) {
      throw new HttpsError('invalid-argument', '필수 정보가 누락되었습니다.');
    }
    const isOwner = await _isOwner(uid, { mapId, x, y, microX, microY });
    if (!isOwner) throw new HttpsError('permission-denied', '이 토지에서 수확할 권한이 없습니다.');

    const allSeeds = await loadSeedsData();
    
    const seasonSnap = await db.doc('configs/season').get();
    const currentSeason = seasonSnap.exists ? seasonSnap.data().current : 'spring';

    const plotId = plotIdFrom({ mapId, x, y, microX, microY });
    const plotRef = db.doc(`farm_plots/${plotId}`);
    const userRef = db.doc(`users/${uid}`);

    let rewards = {};
    let newItemsForUser = [];
    let totalCharExpGain = 0;
    let totalSkillExpGain = 0; // [추가] 스킬 경험치 합산 변수
    let charToAwardExp = null;

    await db.runTransaction(async (tx) => {
      const plotSnap = await tx.get(plotRef);
      if (!plotSnap.exists) throw new HttpsError('failed-precondition', '심어진 작물이 없습니다.');
      const d = plotSnap.data() || {};
      const tiles = d.tiles || {};
      const now = Date.now();
      
      const currentRewards = {};
      
      for (const i of tileIndices) {
        const key = String(i);
        const t = tiles[key];
        if (!t) continue; 
        if ((t.readyAt || 0) > now) continue;

        charToAwardExp = t.plantedByChar;

        const seed = allSeeds.find(s => s.id === t.seedId);
        if (seed && Array.isArray(seed.harvest)) {
          for (const rule of seed.harvest) {
            const p = Number(rule.probability ?? 1);
            if (p >= 1 || Math.random() < p) {
              const min = Math.max(1, Number(rule.min||1));
              const max = Math.max(min, Number(rule.max||min));
              let qty = Math.floor(Math.random()*(max-min+1)) + min;

              let levelBonus = 0;
              try {
                if (t.plantedByChar) {
                  const charSnap = await tx.get(db.doc(`chars/${String(t.plantedByChar).replace(/^chars\//,'')}`));
                  if(charSnap.exists) {
                    const skills = charSnap.data()?.skills;
                    // [수정] 스킬 데이터 구조 변경에 따른 레벨 접근 방식 수정
                    const g = skills?.gardening?.level || (typeof skills?.gardening === 'number' ? skills.gardening : 0);
                    levelBonus = Math.floor(Math.max(0, Math.min(30, g)) / 10);
                  }
                }
              } catch (_) { }

              qty += levelBonus;

              const seasonBonus = seed.season_bonus?.[currentSeason];
              if (seasonBonus === '수확량 소폭 증가') qty = Math.ceil(qty * 1.2);
              if (seasonBonus === '수확량 대폭 증가') qty = Math.ceil(qty * 1.5);
              
              currentRewards[rule.itemId] = (currentRewards[rule.itemId] || 0) + qty;
              totalCharExpGain += 10; // 타일당 캐릭터 경험치 10
              totalSkillExpGain += 15; // [추가] 타일당 원예 스킬 경험치 15
            }
          }
        }
        delete tiles[key];
      }

      if (Object.keys(currentRewards).length > 0) {
        const userSnap = await tx.get(userRef);
        if (!userSnap.exists) throw new HttpsError('not-found', '사용자 정보가 없습니다.');
        const u = userSnap.data()||{};
        let itemsAll = Array.isArray(u.items_all)? u.items_all : [];

        const itemsMeta = await (async ()=>{
          if (!global.__ITEMS_META) {
            const p = path.join(__dirname, './assets/items.json');
            const raw = await fs.readFile(p,'utf8');
            global.__ITEMS_META = JSON.parse(raw);
          }
          return global.__ITEMS_META;
        })();
        
        rewards = currentRewards;
        
        for (const [itemId, cnt] of Object.entries(rewards)) {
          const meta = itemsMeta[itemId] || { name: itemId, rarity: 'normal', type: 'material', placeable: false, aestheticValue: 0, description: '' };
          const newItem = {
            id: `${itemId}_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
            name: meta.name || itemId,
            description: meta.description || '',
            rarity: (meta.rarity || 'normal').toLowerCase(),
            type: meta.type || 'material',
            isConsumable: false,
            properties: { aestheticValue: meta.aestheticValue || 0 },
            count: Number(cnt)
          };
          itemsAll.push(newItem);
          newItemsForUser.push(newItem);
        }

        tx.update(userRef, { items_all: itemsAll });
      }

      if(charToAwardExp) {
        // [수정] 캐릭터 경험치와 스킬 경험치를 별도로 지급
        if (totalCharExpGain > 0) {
          await _awardCharExp(tx, charToAwardExp, totalCharExpGain, `farm_harvest:${plotId}`);
        }
        if (totalSkillExpGain > 0) {
          await _awardSkillExp(tx, charToAwardExp, 'gardening', totalSkillExpGain);
        }
      }

      tx.set(plotRef, { tiles, updatedAt: Date.now() }, { merge: true });
    });
    
    return { ok: true, rewards: newItemsForUser };
  });

  const cancelPlanting = onCall({ region: 'us-central1' }, async (req) => {
    const uid = req.auth?.uid || req.auth?.token?.uid;
    const { mapId, x, y, microX, microY, tileIndex } = req.data || {};
    if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
    if ([mapId,x,y,microX,microY,tileIndex].some(v=>v==null)) {
      throw new HttpsError('invalid-argument', '필수 정보가 누락되었습니다.');
    }

    const isOwner = await _isOwner(uid, { mapId, x, y, microX, microY });
    if (!isOwner) throw new HttpsError('permission-denied', '이 토지에서 작업을 취소할 권한이 없습니다.');

    const plotId = plotIdFrom({ mapId, x, y, microX, microY });
    const plotRef = db.doc(`farm_plots/${plotId}`);

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(plotRef);
      if (!snap.exists) throw new HttpsError('not-found', 'plot not found');
      const d = snap.data() || {};
      const tiles = d.tiles || {};
      const t = tiles[String(tileIndex)];
      if (!t) throw new HttpsError('failed-precondition', '비어있는 타일입니다.');

      const now = Date.now();
      if (!t.plantingEndsAt || now >= t.plantingEndsAt) {
        throw new HttpsError('failed-precondition', '이미 심기 완료 상태로 취소할 수 없습니다.');
      }

      delete tiles[String(tileIndex)];
      tx.set(plotRef, { tiles, updatedAt: now }, { merge: true });
    });

    return { ok: true };
  });

  return { buySeed, getFarmPlotDetail, plantSeedOnTile, assignCharacterToFarm, harvestTiles, cancelPlanting };
};
