// /functions/company.js

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const db = admin.firestore();

// v2 Cloud Function: startConstructionProject
exports.startConstructionProject = onCall({ region: 'us-central1' }, async (req) => {
    const uid = req.auth?.uid;
    if (!uid) {
        throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
    }

    const { plotId, area, materials, buildType, assignedCharacterId, npcId } = req.data;
    if (!plotId || !area || !materials || !buildType || !assignedCharacterId) {
        throw new HttpsError('invalid-argument', '필수 인자가 누락되었습니다.');
    }

    const userRef = db.collection('users').doc(uid);
    const plotRef = db.collection('plots').doc(plotId);
    const characterRef = db.collection('characters').doc(assignedCharacterId);

    try {
        const projectRef = await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userRef);
            const plotDoc = await transaction.get(plotRef);
            const characterDoc = await transaction.get(characterRef);

            if (!userDoc.exists) throw new HttpsError('not-found', '사용자를 찾을 수 없습니다.');
            if (!plotDoc.exists) throw new HttpsError('not-found', '부지를 찾을 수 없습니다.');
            if (!characterDoc.exists) throw new HttpsError('not-found', '캐릭터를 찾을 수 없습니다.');

            if (plotDoc.data().owner !== uid) throw new HttpsError('permission-denied', '부지 소유주가 아닙니다.');
            if (characterDoc.data().owner !== uid) throw new HttpsError('permission-denied', '캐릭터 소유주가 아닙니다.');
            if (characterDoc.data().status !== 'idle') throw new HttpsError('failed-precondition', '캐릭터가 다른 작업을 수행 중입니다.');

            const projectData = {
                plotId,
                area,
                materials,
                buildType,
                assignedCharacterId,
                npcId,
                owner: uid,
                status: 'in-progress',
                startTime: admin.firestore.FieldValue.serverTimestamp(),
            };

            const newProjectRef = db.collection('construction_projects').doc();
            transaction.set(newProjectRef, projectData);
            transaction.update(plotRef, { status: 'under-construction', currentProjectId: newProjectRef.id });
            transaction.update(characterRef, { status: 'constructing', currentProjectId: newProjectRef.id });

            return newProjectRef;
        });

        return { projectId: projectRef.id, message: '건설 프로젝트가 시작되었습니다.' };
    } catch (error) {
        console.error("Error starting construction project: ", error);
        throw new HttpsError('internal', '건설 프로젝트 시작 중 오류가 발생했습니다.', error);
    }
});

// v2 Cloud Function: postConstructionContract
exports.postConstructionContract = onCall({ region: 'us-central1' }, async (req) => {
    const uid = req.auth?.uid;
    if (!uid) {
        throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
    }

    const { plotId, area, materials, payment, minStat } = req.data;

    if (!plotId || !area || !materials || !payment || !minStat) {
        throw new HttpsError('invalid-argument', '필수 인자가 누락되었습니다.');
    }

    try {
        const contractData = {
            plotId,
            area,
            materials,
            payment,
            minStat,
            postedBy: uid,
            status: 'open',
            postedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        const contractRef = await db.collection('construction_contracts').add(contractData);
        return { contractId: contractRef.id, message: '건설 계약이 게시되었습니다.' };
    } catch (error) {
        console.error("Error posting construction contract: ", error);
        throw new HttpsError('internal', '건설 계약 게시 중 오류가 발생했습니다.', error);
    }
});
