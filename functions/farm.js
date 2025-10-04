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

  function plotIdFrom({ mapId, x, y, microX, microY }) {
    return `${mapId}_${x}_${y}_${microX}_${microY}`;
  }
  
  // 땅 소유권 확인
  // 땅 소유권 확인
  async function _isOwner(uid, { mapId, x, y, microX, microY }) {
    if (!uid) return false;
    const microDoc = `${microY}_${microX}`;
    const plotDoc = `${mapId}_${x}_${y}`;
    const ref = db.collection('land_plots').doc(plotDoc).collection('micro_ownership').doc(microDoc);
    const snap = await ref.get();
    return snap.exists && snap.data()?.owner_uid === uid;
  }

  // 여러 씨앗 데이터 파일을 읽어와 하나로 합치는 로더 (안정성 강화)
  let _seedsDataCache = null;
  const loadSeedsData = async () => {
      if (_seedsDataCache) return _seedsDataCache;
      try {
          const seedsDir = path.join(__dirname, './assets/seeds');
          const files = await fs.readdir(seedsDir);
          const allSeeds = [];
          logger.info(`Loading seeds from: ${seedsDir}`);
          for (const file of files) {
              if (file.endsWith('.json')) {
                  try {
                      const data = await fs.readFile(path.join(seedsDir, file), 'utf8');
                      const seedsFromFile = JSON.parse(data);
                      if (Array.isArray(seedsFromFile)) {
                          allSeeds.push(...seedsFromFile);
                      }
                      logger.info(`Successfully loaded ${seedsFromFile.length} seeds from ${file}.`);
                  } catch (e) {
                      logger.error(`Failed to parse seed file: ${file}`, e);
                  }
              }
          }
          _seedsDataCache = allSeeds;
          logger.info(`Total seeds loaded: ${_seedsDataCache.length}`);
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
    
    // [추가] 커스텀 씨앗 디버깅을 위한 로그
    if (allSeeds.length === 0) {
        logger.error("[plantSeedOnTile] No seeds loaded from any file.");
    } else {
        const allSeedIds = allSeeds.map(s => s.id);
        logger.info(`[plantSeedOnTile] Available seed IDs (${allSeedIds.length}): ${JSON.stringify(allSeedIds)}`);
    }
    logger.info(`[plantSeedOnTile] Client requested to plant seedId: "${seedId}"`);

    let seed = allSeeds.find(s => s.id === seedId);
    if (!seed) {
        logger.error(`[plantSeedOnTile] Seed not found in loaded data: "${seedId}"`);
        throw new HttpsError('not-found', `서버에 존재하지 않는 씨앗입니다: ${seedId}`);
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
      // [추가] 커스텀 씨앗 fallback: 서버 메타에 없으면 seedItem.seedInfo 사용
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
              // 기본 “하나 심으면 하나 남” — 커스텀에 harvest 없으면 1개 고정
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
      const now = Date.now();
      const growMin = Math.max(1, Number(seed.growthTimeMinutes || 5));
      const readyAt = now + growMin*60*1000;
      const rarity = String(seed.rarity || 'normal').toLowerCase();

      for (const i of tileIndices) {
        const key = String(i);
        tiles[key] = { seedId, rarity, plantedAt: now, readyAt, stage: 'growing', plantedByChar: charId || null };
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
      const DEFAULT_SKILLS = {
        gardening: 0, construction: 0, art: 0, crafting: 0, research: 0,
        speech: 0, mining: 0, cooking: 0, processing: 0,
      };
      const KEY_ORDER = ['gardening','construction','art','crafting','research','speech','mining','cooking','processing'];

      await db.runTransaction(async (tx) => {
        const now = Date.now();
        const cSnap = await tx.get(charRef);
        const cData = cSnap.exists ? (cSnap.data() || {}) : {};

        let nextSkills = null;

        // 1) skills가 없거나, null/undefined
        if (!cData.skills) {
          nextSkills = { ...DEFAULT_SKILLS };
        }
        // 2) skills가 배열인 레거시 → 객체로 매핑
        else if (Array.isArray(cData.skills)) {
          const arr = cData.skills;
          nextSkills = {};
          KEY_ORDER.forEach((k, i) => { nextSkills[k] = Number(arr[i] ?? 0) || 0; });
        }
        // 3) skills가 객체인데 몇몇 키가 없음 → 부족한 키만 채움
        else if (typeof cData.skills === 'object') {
          nextSkills = { ...cData.skills };
          for (const k of Object.keys(DEFAULT_SKILLS)) {
            if (nextSkills[k] == null) nextSkills[k] = 0;
          }
        }

        if (nextSkills) {
          tx.set(charRef, { skills: nextSkills, updatedAt: now }, { merge: true });
        }

        // 배정 자체
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

        const seed = allSeeds.find(s => s.id === t.seedId);
        if (seed && Array.isArray(seed.harvest)) {
          for (const rule of seed.harvest) {
            const p = Number(rule.probability ?? 1);
            if (p >= 1 || Math.random() < p) {
              const min = Math.max(1, Number(rule.min||1));
              const max = Math.max(min, Number(rule.max||min));
              let qty = Math.floor(Math.random()*(max-min+1)) + min;

              // [추가] 캐릭터 원예 레벨 보너스: 10레벨마다 +1
              let levelBonus = 0;
              try {
                if (t.plantedByChar) {
                  const charSnap = await tx.get(db.doc(`chars/${String(t.plantedByChar).replace(/^chars\//,'')}`));
                  const g = charSnap.exists ? Number(charSnap.data()?.skills?.gardening || 0) : 0;
                  levelBonus = Math.floor(Math.max(0, Math.min(30, g)) / 10);
                }
              } catch (_) { /* 없으면 보너스 0 */ }

              qty += levelBonus;


              const seasonBonus = seed.season_bonus?.[currentSeason];
              if (seasonBonus === '수확량 소폭 증가') qty = Math.ceil(qty * 1.2);
              if (seasonBonus === '수확량 대폭 증가') qty = Math.ceil(qty * 1.5);
              
              currentRewards[rule.itemId] = (currentRewards[rule.itemId] || 0) + qty;
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
            description: meta.description || '', // [수정] 설명 추가
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

      tx.set(plotRef, { tiles, updatedAt: Date.now() }, { merge: true });
    });

    if(Object.keys(rewards).length > 0) {
        await _awardFarmExp(uid, 12);
    }
    
    return { ok: true, rewards: newItemsForUser };
  });

  return { buySeed, getFarmPlotDetail, plantSeedOnTile, assignCharacterToFarm, harvestTiles };
};
