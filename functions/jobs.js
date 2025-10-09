// /functions/jobs.js
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions');
const fs = require('fs').promises;
const path = require('path');

// AI 호출, 관리자 확인 등 헬퍼 함수
async function _isAdmin(uid, admin) {
    if (!uid) return false;
    try {
        const snap = await admin.firestore().doc('configs/admins').get();
        const d = snap.exists ? snap.data() : {};
        const allow = Array.isArray(d.allow) ? d.allow : [];
        if (allow.includes(uid)) return true;
        const allowEmails = Array.isArray(d.allowEmails) ? d.allowEmails : [];
        const user = await admin.auth().getUser(uid);
        return !!(user?.email && allowEmails.includes(user.email));
    } catch (_) { return false; }
}

async function _callGemini(apiKey, model, systemText, userText) {
    const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
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
        const clean = text.replace(/^```(?:json)?\s*/, '').replace(/```$/, '').trim();
        return JSON.parse(clean);
    } catch (e) {
        logger.error("Gemini JSON parse failed", { raw: text, err: e.message });
        throw new HttpsError('internal', 'AI 응답 파싱 실패');
    }
}

let _jobsCache = null;
async function _loadJobs() {
    if (_jobsCache) return _jobsCache;
    const p = path.join(__dirname, './assets/jobs.json');
    const raw = await fs.readFile(p, 'utf8');
    _jobsCache = JSON.parse(raw);
    return _jobsCache;
}

module.exports = (admin, { GEMINI_API_KEY }) => {
    const db = admin.firestore();

    const recommendJobs = onCall({ region: 'us-central1', secrets: [GEMINI_API_KEY] }, async (req) => {
        const uid = req.auth?.uid;
        if (!await _isAdmin(uid, admin)) throw new HttpsError('permission-denied', '관리자 전용 기능입니다.');

        const { charId } = req.data;
        if (!charId) throw new HttpsError('invalid-argument', '캐릭터 ID가 필요합니다.');

        const charSnap = await db.doc(`chars/${charId}`).get();
        if (!charSnap.exists) throw new HttpsError('not-found', '캐릭터를 찾을 수 없습니다.');
        const charData = charSnap.data();
        const narrative = (charData.narratives || []).map(n => n.long).join('\n') || charData.summary;

        const allJobs = await _loadJobs();
        // 히든 직업과 백수는 추천 목록에서 제외
        const availableJobs = allJobs.filter(j => j.name !== '히든 직업' && j.name !== '백수').map(j => j.name);
        
        const systemPrompt = `당신은 'Tale of Heros' 게임의 직업 추천 전문가입니다. 캐릭터의 서사를 분석하여, 제공된 직업 목록 중에서 가장 어울리는 직업 5개를 추천해야 합니다.
- 응답은 반드시 {"recommended_jobs": ["직업1", "직업2", "직업3", "직업4", "직업5"]} 형식의 JSON이어야 합니다.
- 절대로 '히든 직업'이나 '백수'를 추천해서는 안 됩니다.
- 반드시 제공된 직업 목록에 있는 이름만 사용해야 합니다.`;
        
        const userPrompt = `## 캐릭터 서사
${narrative}

## 추천 가능한 직업 목록
${JSON.stringify(availableJobs)}`;

        const result = await _callGemini(GEMINI_API_KEY.value(), 'gemini-2.5-flash-lite', systemPrompt, userPrompt);
        
        const recommended = (Array.isArray(result.recommended_jobs) ? result.recommended_jobs : []).slice(0, 5);

        return { ok: true, jobs: recommended };
    });

    const adminSetCharacterJobAndStats = onCall({ region: 'us-central1' }, async (req) => {
        const uid = req.auth?.uid;
        if (!await _isAdmin(uid, admin)) throw new HttpsError('permission-denied', '관리자 전용 기능입니다.');

        const { charId, jobName, stats } = req.data;
        if (!charId || !jobName || !stats) throw new HttpsError('invalid-argument', '필수 정보가 누락되었습니다.');

        // 스탯 포인트 총합 검증
        let totalCost = 0;
        for (const key in stats) {
            const level = stats[key].level || 0;
            totalCost += level * (level + 1) / 2; // 1부터 n까지의 합 공식
        }

        if (totalCost > 20) {
            throw new HttpsError('invalid-argument', `사용한 스탯 포인트(${totalCost})가 20을 초과했습니다.`);
        }
        
        const charRef = db.doc(`chars/${charId}`);
        await charRef.update({
            job: jobName,
            skills: stats,
            updatedAt: Date.now()
        });

        return { ok: true };
    });

    return { recommendJobs, adminSetCharacterJobAndStats };
};
