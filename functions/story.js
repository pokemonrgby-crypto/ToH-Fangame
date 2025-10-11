// functions/story.js

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { Timestamp } = require('firebase-admin/firestore');
const { logger } = require('firebase-functions');

// ─────────────────────────────────────────────────────────────────────────────
// Gemini 텍스트 호출 헬퍼
async function callGemini(apiKey, model, systemText, userText) {
  const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    systemInstruction: { role: 'system', parts: [{ text: systemText }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: {
      temperature: 0.9,
      maxOutputTokens: 2048,
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

// Gemini JSON 호출 헬퍼 (코드블록 래핑 대비 파싱 포함)
async function callGeminiJSON(apiKey, model, systemText, userText) {
  const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    systemInstruction: { role: 'system', parts: [{ text: systemText }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: {
      temperature: 0.6,
      maxOutputTokens: 2048,
      responseMimeType: "application/json",
    }
  };
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    const txt = await res.text();
    throw new HttpsError('internal', `Gemini API Error (${res.status}): ${txt}`);
  }
  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!text) throw new HttpsError('internal', 'Gemini JSON response was empty.');
  try {
    const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/```$/,'').trim();
    return JSON.parse(clean);
  } catch (e) {
    logger.error("Gemini JSON parse failed", { rawText: text, error: e.message });
    throw new HttpsError('internal', 'AI 응답(JSON) 파싱 실패');
  }
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = (admin, { GEMINI_API_KEY }) => {
  const db = admin.firestore();

  // 세계관 해상도: 프론트 world 객체 → worlds/{id} → configs/worlds 배열 → configs/worlds/{id}
  async function resolveWorld(db, worldId, worldObj) {
    if (worldObj && (worldObj.id || worldObj.name)) return worldObj;

    if (worldId) {
      try {
        const docSnap = await db.doc(`worlds/${worldId}`).get();
        if (docSnap.exists) return { id: worldId, ...docSnap.data() };
      } catch (_) {}
    }

    try {
      const cfgSnap = await db.doc('configs/worlds').get();
      const arr = cfgSnap.exists ? (cfgSnap.data()?.worlds || []) : [];
      const found = arr.find(w => w.id === worldId || w.name === worldId);
      if (found) return found;
    } catch (_) {}

    if (worldId) {
      try {
        const docSnap = await db.doc(`configs/worlds/${worldId}`).get();
        if (docSnap.exists) return { id: worldId, ...docSnap.data() };
      } catch (_) {}
    }
    return null;
  }

  function normalizeWorldFields(w = {}) {
    const name   = String(w.name ?? w.id ?? '').trim();
    const intro  = String(w.intro ?? w.summary ?? '').trim();
    const detail = String(
      w.detail?.lore_long ?? w.detail?.lore ?? w.detail ?? w.description ?? ''
    ).trim();
    return { name, intro, detail };
  }

  // 접근 권한
  async function hasStoryAccess(uid) {
    if (!uid) return false;
    try {
      const [adminSnap, betaSnap] = await Promise.all([
        db.doc('configs/admins').get(),
        db.doc('configs/betatesters').get()
      ]);

      const adminConfig = adminSnap.exists ? adminSnap.data() : {};
      const betaConfig  = betaSnap.exists  ? betaSnap.data()  : {};

      const allowUids = new Set([ ...(adminConfig.allow || []), ...(betaConfig.allow || []) ]);
      if (allowUids.has(uid)) return true;

      const user = await admin.auth().getUser(uid);
      const userEmail = user.email;
      if (!userEmail) return false;

      const allowEmails = new Set([ ...(adminConfig.allowEmails || []), ...(betaConfig.allowEmails || []) ]);
      return allowEmails.has(userEmail);
    } catch (error) {
      logger.error(`Error checking story access for UID: ${uid}`, error);
      return false;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 프롤로그 + 메타(JSON) 생성
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
    if (lastSketchTime && now.seconds - lastSketchTime.seconds < 15) {
      throw new HttpsError('resource-exhausted', `잠시 후 다시 시도해주세요. (${15 - (now.seconds - lastSketchTime.seconds)}초 남음)`);
    }

    if (userData.storyInProgress) {
      throw new HttpsError('failed-precondition', `이미 진행 중인 이야기("${userData.storyInProgress}")가 있습니다.`);
    }

    const { charId, keywords, worldId, world } = req.data;
    if (!charId || !keywords || !worldId) {
      throw new HttpsError('invalid-argument', '캐릭터, 키워드, 세계관 정보는 필수입니다.');
    }

    await userRef.set({ lastStorySketchTime: now }, { merge: true });

    try {
      // 캐릭터 / 세계관
      const charSnap = await db.doc(`chars/${charId}`).get();
      if (!charSnap.exists) throw new HttpsError('not-found', '캐릭터를 찾을 수 없습니다.');
      const charData = charSnap.data();

      const worldDataRaw = await resolveWorld(db, worldId, world);
      if (!worldDataRaw) {
        throw new HttpsError('not-found', '세계관 정보를 찾을 수 없습니다. (worldId/world 객체 확인 필요)');
      }
      const { name: worldName, intro: worldIntro, detail: worldDetail } = normalizeWorldFields(worldDataRaw);

      // 최신 서사
      const latestNarrative =
        (charData.narratives || [])
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0]?.long
        || charData.summary
        || '새롭게 시작하는 캐릭터';

      // 프롤로그 프롬프트
      const systemPrompt = `당신은 주어진 캐릭터와 세계관, 핵심 키워드를 바탕으로 흥미로운 이야기의 도입부(프롤로그)를 생성하는 전문 스토리 작가입니다. 웹소설처럼 독자의 흥미를 유발할 수 있는 흡입력 있는 문체로 3~5문단의 짧은 글을 작성해주세요.`;

      const userPrompt = `
## 세계관 설정
- 이름: ${worldName}
- 소개: ${worldIntro}
- 상세: ${worldDetail}

## 캐릭터 정보
- 이름: ${charData.name}
- 배경 서사: ${latestNarrative}

## 이야기 핵심 키워드
${keywords}

## 지시사항
위 정보를 바탕으로, "${charData.name}" 캐릭터가 주인공인 이야기의 도입부를 작성해주세요.
`;

      // A) 프롤로그(텍스트)
      const sketch = await callGemini(GEMINI_API_KEY.value(), 'gemini-2.5-flash-lite', systemPrompt, userPrompt);

      // B) 설계 메타(JSON)
      let meta = { strengthTier: 'apprentice', logline: '', keyEvents: [] };
      try {
        const metaSystem = `너는 이 세계의 게임 마스터야. 플레이어 캐릭터의 텍스트 설정과 세계관, 키워드를 보고
다음 JSON만 만들어줘. 불필요한 문장/설명 금지.

{
  "strengthTier": "apprentice|hero|transcendent",
  "logline": "한 줄 요약",
  "keyEvents": [
    { "id": "ke1", "title": "짧은 제목", "description": "1~2문장", "location": "string", "status": "pending" }
  ]
}

규칙:
- keyEvents는 4~5개
- location은 세계관 맥락에 맞는 짧은 식별자/장소명
- status는 무조건 "pending"`;

        const metaUser = `
세계관:
- 이름: ${worldName}
- 소개: ${worldIntro}
- 상세: ${worldDetail}

캐릭터:
- 이름: ${charData.name}
- 최신 서사(요약): ${String(latestNarrative).slice(0, 500)}

키워드:
${keywords}

프롤로그 초안(참고):
${String(sketch).slice(0, 1200)}
`;

        const raw = await callGeminiJSON(GEMINI_API_KEY.value(), 'gemini-2.5-flash-lite', metaSystem, metaUser);

        const tier = String(raw?.strengthTier || '').toLowerCase();
        const okTier = ['apprentice', 'hero', 'transcendent'].includes(tier) ? tier : 'apprentice';
        const events = Array.isArray(raw?.keyEvents) ? raw.keyEvents : [];

        meta = {
          strengthTier: okTier,
          logline: String(raw?.logline || '').slice(0, 200),
          keyEvents: events.slice(0, 5).map((e, i) => ({
            id: String(e?.id || `ke${i + 1}`),
            title: String(e?.title || '').slice(0, 60),
            description: String(e?.description || '').slice(0, 300),
            location: String(e?.location || worldId).slice(0, 60),
            status: 'pending'
          }))
        };
      } catch (e) {
        logger.warn('Meta generation failed; continue with sketch only', e);
      }

      return { ok: true, sketch, meta };

    } catch (error) {
      logger.error("Error generating story sketch with AI:", error);
      if (error instanceof HttpsError) throw error;
      throw new HttpsError('internal', 'AI로 이야기 초안을 생성하는 데 실패했습니다.');
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 스토리 시작 + 메타 저장
  const startStory = onCall({ region: 'us-central1' }, async (req) => {
    const uid = req.auth?.uid;
    if (!await hasStoryAccess(uid)) {
      throw new HttpsError('permission-denied', '이 기능에 접근할 권한이 없습니다.');
    }

    const { charId, worldId, initialSketch, logline, keyEvents, strengthTier } = req.data;
    if (!charId || !worldId || !initialSketch) {
      throw new HttpsError('invalid-argument', '캐릭터, 세계관, 초기 스케치 정보는 필수입니다.');
    }

    const userRef  = db.doc(`users/${uid}`);
    const storyRef = db.doc(`stories/${charId}`);

    return db.runTransaction(async (tx) => {
      const userDoc  = await tx.get(userRef);
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

      tx.set(userRef, {
        storyInProgress: charId,
        lastStoryStartTime: now
      }, { merge: true });

      tx.set(storyRef, {
        owner: uid,
        charId,
        worldId,
        createdAt: now,
        status: 'ongoing',
        strengthTier: strengthTier || 'apprentice',
        logline: String(logline || ''),
        keyEvents: Array.isArray(keyEvents) ? keyEvents.slice(0, 5).map(e => ({
          id: String(e?.id || ''),
          title: String(e?.title || '').slice(0, 60),
          description: String(e?.description || '').slice(0, 300),
          location: String(e?.location || worldId).slice(0, 60),
          status: 'pending'
        })) : [],
        narratives: [
          { type: 'sketch', content: String(initialSketch || ''), timestamp: now }
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
