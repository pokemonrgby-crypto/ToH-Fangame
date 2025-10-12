// functions/storyV3.js
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { Timestamp } = require('firebase-admin/firestore');

// --- Gemini 호출 ---
async function callGemini(apiKey, model, systemText, userText) {
  const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    systemInstruction: { role: 'system', parts: [{ text: systemText }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 4096, responseMimeType: "application/json" }
  };
  const res = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  if (!res.ok) throw new HttpsError('internal', `Gemini Error ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!text) throw new HttpsError('internal','Empty Gemini response');
  try { return JSON.parse(text); } catch(e){ throw new HttpsError('internal','Gemini JSON parse failed'); }
}

module.exports = (admin, { GEMINI_API_KEY }) => {
  const db = admin.firestore();

  async function hasStoryAccess(uid){
    if (!uid) return false;
    try{
      const [a,b] = await Promise.all([db.doc('configs/admins').get(), db.doc('configs/betatesters').get()]);
      const A = a.exists ? a.data() : {}; const B = b.exists ? b.data() : {};
      const allowUids = new Set([...(A.allow||[]), ...(B.allow||[])]);
      if (allowUids.has(uid)) return true;
      const user = await admin.auth().getUser(uid);
      const email = user.email||'';
      const allowEmails = new Set([...(A.allowEmails||[]), ...(B.allowEmails||[])]);
      return allowEmails.has(email);
    }catch{ return false; }
  }

  // V3-1) NPC 팩 (비-필드 전부 한 번에)
  const enrichNPCsV3 = onCall({ region:'us-central1', secrets:[GEMINI_API_KEY] }, async (req)=>{
    const uid = req.auth?.uid;
    if (!await hasStoryAccess(uid)) throw new HttpsError('permission-denied','권한 없음');
    const { charId } = req.data||{};
    if (!charId) throw new HttpsError('invalid-argument','charId 필요');

    const runRef = db.doc(`storyRuns/${charId}`);
    const run = (await runRef.get()).data();
    if (!run) throw new HttpsError('failed-precondition','V2 뼈대가 먼저 필요합니다.');

    const world = run.world;
    const nonFields = (run.graph?.nodes||[]).filter(n=>n.kind!=='field').map(n=>({
      id:n.id, name:n.name, difficulty:n.difficulty, groupAttitude:n.groupAttitude, npcCount: (n.npc?.list?.length||6)
    }));

    const system = `역할: 세계관/NPC 설계 디자이너
규칙:
- 오직 JSON 한 개 객체만 출력. 마크다운/코드펜스/설명문 금지.
- 스키마 외 키 금지, null/undefined 금지, 모든 문자열은 200자 이내.
- 시작 마을의 groupAttitudeToPlayer는 "friendly" 고정.
- relations는 대칭이어야 하고, 자기자신 대각선은 3(보통)으로 둘 것.
- 친소값: 1(매우 친함),2(친함),3(보통),4(나쁨, 개선가능),5(매우 나쁨, 개선불가).`;

    const user = `
입력:
- 세계 요약: 이름/소개/상세
- 비-필드 노드: id, name, difficulty, groupAttitude, npcCount

출력 스키마(고정):
{
  "nodes": [
    {
      "id": "N1",
      "npcs": [ { "id":"npc_1","name":"…","role":"…","trait":"…","backstory":"…","attitudeToPlayer":"우호적|보통|나쁨" } ],
      "relations": { "npc_1": { "npc_1": 3, "npc_2": 2 }, "npc_2": { "npc_1": 2, "npc_2": 3 } },
      "groupAttitudeToPlayer": "friendly|neutral|hostile"
    }
  ]
}

제약:
- 각 노드의 npcs 길이는 npcCount(최소5~최대10) 정확히 맞출 것.
- name/role은 중복 최소화.
- attitudeToPlayer는 노드의 groupAttitudeToPlayer와 어긋나지 않게 분포.
- relations는 1..5 정수만 사용, 대칭 유지.
데이터:
- 세계: ${world.name}
- 소개: ${world.intro}
- 상세: ${(world.detail||'').slice(0,1200)}
- 비-필드: ${JSON.stringify(nonFields, null, 2)}
`;

    const data = await callGemini(GEMINI_API_KEY.value(), 'gemini-2.0-pro-exp', system, user);
    await runRef.set({ enrichment: { ...(run.enrichment||{}), npcs: data, npcsUpdatedAt: Timestamp.now() } }, { merge:true });
    return { ok:true, npcs:data };
  });

  // V3-2) 몬스터 팩 (난이도별 1회씩 또는 통합 1회)
  const enrichMonstersByDifficultyV3 = onCall({ region:'us-central1', secrets:[GEMINI_API_KEY] }, async (req)=>{
    const uid = req.auth?.uid;
    if (!await hasStoryAccess(uid)) throw new HttpsError('permission-denied','권한 없음');
    const { charId, difficulties = ['easy','normal','hard','vhard','legend','impossible'] } = req.data||{};
    if (!charId) throw new HttpsError('invalid-argument','charId 필요');

    const runRef = db.doc(`storyRuns/${charId}`);
    const run = (await runRef.get()).data();
    if (!run) throw new HttpsError('failed-precondition','V2 뼈대가 먼저 필요합니다.');

    const world = run.world;
    const byDiff = {};
    for (const diff of difficulties){
      const fields = (run.graph?.nodes||[]).filter(n=>n.kind==='field' && n.difficulty===diff).map(n=>({ id:n.id, name:n.name }));
      if (fields.length===0) continue;

      const system = `역할: 몬스터 디자이너
규칙:
- 오직 JSON 한 개 객체만 출력. 마크다운/코드펜스 금지.
- 스키마 외 키/수치 금지(레벨/체력/등급/확률/수치는 절대 넣지 말 것).
- monsters는 8~12개, name 중복 금지, skills는 1~3개.`;

      const user = `
입력:
- 세계: ${world.name}
- 소개: ${world.intro}
- 상세: ${(world.detail||'').slice(0,800)}
- 난이도 "${diff}" 필드 목록: ${JSON.stringify(fields,null,2)}

출력 스키마:
{ "difficulty":"${diff}", "monsters":[ { "name":"…", "description":"2~3문장", "skills":[{"name":"…","summary":"효과 요약(수치 금지)"}], "tags": ["선택"] } ] }`;

      const data = await callGemini(GEMINI_API_KEY.value(), 'gemini-2.0-pro-exp', system, user);
      byDiff[diff] = data;
    }

    await runRef.set({ enrichment: { ...(run.enrichment||{}), monstersByDifficulty: byDiff, monstersUpdatedAt: Timestamp.now() } }, { merge:true });
    return { ok:true, monstersByDifficulty: byDiff };
  });

  // V3-3) 상점/드랍 서술 팩 (한 번에)
  const enrichShopsAndDropsV3 = onCall({ region:'us-central1', secrets:[GEMINI_API_KEY] }, async (req)=>{
    const uid = req.auth?.uid;
    if (!await hasStoryAccess(uid)) throw new HttpsError('permission-denied','권한 없음');
    const { charId } = req.data||{};
    if (!charId) throw new HttpsError('invalid-argument','charId 필요');

    const runRef = db.doc(`storyRuns/${charId}`);
    const run = (await runRef.get()).data();
    if (!run) throw new HttpsError('failed-precondition','V2 뼈대가 먼저 필요합니다.');

    const world = run.world;
    const nonFields = (run.graph?.nodes||[]).filter(n=>n.kind!=='field').map(n=>({ id:n.id, name:n.name, difficulty:n.difficulty }));

    const system = `역할: 상점/아이템 명명가
규칙:
- 오직 JSON 한 개 객체만 출력. 마크다운/코드펜스 금지.
- 스키마 외 키 금지. 문자열 120자 이내.`;

    const user = `
입력:
- 세계 요약: ${world.name} / ${world.intro}
- 상세: ${(world.detail||'').slice(0,800)}
- 비-필드: ${JSON.stringify(nonFields,null,2)}

요구:
1) shopInventories
   - 노드별로 "blacksmith|general|clothes|potion" 중 1~3개 카테고리 선택
   - 각 카테고리 3~6개 아이템 { name, description(1~2문장), suggestedRarity in ["normal","rare","epic","legend","aether"], isConsumable:boolean }
   - 금지: "alpha","omega"는 절대 사용/표기 금지(판매 금지 규칙)
2) dropLore
   - 12~16개 { name, description } (드랍 이름 템플릿)
   - 레어리티/확률/수치는 쓰지 말 것(전투 엔진에서 결정)

출력 스키마(고정):
{
  "shopInventories": { "N1": { "blacksmith":[{"name":"…","description":"…","suggestedRarity":"rare","isConsumable":false}], "potion":[…] } },
  "dropLore": [ { "name":"…", "description":"…" } ]
}`;

    const data = await callGemini(GEMINI_API_KEY.value(), 'gemini-2.0-pro-exp', system, user);
    await runRef.set({ enrichment: { ...(run.enrichment||{}), shopInventories: data.shopInventories||{}, dropLore: data.dropLore||[], shopsUpdatedAt: Timestamp.now() } }, { merge:true });
    return { ok:true, shopInventories: data.shopInventories||{}, dropLore: data.dropLore||[] };
  });

  return {
    enrichNPCsV3,
    enrichMonstersByDifficultyV3,
    enrichShopsAndDropsV3,
  };
};
