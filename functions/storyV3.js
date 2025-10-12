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

    const system = `너는 세계관/NPC 설계를 위한 시뮬레이션 디자이너다. 반드시 JSON으로만 응답하라.`;
    const user = `
다음 세계 요약과 '비-필드 노드' 리스트를 바탕으로, 각 노드에 대해
1) NPC 배열(개수= npcCount) : {id, name, role, trait, backstory(짧게), attitudeToPlayer in ["우호적","보통","나쁨"]}
2) 관계행렬 relations: { [npcId]: { [npcId]: 1|2|3|4|5 } }  // 1 매우 친함 ~ 5 매우 나쁨
3) groupAttitudeToPlayer: "friendly"|"neutral"|"hostile" (시작 마을은 friendly 고정 권장)
형태로 만들어라.

세계 요약:
- 이름: ${world.name}
- 소개: ${world.intro}
- 상세: ${world.detail?.slice(0,1200)||''}

비-필드 노드 요약(예시):
${JSON.stringify(nonFields, null, 2)}

응답 스키마:
{
  "nodes": [
    {
      "id": "N1",
      "npcs": [ { "id":"npc_1","name":"...","role":"...","trait":"...","backstory":"...","attitudeToPlayer":"우호적"} ],
      "relations": { "npc_1": { "npc_1": 3, "npc_2": 2 }, "npc_2": { "npc_1": 2, "npc_2": 3 } },
      "groupAttitudeToPlayer": "friendly"
    }
  ]
}
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

      const system = `너는 게임 몬스터 디자이너다. 반드시 JSON으로만 응답하라.`;
      const user = `
세계: ${world.name}
세계 분위기: ${world.intro}
세부: ${world.detail?.slice(0,800)||''}

난이도 "${diff}" 필드 목록:
${JSON.stringify(fields,null,2)}

요구사항:
- 이 난이도에 어울리는 '공통 몬스터 풀' 8~12종 생성
- 각 몬스터는 { name, description(2~3문장), skills:[{name, summary}], tags?:string[] } // 수치 금지, 효과 묘사만
- 등급은 전투엔진이 따로 정하므로 여기선 '서술 위주'로.

응답 스키마:
{ "difficulty":"${diff}", "monsters":[ { "name":"...", "description":"...", "skills":[{"name":"...","summary":"..."}] } ] }
`;
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

    const system = `너는 게임 상점/아이템 명명가다. 반드시 JSON만 응답.`;
    const user = `
세계 요약: ${world.name} / ${world.intro}
상세: ${world.detail?.slice(0,800)||''}

비-필드 노드들(상점 가능):
${JSON.stringify(nonFields,null,2)}

요구:
1) shopInventories: 각 노드에 대해 "blacksmith(장비)", "general(일반)", "clothes(의류)", "potion(물약)" 중 1~3개 카테고리 선정.
   - 각 카테고리별 3~6개 아이템 { name, description(1~2문장), suggestedRarity in ["normal","rare","epic","legend","aether"], isConsumable:boolean }
   - 금지: "alpha","omega" 레어리티는 절대 사용 금지(판매 금지 규칙)
2) dropLore: 드랍 아이템 명명 템플릿 12~16개 (짧은 이름 + 1문장 설명). 전투 시스템이 레어리티/확률은 따로 정함.

응답 스키마:
{
  "shopInventories": {
    "N1": { "blacksmith":[{"name":"...","description":"...","suggestedRarity":"rare","isConsumable":false}], "potion":[...] },
    "N2": { ... }
  },
  "dropLore": [ { "name":"...", "description":"..." } ]
}
`;

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
