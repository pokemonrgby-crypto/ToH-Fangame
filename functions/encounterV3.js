// /functions/encounterV3.js
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { FieldValue } = require('firebase-admin/firestore');

module.exports = (admin, { logger, GEMINI_API_KEY }) => {
    const db = admin.firestore();

    // AI 호출 헬퍼 함수
    async function callGeminiForComment(systemText, userText) {
        // ... (기존 Gemini 호출 로직과 유사)
        const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
        const apiKey = GEMINI_API_KEY.value();
        if (!apiKey) throw new HttpsError('internal', 'AI API 키가 설정되지 않았습니다.');
        
        const model = 'gemini-2.5-flash-lite';
        const url = `https://generativelace.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const body = {
            // ... (요청 본문 구성)
        };
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        // ... (응답 처리 로직)
        const json = await res.json();
        return json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    }

    /**
     * 조우 로그에 별점 부여
     */
    const rateEncounter = onCall({ region: 'us-central1' }, async (req) => {
        const uid = req.auth?.uid;
        if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');

        const { logId, targetCharId, rating } = req.data;
        if (!logId || !targetCharId || rating < 1 || rating > 5) {
            throw new HttpsError('invalid-argument', '필수 정보가 누락되었습니다.');
        }

        const today = new Date().toISOString().slice(0, 10);
        const ratingDocRef = db.collection('users').doc(uid).collection('daily_limits').doc(today);

        return await db.runTransaction(async (tx) => {
            const limitSnap = await tx.get(ratingDocRef);
            const ratingCount = limitSnap.exists ? (limitSnap.data().encounter_ratings || 0) : 0;

            if (ratingCount >= 10) {
                throw new HttpsError('resource-exhausted', '하루에 10번까지만 평가할 수 있습니다.');
            }

            const encounterLogRef = db.doc(`encounter_logs/${logId}`);
            const ratingRef = db.collection('encounter_ratings').doc(`${logId}_${uid}`);
            
            const logSnap = await tx.get(encounterLogRef);
            if (!logSnap.exists || logSnap.data().simulated) {
                throw new HttpsError('not-found', '평가할 수 없는 로그입니다.');
            }

            tx.set(ratingRef, {
                logId,
                raterUid: uid,
                targetCharId,
                rating,
                createdAt: FieldValue.serverTimestamp()
            });

            // 캐릭터의 평균 별점 업데이트 (집계)
            const charStatsRef = db.doc(`char_stats/${targetCharId}`);
            tx.set(charStatsRef, {
                encounter_rating_total: FieldValue.increment(rating),
                encounter_rating_count: FieldValue.increment(1)
            }, { merge: true });

            // 평가 횟수 업데이트
            tx.set(ratingDocRef, { encounter_ratings: FieldValue.increment(1) }, { merge: true });

            return { ok: true };
        });
    });

    /**
     * 조우 로그에 댓글 작성
     */
    const commentOnEncounter = onCall({ region: 'us-central1', secrets: [GEMINI_API_KEY] }, async (req) => {
        const uid = req.auth?.uid;
        if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');

        const { logId, actingCharId, rawComment } = req.data;
        if (!logId || !actingCharId || !rawComment) {
            throw new HttpsError('invalid-argument', '필수 정보가 누락되었습니다.');
        }

        // 캐릭터 정보와 최신 서사 가져오기
        const charSnap = await db.doc(`chars/${actingCharId}`).get();
        if (!charSnap.exists || charSnap.data().owner_uid !== uid) {
            throw new HttpsError('permission-denied', '자신의 캐릭터로만 댓글을 작성할 수 있습니다.');
        }
        const charData = charSnap.data();
        const latestNarrative = (charData.narratives || []).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0]?.long || charData.summary;

        // AI를 통해 댓글 변환
        const systemPrompt = "당신은 캐릭터의 서사를 바탕으로 댓글을 변환하는 AI입니다. 다음 캐릭터의 서사를 참고하여, 입력된 댓글을 캐릭터의 말투와 성격에 맞게 자연스럽게 변환해주세요. 결과는 변환된 댓글 텍스트만 포함해야 합니다.";
        const userPrompt = `캐릭터 서사: ${latestNarrative}\n\n변환할 댓글: "${rawComment}"`;
        
        const transformedComment = await callGeminiForComment(systemPrompt, userPrompt);

        // 댓글 저장
        const commentRef = db.collection('encounter_comments').doc();
        await commentRef.set({
            logId,
            authorUid: uid,
            authorCharId: actingCharId,
            authorCharName: charData.name,
            rawComment,
            transformedComment,
            createdAt: FieldValue.serverTimestamp(),
            reports: 0
        });

        return { ok: true, commentId: commentRef.id, transformedComment };
    });

    /**
     * 조우 댓글 신고
     */
    const reportEncounterComment = onCall({ region: 'us-central1' }, async (req) => {
        const uid = req.auth?.uid;
        if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');

        const { commentId, reason } = req.data;
        if (!commentId || !reason) {
            throw new HttpsError('invalid-argument', '필수 정보가 누락되었습니다.');
        }

        const commentRef = db.doc(`encounter_comments/${commentId}`);
        const reportRef = db.collection('encounter_reports').doc();

        await db.runTransaction(async (tx) => {
            const commentSnap = await tx.get(commentRef);
            if (!commentSnap.exists) {
                throw new HttpsError('not-found', '신고할 댓글이 없습니다.');
            }
            const commentData = commentSnap.data();

            tx.set(reportRef, {
                commentId,
                reason,
                reporterUid: uid,
                reportedUid: commentData.authorUid,
                createdAt: FieldValue.serverTimestamp()
            });

            tx.update(commentRef, { reports: FieldValue.increment(1) });
        });

        return { ok: true };
    });

    return { rateEncounter, commentOnEncounter, reportEncounterComment };
};
