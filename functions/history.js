// functions/history.js (신규 파일)
module.exports = (admin, { onCall, HttpsError }) => {
    const db = admin.firestore();
    const { Timestamp } = admin.firestore;

    // [수정] 숫자, Timestamp 객체, ISO 문자열, 레거시 객체를 모두 밀리초로 변환하는 헬퍼 함수
    const toMillis = (ts) => {
        if (!ts) return 0;
        if (typeof ts === 'number') return ts; // 이미 숫자 형식인 경우
        if (typeof ts.toMillis === 'function') return ts.toMillis(); // Timestamp 객체인 경우
        if (typeof ts === 'string') { // ISO 날짜 문자열인 경우
            const d = new Date(ts);
            if (!isNaN(d)) return d.getTime();
        }
        // 레거시 Timestamp 객체 형식일 경우 (_seconds, _nanoseconds)
        if (typeof ts === 'object' && ts._seconds !== undefined && ts._nanoseconds !== undefined) {
            return ts._seconds * 1000 + ts._nanoseconds / 1000000;
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
            // [수정] 커서가 숫자(밀리초)이므로 Timestamp 객체로 변환하여 쿼리
            const startAfterTimestamp = Timestamp.fromMillis(Number(cursor));
            queryA = queryA.startAfter(startAfterTimestamp);
            queryB = queryB.startAfter(startAfterTimestamp);
        }

        const [snapA, snapB] = await Promise.all([queryA.get(), queryB.get()]);

        const results = [];
        const seenIds = new Set(); // 중복 제거용 Set

        // [수정] 데이터를 가져올 때 endedAt을 밀리초로 변환하여 저장
        snapA.forEach(doc => {
            if (!seenIds.has(doc.id)) {
                results.push({ id: doc.id, ...doc.data(), endedAtMillis: toMillis(doc.data().endedAt) });
                seenIds.add(doc.id);
            }
        });
        snapB.forEach(doc => {
            if (!seenIds.has(doc.id)) {
                results.push({ id: doc.id, ...doc.data(), endedAtMillis: toMillis(doc.data().endedAt) });
                seenIds.add(doc.id);
            }
        });

        // [수정] 밀리초 기준으로 완벽하게 정렬
        results.sort((a, b) => b.endedAtMillis - a.endedAtMillis);
        
        const finalResults = results.slice(0, limitNum);

        let nextCursor = null;
        // [수정] 불러온 전체 결과(results)가 요청한 limit보다 많아야 다음 페이지가 존재함
        if (results.length > limitNum) {
            const lastItem = finalResults[finalResults.length - 1];
            // [수정] 다음 커서도 밀리초 값으로 설정
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
