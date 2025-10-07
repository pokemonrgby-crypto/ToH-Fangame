// /functions/skill.js

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions');
const { FieldValue } = require('firebase-admin/firestore');

// AI 모델 풀
const MODEL_POOL = ['gemini-2.0-flash-lite', 'gemini-2.5-flash-lite', 'gemini-2.0-flash', 'gemini-2.5-flash'];

function pickModels() {
  const shuffled = [...MODEL_POOL].sort(() => 0.5 - Math.random());
  return { primary: shuffled[0], fallback: shuffled[1] || shuffled[0] };
}

// Gemini 호출 헬퍼
async function callGemini(apiKey, systemText, userText, modelName) {
    const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
    const body = {
        systemInstruction: { role: 'system', parts: [{ text: systemText }] },
        contents: [{ role: 'user', parts: [{ text: userText }] }],
        generationConfig: {
            temperature: 0.85,
            maxOutputTokens: 2048,
            responseMimeType: "application/json",
        },
        safetySettings: [
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" }
        ]
    };
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) {
        const txt = await res.text();
        throw new HttpsError('internal', `Gemini API Error (${res.status}): ${txt}`);
    }
    const json = await res.json();
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) throw new HttpsError('internal', 'Gemini response was empty.');
    try {
        return JSON.parse(text);
    } catch (e) {
        logger.error("Gemini JSON parse failed", { rawText: text, error: e.message });
        throw new HttpsError('internal', 'AI 응답 파싱에 실패했습니다.');
    }
}

