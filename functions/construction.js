// /functions/construction.js

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const db = admin.firestore();
// 참고: character.js에서 getCharacter, updateCharacterStats를 가져오는 부분은
// character.js도 v2로 리팩토링해야 하므로 우선 여기서는 제거합니다.
// 필요한 로직은 직접 이 파일 내에서 구현하거나, character.js 리팩토링 후 가져와야 합니다.

exports.completeConstructionProject = onCall({ region: 'us-central1' }, async (req) => {
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');

    const { projectId } = req.data;
    if (!projectId) throw new HttpsError('invalid-argument', '프로젝트 ID가 필요합니다.');

    const projectRef = db.collection('construction_projects').doc(projectId);

    try {
        await db.runTransaction(async (transaction) => {
            const projectDoc = await transaction.get(projectRef);
            if (!projectDoc.exists) throw new HttpsError('not-found', '프로젝트를 찾을 수 없습니다.');

            const project = projectDoc.data();
            if (project.owner !== uid) throw new HttpsError('permission-denied', '프로젝트 소유주가 아닙니다.');

            // 여기에 프로젝트 완료 로직 구현 (예: 캐릭터 상태 변경, 부지 상태 변경 등)
            const characterRef = db.collection('characters').doc(project.assignedCharacterId);
            const plotRef = db.collection('plots').doc(project.plotId);

            transaction.update(projectRef, { status: 'completed', endTime: admin.firestore.FieldValue.serverTimestamp() });
            transaction.update(characterRef, { status: 'idle', currentProjectId: null });
            transaction.update(plotRef, { status: 'developed', currentProjectId: null });
        });
        return { success: true, message: '건설 프로젝트가 완료되었습니다.' };
    } catch (error) {
        console.error('Error completing construction project:', error);
        throw new HttpsError('internal', '프로젝트 완료 중 오류 발생', error.message);
    }
});

exports.acceptConstructionContract = onCall({ region: 'us-central1' }, async (req) => {
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');

    const { contractId, characterId } = req.data;
    if (!contractId || !characterId) throw new HttpsError('invalid-argument', '계약 ID와 캐릭터 ID가 필요합니다.');
    
    // 계약 수락 로직 구현
    // ...
    return { success: true, message: '건설 계약을 수락했습니다.' };
});

exports.cancelConstructionProject = onCall({ region: 'us-central1' }, async (req) => {
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');

    const { projectId } = req.data;
    if (!projectId) throw new HttpsError('invalid-argument', '프로젝트 ID가 필요합니다.');

    // 프로젝트 취소 로직 구현
    // ...
    return { success: true, message: '건설 프로젝트가 취소되었습니다.' };
});

exports.listConstructionContracts = onCall({ region: 'us-central1' }, async (req) => {
    try {
        const contractsSnapshot = await db.collection('construction_contracts').where('status', '==', 'open').get();
        const contracts = contractsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        return { contracts };
    } catch (error) {
        console.error('Error listing construction contracts:', error);
        throw new HttpsError('internal', '계약 목록을 불러오는 중 오류가 발생했습니다.');
    }
});
