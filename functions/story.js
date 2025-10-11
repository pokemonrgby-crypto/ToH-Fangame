// functions/story.js

// [추가] Firestore 타임스탬프 가져오기
const { Timestamp } = require('firebase-admin/firestore');

module.exports = (admin, { onCall, HttpsError, logger, GEMINI_API_KEY }) => {
    const db = admin.firestore();

    // ... (hasStoryAccess 함수는 이전과 동일)
    async function hasStoryAccess(uid) {
        if (!uid) return false;
        try {
            const [adminSnap, betaSnap] = await Promise.all([
                db.doc('configs/admins').get(),
                db.doc('configs/betatesters').get()
            ]);

            const adminConfig = adminSnap.exists ? adminSnap.data() : {};
            const betaConfig = betaSnap.exists ? betaSnap.data() : {};

            const allowUids = new Set([
                ...(adminConfig.allow || []),
                ...(betaConfig.allow || [])
            ]);

            if (allowUids.has(uid)) return true;

            const user = await admin.auth().getUser(uid);
            const userEmail = user.email;
            if (!userEmail) return false;

            const allowEmails = new Set([
                ...(adminConfig.allowEmails || []),
                ...(betaConfig.allowEmails || [])
            ]);

            return allowEmails.has(userEmail);

        } catch (error) {
            logger.error(`Error checking story access for UID: ${uid}`, error);
            return false;
        }
    }


    /**
     * 스토리 초안(스케치)을 생성합니다.
     */
    const generateStorySketch = onCall({ region: 'us-central1', secrets: [GEMINI_API_KEY] }, async (req) => {
        const uid = req.auth?.uid;
        if (!await hasStoryAccess(uid)) {
            throw new HttpsError('permission-denied', '이 기능에 접근할 권한이 없습니다.');
        }

        const userRef = db.doc(`users/${uid}`);
        const userDoc = await userRef.get();
        const userData = userDoc.data() || {};
        
        // 1분 쿨타임 체크
        const now = Timestamp.now();
        const lastSketchTime = userData.lastStorySketchTime;
        if (lastSketchTime && now.seconds - lastSketchTime.seconds < 60) {
            throw new HttpsError('resource-exhausted', `잠시 후 다시 시도해주세요. (${60 - (now.seconds - lastSketchTime.seconds)}초 남음)`);
        }

        // 이미 스토리가 진행중인지 확인
        if (userData.storyInProgress) {
            throw new HttpsError('failed-precondition', `이미 진행 중인 이야기("${userData.storyInProgress}")가 있습니다.`);
        }

        const { charId, keywords, worldId } = req.data;
        if (!charId || !keywords || !worldId) {
            throw new HttpsError('invalid-argument', '캐릭터, 키워드, 세계관 정보는 필수입니다.');
        }

        // 쿨타임 기록 업데이트
        await userRef.update({ lastStorySketchTime: now });
        
        // TODO: Gemini API를 호출하여 스토리 스케치를 생성하는 로직 구현
        // 1. charId로 캐릭터의 최신 서사 정보를 가져옵니다.
        // 2. keywords, worldId와 서사 정보를 조합하여 AI 프롬프트를 만듭니다.
        // 3. AI를 호출하고 결과를 반환합니다.

        // 임시 더미 데이터 반환
        return {
            ok: true,
            sketch: `세계관 [${worldId}]에서 "${keywords}" 키워드와 관련된 이야기가 곧 시작됩니다...\n\n(AI 생성 로직 추가 예정)`
        };
    });


    /**
     * 새로운 스토리를 시작하고 문서를 생성합니다.
     */
    const startStory = onCall({ region: 'us-central1' }, async (req) => {
        const uid = req.auth?.uid;
        if (!await hasStoryAccess(uid)) {
            throw new HttpsError('permission-denied', '이 기능에 접근할 권한이 없습니다.');
        }

        const { charId, worldId, initialSketch } = req.data;
        if (!charId || !worldId || !initialSketch) {
            throw new HttpsError('invalid-argument', '캐릭터, 세계관, 초기 스케치 정보는 필수입니다.');
        }

        const userRef = db.doc(`users/${uid}`);
        const storyRef = db.doc(`stories/${charId}`);

        return db.runTransaction(async (tx) => {
            const userDoc = await tx.get(userRef);
            const storyDoc = await tx.get(storyRef);
            const userData = userDoc.data() || {};

            const now = Timestamp.now();
            
            // 7일 쿨타임 체크
            const lastStoryStartTime = userData.lastStoryStartTime;
            if (lastStoryStartTime && now.seconds - lastStoryStartTime.seconds < 7 * 24 * 60 * 60) {
                throw new HttpsError('resource-exhausted', '새 이야기는 7일에 한 번만 시작할 수 있습니다.');
            }

            // 이미 진행중인 스토리가 있는지 다시 한번 확인
            if (userData.storyInProgress) {
                throw new HttpsError('failed-precondition', `이미 진행 중인 이야기("${userData.storyInProgress}")가 있습니다.`);
            }
            
            // 해당 캐릭터로 생성된 스토리가 이미 있는지 확인 (중복 방지)
            if (storyDoc.exists) {
                throw new HttpsError('already-exists', '이 캐릭터는 이미 생성된 이야기가 있습니다.');
            }
            
            // 1. 유저 문서 업데이트
            tx.update(userRef, {
                storyInProgress: charId,
                lastStoryStartTime: now
            });
            
            // 2. 새로운 스토리 문서 생성
            tx.set(storyRef, {
                owner: uid,
                charId: charId,
                worldId: worldId,
                createdAt: now,
                status: 'ongoing', // 진행중
                narrative: [
                    { type: 'sketch', content: initialSketch, timestamp: now }
                ]
            });

            return { ok: true, message: '새로운 이야기가 시작되었습니다!' };
        });
    });

    return {
        generateStorySketch,
        startStory,
        // 나중에 추가될 함수들...
    };
};
