// /functions/construction.js
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { FieldValue } = require('firebase-admin/firestore');
const admin = require('firebase-admin');
const db = admin.firestore();
const { v4: uuidv4 } = require('uuid');
const { deductItemsFromInventory } = require('./utils'); // 유틸 함수가 있다고 가정
const { buildingMaterials } = require('./assets'); // 에셋 로더 사용

/**
 * 건설에 필요한 자재와 비용, 시간을 계산하는 내부 함수 (개선)
 * @param {string} scale - 규모 (소형, 중형, 대형, 초대형)
 * @param {number} height - 높이 (m)
 * @param {string} architecturalStyle - 건축 양식
 * @returns {object} { materials, cost, duration, aestheticValue }
 */
function calculateConstructionRequirements(scale, height, architecturalStyle) {
    const materialsData = buildingMaterials();
    if (!materialsData) {
        throw new HttpsError('internal', '건축 자재 데이터를 불러올 수 없습니다.');
    }

    let baseMultiplier = 1;
    if (scale === '중형') baseMultiplier = 5;
    if (scale === '대형') baseMultiplier = 25;
    if (scale === '초대형') baseMultiplier = 125;

    const heightMultiplier = Math.max(1, height / 10);
    const styleMultiplier = 1.2; // 양식에 따른 비용/자재 증가 (예시)

    // 건축 양식에 따라 필요 자재 종류 및 수량 변경 (예시 로직)
    const materials = {};
    if (architecturalStyle === '브루탈리즘') {
        materials['concrete_mix'] = Math.floor(200 * baseMultiplier * heightMultiplier);
        materials['iron_ingot'] = Math.floor(50 * baseMultiplier * heightMultiplier);
    } else {
        materials['processed_wood'] = Math.floor(100 * baseMultiplier * heightMultiplier * styleMultiplier);
        materials['stone_brick'] = Math.floor(80 * baseMultiplier * heightMultiplier * styleMultiplier);
        materials['iron_ingot'] = Math.floor(20 * baseMultiplier * heightMultiplier);
        materials['glass'] = Math.floor(15 * baseMultiplier * heightMultiplier * styleMultiplier);
    }
    
    let cost = 0;
    let aestheticValue = 0;
    for(const matId in materials) {
        if(materialsData[matId]) {
            const materialInfo = materialsData[matId];
            cost += materialInfo.basePrice * materials[matId];
            if (materialInfo.aesthetic_modifier) {
                aestheticValue += (materials[matId] * (materialInfo.aesthetic_modifier - 1));
            }
        }
    }
    cost = Math.floor(cost * 1.25); // 시공사 마진 및 인건비
    aestheticValue = Math.floor(aestheticValue + (height / 10) + (baseMultiplier * 5)); // 규모와 높이에 따른 미관 점수

    const duration = Math.floor(60 * baseMultiplier * heightMultiplier * styleMultiplier);

    return { materials, cost, duration, aestheticValue };
}

/**
 * 신규 건물 건설 시작
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
        contractor, // 시공사 정보
    } = req.data;
    
    if (!plotId || !buildingName || !buildingType || !architecturalStyle || !scale || !height) {
        throw new HttpsError('invalid-argument', '필수 정보가 누락되었습니다.');
    }
    if (typeof height !== 'number' || height < 5 || height > 1000) {
        throw new HttpsError('invalid-argument', '높이는 5m에서 1000m 사이여야 합니다.');
    }

    const { materials, cost, duration, aestheticValue } = calculateConstructionRequirements(scale, height, architecturalStyle);

    try {
        await db.runTransaction(async (transaction) => {
            const userRef = db.collection('users').doc(uid);
            const userDoc = await transaction.get(userRef);
            if (!userDoc.exists) throw new HttpsError('not-found', '사용자 정보를 찾을 수 없습니다.');
            
            const userCoins = userDoc.data().coins || 0;
            if (userCoins < cost) throw new HttpsError('failed-precondition', `비용이 부족합니다. (현재: ${userCoins}, 필요: ${cost})`);
            
            transaction.update(userRef, { coins: FieldValue.increment(-cost) });
            await deductItemsFromInventory(transaction, uid, materials); // 유틸 함수 사용
            
            const projectId = uuidv4();
            const projectRef = db.collection('construction_projects').doc(projectId);
            const startTime = Date.now();
            const completionTime = new Date(startTime + duration * 60 * 1000);

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
                baseAestheticValue: aestheticValue,
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
 * 건설 프로젝트 완료
 */
exports.completeConstruction = onCall({ region: 'us-central1' }, async (req) => {
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');

    const { projectId } = req.data;
    if (!projectId) throw new HttpsError('invalid-argument', '프로젝트 ID가 필요합니다.');
    
    const projectRef = db.collection('construction_projects').doc(projectId);
    
    try {
        const result = await db.runTransaction(async (transaction) => {
            const projectDoc = await transaction.get(projectRef);
            if (!projectDoc.exists) throw new HttpsError('not-found', '진행중인 건설 프로젝트를 찾을 수 없습니다.');
            
            const projectData = projectDoc.data();
            if (projectData.ownerId !== uid) throw new HttpsError('permission-denied', '프로젝트 소유주가 아닙니다.');
            if (new Date() < projectData.completionTime.toDate()) throw new HttpsError('failed-precondition', '아직 건설이 완료되지 않았습니다.');
            
            const plotRef = db.collection('land_plots').doc(projectData.plotId);
            
            const newBuilding = {
                id: uuidv4(),
                name: projectData.buildingName,
                type: projectData.buildingType,
                style: projectData.architecturalStyle,
                scale: projectData.scale,
                height: projectData.height,
                contractor: projectData.contractor,
                completionDate: projectData.completionTime,
                
                // 관리 정보
                manager: null,
                collapseChance: 1.0, 
                lastInspection: null,
                safetyLevel: '안전', 
                profitability: 0,
                baseAestheticValue: projectData.baseAestheticValue,
                finalAestheticGrade: 'F', // 초기 등급
                
                // 시설 및 용도 정보
                purpose: null,
                placed_facilities: [],
            };
            
            transaction.update(plotRef, {
                facilities: FieldValue.arrayUnion(newBuilding),
                // TODO: 부지의 usedArea 업데이트 로직 추가
            });
            transaction.delete(projectRef);
            return newBuilding;
        });

        return { success: true, message: `'${result.name}' 건물이 완공되었습니다!`, building: result };
    } catch (error) {
        console.error("Construction completion failed:", error);
        throw new HttpsError('internal', '건물 완공 처리에 실패했습니다.');
    }
});

