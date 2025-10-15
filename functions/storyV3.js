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
    generationConfig: { temperature: 0.7, maxOutputTokens: 8192, responseMimeType: "application/json" }
  };
  const res = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  if (!res.ok) throw new HttpsError('internal', `Gemini Error ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!text) throw new HttpsError('internal','Empty Gemini response');
  try { return JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/```$/,'').trim()); } catch(e){ throw new HttpsError('internal','Gemini JSON parse failed'); }
}

// 유틸
const rangeMap = (r, min, max) => min + ((Math.max(1, r)-1) % (max-min+1));
const choiceFromRoll = (arr, r) => arr[(Math.max(1, r)-1) % arr.length];
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

  // V3-1) NPC 팩 (V2 입력값 존중)
  const enrichNPCsV3 = onCall({ region:'us-central1', secrets:[GEMINI_API_KEY], memory: '1GiB' }, async (req)=>{
    // ... (이전과 동일, 변경 없음)
  });

  // V3-2) 몬스터 팩 (난이도별) — 스킬 효과 구조화 추가
  const enrichMonstersByDifficultyV3 = onCall({ region:'us-central1', secrets:[GEMINI_API_KEY], memory: '1GiB' }, async (req)=>{
    const uid = req.auth?.uid;
    if (!await hasStoryAccess(uid)) throw new HttpsError('permission-denied','권한 없음');
    const { charId, difficulties = ['easy','normal','hard','vhard','legend','impossible'] } = req.data||{};
    if (!charId) throw new HttpsError('invalid-argument','charId 필요');

    const runRef = db.doc(`storyRuns/${charId}`);
    const runSnap = await runRef.get();
    const run = runSnap.data();
    if (!run) throw new HttpsError('failed-precondition','V2 뼈대가 먼저 필요합니다.');
    const rules = run.rules;
    if (!rules) throw new HttpsError('failed-precondition', 'V2 규칙이 먼저 필요합니다.');

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

    // 설계안에 명시된 효과 타입
    const EFFECT_TYPES = ['DAMAGE_MULTIPLIER', 'DAMAGE_REDUCTION_SELF', 'MAX_HP_PERCENT_DAMAGE', 'HEAL_SELF'];

    const world = run.world;
    const byDiff = run.enrichment.monstersByDifficulty || {};
    for (const diff of difficulties){
      const fields = (run.graph?.nodes||[]).filter(n=>n.kind==='field' && n.difficulty===diff).map(n=>({ id:n.id, name:n.name }));
      if (fields.length===0) continue;

      // 프리롤 기반으로 몬스터 및 스킬/효과 구조 생성
      const monsterCount = rangeMap(nextRoll(), 8, 12);
      const monsterConstraints = [];
      for (let i = 0; i < monsterCount; i++) {
        const grade = choiceFromRoll(rules.ENEMY_GRADES.slice(0, -1), nextRoll()); // hidden 제외
        const skillCount = rangeMap(nextRoll(), 1, 3);
        const skills = [];
        for (let j = 0; j < skillCount; j++) {
            let effectCount = 0;
            if (grade === 'normal' && nextRoll() > 50) effectCount = 1;
            else if (grade === 'elite') effectCount = rangeMap(nextRoll(), 1, 2);
            else if (grade === 'boss') effectCount = rangeMap(nextRoll(), 1, 3);

            const effects = [];
            for (let k = 0; k < effectCount; k++) {
                const type = choiceFromRoll(EFFECT_TYPES, nextRoll());
                let value, triggerTurn = 0;

                if (nextRoll() > 50) { // 50% 확률로 지연 발동
                    triggerTurn = rangeMap(nextRoll(), 1, 5);
                }

                switch (type) {
                    case 'DAMAGE_MULTIPLIER':
                        value = 1 + 0.02 * rangeMap(nextRoll(), 10, 50); // 1.2 ~ 2.0
                        break;
                    case 'DAMAGE_REDUCTION_SELF':
                        value = 1 + 0.02 * rangeMap(nextRoll(), 5, 40); // 1.1 ~ 1.8
                        break;
                    case 'MAX_HP_PERCENT_DAMAGE':
                        value = rangeMap(nextRoll(), 10, 50); // 10 ~ 50%
                        break;
                    case 'HEAL_SELF':
                        value = rangeMap(nextRoll(), 10, 20); // 10 ~ 20%
                        break;
                }
                effects.push({ type, value: parseFloat(value.toFixed(2)), triggerTurn });
            }
            skills.push({ effects });
        }
        monsterConstraints.push({ grade, skills });
      }
      
      const system = `역할: 몬스터 디자이너
규칙:
- 오직 JSON 한 개 객체만 출력. 마크다운/코드펜스 금지.
- 스키마 외 키/수치 금지(레벨/체력/확률/수치는 절대 넣지 말 것).
- 입력된 "constraints" 구조를 완벽하게 따를 것. 각 몬스터, 스킬, 효과의 개수와 값을 절대 변경하지 말고 그대로 출력 JSON에 포함시켜라.
- 너의 역할은 이 기계적인 제약사항에 어울리는 'name', 'description', 'summary'를 창의적으로 채우는 것이다.`;

      const user = `
입력:
- 세계: ${world.name}
- 소개: ${world.intro}
- 난이도: "${diff}"
- 몬스터 제약사항 (반드시 이 구조와 값을 따를 것): ${JSON.stringify(monsterConstraints, null, 2)}

출력 스키마 (name, description, summary만 창작):
{
  "difficulty": "${diff}",
  "monsters": [
    {
      "name": "...",
      "description": "2~3문장",
      "grade": "elite", // constraints에서 복사
      "skills": [
        {
          "name": "...",
          "summary": "효과 요약(수치 금지)",
          "effects": [ // constraints에서 복사
            { "type": "DAMAGE_MULTIPLIER", "value": 1.5, "triggerTurn": 2 }
          ]
        }
      ]
    }
  ]
}`;

      console.log(`[V3] 난이도 ${diff}: AI 호출 시작 (몬스터 제약사항 크기: ${JSON.stringify(monsterConstraints).length} bytes`);
      const data = await callGemini(GEMINI_API_KEY.value(), 'gemini-1.5-pro-latest', system, user);
      byDiff[diff] = data;
      console.log(`[V3] 난이도 ${diff}: AI 응답 수신 완료 (몬스터 ${data?.monsters?.length || 0}개)`);
    }

    // 프리롤 커서 업데이트 + 결과 저장
    await runRef.set({
      prerolls: pre.prerolls, cursor: pre.cursor, updatedAt: pre.updatedAt,
      enrichment: { ...(run.enrichment||{}), monstersByDifficulty: byDiff, monstersUpdatedAt: Timestamp.now() }
    }, { merge:true });
    console.log(`[V3] 몬스터 데이터 저장 완료. 총 난이도:`, Object.keys(byDiff).length);

    return { ok:true, monstersByDifficulty: byDiff };
  });

    console.log(`[V3] enrichShopsAndDropsV3 시작`);
  // V3-3) 상점/드랍 서술 팩 — 아이템 효과 구조화 추가
  const enrichShopsAndDropsV3 = onCall({ region:'us-central1', secrets:[GEMINI_API_KEY], memory: '1GiB' }, async (req)=>{
    const uid = req.auth?.uid;
    if (!await hasStoryAccess(uid)) throw new HttpsError('permission-denied','권한 없음');
    const { charId } = req.data||{};
    if (!charId) throw new HttpsError('invalid-argument','charId 필요');

    const runRef = db.doc(`storyRuns/${charId}`);
    const runSnap = await runRef.get();
    const run = runSnap.data();
    if (!run) throw new HttpsError('failed-precondition','V2 뼈대가 먼저 필요합니다.');

    console.log(`[V3] 비-필드 노드 수:`, nonFieldNodes.length);
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

    const ITEM_EFFECT_TYPES = {
        potion: [{ type: 'HEAL_HP', min: 20, max: 100 }, { type: 'BLOCK_NEXT_ATTACK', min: 1, max: 1 }],
        general: [{ type: 'HEAL_HP', min: 10, max: 50 }],
        clothes: [{ type: 'INCREASE_MAX_HP', min: 10, max: 50 }],
        blacksmith: [{ type: 'INCREASE_DAMAGE', min: 5, max: 20 }]
    };

    // 카테고리/아이템 개수/효과 프리롤 결정
    const allCats = ['blacksmith','general','clothes','potion'];
    const plan = {};
    for (const n of nonFieldNodes){
      const startIdx = (Math.max(1, nextRoll())-1) % allCats.length;
      const catCount = rangeMap(nextRoll(), 1, 3); // 1~3개 카테고리
      const ordered = rotate(allCats, startIdx);
      const cats = ordered.slice(0, catCount);

      const itemConstraints = {};
      for (const c of cats){
        const itemCount = rangeMap(nextRoll(), 3, 6);
        itemConstraints[c] = [];
        for (let i = 0; i < itemCount; i++) {
            const effectTemplate = choiceFromRoll(ITEM_EFFECT_TYPES[c], nextRoll());
            const effectValue = rangeMap(nextRoll(), effectTemplate.min, effectTemplate.max);
            const isConsumable = c === 'potion' || c === 'general';
            const price = (effectValue * 5) + rangeMap(nextRoll(), 10, 50);

            itemConstraints[c].push({
                isConsumable,
                uses: isConsumable ? 1 : -1, // -1 for permanent
                price,
                effect: { type: effectTemplate.type, value: effectValue }
            });
        }
      }
      plan[n.id] = { itemConstraints };
    }
    console.log(`[V3] 드랍 아이템 템플릿 개수:`, dropLoreCount);
    console.log(`[V3] 상점 계획 크기:`, JSON.stringify(plan).length, `bytes`);

    const dropLoreCount = rangeMap(nextRoll(), 12, 16);

    const system = `역할: 상점/아이템 명명가
규칙:
- 오직 JSON 한 개 객체만 출력. 마크다운/코드펜스 금지.
- 입력된 "plan"의 제약사항(isConsumable, uses, price, effect)을 절대 변경하지 말고 그대로 출력 JSON에 포함시켜라.
- 너의 역할은 이 기계적인 제약사항에 어울리는 'name', 'description', 'suggestedRarity'를 창의적으로 채우는 것이다.
- "alpha","omega" 레어리티는 절대 사용/표기 금지(판매 금지).`;

    const user = `
입력:
- 세계 요약: ${world.name} / ${world.intro}
- 상점 계획(plan): ${JSON.stringify(plan,null,2)}
- 드랍 네이밍 템플릿 개수: ${dropLoreCount}

요구:
1) shopInventories: 각 노드별 plan.itemConstraints에 맞춰 아이템 생성. name, description, suggestedRarity만 창작.
2) dropLore: ${dropLoreCount}개의 { name, description } 생성.

출력 스키마(고정):
{
  "shopInventories": {
    "N1": {
      "potion": [
        {
          "name": "...",
          "description": "...",
          "suggestedRarity": "normal",
          "isConsumable": true, // plan에서 복사
          "uses": 1, // plan에서 복사
          "price": 120, // plan에서 복사
          "effect": { "type": "HEAL_HP", "value": 50 } // plan에서 복사
        }
      ]
    }
  },
    console.log(`[V3] AI 호출 시작 (상점/드랍 아이템)`);
  "dropLore": [ { "name":"...", "description":"..." } ]
    console.log(`[V3] AI 응답 수신 완료 - 상점:`, Object.keys(data.shopInventories||{}).length, `개 노드 | 드랍 템플릿:`, (data.dropLore||[]).length, `개`);
}`;

    const data = await callGemini(GEMINI_API_KEY.value(), 'gemini-1.5-pro-latest', system, user);

    await runRef.set({
    console.log(`[V3] 상점/드랍 데이터 저장 완료`);
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