module.exports = (admin, { GEMINI_API_KEY }) => {
    const db = admin.firestore();
    const CREATE_COOLDOWN_MS = 3 * 60 * 1000; // 3분 쿨타임

    // 1단계: AI로 스킬 초안 생성
    const generateNewSkill = onCall({ region: 'us-central1', secrets: [GEMINI_API_KEY] }, async (req) => {
        const uid = req.auth?.uid;
        if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');

        const { charId, generationMode, customName, userPrompt } = req.data;
        if (!charId || !generationMode) {
            throw new HttpsError('invalid-argument', '캐릭터 ID와 생성 모드가 필요합니다.');
        }

        const charRef = db.doc(`chars/${charId}`);
        const userRef = db.doc(`users/${uid}`);

        const [charSnap, userSnap] = await Promise.all([charRef.get(), userRef.get()]);

        if (!charSnap.exists) throw new HttpsError('not-found', '캐릭터를 찾을 수 없습니다.');
        const charData = charSnap.data();
        if (charData.owner_uid !== uid) throw new HttpsError('permission-denied', '자신의 캐릭터가 아닙니다.');

        const skills = (Array.isArray(charData.abilities_all) ? charData.abilities_all : []).filter(s => s.name);
        if (skills.length >= 8) {
            throw new HttpsError('failed-precondition', '스킬은 최대 8개까지 보유할 수 있습니다.');
        }
        
        const lastCreatedAt = userSnap.data()?.lastSkillCreatedAt?.toMillis() || 0;
        if (Date.now() - lastCreatedAt < CREATE_COOLDOWN_MS) {
            const remaining = Math.ceil((CREATE_COOLDOWN_MS - (Date.now() - lastCreatedAt)) / 1000);
            throw new HttpsError('resource-exhausted', `스킬 생성 쿨타임이 ${remaining}초 남았습니다.`);
        }
        
        const additionalSkills = Math.max(0, skills.length - 4);
        const cost = 500 + (additionalSkills * 500);
        const userCoins = userSnap.data()?.coins || 0;
        if (userCoins < cost) {
            throw new HttpsError('failed-precondition', `코인이 부족합니다. (필요: ${cost})`);
        }

        const systemPrompt = (await db.doc('configs/prompts').get()).data()?.skill_create_system || '';
        if (!systemPrompt) throw new HttpsError('internal', '시스템 프롬프트를 찾을 수 없습니다.');

        const aiUserPrompt = JSON.stringify({
            character: charData,
            generationMode: generationMode,
            customName: customName || null,
            userPrompt: userPrompt || null
        }, null, 2);
        
        const { primary, fallback } = pickModels();
        let aiResult = {};
        try {
            aiResult = await callGemini(GEMINI_API_KEY.value(), systemPrompt, aiUserPrompt, primary);
        } catch (e) {
            logger.warn(`Primary model ${primary} failed, trying fallback ${fallback}`, { error: e.message });
            aiResult = await callGemini(GEMINI_API_KEY.value(), systemPrompt, aiUserPrompt, fallback);
        }

        const newSkill = {
            name: String(aiResult.name || '알 수 없는 스킬').slice(0, 20),
            desc_soft: String(aiResult.description || '').slice(0, 140),
            level: 0 // [추가] 신규 스킬은 0레벨로 시작
        };
        
        // 쿨타임 기록만 먼저 처리
        await userRef.set({ lastSkillCreatedAt: FieldValue.serverTimestamp() }, { merge: true });

        return { ok: true, generatedSkill: newSkill, cost };
    });
    
    // 2단계: 사용자가 확인 후 스킬 최종 적용
    const confirmAddSkill = onCall({ region: 'us-central1' }, async (req) => {
        const uid = req.auth?.uid;
        if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');

        const { charId, skill } = req.data;
        if (!charId || !skill || !skill.name || !skill.desc_soft) {
            throw new HttpsError('invalid-argument', '캐릭터 ID와 스킬 정보가 필요합니다.');
        }

        return await db.runTransaction(async (tx) => {
            const charRef = db.doc(`chars/${charId}`);
            const userRef = db.doc(`users/${uid}`);

            const [charSnap, userSnap] = await Promise.all([tx.get(charRef), tx.get(userRef)]);
            if (!charSnap.exists) throw new HttpsError('not-found', '캐릭터를 찾을 수 없습니다.');
            
            const charData = charSnap.data();
            if (charData.owner_uid !== uid) throw new HttpsError('permission-denied', '자신의 캐릭터가 아닙니다.');

            const skills = (Array.isArray(charData.abilities_all) ? charData.abilities_all : []).filter(s => s.name);
            if (skills.length >= 8) {
                throw new HttpsError('failed-precondition', '스킬은 최대 8개까지 보유할 수 있습니다.');
            }

            const additionalSkills = Math.max(0, skills.length - 4);
            const cost = 500 + (additionalSkills * 500);
            const userCoins = userSnap.data()?.coins || 0;
            if (userCoins < cost) {
                throw new HttpsError('failed-precondition', `코인이 부족합니다. (필요: ${cost})`);
            }

            tx.update(userRef, { coins: FieldValue.increment(-cost) });
            tx.update(charRef, { abilities_all: FieldValue.arrayUnion({ ...skill, level: 0 }) }); // [수정] 레벨 명시

            return { ok: true, addedSkill: skill };
        });
    });

    // [신규] 스킬 성장 함수
    const enhanceSkill = onCall({ region: 'us-central1', secrets: [GEMINI_API_KEY] }, async (req) => {
        const uid = req.auth?.uid;
        if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');

        const { charId, skillIndex } = req.data;
        if (!charId || typeof skillIndex !== 'number') {
            throw new HttpsError('invalid-argument', '캐릭터 ID와 스킬 인덱스가 필요합니다.');
        }

        return await db.runTransaction(async (tx) => {
            const charRef = db.doc(`chars/${charId}`);
            const userRef = db.doc(`users/${uid}`);
            const [charSnap, userSnap] = await Promise.all([tx.get(charRef), tx.get(userRef)]);

            if (!charSnap.exists) throw new HttpsError('not-found', '캐릭터를 찾을 수 없습니다.');
            const charData = charSnap.data();
            if (charData.owner_uid !== uid) throw new HttpsError('permission-denied', '자신의 캐릭터가 아닙니다.');
            
            const userCoins = userSnap.data()?.coins || 0;
            const totalExp = charData.exp_total || 0;

            const skills = Array.isArray(charData.abilities_all) ? [...charData.abilities_all] : [];
            const skillToEnhance = skills[skillIndex];
            if (!skillToEnhance) throw new HttpsError('not-found', '존재하지 않는 스킬입니다.');
            
            const currentLevel = skillToEnhance.level || 0;
            if (currentLevel >= 3) throw new HttpsError('failed-precondition', '이미 최고 레벨입니다.');

            const targetLevel = currentLevel + 1;
            const costs = { 1: 100, 2: 300, 3: 500 };
            const expReqs = { 1: 1000, 2: 3000, 3: 10000 };
            
            const cost = costs[targetLevel];
            const expReq = expReqs[targetLevel];

            if (userCoins < cost) throw new HttpsError('failed-precondition', `코인이 부족합니다. (필요: ${cost})`);
            if (totalExp < expReq) throw new HttpsError('failed-precondition', `총 경험치가 부족합니다. (필요: ${expReq})`);

            // AI 호출하여 새 설명 생성
            const systemPrompt = (await db.doc('configs/prompts').get()).data()?.skill_enhance_system || '';
            if (!systemPrompt) throw new HttpsError('internal', '스킬 강화 프롬프트를 찾을 수 없습니다.');

            const aiUserPrompt = JSON.stringify({
                character: { name: charData.name, summary: charData.summary },
                skill: skillToEnhance,
                targetLevel,
            }, null, 2);

            const { primary, fallback } = pickModels();
            let aiResult;
            try {
                aiResult = await callGemini(GEMINI_API_KEY.value(), systemPrompt, aiUserPrompt, primary);
            } catch (e) {
                logger.warn(`Enhance skill primary model failed, trying fallback.`, { error: e.message });
                aiResult = await callGemini(GEMINI_API_KEY.value(), systemPrompt, aiUserPrompt, fallback);
            }

            const enhancedSkill = {
                ...skillToEnhance,
                desc_soft: aiResult.desc_soft,
                level: targetLevel,
            };

            skills[skillIndex] = enhancedSkill;
            
            tx.update(userRef, { coins: FieldValue.increment(-cost) });
            tx.update(charRef, { abilities_all: skills });

            return { ok: true, updatedSkill: enhancedSkill, cost };
        });
    });

    return { generateNewSkill, confirmAddSkill, enhanceSkill };
};
