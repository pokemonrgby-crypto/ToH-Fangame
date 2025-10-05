// /functions/farm.js (전체 교체)
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions');
const fs = require('fs').promises;
const path = require('path');

module.exports = (admin) => {
  const db = admin.firestore();
  const { FieldValue, Timestamp } = admin.firestore;

  const SKILL_EXP_TABLE = {
    plant:  { normal: 2, rare: 5, epic: 15, legendary: 40, mythic: 100, aether: 250 },
    harvest:{ normal: 5, rare: 15, epic: 40, legendary: 100, mythic: 250, aether: 600 },
  };

  // 농사 프로필(레벨/경험치) 읽기/업데이트 - 최대 레벨 100으로 수정
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
      // ANCHOR: [수정] 농장 레벨업 상한을 100으로 변경
      while (exp >= nextExp && level < 100) {
        exp -= nextExp;
        level += 1;
      nextExp = Math.floor(200 * (2 ** Math.sqrt(level)));
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

  // 스킬 경험치 지급 및 레벨업 로직 - 최대 레벨 100으로 수정
  async function _awardSkillExp(tx, charId, skillName, expToAdd) {
    if (!charId || !skillName || expToAdd <= 0) return;
    const charRef = db.doc(`chars/${charId}`);
    const charSnap = await tx.get(charRef);
    if (!charSnap.exists) return;
    
    const charData = charSnap.data() || {};
    let skills = charData.skills || {};

    if (typeof skills[skillName] === 'number' || skills[skillName] === undefined) {
      const currentLevel = Number(skills[skillName] || 0);
      skills[skillName] = {
        level: currentLevel,
        exp: 0,
        nextExp: Math.floor(200 * (2 ** Math.sqrt(currentLevel)))
      };
    }
    
    let { level, exp, nextExp } = skills[skillName];
    exp += expToAdd;

    // ANCHOR: [수정] 스킬 레벨업 상한을 100으로 변경
    while (exp >= nextExp && level < 100) {
      exp -= nextExp;
      level += 1;
      nextExp = Math.floor(200 * (2 ** Math.sqrt(level)));
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

  // ANCHOR: [수정] 원예 스킬 시간 단축 공식 변경 (최대 레벨 100, 최대 99% 단축)
  function levelSpeedMult(gardeningLv = 0) {
    // 1. 레벨 상한을 100으로 변경
    const lv = Math.max(0, Math.min(100, Number(gardeningLv || 0)));
    // 2. 최대 할인율을 0.99 (99%)로, 레벨 분모를 100으로 변경
    //    레벨 100일 때: 1 - 0.99 * (100 / 100) = 0.01 (즉, 1%의 시간만 소요)
    return 1 - 0.99 * (lv / 100);
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
      if (!seedItem) throw new HttpsError('failed-precondition', '인벤토리에 해당 씨앗이 없습니다.');
      const uses = Number(seedItem.uses ?? 1);
      if (uses < n) throw new HttpsError('failed-precondition', `씨앗 사용 가능 횟수가 부족합니다. (필요: ${n}, 보유: ${uses})`);

      if (!seed) {
        const si = seedItem?.seedInfo;
        if (si && (String(si.id) === String(seedId) || String(seedId).includes(String(si.id)))) {
          seed = {
            id: String(si.id),
            rarity: String(seedItem.rarity || si.rarity || 'normal').toLowerCase(),
            growthTimeMinutes: Math.max(1, Number(si.growthTimeMinutes || 5)),
            isPerennial: si.isPerennial || false,
            harvest: Array.isArray(si.harvest) && si.harvest.length ? si.harvest : [],
          };
        }
      }
      if (!seed) throw new HttpsError('not-found', `서버/인벤토리에 씨앗 정의가 없습니다: ${seedId}`);

      const plotSnap = await tx.get(plotRef);
      const cur = plotSnap.exists ? (plotSnap.data()||{}) : {};
      const tiles = cur.tiles || {};
      for (const i of tileIndices) {
        if (tiles[String(i)]) {
          throw new HttpsError('failed-precondition', `이미 작물이 심어져 있는 타일(${i})이 포함되어 있습니다.`);
        }
      }
      
      let lastPlantingEndsAt = Date.now();
      for (const key in tiles) {
          const tile = tiles[key];
          if (tile && tile.plantingEndsAt > lastPlantingEndsAt) {
              lastPlantingEndsAt = Number(tile.plantingEndsAt);
          }
      }
      
      const rarity = String(seed.rarity || 'normal').toLowerCase();
      
      let gardeningLv = 0;
      if (charId) {
          try {
              const charDoc = await tx.get(db.doc(`chars/${charId}`));
              if (charDoc.exists) {
                  const skills = charDoc.data()?.skills;
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
        const plantingStartsAt = lastPlantingEndsAt + cumulativePlantingTime;
        const plantingEndsAt = plantingStartsAt + plantMs;
        const readyAt = plantingEndsAt + growMs;

        const actualHarvest = [];
        if (Array.isArray(seed.harvest)) {
          for (const rule of seed.harvest) {
              const p = Number(rule.probability ?? 1);
              if (p >= 1 || Math.random() < p) {
                  const min = Math.max(1, Number(rule.min || 1));
                  const max = Math.max(min, Number(rule.max || min));
                  let qty = Math.floor(Math.random() * (max - min + 1)) + min;
                  actualHarvest.push({ itemId: rule.itemId, count: qty });
              }
          }
        }
        
        tiles[key] = {
          seedId: String(seed.id),
          rarity,
          isPerennial: !!seed.isPerennial,
          plantedByChar: charId || null,
          plantedAt: plantingStartsAt,
          plantingEndsAt: plantingEndsAt,
          readyAt: readyAt,
          status: 'planting',
          actualHarvest,
        };
        cumulativePlantingTime += plantMs;
      }
      
      // ANCHOR: [수정] 심을 때 등급별 스킬 경험치 지급
      const plantExp = SKILL_EXP_TABLE.plant[rarity] || 2;
      await _awardSkillExp(tx, charId, 'gardening', plantExp * n);

      if (uses === n) {
        const remain = items.filter(it => it.id !== seedItemId);
        tx.update(userRef, { items_all: remain });
      } else {
        const remain = items.map(it => it.id === seedItemId ? { ...it, uses: uses - n } : it);
        tx.update(userRef, { items_all: remain });
      }

      tx.set(plotRef, { tiles, updatedAt: Date.now() }, { merge: true });
    });

    await _awardFarmExp(uid, 5 * n);
    return { ok: true, planted: tileIndices.length };
  });

  // ANCHOR: assignCharacterToFarm 함수에 레거시 호환 코드 복원
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
      
      // ANCHOR: [복원] 레거시 스킬 데이터(숫자)를 새 구조(객체)로 마이그레이션하는 로직
      await db.runTransaction(async (tx) => {
        const now = Date.now();
        const cSnap = await tx.get(charRef);
        const cData = cSnap.exists ? (cSnap.data() || {}) : {};

        let skills = cData.skills || {};
        let needsUpdate = false;

        const defaultSkillKeys = ['gardening', 'construction', 'art', 'crafting', 'research', 'speech', 'mining', 'cooking', 'processing'];
        for (const key of defaultSkillKeys) {
          if (!skills[key] || typeof skills[key] === 'number') {
            const level = Number(skills[key] || 0);
            skills[key] = {
              level,
              exp: 0,
              nextExp: Math.floor(200 * (2 ** Math.sqrt(level)))
            };
            needsUpdate = true;
          }
        }
        
        if (needsUpdate) {
          tx.set(charRef, { skills, updatedAt: now }, { merge: true });
        }
        // ANCHOR_END

        tx.set(plotRef, { assigned_char_id: charId, updatedAt: now }, { merge: true });
      });
    } else {
      await plotRef.set({ assigned_char_id: null, updatedAt: Date.now() }, { merge: true });
    }

    return { ok: true, assigned_char_id: charId || null };
  });

  // ANCHOR: harvestTiles 함수에 등급별 스킬 경험치 지급 로직 추가
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

    let newItemsForUser = [];
    
    await db.runTransaction(async (tx) => {
      // --- 1. 모든 읽기(Read) 작업을 트랜잭션 맨 위로 ---
      const plotSnap = await tx.get(plotRef);
      if (!plotSnap.exists) throw new HttpsError('failed-precondition', '심어진 작물이 없습니다.');
      
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) throw new HttpsError('not-found', '사용자 정보가 없습니다.');

      const plotData = plotSnap.data() || {};
      const tiles = plotData.tiles || {};
      
      const charIdsToRead = new Set();
      for (const i of tileIndices) {
        const tileData = tiles[String(i)];
        if (tileData?.plantedByChar) {
          charIdsToRead.add(String(tileData.plantedByChar).replace(/^chars\//,''));
        }
      }
      
      const charSnaps = new Map();
      if (charIdsToRead.size > 0) {
          const charRefs = Array.from(charIdsToRead).map(id => db.doc(`chars/${id}`));
          const charDocs = await tx.getAll(...charRefs);
          charDocs.forEach(doc => {
              if (doc.exists) charSnaps.set(doc.id, doc.data());
          });
      }

      // --- 2. 읽어온 데이터를 바탕으로 모든 쓰기(Write) 작업 준비 ---
      const now = Date.now();
      const currentRewards = {};
      const updates = {};
      let totalCharExpGain = 0;
      let totalSkillExpGainByChar = {}; // 캐릭터별로 스킬 경험치 누적

      for (const i of tileIndices) {
        const key = String(i);
        const t = tiles[key];
        if (!t || (t.readyAt || 0) > now) continue;

        const charId = t.plantedByChar ? String(t.plantedByChar).replace(/^chars\//,'') : null;

        const harvestItems = t.actualHarvest || [];
        for (const item of harvestItems) {
            let qty = item.count;
            let levelBonus = 0;
            if (charId) {
              const charData = charSnaps.get(charId);
              if(charData) {
                const skills = charData.skills;
                const g = skills?.gardening?.level || (typeof skills?.gardening === 'number' ? skills.gardening : 0);
                levelBonus = Math.floor(Math.max(0, Math.min(100, g)) / 10);
              }
            }
            qty += levelBonus;
            
            const seed = allSeeds.find(s => s.id === t.seedId);
            const seasonBonus = seed?.season_bonus?.[currentSeason];
            if (seasonBonus === '수확량 소폭 증가') qty = Math.ceil(qty * 1.2);
            if (seasonBonus === '수확량 대폭 증가') qty = Math.ceil(qty * 1.5);

            currentRewards[item.itemId] = (currentRewards[item.itemId] || 0) + qty;
        }
        
        if (charId) {
          totalCharExpGain += 10;
          const rarity = t.rarity || 'normal';
          const skillExp = SKILL_EXP_TABLE.harvest[rarity] || 5;
          totalSkillExpGainByChar[charId] = (totalSkillExpGainByChar[charId] || 0) + skillExp;
        }
        
        if (t.isPerennial) {
          const seed = allSeeds.find(s => s.id === t.seedId);
          if (seed) {
            const growMs = (seed?.growthTimeMinutes || 30) * 60 * 1000;
            let gardeningLv = 0;
            if (charId) {
              const charData = charSnaps.get(charId);
              if (charData) {
                const skills = charData.skills;
                gardeningLv = skills?.gardening?.level || (typeof skills?.gardening === 'number' ? skills.gardening : 0);
              }
            }
            const slotMult = deviceSpeedMult(plotData.device_slots || []);
            const regrowMs = Math.floor(growMs * levelSpeedMult(gardeningLv) * slotMult);
            
            const nextHarvest = [];
            if (Array.isArray(seed.harvest)) {
              for (const rule of seed.harvest) {
                  if ((rule.probability ?? 1) >= 1 || Math.random() < (rule.probability ?? 1)) {
                      const min = Math.max(1, Number(rule.min || 1));
                      const max = Math.max(min, Number(rule.max || min));
                      nextHarvest.push({ itemId: rule.itemId, count: Math.floor(Math.random() * (max - min + 1)) + min });
                  }
              }
            }
            updates[`tiles.${key}.readyAt`] = now + regrowMs;
            updates[`tiles.${key}.plantingEndsAt`] = now;
            updates[`tiles.${key}.actualHarvest`] = nextHarvest;
          } else {
             updates[`tiles.${key}`] = FieldValue.delete();
          }
        } else {
          updates[`tiles.${key}`] = FieldValue.delete();
        }
      }

      // --- 3. 모든 쓰기 작업을 한 번에 실행 ---
      if (Object.keys(currentRewards).length > 0) {
        let itemsAll = Array.isArray(userSnap.data().items_all) ? userSnap.data().items_all : [];
        const itemsMeta = await (async ()=>{
          if (!global.__ITEMS_META) {
            const p = path.join(__dirname, './assets/items.json');
            const raw = await fs.readFile(p,'utf8');
            global.__ITEMS_META = JSON.parse(raw);
          }
          return global.__ITEMS_META;
        })();
        
        for (const [itemId, cnt] of Object.entries(currentRewards)) {
          // custom_items 컬렉션에서 아이템 정보 조회
          const customItemSnap = await tx.get(db.doc(`custom_items/${itemId}`));
          let meta;
          if (customItemSnap.exists) {
            meta = customItemSnap.data();
          } else {
            meta = itemsMeta[itemId] || { name: itemId, rarity: 'normal', type: 'material', placeable: false, aestheticValue: 0, description: '' };
          }
          
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

      // 캐릭터별 경험치 및 스킬 경험치 지급
      for (const charId of Object.keys(totalSkillExpGainByChar)) {
        const charData = charSnaps.get(charId);
        if (charData) {
          // 캐릭터 경험치
          const ownerUid = charData.owner_uid;
          const currentExp = Number(charData.exp || 0);
          const newTotalExp = currentExp + totalCharExpGain; // totalCharExpGain은 모든 캐릭터에 공통으로 적용
          const coinsToMint = Math.floor(newTotalExp / 100);
          const finalExp = newTotalExp % 100;
          tx.update(db.doc(`chars/${charId}`), { exp_total: FieldValue.increment(totalCharExpGain), exp: finalExp });
          if (coinsToMint > 0) tx.set(db.doc(`users/${ownerUid}`), { coins: FieldValue.increment(coinsToMint) }, { merge: true });
          
          // 원예 스킬 경험치
          let skills = charData.skills || {};
          const skillName = 'gardening';
          if (typeof skills[skillName] !== 'object' || skills[skillName] === null) {
              skills[skillName] = { level: 0, exp: 0, nextExp: 200 };
          }
          let { level, exp, nextExp } = skills[skillName];
          exp += totalSkillExpGainByChar[charId];
          while (exp >= nextExp && level < 100) {
            exp -= nextExp;
            level += 1;
            nextExp = Math.floor(200 * (2 ** Math.sqrt(level)));
          }
          skills[skillName] = { level, exp, nextExp };
          tx.update(db.doc(`chars/${charId}`), { skills });
        }
      }
      
      updates.updatedAt = FieldValue.serverTimestamp();
      tx.update(plotRef, updates);
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
      if (!t.readyAt || now >= t.readyAt) {
        throw new HttpsError('failed-precondition', '이미 수확 준비가 완료된 작물은 취소할 수 없습니다.');
      }

      delete tiles[String(tileIndex)];
      tx.set(plotRef, { tiles, updatedAt: now }, { merge: true });
    });

    return { ok: true };
  });


  return { buySeed, getFarmPlotDetail, plantSeedOnTile, assignCharacterToFarm, harvestTiles, cancelPlanting };
};
