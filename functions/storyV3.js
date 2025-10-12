// functions/storyV3.js
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { Timestamp } = require('firebase-admin/firestore');

// --- 프리롤(공유 링버퍼 재사용) ---
const PREROLL_SIZE = 50;
function d100(){ return Math.floor(Math.random()*100)+1; }
async function ensurePreroll(docRef){
  const snap = await docRef.get();
  if (snap.exists) {
    const d = snap.data()||{};
    if (Array.isArray(d.prerolls) && d.prerolls.length === PREROLL_SIZE) return d;
  }
  const prerolls = Array.from({length:PREROLL_SIZE},()=>d100());
  const payload = { prerolls, cursor:0, updatedAt: new Date() };
  await docRef.set(payload, { merge:true });
  return payload;
}

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

// 유틸
const rangeMap = (r, min, max) => min + ((Math.max(1, r)-1) % (max-min+1));
const rotate = (arr, k)=>arr.slice(k).concat(arr.slice(0,k));

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

  // V3-1) NPC 팩 (비-필드 전부 한 번에) — 수치/행렬은 V2 입력값 존중
  const enrichNPCsV3 = onCall({ region:'us-central1', secrets:[GEMINI_API_KEY] }, async (req)=>{
    const uid = req.auth?.uid;
    if (!await hasStoryAccess(uid)) throw new HttpsError('permission-denied','권한 없음');
    const { charId } = req.data||{};
    if (!charId) throw new HttpsError('invalid-argument','charId 필요');

    const runRef = db.doc(`storyRuns/${charId}`);
    const run = (await runRef.get()).data();
    if (!run) throw new HttpsError('failed-precondition','V2 뼈대가 먼저 필요합니다.');

    const world = run.world;
    const nonFields = (run.graph?.nodes||[]).filter(n=>n.kind!=='field').map(n=>{
      const npcCount = (n.npc?.list?.length || 6);
      return {
        id:n.id, name:n.name, difficulty:n.difficulty,
        groupAttitude:n.groupAttitude,
        npcCount,
        groupAttitudeToPlayerInput: n.groupAttitudeToPlayerInput || (n.id==='N1'?'friendly':'neutral'),
        npcAttitudeBias: (typeof n.npcAttitudeBias==='number'? n.npcAttitudeBias : 0),
        relationsSeed: typeof n.relationsSeed==='number' ? n.relationsSeed : 50,
        relationsPreset: n.npc?.relations || null
      };
    });

    const system = `역할: 세계관/NPC 설계 디자이너
규칙:
- 오직 JSON 한 개 객체만 출력. 마크다운/코드펜스/설명문 금지.
- 스키마 외 키 금지, null/undefined 금지, 모든 문자열은 200자 이내.
- "groupAttitudeToPlayerInput"이 주어지면 그 값을 그대로 사용(friendly/neutral/hostile).
- "npcAttitudeBias"(-1/0/+1)를 반영해 개인별 attitudeToPlayer를 분포시킬 것.
- "relationsPreset"이 주어지면 그 행렬(1..5, 대칭, 대각=3)을 그대로 복사 사용할 것(숫자 변경 금지).`;

    const user = `
입력:
- 세계 요약: 이름/소개/상세
- 비-필드 노드: id, name, difficulty, groupAttitude, npcCount,
                groupAttitudeToPlayerInput(필수), npcAttitudeBias(-1|0|+1), relationsSeed(정수),
                relationsPreset(행렬이 있을 경우 그대로 사용)

출력 스키마(고정):
{
  "nodes": [
    {
      "id": "N1",
      "npcs": [ { "id":"npc_1","name":"…","role":"…","trait":"…","backstory":"…","attitudeToPlayer":"우호적|보통|나쁨" } ],
      "relations": { "npc_1": { "npc_1": 3, "npc_2": 2 }, "npc_2": { "npc_1": 2, "npc_2": 3 } },
      "groupAttitudeToPlayer": "friendly|neutral|hostile" // ← 반드시 입력값을 그대로 사용
    }
  ]
}

제약:
- 각 노드의 npcs 길이는 npcCount(최소5~최대10) 정확히 맞출 것.
- groupAttitudeToPlayer는 groupAttitudeToPlayerInput을 그대로 사용.
- npcAttitudeBias(-1/0/+1)에 따라 개인 attitudeToPlayer 분포를 조정(예: +1이면 '나쁨' 비중 ↑).
- relationsPreset이 있으면 그대로 복사하고, 없으면 1..5 정수로 대칭/대각3 행렬 생성.
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

  // V3-2) 몬스터 팩 (난이도별) — 개수/스킬수 모두 프리롤로 고정 후 프롬프트에 명시
  const enrichMonstersByDifficultyV3 = onCall({ region:'us-central1', secrets:[GEMINI_API_KEY] }, async (req)=>{
    const uid = req.auth?.uid;
    if (!await hasStoryAccess(uid)) throw new HttpsError('permission-denied','권한 없음');
    const { charId, difficulties = ['easy','normal','hard','vhard','legend','impossible'] } = req.data||{};
    if (!charId) throw new HttpsError('invalid-argument','charId 필요');

    const runRef = db.doc(`storyRuns/${charId}`);
    const runSnap = await runRef.get();
    const run = runSnap.data();
    if (!run) throw new HttpsError('failed-precondition','V2 뼈대가 먼저 필요합니다.');

    // 프리롤 준비 + 로컬 소비
    let pre = await ensurePreroll(runRef);
    const nextRoll = ()=>{
      const i = (pre.cursor||0) % PREROLL_SIZE;
      const roll = pre.prerolls[i];
      pre.prerolls[i] = d100();
      pre.cursor = (i+1) % PREROLL_SIZE;
      pre.updatedAt = new Date();
      return roll;
    };

    const world = run.world;
    const byDiff = {};
    for (const diff of difficulties){
      const fields = (run.graph?.nodes||[]).filter(n=>n.kind==='field' && n.difficulty===diff).map(n=>({ id:n.id, name:n.name }));
      if (fields.length===0) continue;

      // 프리롤: 몬스터 수(8~12), 각 몬스터 스킬 수(1~3)
      const monsterCount = rangeMap(nextRoll(), 8, 12);
      const skillCounts = Array.from({length: monsterCount}, ()=> rangeMap(nextRoll(), 1, 3));

      const system = `역할: 몬스터 디자이너
규칙:
- 오직 JSON 한 개 객체만 출력. 마크다운/코드펜스 금지.
- 스키마 외 키/수치 금지(레벨/체력/등급/확률/수치는 절대 넣지 말 것).
- monsters는 정확히 ${monsterCount}개.
- i번째 몬스터의 skills 길이는 정확히 skillCounts[i]를 따를 것.`;

      const user = `
입력:
- 세계: ${world.name}
- 소개: ${world.intro}
- 상세: ${(world.detail||'').slice(0,800)}
- 난이도 "${diff}" 필드 목록: ${JSON.stringify(fields,null,2)}
- 제약: monsters=${monsterCount}, skillCounts=${JSON.stringify(skillCounts)}

출력 스키마:
{ "difficulty":"${diff}", "monsters":[ { "name":"…", "description":"2~3문장", "skills":[{"name":"…","summary":"효과 요약(수치 금지)"}], "tags": ["선택"] } ] }`;

      const data = await callGemini(GEMINI_API_KEY.value(), 'gemini-2.0-pro-exp', system, user);
      byDiff[diff] = { ...data, constraints: { monsterCount, skillCounts } };
    }

    // 프리롤 커서 업데이트 + 결과 저장
    await runRef.set({
      prerolls: pre.prerolls, cursor: pre.cursor, updatedAt: pre.updatedAt,
      enrichment: { ...(run.enrichment||{}), monstersByDifficulty: byDiff, monstersUpdatedAt: Timestamp.now() }
    }, { merge:true });

    return { ok:true, monstersByDifficulty: byDiff };
  });

  // V3-3) 상점/드랍 서술 팩 — 카테고리/아이템 개수/드랍템플릿 개수까지 프리롤로 고정
  const enrichShopsAndDropsV3 = onCall({ region:'us-central1', secrets:[GEMINI_API_KEY] }, async (req)=>{
    const uid = req.auth?.uid;
    if (!await hasStoryAccess(uid)) throw new HttpsError('permission-denied','권한 없음');
    const { charId } = req.data||{};
    if (!charId) throw new HttpsError('invalid-argument','charId 필요');

    const runRef = db.doc(`storyRuns/${charId}`);
    const runSnap = await runRef.get();
    const run = runSnap.data();
    if (!run) throw new HttpsError('failed-precondition','V2 뼈대가 먼저 필요합니다.');

    const world = run.world;
    const nonFieldNodes = (run.graph?.nodes||[]).filter(n=>n.kind!=='field');

    // 프리롤 준비 + 로컬 소비
    let pre = await ensurePreroll(runRef);
    const nextRoll = ()=>{
      const i = (pre.cursor||0) % PREROLL_SIZE;
      const roll = pre.prerolls[i];
      pre.prerolls[i] = d100();
      pre.cursor = (i+1) % PREROLL_SIZE;
      pre.updatedAt = new Date();
      return roll;
    };

    // 카테고리/아이템 개수 프리롤 결정
    const allCats = ['blacksmith','general','clothes','potion'];
    const plan = {};
    for (const n of nonFieldNodes){
      const startIdx = (Math.max(1, nextRoll())-1) % allCats.length;
      const catCount = rangeMap(nextRoll(), 1, 3); // 1~3개 카테고리
      const ordered = rotate(allCats, startIdx);
      const cats = ordered.slice(0, catCount);

      const itemCounts = {};
      for (const c of cats){
        itemCounts[c] = rangeMap(nextRoll(), 3, 6); // 각 카테고리 3~6개
      }
      plan[n.id] = { categories: cats, itemCountsByCategory: itemCounts };
    }

    const dropLoreCount = rangeMap(nextRoll(), 12, 16); // 드랍 네이밍 템플릿 12~16개

    const system = `역할: 상점/아이템 명명가
규칙:
- 오직 JSON 한 개 객체만 출력. 마크다운/코드펜스 금지.
- 스키마 외 키 금지. 문자열 120자 이내.
- 각 노드별 카테고리/아이템 개수는 입력 plan을 정확히 따른다.
- "alpha","omega" 레어리티는 절대 사용/표기 금지(판매 금지).`;

    const user = `
입력:
- 세계 요약: ${world.name} / ${world.intro}
- 상세: ${(world.detail||'').slice(0,800)}
- 상점 계획(plan): ${JSON.stringify(plan,null,2)}
- 드랍 네이밍 템플릿 개수: ${dropLoreCount}

요구:
1) shopInventories
   - 노드별 plan.categories에 지정된 카테고리만 생성
   - 각 카테고리는 plan.itemCountsByCategory[cat] 개수만큼 아이템 생성
   - 아이템 스키마: { name, description(1~2문장), suggestedRarity in ["normal","rare","epic","legend","aether"], isConsumable:boolean }
   - 금지: "alpha","omega" 사용/표기 금지
2) dropLore
   - 정확히 ${dropLoreCount}개 { name, description } (드랍 이름 템플릿)
   - 레어리티/확률/수치는 쓰지 말 것(전투 엔진에서 결정)

출력 스키마(고정):
{
  "shopInventories": { "N1": { "blacksmith":[{"name":"…","description":"…","suggestedRarity":"rare","isConsumable":false}], "potion":[…] } },
  "dropLore": [ { "name":"…", "description":"…" } ]
}`;

    const data = await callGemini(GEMINI_API_KEY.value(), 'gemini-2.0-pro-exp', system, user);

    await runRef.set({
      prerolls: pre.prerolls, cursor: pre.cursor, updatedAt: pre.updatedAt,
      enrichment: { ...(run.enrichment||{}), shopInventories: data.shopInventories||{}, dropLore: data.dropLore||[], shopsUpdatedAt: Timestamp.now() }
    }, { merge:true });

    return { ok:true, shopInventories: data.shopInventories||{}, dropLore: data.dropLore||[] };
  });

  return {
    enrichNPCsV3,
    enrichMonstersByDifficultyV3,
    enrichShopsAndDropsV3,
  };
};
