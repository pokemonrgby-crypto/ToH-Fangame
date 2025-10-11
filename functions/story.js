// functions/story.js

module.exports = (admin, { onCall, HttpsError, logger, GEMINI_API_KEY }) => {
    const db = admin.firestore();

    /**
     * 사용자가 스토리 생성 기능에 접근할 수 있는지 확인합니다.
     * 관리자 또는 베타테스터일 경우에만 접근을 허용합니다.
     * @param {string} uid - 확인할 사용자 UID
     * @returns {Promise<boolean>} - 접근 가능 여부
     */
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

        const { charId, keywords } = req.data;
        if (!charId || !keywords) {
            throw new HttpsError('invalid-argument', '캐릭터 ID와 키워드는 필수입니다.');
        }

        // TODO: Gemini API를 호출하여 스토리 스케치를 생성하는 로직 구현
        // 1. charId로 캐릭터의 최신 서사 정보를 가져옵니다.
        // 2. 키워드와 서사 정보를 조합하여 AI 프롬프트를 만듭니다.
        // 3. AI를 호출하고 결과를 반환합니다.

        // 임시 더미 데이터 반환
        return {
            ok: true,
            sketch: `"${keywords}" 키워드와 관련된 이야기가 곧 시작됩니다...\n\n(AI 생성 로직 추가 예정)`
        };
    });


    return {
        generateStorySketch,
        // 나중에 추가될 함수들...
    };
};