/**
 * 건물 관리
 */
exports.manageBuilding = onCall({ region: 'us-central1' }, async (req) => {
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');

    const { plotId, buildingId, action, payload } = req.data; // payload 추가
    if (!plotId || !buildingId || !action) {
        throw new HttpsError('invalid-argument', '필수 정보(plotId, buildingId, action)가 누락되었습니다.');
    }
    
    const plotRef = db.collection('land_plots').doc(plotId);
    let resultMessage = '';

    try {
        await db.runTransaction(async (transaction) => {
            const plotDoc = await transaction.get(plotRef);
            if (!plotDoc.exists) throw new HttpsError('not-found', '부지 정보를 찾을 수 없습니다.');
            
            // TODO: 부지 소유권 확인 로직 추가

            const plotData = plotDoc.data();
            const facilities = plotData.facilities || [];
            const buildingIndex = facilities.findIndex(f => f.id === buildingId);

            if (buildingIndex === -1) throw new HttpsError('not-found', '해당 건물을 찾을 수 없습니다.');
            
            let building = facilities[buildingIndex];

            switch (action) {
                case 'inspect_collapse':
                    // 시간이 지날수록, 높고 클수록 붕괴도가 높아질 확률 증가
                    building.collapseChance += Math.random() * (building.height / 100) + (building.scale === '초대형' ? 1 : 0);
                    if (building.collapseChance > 100) building.collapseChance = 100;
                    
                    if (building.collapseChance > 90) building.safetyLevel = '붕괴 직전';
                    else if (building.collapseChance > 70) building.safetyLevel = '위급';
                    else if (building.collapseChance > 40) building.safetyLevel = '위험';
                    else if (building.collapseChance > 15) building.safetyLevel = '불안';
                    else building.safetyLevel = '안전';
                    
                    building.lastInspection = new Date();
                    resultMessage = `[${building.name}] 붕괴도 조사 완료. 현재 안전도: ${building.safetyLevel} (${building.collapseChance.toFixed(2)}%)`;
                    break;

                case 'repair':
                    if (!['불안', '위험', '위급'].includes(building.safetyLevel)) {
                        throw new HttpsError('failed-precondition', '보수 작업은 안전도가 \'불안\', \'위험\', \'위급\'일 때만 가능합니다.');
                    }
                    // TODO: 보수에 필요한 자원 및 비용 계산 및 차감 로직 추가
                    building.collapseChance -= (Math.random() * 15 + 10); // 10~25%p 랜덤 감소
                    if (building.collapseChance < 1) building.collapseChance = 1.0;
                    // 보수 후 안전도 재평가 (위 inspect_collapse 로직 재사용)
                    resultMessage = `[${building.name}] 보수 작업 완료. 붕괴도가 개선되었습니다.`;
                    break;
                
                case 'rebuild':
                     if (building.safetyLevel !== '붕괴 직전') {
                        throw new HttpsError('failed-precondition', '재건축은 \'붕괴 직전\' 상태에서만 가능합니다.');
                     }
                     // TODO: 재건축 비용 계산 및 자원 차감. startConstruction 로직 일부 재활용 가능.
                     // 재건축은 건설 프로젝트를 새로 생성하는 방식으로 구현.
                     resultMessage = `[${building.name}] 재건축이 필요합니다.`;
                     break;

                case 'inspect_aesthetic':
                    // 기본 미관 점수 + 내부 시설(facilities.json) + 가구(items.json)의 미관 점수 합산
                    let totalAesthetic = building.baseAestheticValue || 0;
                    // TODO: 배치된 시설/가구의 aestheticValue 합산 로직 추가
                    
                    // 등급 판정 (예시)
                    if (totalAesthetic > 1000) building.finalAestheticGrade = 'SSS';
                    else if (totalAesthetic > 700) building.finalAestheticGrade = 'SS';
                    else if (totalAesthetic > 500) building.finalAestheticGrade = 'S';
                    else if (totalAesthetic > 300) building.finalAestheticGrade = 'A';
                    else if (totalAesthetic > 150) building.finalAestheticGrade = 'B';
                    else if (totalAesthetic > 50) building.finalAestheticGrade = 'C';
                    else building.finalAestheticGrade = 'F';

                    resultMessage = `[${building.name}] 미관도 조사 완료. 최종 등급: ${building.finalAestheticGrade} (${totalAesthetic}점)`;
                    break;

                default:
                    throw new HttpsError('invalid-argument', '알 수 없는 관리 명령입니다.');
            }

            facilities[buildingIndex] = building;
            transaction.update(plotRef, { facilities: facilities });
        });
        
        return { success: true, message: resultMessage };

    } catch (error) {
        console.error(`Building management failed (Action: ${action}):`, error);
        throw new HttpsError('internal', error.message || '건물 관리 명령 수행에 실패했습니다.');
    }
});
