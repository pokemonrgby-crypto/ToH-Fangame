// /functions/tasks.js
const functions = require('firebase-functions');
const admin = require('firebase-admin');

/**
 * 1분마다 실행되는 스케줄 함수. 모든 활성 작업을 처리합니다.
 */
exports.processTasks = functions.pubsub.schedule('every 1 minutes').onRun(async (context) => {
    const now = admin.firestore.Timestamp.now();
    const tasksRef = admin.firestore().collection('tasks');
    const activeTasksSnapshot = await tasksRef.where('status', '==', 'active').get();

    if (activeTasksSnapshot.empty) {
        console.log('No active tasks to process.');
        return null;
    }

    const promises = [];
    activeTasksSnapshot.forEach(doc => {
        const task = doc.data();
        if (task.completedAt && now.seconds >= task.completedAt.seconds) {
            promises.push(completeTask(doc.id, task));
        }
    });

    await Promise.all(promises);
    return null;
});

/**
 * 작업을 완료 처리하는 내부 함수
 * @param {string} taskId - 완료할 작업의 ID
 * @param {object} task - 작업 데이터
 */
async function completeTask(taskId, task) {
    const db = admin.firestore();
    const batch = db.batch();
    const taskRef = db.collection('tasks').doc(taskId);

    // 작업 유형별 완료 로직
    if (task.type === 'construction' && task.details) {
        const plotRef = db.collection('land_plots').doc(task.plotId);
        const newBuilding = task.details; // 건설 시작 시점에 계산된 건물 데이터
        newBuilding.id = `building_${Date.now()}`;
        newBuilding.completedAt = admin.firestore.FieldValue.serverTimestamp();

        batch.update(plotRef, {
            facilities: admin.firestore.FieldValue.arrayUnion(newBuilding)
        });
    }
    // 여기에 'farming' 등 다른 작업 완료 로직 추가 가능

    // 참여자들의 activeTaskId 해제
    if (task.participants && task.participants.length > 0) {
        task.participants.forEach(charId => {
            const charRef = db.collection('chars').doc(charId);
            batch.update(charRef, { activeTaskId: null });
        });
    }

    // 작업 문서 상태 업데이트
    batch.update(taskRef, { status: 'completed' });
    console.log(`Task ${taskId} completed successfully.`);
    return batch.commit();
}
