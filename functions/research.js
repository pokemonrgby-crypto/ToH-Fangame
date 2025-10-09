// /functions/research.js
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { FieldValue } = require('firebase-admin/firestore');
const admin = require('firebase-admin');
const db = admin.firestore();
const { v4: uuidv4 } = require('uuid');
const { researchTree } = require('./assets');
const { deductItemsFromInventory } = require('./utils');

/**
 * 클라이언트에 전체 연구 트리 데이터를 전송
 */
exports.getResearchTreeData = onCall({ region: 'us-central1' }, (req) => {
    const tree = researchTree();
    if (!tree) {
        throw new HttpsError('internal', '연구 트리 에셋을 불러올 수 없습니다.');
    }
    return { success: true, tree };
});


/**
 * 신규 연구 시작
 */
exports.startResearch = onCall({ region: 'us-central1' }, async (req) => {
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');

    const { projectId, teamCharacterIds, facilityBuildingId, plotId } = req.data;
    if (!projectId || !teamCharacterIds || teamCharacterIds.length === 0 || !facilityBuildingId || !plotId) {
        throw new HttpsError('invalid-argument', '필수 정보가 누락되었습니다.');
    }

    const allProjects = researchTree().projects;
    const projectData = allProjects[projectId];
    if (!projectData) throw new HttpsError('not-found', '해당 연구 프로젝트를 찾을 수 없습니다.');

    const researchRef = db.collection('active_researches').doc(uuidv4());

    try {
        await db.runTransaction(async (transaction) => {
            // 1. 선행 연구 조건 확인
            const knowledgeRef = db.collection('knowledge').doc(uid); // 연구는 유저 단위로 귀속
            const knowledgeDoc = await transaction.get(knowledgeRef);
            const userKnowledge = knowledgeDoc.exists ? knowledgeDoc.data() : {};
            
            for (const prereqId of projectData.prerequisites) {
                if (!userKnowledge[prereqId] || userKnowledge[prereqId].understanding < 100) {
                    throw new HttpsError('failed-precondition', `선행 연구 '${allProjects[prereqId]?.name || prereqId}'가 완료되지 않았습니다.`);
                }
            }
            
            // 2. 팀 스탯 조건 확인
            const teamStats = {};
            for (const charId of teamCharacterIds) {
                const charRef = db.collection('chars').doc(charId);
                const charDoc = await transaction.get(charRef);
                if (!charDoc.exists || charDoc.data().owner_uid !== uid) {
                    throw new HttpsError('permission-denied', `캐릭터(${charId}) 정보가 올바르지 않습니다.`);
                }
                // TODO: 캐릭터 스탯을 읽어와서 팀의 최고 스탯을 계산
            }
            // TODO: teamStats와 projectData.requiredStats 비교 로직 구현

            // 3. 필요 시설 확인
            const plotRef = db.collection('land_plots').doc(plotId);
            const plotDoc = await transaction.get(plotRef);
            if (!plotDoc.exists) throw new HttpsError('not-found', '부지 정보를 찾을 수 없습니다.');
            const building = (plotDoc.data().facilities || []).find(f => f.id === facilityBuildingId);
            if (!building || building.purpose !== projectData.requiredFacility) {
                 throw new HttpsError('failed-precondition', `연구에 필요한 시설('${projectData.requiredFacility}')이 아닙니다.`);
            }

            // 4. 필요 재료 차감
            if (projectData.requiredMaterials) {
                const materialsToDeduct = projectData.requiredMaterials.reduce((acc, mat) => {
                    acc[mat.itemId] = mat.quantity;
                    return acc;
                }, {});
                await deductItemsFromInventory(transaction, uid, materialsToDeduct);
            }

            // 5. 연구 프로젝트 문서 생성
            const startTime = Date.now();
            const firstStage = projectData.stages[0];
            
            transaction.set(researchRef, {
                ownerId: uid,
                projectId: projectId,
                team: teamCharacterIds,
                status: 'inprogress',
                currentStage: 0,
                stageProgress: 0, // 분 단위 진행도
                totalTimeForStage: firstStage.time,
                understanding: userKnowledge[projectId]?.understanding || 0,
                createdAt: new Date(startTime),
                lastUpdatedAt: new Date(startTime),
            });

            // TODO: 참여 캐릭터 상태를 'researching'으로 변경
        });

        return { success: true, message: `'${projectData.name}' 연구를 시작합니다.` };

    } catch (error) {
        console.error("Research start failed:", error);
        throw new HttpsError('internal', error.message || '연구 시작에 실패했습니다.');
    }
});

// 참고: progressResearch는 Cron Job으로 주기적으로 실행하는 것이 이상적입니다.
// 예시: 1분마다 모든 active_researches를 업데이트하는 스케줄 함수
// exports.progressAllResearches = onSchedule('every 1 minutes', async (context) => { ... });
