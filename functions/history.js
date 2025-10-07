// functions/history.js (신규 파일)
module.exports = (admin, { onCall, HttpsError }) => {
    const db = admin.firestore();
    const { Timestamp } = admin.firestore;

    const getUserBattleHistory = onCall({ region: 'us-central1' }, async (req) => {
        const uid = req.auth?.uid;
        if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');

        const { charId, limit = 15, cursor } = req.data;
        if (!charId) throw new HttpsError('invalid-argument', 'charId가 필요합니다.');

        const charRef = `chars/${charId}`;
        const BATTLE_LOGS = db.collection('battle_logs');
        const limitNum = Math.max(1, Math.min(30, Number(limit)));

        // Firestore는 OR 쿼리를 지원하지 않으므로, 두 개의 쿼리를 병렬로 실행합니다.
        let queryA = BATTLE_LOGS.where('attacker_char', '==', charRef).orderBy('endedAt', 'desc').limit(limitNum);
        let queryB = BATTLE_LOGS.where('defender_char', '==', charRef).orderBy('endedAt', 'desc').limit(limitNum);

        if (cursor) {
            // 커서(마지막으로 가져온 항목의 타임스탬프)가 있으면 그 지점부터 가져옵니다.
            const startAfterTimestamp = Timestamp.fromMillis(Number(cursor));
            queryA = queryA.startAfter(startAfterTimestamp);
            queryB = queryB.startAfter(startAfterTimestamp);
        }

        const [snapA, snapB] = await Promise.all([queryA.get(), queryB.get()]);

        const results = [];
        snapA.forEach(doc => results.push({ id: doc.id, ...doc.data() }));
        snapB.forEach(doc => results.push({ id: doc.id, ...doc.data() }));

        // 서버에서 두 결과를 합친 후 시간순으로 완벽하게 정렬합니다.
        results.sort((a, b) => (b.endedAt?.toMillis?.() ?? 0) - (a.endedAt?.toMillis?.() ?? 0));
        
        // 요청된 개수(limit)만큼만 잘라서 클라이언트에 반환합니다.
        const finalResults = results.slice(0, limitNum);

        // 다음 페이지를 요청할 때 사용할 커서를 생성합니다.
        let nextCursor = null;
        if (finalResults.length === limitNum) {
            const lastItem = finalResults[finalResults.length - 1];
            nextCursor = lastItem.endedAt?.toMillis?.() ?? null;
        }

        return {
            ok: true,
            logs: finalResults,
            nextCursor,
        };
    });

    return { getUserBattleHistory };
};
