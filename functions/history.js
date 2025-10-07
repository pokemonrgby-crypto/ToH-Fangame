// functions/history.js (신규 파일)
module.exports = (admin, { onCall, HttpsError }) => {
    const db = admin.firestore();
    const { Timestamp } = admin.firestore;

    // [추가] 숫자와 Timestamp 객체, ISO 문자열을 모두 밀리초로 변환하는 헬퍼 함수
    const toMillis = (ts) => {
        if (!ts) return 0;
        if (typeof ts === 'number') return ts; // 이미 숫자 형식인 경우
        if (typeof ts.toMillis === 'function') return ts.toMillis(); // Timestamp 객체인 경우
        if (typeof ts === 'string') { // ISO 날짜 문자열인 경우
            const d = new Date(ts);
            if (!isNaN(d)) return d.getTime();
        }
        // 레거시 Timestamp 객체 형식일 경우
        if (typeof ts === 'object' && ts._seconds !== undefined) {
            return ts._seconds * 1000 + (ts._nanoseconds || 0) / 1000000;
        }
        return 0;
    };

    const getUserBattleHistory = onCall({ region: 'us-central1' }, async (req) => {
        const uid = req.auth?.uid;
        if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');

        const { charId, limit = 15, cursor } = req.data;
        if (!charId) throw new HttpsError('invalid-argument', 'charId가 필요합니다.');

        const charRef = `chars/${charId}`;
        const BATTLE_LOGS = db.collection('battle_logs');
        const limitNum = Math.max(1, Math.min(30, Number(limit)));

        let queryA = BATTLE_LOGS.where('attacker_char', '==', charRef).orderBy('endedAt', 'desc').limit(limitNum);
        let queryB = BATTLE_LOGS.where('defender_char', '==', charRef).orderBy('endedAt', 'desc').limit(limitNum);

        if (cursor) {
            const startAfterTimestamp = Timestamp.fromMillis(Number(cursor));
            queryA = queryA.startAfter(startAfterTimestamp);
            queryB = queryB.startAfter(startAfterTimestamp);
        }

        const [snapA, snapB] = await Promise.all([queryA.get(), queryB.get()]);

        const results = [];
        snapA.forEach(doc => results.push({ id: doc.id, ...doc.data(), endedAtMillis: toMillis(doc.data().endedAt) }));
        snapB.forEach(doc => {
            // 중복 방지 (이론적으로는 발생하지 않음)
            if (!results.some(r => r.id === doc.id)) {
                results.push({ id: doc.id, ...doc.data(), endedAtMillis: toMillis(doc.data().endedAt) });
            }
        });
        
        // endedAtMillis 기준으로 정확하게 정렬
        results.sort((a, b) => b.endedAtMillis - a.endedAtMillis);
        
        const finalResults = results.slice(0, limitNum);

        let nextCursor = null;
        // 불러온 데이터(results)가 반환할 데이터(finalResults)보다 많으면 다음 페이지가 있다는 의미
        if (results.length > limitNum) {
            const lastItem = finalResults[finalResults.length - 1];
            nextCursor = lastItem.endedAtMillis ?? null;
        }

        return {
            ok: true,
            logs: finalResults,
            nextCursor,
        };
    });

    return { getUserBattleHistory };
};
