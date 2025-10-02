// /functions/land.js
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions');
const fs = require('fs').promises;
const path = require('path');

module.exports = (admin) => {
  const db = admin.firestore();

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

  // [수정] 더 안정적인 시드 기반 랜덤 생성기 (cyrb53 해시 알고리즘 사용)
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

  // [수정] Blueprint에 따라 10x10 그리드를 '결정론적으로' 생성하는 함수
  const generateMicroGrid = (blueprint, seedStr) => {
    const random = createSeededRandom(seedStr); // 시드 문자열 기반 랜덤 함수 사용
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

  const getLandDetail = onCall({ region: 'us-central1' }, async (req) => {
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
                // [수정] 시드를 고유한 문자열로 생성
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
    ownershipSnap.forEach(doc => { owners[doc.id] = doc.data().ownerName; });

    return { ok: true, mapId, x, y, floatingPopulation, microGrid, owners };
  });

  return { getLandDetail };
};
