// functions/story.js

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { Timestamp } = require('firebase-admin/firestore');
const { logger } = require('firebase-functions');

// Gemini API 호출을 위한 헬퍼 함수
async function callGemini(apiKey, model, systemText, userText) {
    const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const body = {
      systemInstruction: { role: 'system', parts: [{ text: systemText }] },
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      generationConfig: {
        temperature: 0.9,
        maxOutputTokens: 2048,
        // JSON 응답을 강제하지 않고, 텍스트로 자유롭게 서술하도록 설정
      }
    };
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) {
        const txt = await res.text();
        throw new HttpsError('internal', `Gemini API Error (${res.status}): ${txt}`);
    }
    const json = await res.json();
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) throw new HttpsError('internal', 'Gemini response was empty.');
    return text;
}


module.exports = (admin, { GEMINI_API_KEY }) => {
    const db = admin.firestore();

    /**
     * 유저가 스토리 기능에 접근할 수 있는지 확인합니다. (어드민 또는 베타테스터)
     * @param {string} uid - 확인할 사용자 UID
     * @returns {Promise<boolean>} 접근 가능 여부
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

        const userRef = db.doc(`users/${uid}`);
        const userDoc = await userRef.get();
        const userData = userDoc.data() || {};
        
        const now = Timestamp.now();
        const lastSketchTime = userData.lastStorySketchTime;
        if (lastSketchTime && now.seconds - lastSketchTime.seconds < 15) { // 쿨타임 15초
            throw new HttpsError('resource-exhausted', `잠시 후 다시 시도해주세요. (${15 - (now.seconds - lastSketchTime.seconds)}초 남음)`);
        }

        if (userData.storyInProgress) {
            throw new HttpsError('failed-precondition', `이미 진행 중인 이야기("${userData.storyInProgress}")가 있습니다.`);
        }

        const { charId, keywords, worldId } = req.data;
        if (!charId || !keywords || !worldId) {
            throw new HttpsError('invalid-argument', '캐릭터, 키워드, 세계관 정보는 필수입니다.');
        }
        
        await userRef.set({ lastStorySketchTime: now }, { merge: true });

        // --- Gemini API 호출 로직 ---
        try {
            // 1. 캐릭터 및 세계관 정보 가져오기
            const charSnap = await db.doc(`chars/${charId}`).get();
            if (!charSnap.exists) throw new HttpsError('not-found', '캐릭터를 찾을 수 없습니다.');
            const charData = charSnap.data();

            const worldsSnap = await db.doc('configs/worlds').get();
            const worldData = (worldsSnap.data()?.worlds || []).find(w => w.id === worldId);
            if (!worldData) throw new HttpsError('not-found', '세계관 정보를 찾을 수 없습니다.');

            // 2. 최신 서사 추출
            const latestNarrative = (charData.narratives || [])
                .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0]?.long 
                || charData.summary 
                || '새롭게 시작하는 캐릭터';

            // 3. AI 프롬프트 구성
            const systemPrompt = `당신은 주어진 캐릭터와 세계관, 핵심 키워드를 바탕으로 흥미로운 이야기의 도입부(프롤로그)를 생성하는 전문 스토리 작가입니다. 웹소설처럼 독자의 흥미를 유발할 수 있는 흡입력 있는 문체로 3~5문단의 짧은 글을 작성해주세요.`;
            
            const userPrompt = `
                ## 세계관 설정
                - 이름: ${worldData.name}
                - 소개: ${worldData.intro}
                - 상세: ${worldData.detail?.lore_long || worldData.detail?.lore}

                ## 캐릭터 정보
                - 이름: ${charData.name}
                - 배경 서사: ${latestNarrative}

                ## 이야기 핵심 키워드
                ${keywords}

                ## 지시사항
                위 정보를 바탕으로, "${charData.name}" 캐릭터가 주인공인 이야기의 도입부를 작성해주세요.
            `;

            // 4. AI 호출
            const sketch = await callGemini(GEMINI_API_KEY.value(), 'gemini-2.5-flash-lite', systemPrompt, userPrompt);

            return { ok: true, sketch };

        } catch (error) {
            logger.error("Error generating story sketch with AI:", error);
            if (error instanceof HttpsError) throw error;
            throw new HttpsError('internal', 'AI로 이야기 초안을 생성하는 데 실패했습니다.');
        }
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
            
            const lastStoryStartTime = userData.lastStoryStartTime;
            if (lastStoryStartTime && now.seconds - lastStoryStartTime.seconds < 7 * 24 * 60 * 60) {
                throw new HttpsError('resource-exhausted', '새 이야기는 7일에 한 번만 시작할 수 있습니다.');
            }

            if (userData.storyInProgress) {
                throw new HttpsError('failed-precondition', `이미 진행 중인 이야기("${userData.storyInProgress}")가 있습니다.`);
            }
            
            if (storyDoc.exists) {
                throw new HttpsError('already-exists', '이 캐릭터는 이미 생성된 이야기가 있습니다.');
            }
            
            tx.update(userRef, {
                storyInProgress: charId,
                lastStoryStartTime: now
            });
            
            tx.set(storyRef, {
                owner: uid,
                charId: charId,
                worldId: worldId,
                createdAt: now,
                status: 'ongoing',
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
    };
};
