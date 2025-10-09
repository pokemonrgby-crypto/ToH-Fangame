// /functions/construction.js
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { FieldValue } = require('firebase-admin/firestore');
const admin = require('firebase-admin');
const db = admin.firestore();
const { v4: uuidv4 } = require('uuid');

// 에셋 로더와 유틸리티 함수를 불러옵니다.
const { buildingMaterials, researchTree, buildings: buildingsData } = require('./assets');
const { deductItemsFromInventory, ensureCharacterSkills } = require('./utils');

const MATERIAL_BUYOUT_MULTIPLIER = 2.5; // 자재 긴급 구매 시 가격 배수

/**
 * 건설 요구사항 계산 함수 (업그레이드)
 * @param {object} params - { scale, height, architecturalStyle, constructionLevel }
 * @returns {object} { materials, cost, duration, aestheticValue, qualityBonus }
 */
function calculateConstructionRequirements({ scale, height, architecturalStyle, constructionLevel = 1 }) {
    const materialsData = buildingMaterials();
    // ... (기존 계산 로직, aestheticValue 계산 포함)

    // [수정] 건설 레벨에 따른 시간 단축 및 품질 보너스
    const durationMultiplier = 1 / (1 + (constructionLevel - 1) * 0.05); // 레벨당 5% 시간 단축
    const duration = Math.max(10, Math.floor(baseDuration * durationMultiplier)); // 최소 10분
    const qualityBonus = Math.min(0.5, (constructionLevel - 1) * 0.005); // 레벨당 0.5% 품질 보너스 확률 (최대 50%)

    return { materials, cost, duration, aestheticValue, qualityBonus };
}

/**
 * 신규 건물 건설 시작 (v2 - 노동력, 자재 구매, 기술 통합)
 */
exports.startConstruction = onCall({ region: 'us-central1' }, async (req) => {
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');

    const {
        plotId,
        buildingId, // 건설할 건물의 ID (buildings.json)
        contractor, // { type: 'character' | 'npc', id?: string, level?: number }
        allowMaterialBuyout = false, // 자재 긴급 구매 허용 여부
        // 이름, 양식 등은 buildingId로 조회
    } = req.data;

    if (!plotId || !buildingId || !contractor) {
        throw new HttpsError('invalid-argument', '필수 정보가 누락되었습니다.');
    }

    const buildingInfo = buildingsData()[buildingId];
    if (!buildingInfo) {
        throw new HttpsError('not-found', '존재하지 않는 건물입니다.');
    }

    let constructionLevel = 1;
    let laborCost = 0;

    // 트랜잭션 시작
    try {
        const result = await db.runTransaction(async (transaction) => {
            const userRef = db.collection('users').doc(uid);
            const userDoc = await transaction.get(userRef);
            if (!userDoc.exists) throw new HttpsError('not-found', '사용자 정보를 찾을 수 없습니다.');
            const userData = userDoc.data();

            // 1. 기술(지식) 선행 조건 확인
            if (buildingInfo.required_knowledge && buildingInfo.required_knowledge.length > 0) {
                const knowledgeRef = db.collection('knowledge').doc(uid);
                const knowledgeDoc = await transaction.get(knowledgeRef);
                const userKnowledge = knowledgeDoc.exists ? knowledgeDoc.data() : {};
                for (const techId of buildingInfo.required_knowledge) {
                    if (!userKnowledge[techId] || userKnowledge[techId].understanding < 100) {
                        const techName = researchTree().projects[techId]?.name || techId;
                        throw new HttpsError('failed-precondition', `필요한 기술(${techName})이 부족합니다.`);
                    }
                }
            }

            // 2. 노동력(건축가) 레벨 결정 및 비용 계산
            if (contractor.type === 'character' && contractor.id) {
                const charRef = db.collection('chars').doc(contractor.id);
                let charData = (await transaction.get(charRef)).data();
                if (!charData || charData.owner_uid !== uid) throw new HttpsError('permission-denied', '유효하지 않은 캐릭터입니다.');
                
                // 레거시 캐릭터 호환
                charData = await ensureCharacterSkills(transaction, charRef, charData);
                constructionLevel = charData.skills.construction.level;
                // TODO: 캐릭터 상태를 'constructing'으로 변경
                
            } else if (contractor.type === 'npc' && contractor.level) {
                constructionLevel = contractor.level;
                laborCost = Math.floor(50 * Math.pow(constructionLevel, 1.5)); // NPC 레벨에 따른 인건비 (기하급수적 증가)
            }

            // 3. 건설 요구사항 계산 (노동력 레벨 반영)
            const { materials, cost, duration, aestheticValue, qualityBonus } = calculateConstructionRequirements({
                ...buildingInfo, // scale, height 등
                constructionLevel,
            });

            const totalCost = cost + laborCost;

            // 4. 자재 확인 및 긴급 구매 처리
            let materialBuyoutCost = 0;
            const materialsToDeduct = {};
            const userItems = userData.items_all || [];

            for (const matId in materials) {
                const requiredQty = materials[matId];
                const userItem = userItems.find(item => item.id === matId);
                const userQty = userItem ? (userItem.count || 1) : 0;

                if (userQty < requiredQty) {
                    if (!allowMaterialBuyout) {
                        throw new HttpsError('failed-precondition', `자재(${buildingMaterials()[matId].name})가 부족합니다.`);
                    }
                    const missingQty = requiredQty - userQty;
                    const price = buildingMaterials()[matId].basePrice;
                    materialBuyoutCost += missingQty * price * MATERIAL_BUYOUT_MULTIPLIER;
                    if(userQty > 0) materialsToDeduct[matId] = userQty; // 있는 만큼은 차감
                } else {
                    materialsToDeduct[matId] = requiredQty;
                }
            }
            
            // 5. 최종 비용 확인 및 차감
            const finalCost = totalCost + materialBuyoutCost;
            if (userData.coins < finalCost) {
                throw new HttpsError('failed-precondition', `비용이 부족합니다. (필요: ${finalCost})`);
            }
            transaction.update(userRef, { coins: FieldValue.increment(-finalCost) });
            
            // 6. 자재 차감
            await deductItemsFromInventory(transaction, uid, materialsToDeduct);

            // 7. 건설 프로젝트 문서 생성
            const projectId = uuidv4();
            const projectRef = db.collection('construction_projects').doc(projectId);
            const startTime = Date.now();
            const completionTime = new Date(startTime + duration * 60 * 1000);

            transaction.set(projectRef, {
                ownerId: uid,
                plotId,
                projectId,
                buildingId,
                buildingName: buildingInfo.name,
                contractor,
                constructionLevel,
                status: 'inprogress',
                startTime: new Date(startTime),
                completionTime,
                baseAestheticValue: aestheticValue,
                qualityBonus,
            });

            return { projectId, message: `'${buildingInfo.name}' 건설을 시작합니다!` };
        });

        return result;

    } catch (error) {
        console.error("Construction start failed:", error);
        if (error instanceof HttpsError) throw error;
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
