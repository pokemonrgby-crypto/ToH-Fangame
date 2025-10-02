// /functions/land.js
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions');
const fs = require('fs').promises;
const path = require('path');

module.exports = (admin) => {
  const db = admin.firestore();
  const { FieldValue } = admin.firestore;

  // micro_legend.json을 한 번만 로드하여 캐시
  let microLegend = null;
  const loadMicroLegend = async () => {
    if (microLegend) return microLegend;
    try {
        const legendPath = path.join(__dirname, './assets/micro_legend.json');
        const data = await fs.readFile(legendPath, 'utf8');
        microLegend = JSON.parse(data);
        return microLegend;
    } catch (error) {
        logger.error("Failed to load micro_legend.json", error);
        return { blueprints: {} };
    }
  };

  // 시드 기반 랜덤 생성기 (결정론적 생성을 위해)
  const createSeededRandom = (seedStr) => {
    let h1 = 1779033703, h2 = 3144134277,
        h3 = 1013904242, h4 = 2773480762;
    for (let i = 0, k; i < seedStr.length; i++) {
        k = seedStr.charCodeAt(i);
        h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
        h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
        h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
        h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
    }
    h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
    h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
    h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
    h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
    let seed = (h1^h2^h3^h4)>>>0;
    return () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
  };

  const generateMicroGrid = (blueprint, seedStr) => {
    const random = createSeededRandom(seedStr);
    const base = blueprint.base || 'g';
    const grid = Array(100).fill(base);
    const composition = blueprint.composition || [];
    composition.forEach(comp => {
        const { type, density } = comp;
        const count = Math.floor(100 * density);
        for (let i = 0; i < count; i++) {
            const randomIndex = Math.floor(random() * 100);
            grid[randomIndex] = type;
        }
    });
    return grid;
  };

  // [신규] 관리자 확인 헬퍼
  async function _isAdmin(uid) {
    if (!uid) return false;
    try {
      const snap = await db.doc('configs/admins').get();
      const d = snap.exists ? snap.data() : {};
      const allow = Array.isArray(d.allow) ? d.allow : [];
      if (allow.includes(uid)) return true;
      const allowEmails = Array.isArray(d.allowEmails) ? d.allowEmails : [];
      const user = await admin.auth().getUser(uid);
      return !!(user?.email && allowEmails.includes(user.email));
    } catch (_) { return false; }
  }

  // [신규] 토지 가격 계산 로직 (향후 확장 가능)
  function _calculateLandPrice(tileType, microTileType, legend) {
    const basePrice = { s: 500, l: 700, M: 2000, m: 3000, f: 1200, n: 1000, b: 1500, d: 800, r: 2500, R: 5000 }[tileType] || 1000;
    const microInfo = legend.micro_tile_legend[microTileType] || {};
    const microMultiplier = microInfo.buildable ? 1.2 : 0.8; // 건설 가능 여부에 따른 가치 변동
    return Math.floor(basePrice * microMultiplier);
  }

  const getLandDetail = onCall({ region: 'us-central1' }, async (req) => {
    // ... (기존 getLandDetail 함수 내용은 변경 없음)
    const { mapId, x, y, tileType, plotId } = req.data;
    if (!mapId || x === undefined || y === undefined) {
      throw new HttpsError('invalid-argument', '필수 정보(mapId, x, y)가 누락되었습니다.');
    }

    const floatingPopulation = 10 + Math.floor(Math.random() * 50);
    
    let microGrid = null;
    
    if (plotId) {
        const plotPath = path.join(__dirname, 'assets', 'mapdata', mapId.split('_')[0], 'plots', `${plotId}.json`);
        try {
            const plotData = await fs.readFile(plotPath, 'utf8');
            microGrid = JSON.parse(plotData).pattern;
            logger.info(`Loaded pre-designed plot '${plotId}' for ${mapId} (${x},${y}) from ${plotPath}`);
        } catch (error) {
            logger.warn(`Pre-designed plot '${plotId}' not found at ${plotPath}, falling back to procedural generation.`, error);
        }
    }

    if (!microGrid) {
        if (!tileType) {
            logger.error(`Cannot generate grid for ${mapId}(${x},${y}) without plotId or tileType.`);
            microGrid = Array(100).fill('g');
        } else {
            const legend = await loadMicroLegend();
            const blueprint = legend.blueprints[tileType];
            if (blueprint) {
                const seedString = `${mapId}_${x}_${y}`;
                microGrid = generateMicroGrid(blueprint, seedString);
                logger.info(`Procedurally generated grid for tileType '${tileType}' at ${mapId}(${x},${y})`);
            } else {
                logger.warn(`No blueprint found for tileType '${tileType}'. Falling back to default.`);
                microGrid = Array(100).fill('g');
            }
        }
    }

    const ownershipRef = db.collection('land_plots').doc(`${mapId}_${x}_${y}`).collection('micro_ownership');
    const ownershipSnap = await ownershipRef.get();
    const owners = {};
    ownershipSnap.forEach(doc => { owners[doc.id] = doc.data() });

    return { ok: true, mapId, x, y, floatingPopulation, microGrid, owners };
  });

  // [신규] 마이크로 플롯 구매 함수
  const buyMicroPlot = onCall({ region: 'us-central1' }, async (req) => {
    const uid = req.auth?.uid;
    if (!await _isAdmin(uid)) throw new HttpsError('permission-denied', '관리자만 토지를 구매할 수 있습니다.');

    const { mapId, x, y, microX, microY, tileType, microTileType } = req.data;
    if (mapId === undefined || x === undefined || y === undefined || microX === undefined || microY === undefined || !microTileType) {
      throw new HttpsError('invalid-argument', '필수 정보가 누락되었습니다.');
    }
    
    const legend = await loadMicroLegend();
    const price = _calculateLandPrice(tileType, microTileType, legend);
    const plotDocId = `${mapId}_${x}_${y}`;
    const microDocId = `${microY}_${microX}`;
    
    return db.runTransaction(async (tx) => {
      const userRef = db.doc(`users/${uid}`);
      const microOwnershipRef = db.collection('land_plots').doc(plotDocId).collection('micro_ownership').doc(microDocId);
      
      const [userSnap, ownerSnap] = await Promise.all([tx.get(userRef), tx.get(microOwnershipRef)]);
      
      if (ownerSnap.exists) throw new HttpsError('already-exists', '이미 소유자가 있는 토지입니다.');
      
      const userCoins = userSnap.data()?.coins || 0;
      if (userCoins < price) throw new HttpsError('failed-precondition', '코인이 부족합니다.');
      
      tx.update(userRef, { coins: FieldValue.increment(-price) });
      tx.set(microOwnershipRef, {
        owner_uid: uid,
        ownerName: userSnap.data()?.nickname || '관리자',
        purchasedAt: FieldValue.serverTimestamp(),
        price: price
      });
      
      return { ok: true, price, newBalance: userCoins - price };
    });
  });

  // [신규] 마이크로 플롯 판매 함수
  const sellMicroPlot = onCall({ region: 'us-central1' }, async (req) => {
    const uid = req.auth?.uid;
    if (!await _isAdmin(uid)) throw new HttpsError('permission-denied', '관리자만 토지를 판매할 수 있습니다.');
    
    const { mapId, x, y, microX, microY } = req.data;
    if (mapId === undefined || x === undefined || y === undefined || microX === undefined || microY === undefined) {
      throw new HttpsError('invalid-argument', '필수 정보가 누락되었습니다.');
    }
    
    const plotDocId = `${mapId}_${x}_${y}`;
    const microDocId = `${microY}_${microX}`;
    
    return db.runTransaction(async (tx) => {
      const userRef = db.doc(`users/${uid}`);
      const microOwnershipRef = db.collection('land_plots').doc(plotDocId).collection('micro_ownership').doc(microDocId);
      const ownerSnap = await tx.get(microOwnershipRef);
      
      if (!ownerSnap.exists || ownerSnap.data().owner_uid !== uid) {
        throw new HttpsError('permission-denied', '소유하고 있는 토지가 아닙니다.');
      }
      
      const salePrice = Math.floor((ownerSnap.data().price || 0) * 0.8); // 판매 시 80% 환급
      
      tx.update(userRef, { coins: FieldValue.increment(salePrice) });
      tx.delete(microOwnershipRef);
      
      return { ok: true, refund: salePrice };
    });
  });

  return { getLandDetail, buyMicroPlot, sellMicroPlot };
};
