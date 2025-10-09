// /functions/jobs.js
const { onCall, HttpsError } = require('firebase-functions/v2/on-call');
const { logger } = require('firebase-functions');
const fs = require('fs').promises;
const path = require('path');

async function _callGemini(apiKey, model, systemText, userText) {
    const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
    // [수정] API 주소 오타 수정 (generativelace -> generativelanguage)
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const body = {
      systemInstruction: { role: 'system', parts: [{ text: systemText }] },
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      generationConfig: {
        temperature: 0.7, maxOutputTokens: 2048, responseMimeType: "application/json",
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
    try {
        // [수정] AI 응답에서 JSON 객체만 정확히 추출하도록 파싱 로직 강화
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error('No valid JSON object found in the response.');
        }
        return JSON.parse(jsonMatch[0]);
    } catch (e) {
        logger.error("Gemini JSON parse failed", { raw: text, err: e.message });
        throw new HttpsError('internal', 'AI 응답을 파싱하는 데 실패했습니다. 잠시 후 다시 시도해주세요.');
    }
}

let _jobsCache = null;
async function _loadJobs() {
    if (_jobsCache) return _jobsCache;
    // NOTE: 'functions' 폴더 내에 'assets' 폴더가 있어야 합니다.
    const p = path.join(__dirname, 'assets/jobs.json');
    const raw = await fs.readFile(p, 'utf8');
    _jobsCache = JSON.parse(raw);
    return _jobsCache;
}

module.exports = (admin, { GEMINI_API_KEY }) => {
    const db = admin.firestore();

    const recommendJobs = onCall({ region: 'us-central1', secrets: [GEMINI_API_KEY] }, async (req) => {
        const uid = req.auth?.uid;
        if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');

        const { charId } = req.data;
        if (!charId) throw new HttpsError('invalid-argument', '캐릭터 ID가 필요합니다.');

        const charRef = db.doc(`chars/${charId}`);
        const charSnap = await charRef.get();
        if (!charSnap.exists) throw new HttpsError('not-found', '캐릭터를 찾을 수 없습니다.');
        
        const charData = charSnap.data();
        if (charData.owner_uid !== uid) {
            throw new HttpsError('permission-denied', '캐릭터 소유자만 직업을 추천받을 수 있습니다.');
        }

        // [추가] 3분 쿨타임 로직
        const now = Date.now();
        const lastRecommendationTime = charData.lastJobRecommendationAt || 0;
        const cooldown = 3 * 60 * 1000; // 3분
        if (now - lastRecommendationTime < cooldown) {
            const timeLeft = Math.ceil((cooldown - (now - lastRecommendationTime)) / 1000 / 60);
            throw new HttpsError('resource-exhausted', `너무 자주 요청했습니다. ${timeLeft}분 후에 다시 시도해주세요.`);
        }

        // [수정] 가장 최신 서사 1개만 사용하도록 로직 변경
        let narrative = charData.summary || ''; // 서사가 없을 경우 summary를 기본값으로 사용
        if (charData.narratives && Array.isArray(charData.narratives) && charData.narratives.length > 0) {
            // 'createdAt' 기준으로 내림차순 정렬하여 가장 최신 서사를 찾음
            const sortedNarratives = [...charData.narratives].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
            if (sortedNarratives[0].long) {
                narrative = sortedNarratives[0].long;
            }
        }

        if (!narrative) {
            throw new HttpsError('failed-precondition', '캐릭터의 서사 정보가 부족하여 직업을 추천할 수 없습니다.');
        }

        const allJobs = await _loadJobs();
        const availableJobs = allJobs.filter(j => j.name !== '히든 직업' && j.name !== '백수').map(j => j.name);
        
        const systemPrompt = `당신은 'Tale of Heros' 게임의 직업 추천 전문가입니다. 캐릭터의 서사를 분석하여, 제공된 직업 목록 중에서 가장 어울리는 직업 5개를 추천해야 합니다.
- 응답은 반드시 {"recommended_jobs": ["직업1", "직업2", "직업3", "직업4", "직업5"]} 형식의 JSON이어야 합니다.
- 절대로 '히든 직업'이나 '백수'를 추천해서는 안 됩니다.
- 반드시 제공된 직업 목록에 있는 이름만 사용해야 합니다.`;
        
        const userPrompt = `## 캐릭터 서사
${narrative}

## 추천 가능한 직업 목록
${JSON.stringify(availableJobs)}`;

        const result = await _callGemini(GEMINI_API_KEY.value(), 'gemini-2.5-flash', systemPrompt, userPrompt);
        
        // [추가] AI 호출 성공 시, 현재 시간을 타임스탬프로 저장
        await charRef.update({ lastJobRecommendationAt: now });

        const recommended = (Array.isArray(result.recommended_jobs) ? result.recommended_jobs : []).slice(0, 5);

        return { ok: true, jobs: recommended };
    });

    const setCharacterJobAndStats = onCall({ region: 'us-central1' }, async (req) => {
        const uid = req.auth?.uid;
        if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');

        const { charId, jobName, stats } = req.data;
        if (!charId || !jobName || !stats) throw new HttpsError('invalid-argument', '필수 정보가 누락되었습니다.');

        const charRef = db.doc(`chars/${charId}`);
        const charSnap = await charRef.get();
        if (!charSnap.exists) throw new HttpsError('not-found', '캐릭터를 찾을 수 없습니다.');

        const charData = charSnap.data();
        if (charData.owner_uid !== uid) {
            throw new HttpsError('permission-denied', '캐릭터 소유자만 직업을 설정할 수 있습니다.');
        }
        if (charData.job && charData.job !== '백수') {
             throw new HttpsError('failed-precondition', '이미 직업이 설정된 캐릭터입니다.');
        }

        let totalCost = 0;
        for (const key in stats) {
            const level = stats[key]?.level || 0;
            totalCost += level * (level + 1) / 2;
        }

        if (totalCost > 20) {
            throw new HttpsError('invalid-argument', `사용한 스탯 포인트(${totalCost})가 20을 초과했습니다.`);
        }
        
        await charRef.update({
            job: jobName,
            skills: stats,
            updatedAt: Date.now()
        });

        return { ok: true };
    });

    return { recommendJobs, setCharacterJobAndStats };
};
