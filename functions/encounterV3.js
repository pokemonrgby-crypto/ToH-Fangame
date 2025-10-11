// /functions/encounterV3.js

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { FieldValue } = require('firebase-admin/firestore');

module.exports = (admin, { logger, GEMINI_API_KEY }) => {
    const db = admin.firestore();

    // AI 호출 헬퍼 함수
    async function callGeminiForComment(systemText, userText) {
        const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
        const apiKey = GEMINI_API_KEY.value();
        if (!apiKey) throw new HttpsError('internal', 'AI API 키가 설정되지 않았습니다.');
        
        const model = 'gemini-2.5-flash-lite';
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
        const text = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if(!text) throw new HttpsError('internal', 'Gemini 응답이 비어 있습니다.');
        try {
            // 더 안정적인 JSON 파싱 로직
            let clean = text.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '').trim();
            const firstBrace = clean.indexOf('{');
            const lastBrace = clean.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace > firstBrace) {
                clean = clean.slice(firstBrace, lastBrace + 1);
            }
            clean = clean.replace(/,\s*([}\]])/g, '$1');
            return JSON.parse(clean);
        } catch(e) {
            logger.error("callGeminiForComment JSON parse failed", { rawText: text, error: e.message });
            return { transformedComment: text };
        }
    }

    /**
     * 조우 로그에 리뷰(별점 및 댓글)를 한번에 제출
     */
    const submitEncounterReview = onCall({ region: 'us-central1', secrets: [GEMINI_API_KEY], cors: true }, async (req) => {
        const uid = req.auth?.uid;
        if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');

        const { logId, actingCharId, rawComment, ratings } = req.data;
        if (!logId || !actingCharId || !ratings || typeof ratings !== 'object' || Object.keys(ratings).length === 0) {
            throw new HttpsError('invalid-argument', '필수 정보(logId, actingCharId, ratings)가 올바르지 않습니다.');
        }

        const charSnap = await db.doc(`chars/${actingCharId}`).get();
        if (!charSnap.exists || charSnap.data().owner_uid !== uid) {
            throw new HttpsError('permission-denied', '자신의 캐릭터로만 리뷰를 작성할 수 있습니다.');
        }
        const charData = charSnap.data();
        
        let transformedComment = rawComment;
        let newCommentData = null;

        if (rawComment && typeof rawComment === 'string' && rawComment.trim().length > 0) {
            // [수정] AI에게 조우 로그 내용을 전달하기 위해 트랜잭션 외부에서 미리 문서를 가져옴
            const logSnapForPrompt = await db.doc(`encounter_logs/${logId}`).get();
            if (!logSnapForPrompt.exists) {
                throw new HttpsError('not-found', '댓글을 작성할 조우 로그를 찾을 수 없습니다.');
            }
            const logData = logSnapForPrompt.data();
            const encounterText = logData.text || "조우 상황을 요약할 수 없습니다.";

            const latestNarrative = (charData.narratives || []).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0]?.long || charData.summary;
            
            // [수정] 시스템 프롬프트 강화 및 조우 로그 내용 추가
            const systemPrompt = `당신은 주어진 상황(조우 로그)과 캐릭터의 서사를 기반으로 사용자의 댓글을 변환하는 AI입니다.
캐릭터의 성격과 말투, 톤을 완벽하게 파악하고 흉내내어, 마치 그 캐릭터가 직접 말하는 것처럼 댓글을 수정해야 합니다.

Your response MUST be a single, valid JSON object and nothing else.
Do NOT include markdown, explanations, or any characters outside of the JSON structure.

BAD EXAMPLE (extra characters):
\`\`\`json
{"transformedComment": "이런, 어이가 없군."}
\`\`\`
"}

GOOD EXAMPLE (valid JSON only):
{"transformedComment": "이런, 어이가 없군."}

이제 아래 조우 상황, 캐릭터 서사, 원본 댓글을 바탕으로, 댓글을 캐릭터의 목소리로 변환해주세요.`;
            
            const userPrompt = `조우 상황:\n"""\n${encounterText}\n"""\n\n캐릭터 서사:\n"""\n${latestNarrative}\n"""\n\n변환할 원본 댓글: "${rawComment}"`;
            
            const aiResult = await callGeminiForComment(systemPrompt, userPrompt);
            
            if (aiResult && aiResult.transformedComment) {
                transformedComment = aiResult.transformedComment;
            } else {
                transformedComment = rawComment; 
                logger.warn('AI comment transformation failed or returned invalid format. Using raw comment.', { logId, actingCharId, aiResponse: aiResult });
            }
        }

        // Firestore 트랜잭션
        return await db.runTransaction(async (tx) => {
            const today = new Date().toISOString().slice(0, 10);
            const ratingLimitDocRef = db.collection('users').doc(uid).collection('daily_limits').doc(today);
            const encounterLogRef = db.doc(`encounter_logs/${logId}`);
            
            const ratingCharIds = Object.keys(ratings);
            const ratingRefs = ratingCharIds.map(targetCharId => 
                db.collection('encounter_ratings').doc(`${logId}_${targetCharId}_${uid}`)
            );

            const docsToRead = [
                tx.get(ratingLimitDocRef),
                tx.get(encounterLogRef),
                ...ratingRefs.map(ref => tx.get(ref))
            ];
            const [limitSnap, logSnap, ...existingRatingSnaps] = await Promise.all(docsToRead);

            const ratingCount = limitSnap.exists ? (limitSnap.data().encounter_ratings || 0) : 0;
            if (ratingCount + ratingCharIds.length > 10) {
                throw new HttpsError('resource-exhausted', '하루에 10번까지만 평가할 수 있습니다.');
            }

            if (!logSnap.exists || logSnap.data().simulated) {
                throw new HttpsError('not-found', '평가할 수 없는 로그입니다.');
            }

            for (let i = 0; i < existingRatingSnaps.length; i++) {
                if (existingRatingSnaps[i].exists) {
                    const targetCharId = ratingCharIds[i];
                    throw new HttpsError('already-exists', `이미 이 캐릭터(${targetCharId})에게 별점을 주었습니다.`);
                }
            }

            ratingCharIds.forEach(targetCharId => {
                const rating = ratings[targetCharId];
                if (rating < 0.5 || rating > 5) {
                    throw new HttpsError('invalid-argument', '별점은 0.5점에서 5점 사이여야 합니다.');
                }
                const ratingRef = db.collection('encounter_ratings').doc(`${logId}_${targetCharId}_${uid}`);
                tx.set(ratingRef, { logId, raterUid: uid, targetCharId, rating, createdAt: FieldValue.serverTimestamp() });
                
                const charStatsRef = db.collection('char_encounter_stats').doc(targetCharId);
                tx.set(charStatsRef, { totalRating: FieldValue.increment(rating), ratingCount: FieldValue.increment(1) }, { merge: true });
            });
            
            tx.set(ratingLimitDocRef, { encounter_ratings: FieldValue.increment(ratingCharIds.length) }, { merge: true });

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
                newCommentData.id = commentRef.id;
            }
            
            return { ok: true, comment: newCommentData };
        });
    });

    /**
     * 조우 댓글 신고
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

    return { submitEncounterReview, reportEncounterComment };
};
