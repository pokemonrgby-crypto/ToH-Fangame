const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');

// Asset 파일 로드 (실제로는 index.js 등에서 한번만 로드 후 전달받는 것이 효율적)
const buildingMaterials = require('./assets/building_materials.json');
const architecturalStyles = require('./assets/architectural_styles.json');

/**
 * 건물 건설을 시작하는 함수
 * @param {object} data - 클라이언트에서 전달하는 데이터
 * @param {string} data.plotId - 건물을 지을 토지 ID
 * @param {string} data.name - 건물 이름
 * @param {number} data.area - 건설할 면적 (m²)
 * @param {number} data.height - 건설할 높이 (m)
 * @param {string} data.styleId - 건축 양식 ID
 * @param {string} context - 호출한 사용자 정보
 */
exports.startConstruction = functions.https.onCall(async (data, context) => {
    const { plotId, name, area, height, styleId } = data;
    const uid = context.auth.uid;

    if (!plotId || !name || !area || !height || !styleId) {
        throw new functions.https.HttpsError('invalid-argument', '필수 인자가 누락되었습니다.');
    }
    if (area <= 0 || height <= 0) {
        throw new functions.https.HttpsError('invalid-argument', '면적과 높이는 0보다 커야 합니다.');
    }

    const db = admin.firestore();
    const plotRef = db.collection('land_plots').doc(plotId);
    const playerInventoryRef = db.collection('inventories').doc(uid);

    // 트랜잭션을 사용하여 데이터 일관성 보장
    return db.runTransaction(async (transaction) => {
        const plotDoc = await transaction.get(plotRef);
        const inventoryDoc = await transaction.get(playerInventoryRef);

        if (!plotDoc.exists || plotDoc.data().ownerId !== uid) {
            throw new functions.https.HttpsError('not-found', '존재하지 않거나 소유하지 않은 토지입니다.');
        }

        const plotData = plotDoc.data();
        if (plotData.totalArea < plotData.usedArea + area) {
            throw new functions.https.HttpsError('resource-exhausted', '토지 면적이 부족합니다.');
        }

        // 1. 필요 자재 및 비용, 시간 계산 (이 공식은 예시이며, 고도화 필요)
        const requiredMaterials = {
            'processed_wood': Math.ceil(area * height * 0.1),
            'stone_brick': Math.ceil(area * height * 0.2)
        };
        const constructionCost = Object.keys(requiredMaterials).reduce((acc, matId) => {
            return acc + (requiredMaterials[matId] * (buildingMaterials[matId]?.basePrice || 10));
        }, 0);
        const constructionTimeMinutes = Math.ceil((area * height) / 10); // 10m³/min 속도라고 가정

        // 2. 플레이어 재화 및 자재 확인
        const inventoryData = inventoryDoc.data() || { items: {}, coin: 0 };
        if (inventoryData.coin < constructionCost) {
            throw new functions.https.HttpsError('resource-exhausted', '건설 비용(코인)이 부족합니다.');
        }
        for (const matId in requiredMaterials) {
            if ((inventoryData.items[matId] || 0) < requiredMaterials[matId]) {
                throw new functions.https.HttpsError('resource-exhausted', `${buildingMaterials[matId].name} 자재가 부족합니다.`);
            }
        }

        // 3. 재화 및 자재 차감
        const newCoin = inventoryData.coin - constructionCost;
        const newItems = { ...inventoryData.items };
        for (const matId in requiredMaterials) {
            newItems[matId] -= requiredMaterials[matId];
        }
        transaction.set(playerInventoryRef, { ...inventoryData, coin: newCoin, items: newItems });


        // 4. 건물 데이터 생성 및 토지에 추가
        const newBuilding = {
            id: `building_${uuidv4()}`,
            type: 'building',
            name,
            area,
            height,
            styleId,
            purposeId: 'unassigned',
            buildStatus: 'constructing',
            constructionStartTime: new Date().toISOString(),
            completionTime: new Date(Date.now() + constructionTimeMinutes * 60 * 1000).toISOString(),
            durability: 100.0,
            collapseRisk: 1.0,
            aestheticScore: 20, // 기본 미관 점수
            managerCharId: null,
            placed_facilities: []
        };

        transaction.update(plotRef, {
            usedArea: plotData.usedArea + area,
            facilities: admin.firestore.FieldValue.arrayUnion(newBuilding)
        });

        return { success: true, message: '건설을 시작했습니다!', buildingId: newBuilding.id };
    });
});
