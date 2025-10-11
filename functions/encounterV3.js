// /functions/encounterV3.js

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { FieldValue } = require('firebase-admin/firestore');

module.exports = (admin, { logger, GEMINI_API_KEY }) => {
    const db = admin.firestore();

    // AI 호출 헬퍼 함수 (변경 없음)
    async function callGeminiForComment(systemText, userText) {
        const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
        const apiKey = GEMINI_API_KEY.value();
        if (!apiKey) throw new HttpsError('internal', 'AI API 키가 설정되지 않았습니다.');
        
        const model = 'gemini-2.5-flash-lite'; // 최신 모델로 변경 권장 (또는 기존 모델 사용)
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const body = {
            systemInstruction: { parts: [{ text: systemText }] },
            contents: [{ role: 'user', parts: [{ text: userText }] }],
            generationConfig: {
                temperature: 0.8,
                maxOutputTokens: 2048,
                responseMimeType: "application/json",
            }
        };

        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if(!res.ok){
            const txt = await res.text().catch(()=> '');
            throw new HttpsError('internal', `Gemini API 호출 실패: ${res.status} ${txt}`);
        }
        const json = await res.json().catch(()=>null);
        const text = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if(!text) throw new HttpsError('internal', 'Gemini 응답이 비어 있습니다.');
        try {
            return JSON.parse(text);
        } catch(e) {
            // AI가 JSON 형식이 아닌 일반 텍스트만 반환한 경우, 그대로 사용
            return { transformedComment: text.replace(/["']/g, '') };
        }
    }

    /**
     * 조우 로그에 리뷰(별점 및 댓글)를 한번에 제출
     */
    const submitEncounterReview = onCall({ region: 'us-central1', secrets: [GEMINI_API_KEY], cors: true }, async (req) => {
        const uid = req.auth?.uid;
        if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');

        const { logId, actingCharId, rawComment, ratings } = req.data;
        // rawComment는 선택사항일 수 있으므로 유효성 검사에서 제외하고, ratings는 필수
        if (!logId || !actingCharId || !ratings || typeof ratings !== 'object' || Object.keys(ratings).length === 0) {
            throw new HttpsError('invalid-argument', '필수 정보(logId, actingCharId, ratings)가 올바르지 않습니다.');
        }

        const charSnap = await db.doc(`chars/${actingCharId}`).get();
        if (!charSnap.exists || charSnap.data().owner_uid !== uid) {
            throw new HttpsError('permission-denied', '자신의 캐릭터로만 리뷰를 작성할 수 있습니다.');
        }
        const charData = charSnap.data();
        
        let transformedComment = rawComment; // 기본값은 원본 댓글
        let newCommentData = null; // 댓글 데이터를 담을 변수

        // 댓글이 있는 경우에만 AI 호출
        if (rawComment && typeof rawComment === 'string' && rawComment.trim().length > 0) {
            const latestNarrative = (charData.narratives || []).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0]?.long || charData.summary;
            const systemPrompt = `You are an AI that transforms comments based on a character's narrative. Your response MUST be a JSON object of the format: {"transformedComment": "your_transformed_comment_text"}. Do not include any other text or markdown. Based on the character's narrative, rewrite the user's raw comment to match the character's personality and tone.`;
            const userPrompt = `Character Narrative: ${latestNarrative}\n\nRaw Comment to Transform: "${rawComment}"`;
            
            const aiResult = await callGeminiForComment(systemPrompt, userPrompt);
            transformedComment = aiResult.transformedComment;
        }

        // Firestore 트랜잭션으로 댓글과 별점 동시 처리
        return await db.runTransaction(async (tx) => {
            const today = new Date().toISOString().slice(0, 10);
            const ratingLimitDocRef = db.collection('users').doc(uid).collection('daily_limits').doc(today);
            const limitSnap = await tx.get(ratingLimitDocRef);
            const ratingCount = limitSnap.exists ? (limitSnap.data().encounter_ratings || 0) : 0;

            if (ratingCount + Object.keys(ratings).length > 10) {
                throw new HttpsError('resource-exhausted', '하루에 10번까지만 평가할 수 있습니다.');
            }

            const encounterLogRef = db.doc(`encounter_logs/${logId}`);
            const logSnap = await tx.get(encounterLogRef);
            if (!logSnap.exists || logSnap.data().simulated) {
                throw new HttpsError('not-found', '평가할 수 없는 로그입니다.');
            }

            // 별점 처리
            for (const targetCharId in ratings) {
                const rating = ratings[targetCharId];
                if (rating < 0.5 || rating > 5) {
                    throw new HttpsError('invalid-argument', '별점은 0.5점에서 5점 사이여야 합니다.');
                }

                const ratingRef = db.collection('encounter_ratings').doc(`${logId}_${targetCharId}_${uid}`);
                const existingRatingSnap = await tx.get(ratingRef);
                if (existingRatingSnap.exists) {
                    // 이미 별점을 준 경우, 이번 요청에서는 건너뛰도록 처리하거나 에러를 발생시킬 수 있습니다.
                    // 여기서는 에러를 발생시킵니다.
                    throw new HttpsError('already-exists', `이미 이 캐릭터(${targetCharId})에게 별점을 주었습니다.`);
                }

                tx.set(ratingRef, { logId, raterUid: uid, targetCharId, rating, createdAt: FieldValue.serverTimestamp() });
                const charStatsRef = db.collection('char_encounter_stats').doc(targetCharId);
                tx.set(charStatsRef, { totalRating: FieldValue.increment(rating), ratingCount: FieldValue.increment(1) }, { merge: true });
            }
            
            tx.set(ratingLimitDocRef, { encounter_ratings: FieldValue.increment(Object.keys(ratings).length) }, { merge: true });

            // 댓글 처리 (댓글 내용이 있을 경우에만)
            if (rawComment && typeof rawComment === 'string' && rawComment.trim().length > 0) {
                const commentRef = db.collection('encounter_logs').doc(logId).collection('comments').doc();
                newCommentData = {
                    uid: uid,
                    authorCharId: actingCharId,
                    displayName: charData.name,
                    photoURL: charData.thumb_url || null,
                    text: transformedComment,
                    rawText: rawComment,
                    createdAt: FieldValue.serverTimestamp(),
                    reports: 0
                };
                tx.set(commentRef, newCommentData);
                // 클라이언트에서 즉시 UI에 반영할 수 있도록 ID를 추가해서 전달
                newCommentData.id = commentRef.id;
            }
            
            return { ok: true, comment: newCommentData }; // 댓글이 없으면 comment는 null
        });
    });

    /**
     * 조우 댓글 신고 (변경 없음)
     */
    const reportEncounterComment = onCall({ region: 'us-central1' }, async (req) => {
        const uid = req.auth?.uid;
        if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');

        const { logId, commentId, reason } = req.data;
        if (!logId || !commentId || !reason) {
            throw new HttpsError('invalid-argument', '필수 정보가 누락되었습니다.');
        }

        const commentRef = db.doc(`encounter_logs/${logId}/comments/${commentId}`);
        const reportRef = db.collection('encounter_reports').doc();

        await db.runTransaction(async (tx) => {
            const commentSnap = await tx.get(commentRef);
            if (!commentSnap.exists) {
                throw new HttpsError('not-found', '신고할 댓글이 없습니다.');
            }
            const commentData = commentSnap.data();

            tx.set(reportRef, {
                logId,
                commentId,
                reason,
                reporterUid: uid,
                reportedUid: commentData.uid,
                reportedCharId: commentData.authorCharId,
                createdAt: FieldValue.serverTimestamp()
            });

            tx.update(commentRef, { reports: FieldValue.increment(1) });
        });

        return { ok: true, message: '신고가 접수되었습니다.' };
    });

    // submitEncounterReview 함수를 포함하여 export 합니다.
    return { submitEncounterReview, reportEncounterComment };
};
