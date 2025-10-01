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
        // [수정] 파일 경로를 functions 폴더 내부로 변경
        const legendPath = path.join(__dirname, './assets/micro_legend.json');
        const data = await fs.readFile(legendPath, 'utf8');
        microLegend = JSON.parse(data);
        return microLegend;
    } catch (error) {
        logger.error("Failed to load micro_legend.json", error);
        return { blueprints: {} };
    }
  };

  // Blueprint에 따라 10x10 그리드를 절차적으로 생성하는 함수
  const generateMicroGrid = (blueprint) => {
    const base = blueprint.base || 'g'; // 기본 타일 (예: 잔디)
    const grid = Array(100).fill(base);
    const composition = blueprint.composition || [];

    composition.forEach(comp => {
        const { type, density } = comp;
        const count = Math.floor(100 * density);
        for (let i = 0; i < count; i++) {
            const randomIndex = Math.floor(Math.random() * 100);
            grid[randomIndex] = type;
        }
    });
    return grid;
  };

  const getLandDetail = onCall({ region: 'us-central1' }, async (req) => {
    // 1. 요청에서 필요한 정보 추출
    const { mapId, x, y, tileType, plotId } = req.data;
    if (!mapId || x === undefined || y === undefined) {
      throw new HttpsError('invalid-argument', '필수 정보(mapId, x, y)가 누락되었습니다.');
    }

    // 2. 동적 데이터 생성 (예: 유동 인구)
    const floatingPopulation = 10 + Math.floor(Math.random() * 50);
    
    let microGrid = null;
    
    // 3. plotId가 있으면, 해당 이름의 사전 제작 파일을 먼저 찾습니다.
    if (plotId) {
        // [수정] 파일 경로를 functions 폴더 내부로 변경하고, path.join을 사용하여 안정적으로 경로를 만듭니다.
        const plotPath = path.join(__dirname, 'assets', 'mapdata', mapId.split('_')[0], 'plots', `${plotId}.json`);
        try {
            const plotData = await fs.readFile(plotPath, 'utf8');
            microGrid = JSON.parse(plotData).pattern;
            logger.info(`Loaded pre-designed plot '${plotId}' for ${mapId} (${x},${y}) from ${plotPath}`);
        } catch (error) {
            logger.warn(`Pre-designed plot '${plotId}' not found at ${plotPath}, falling back to procedural generation.`, error);
        }
    }

    // 4. 사전 제작 파일이 없었거나 plotId가 원래 없었으면, 절차적으로 생성합니다.
    if (!microGrid) {
        if (!tileType) {
            // plotId도 없고 tileType도 없으면 생성 불가
            logger.error(`Cannot generate grid for ${mapId}(${x},${y}) without plotId or tileType.`);
            microGrid = Array(100).fill('g'); // 비상용 잔디밭
        } else {
            const legend = await loadMicroLegend();
            const blueprint = legend.blueprints[tileType];
            if (blueprint) {
                microGrid = generateMicroGrid(blueprint);
                logger.info(`Procedurally generated grid for tileType '${tileType}' at ${mapId}(${x},${y})`);
            } else {
                logger.warn(`No blueprint found for tileType '${tileType}'. Falling back to default.`);
                microGrid = Array(100).fill('g'); // Fallback
            }
        }
    }

    // 5. Firestore에서 미시적(10x10) 소유권 정보 조회
    const ownershipRef = db.collection('land_plots').doc(`${mapId}_${x}_${y}`).collection('micro_ownership');
    const ownershipSnap = await ownershipRef.get();
    const owners = {};
    ownershipSnap.forEach(doc => { owners[doc.id] = doc.data().ownerName; });

    // 6. 클라이언트에 모든 정보 반환
    return { ok: true, mapId, x, y, floatingPopulation, microGrid, owners };
  });

  // 다른 함수들이 있다면 여기에 추가...

  return { getLandDetail };
};
