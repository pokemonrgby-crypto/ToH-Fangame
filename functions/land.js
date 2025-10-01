// /functions/land.js
const fs = require('fs').promises;
const path = require('path');

module.exports = (admin, { onCall, HttpsError, logger }) => {
  const db = admin.firestore();

  let microLegend = null;
  const loadMicroLegend = async () => { /* ... (이전과 동일) ... */ };
  const generateMicroGrid = (blueprint) => { /* ... (이전과 동일) ... */ };

  const getLandDetail = onCall({ region: 'us-central1' }, async (req) => {
    const { mapId, x, y, tileType, plotId } = req.data; // plotId 수신
    if (!mapId || x === undefined || y === undefined || !tileType) {
      throw new HttpsError('invalid-argument', '필수 정보가 누락되었습니다.');
    }

    const floatingPopulation = 10 + Math.floor(Math.random() * 50);
    
    let microGrid = null;
    
    // 1. plotId가 있으면, 해당 이름의 사전 제작 파일을 먼저 찾습니다.
    if (plotId) {
        const plotPath = `../public/assets/mapdata/${mapId.split('_')[0]}/plots/${plotId}.json`;
        try {
            const plotData = await fs.readFile(path.join(__dirname, plotPath), 'utf8');
            microGrid = JSON.parse(plotData).pattern;
            logger.info(`Loaded pre-designed plot '${plotId}' for ${mapId} (${x},${y})`);
        } catch (error) {
            logger.warn(`Pre-designed plot '${plotId}' not found, falling back to procedural generation.`);
        }
    }

    // 2. 사전 제작 파일이 없었거나 plotId가 원래 없었으면, 절차적으로 생성합니다.
    if (!microGrid) {
        const legend = await loadMicroLegend();
        const blueprint = legend.blueprints[tileType];
        if (blueprint) {
            microGrid = blueprint.pattern || generateMicroGrid(blueprint);
        } else {
            microGrid = Array(100).fill('g'); // Fallback
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
