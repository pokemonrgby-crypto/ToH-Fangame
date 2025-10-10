// /functions/tasks.js (신규 파일)
const { onSchedule } = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');

/**
 * 건설 작업 완료 처리 헬퍼 함수
 * @param {FirebaseFirestore.Transaction} transaction - Firestore 트랜잭션
 * @param {string} taskId - 완료된 태스크 ID
 * @param {object} taskData - 완료된 태스크 데이터
 */
async function completeConstructionTask(transaction, taskId, taskData) {
    const db = getFirestore();
    const { ownerId, plotId, details, assignedCharacters, finalStats } = taskData;

    // 1. Plot 문서에 최종 건물(facility) 정보 추가
    const plotRef = db.collection('plots').doc(plotId);
    const buildingId = admin.firestore.FieldValue.serverTimestamp().toMillis().toString() + "_" + Math.random().toString(36).substring(2,9); // 더 안전한 ID 생성
    
    // construction.js의 상세한 데이터 구조를 반영
    const newBuilding = {
        id: buildingId,
        name: details.name,
        type: details.purposeId,
        style: details.styleId,
        area: details.area,
        floors: details.floors,
        rooms: details.rooms || [],
        mainMaterials: details.mainMaterialIds,
        subMaterials: details.subMaterialIds,
        ownerId: ownerId,
        completedAt: Timestamp.now(),
        managerCharId: null,
        stability: finalStats.baseStability || 100,
        aesthetic: finalStats.baseAesthetic || 50,
        grade: 'C', // TODO: 최종 등급 계산 로직
        collapseChance: 1.0,
        safetyLevel: '안전',
        profitability: 0,
        status: 'active',
    };
    transaction.update(plotRef, {
        facilities: FieldValue.arrayUnion(newBuilding),
        usedArea: FieldValue.increment(details.area)
    });

    // 2. 참여 캐릭터 상태 해제 및 경험치 부여
    if (assignedCharacters && assignedCharacters.length > 0) {
        for (const charId of assignedCharacters) {
            const charRef = db.collection('chars').doc(charId);
            const expGain = Math.ceil(taskData.requiredManHours / assignedCharacters.length / 10);
            transaction.update(charRef, {
                activeTaskId: FieldValue.delete(),
                status: 'idle',
                'skills.construction.exp': FieldValue.increment(expGain),
                'skills.art.exp': FieldValue.increment(Math.ceil(expGain / 5))
            });
        }
    }


    // 3. 퀘스트였다면 보상 지급 및 상태 변경
    const questQuery = await db.collection('quests').where('taskId', '==', taskId).limit(1).get();
    if (!questQuery.empty) {
        const questDoc = questQuery.docs[0];
        const questData = questDoc.data();
        transaction.update(questDoc.ref, { status: 'completed' });
        
        for (const participantId of questData.participants) {
            const charDoc = await transaction.get(db.collection('chars').doc(participantId));
            if (charDoc.exists) {
                const participantOwnerId = charDoc.data().owner_uid;
                const userRef = db.collection('users').doc(participantOwnerId);
                transaction.update(userRef, { coins: FieldValue.increment(questData.reward) });
            }
        }
    }

    // 4. 완료된 Task 문서 삭제
    transaction.delete(db.collection('tasks').doc(taskId));
}


/**
 * 1분마다 모든 진행중인 작업을 처리하는 스케줄링 함수
 */
exports.progressTasks = onSchedule({
    schedule: 'every 1 minutes',
    timeZone: 'Asia/Seoul',
    region: 'us-central1',
    memory: '512MiB',
}, async (event) => {
    const db = getFirestore();
    const tasksQuery = db.collection('tasks').where('status', '==', 'in_progress');
        
    const snapshot = await tasksQuery.get();
    if (snapshot.empty) {
        // console.log("No in-progress tasks to process.");
        return;
    }

    const promises = snapshot.docs.map(doc => {
        const task = doc.data();
        const taskId = doc.id;
        
        return db.runTransaction(async (transaction) => {
            const charIds = task.assignedCharacters || [];
            
            // NPC 노동력도 여기에 추가할 수 있습니다. (task.npcTeam 등)
            let totalPower = 0;
            if (charIds.length > 0) {
                const charRefs = charIds.map(id => db.collection('chars').doc(id));
                const charDocs = await transaction.getAll(...charRefs);
                for(const charDoc of charDocs) {
                    if(charDoc.exists) {
                        const skills = charDoc.data().skills || {};
                        const constructionLevel = skills.construction?.level || 1;
                        totalPower += 1 + (constructionLevel * 0.04); // 분당 작업량 (기존 construction.js 공식과 일치)
                    }
                }
            }
            
            if (totalPower === 0) return; // 작업자가 없으면 진행 불가

            const newProgress = (task.progress || 0) + totalPower;

            if (newProgress >= task.requiredManHours) {
                // 작업 완료
                if (task.type === 'construction') {
                    await completeConstructionTask(transaction, taskId, task);
                } // 여기에 'research' 등 다른 타입의 작업 완료 로직도 추가 가능
            } else {
                // 진척도 업데이트
                transaction.update(doc.ref, { progress: newProgress });
            }
        });
    });

    await Promise.all(promises);
    console.log(`Processed ${snapshot.size} tasks.`);
});
