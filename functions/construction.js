// /functions/construction.js
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { FieldValue } = require('firebase-admin/firestore');
const admin = require('firebase-admin');
const db = admin.firestore();
const { v4: uuidv4 } = require('uuid');
const { deductItemsFromInventory } = require('./utils');

// 에셋 데이터 로드 (실제 환경에서는 시작 시 한번만 로드하도록 최적화 필요)
const itemsData = require('./assets/items.json');

/**
 * 건설에 필요한 자재와 비용, 시간을 계산하는 내부 함수
 * @param {string} scale - 규모 (소형, 중형, 대형, 초대형)
 * @param {number} height - 높이 (m)
 * @returns {object} { materials, cost, duration }
 */
function calculateConstructionRequirements(scale, height) {
    // 이 로직은 게임 기획에 따라 매우 상세하고 복잡해질 수 있습니다.
    // 여기서는 규모와 높이에 따라 선형적으로 증가하는 간단한 예시를 사용합니다.
    let baseMultiplier = 1;
    if (scale === '중형') baseMultiplier = 5;
    if (scale === '대형') baseMultiplier = 25;
    if (scale === '초대형') baseMultiplier = 125;

    const heightMultiplier = Math.max(1, height / 10); // 10m당 배수 증가

    const materials = {
        'processed_wood': Math.floor(100 * baseMultiplier * heightMultiplier),
        'stone_brick': Math.floor(80 * baseMultiplier * heightMultiplier),
        'iron_ingot': Math.floor(20 * baseMultiplier * heightMultiplier),
        'glass': Math.floor(15 * baseMultiplier * heightMultiplier)
    };
    
    // 기본 시공 비용 계산
    let cost = 0;
    for(const matId in materials) {
        if(itemsData[matId]) {
            cost += itemsData[matId].basePrice * materials[matId];
        }
    }
    cost = Math.floor(cost * 1.2); // 시공사 마진

    // 예상 소요 시간 (분 단위)
    const duration = Math.floor(60 * baseMultiplier * heightMultiplier);

    return { materials, cost, duration };
}


/**
 * 신규 건물 건설을 시작하는 함수
 */
exports.startConstruction = onCall({ region: 'us-central1' }, async (req) => {
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');

    const {
        plotId,
        buildingName,
        buildingType,
        architecturalStyle,
        scale,
        height, // m 단위 숫자
        contractor,
    } = req.data;
    
    // 1. 입력값 유효성 검사
    if (!plotId || !buildingName || !buildingType || !scale || !height) {
        throw new HttpsError('invalid-argument', '필수 정보가 누락되었습니다.');
    }
    if (typeof height !== 'number' || height < 5 || height > 1000) {
        throw new HttpsError('invalid-argument', '높이는 5m에서 1000m 사이여야 합니다.');
    }

    // 2. 필요 자원 및 비용, 시간 계산
    const { materials, cost, duration } = calculateConstructionRequirements(scale, height);

    try {
        await db.runTransaction(async (transaction) => {
            const userRef = db.collection('users').doc(uid);
            const userDoc = await transaction.get(userRef);

            if (!userDoc.exists) {
                throw new HttpsError('not-found', '사용자 정보를 찾을 수 없습니다.');
            }

            // 3. 비용 확인 및 차감
            const userCoins = userDoc.data().coins || 0;
            if (userCoins < cost) {
                throw new HttpsError('failed-precondition', `비용이 부족합니다. (현재: ${userCoins}, 필요: ${cost})`);
            }
            transaction.update(userRef, { coins: FieldValue.increment(-cost) });

            // 4. 자원 확인 및 차감 (유틸 함수 사용)
            await deductItemsFromInventory(transaction, uid, materials);
            
            // 5. 건설 프로젝트 문서 생성
            const projectId = uuidv4();
            const projectRef = db.collection('construction_projects').doc(projectId);
            const startTime = Date.now();
            const completionTime = new Date(startTime + duration * 60 * 1000); // 분 -> 밀리초

            transaction.set(projectRef, {
                ownerId: uid,
                plotId,
                projectId,
                buildingName,
                buildingType,
                architecturalStyle,
                scale,
                height,
                contractor,
                requiredMaterials: materials,
                cost,
                status: 'inprogress',
                startTime: new Date(startTime),
                completionTime,
            });
        });

        return { success: true, message: `'${buildingName}' 건설을 시작합니다. 예상 완공 시간: ${new Date(Date.now() + duration * 60 * 1000).toLocaleString()}` };

    } catch (error) {
        console.error("Construction start failed:", error);
        throw new HttpsError('internal', error.message || '건설 시작에 실패했습니다.');
    }
});


/**
 * 건설 프로젝트를 완료하는 함수
 */
exports.completeConstruction = onCall({ region: 'us-central1' }, async (req) => {
    // 참고: 실제 프로덕션에서는 Cron Job과 결합하여 자동으로 이 함수를 호출하거나,
    // 클라이언트가 프로젝트 상태를 폴링하여 완료 시점에 직접 호출하게 할 수 있습니다.
    // 여기서는 수동 호출을 가정합니다.

    const { projectId } = req.data;
    if (!projectId) throw new HttpsError('invalid-argument', '프로젝트 ID가 필요합니다.');
    
    const projectRef = db.collection('construction_projects').doc(projectId);
    const projectDoc = await projectRef.get();

    if (!projectDoc.exists) {
        throw new HttpsError('not-found', '진행중인 건설 프로젝트를 찾을 수 없습니다.');
    }

    const projectData = projectDoc.data();
    
    // 완공 시간이 지났는지 확인
    if (new Date() < projectData.completionTime.toDate()) {
         throw new HttpsError('failed-precondition', '아직 건설이 완료되지 않았습니다.');
    }

    const plotRef = db.collection('land_plots').doc(projectData.plotId);
    
    // 건물의 최종 데이터 구조
    const newBuilding = {
        id: uuidv4(),
        name: projectData.buildingName,
        type: projectData.buildingType,
        style: projectData.architecturalStyle,
        scale: projectData.scale,
        height: projectData.height,
        contractor: projectData.contractor,
        completionDate: projectData.completionTime,
        collapseChance: 1.0, // 초기 붕괴 가능성 1%
        lastInspection: null, // 마지막 조사일
        safetyLevel: '안전', // 안전, 불안, 위험, 위급, 붕괴 직전
        profitability: 0, // G/h
        aestheticValue: 0, // SSS ~ F
        manager: null, // 관리인
    };
    
    try {
        await db.runTransaction(async (transaction) => {
            // land_plots 문서의 facilities 배열에 새 건물 추가
            transaction.update(plotRef, {
                facilities: FieldValue.arrayUnion(newBuilding)
            });
            // 건설 프로젝트 문서 삭제
            transaction.delete(projectRef);
        });

        return { success: true, message: `'${projectData.buildingName}' 건물이 완공되었습니다!`, building: newBuilding };
    } catch (error) {
        console.error("Construction completion failed:", error);
        throw new HttpsError('internal', '건물 완공 처리에 실패했습니다.');
    }
});
// ... manageBuilding 함수는 다음 단계에서 ...
