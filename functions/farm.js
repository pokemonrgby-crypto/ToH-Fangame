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

    const seed = allSeeds.find(s => s.id === seedId);
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

    await plotRef.set({ assigned_char_id: charId || null, updatedAt: Date.now() }, { merge: true });
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
