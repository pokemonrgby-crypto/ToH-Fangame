// functions/explore_v2.js
// 탐험 v2: 주사위/프리롤/프롬프트/로그를 서버로 이전

const { Timestamp, FieldValue } = require('firebase-admin/firestore');

// ---- 테이블(클라 explore.js 값을 서버로 포팅) ----
const EVENT_TABLE = {
  easy:   { safe:150, item:270, narrative:200, risk:230, combat:150 },
  normal: { safe:120, item:275, narrative:180, risk:235, combat:190 },
  hard:   { safe:90,  item:280, narrative:160, risk:240, combat:230 },
  vhard:  { safe:60,  item:285, narrative:140, risk:245, combat:270 },
  legend: { safe:30,  item:290, narrative:120, risk:250, combat:310 },
};

const RARITY_TABLES_BY_DIFFICULTY = {
  normal: [
    { upto: 500, rarity: 'normal' },
    { upto: 800, rarity: 'rare'   },
    { upto: 930, rarity: 'epic'   },
    { upto: 980, rarity: 'legend' },
    { upto: 1000, rarity: 'myth'  },
  ],
  easy: [
    { upto: 600, rarity: 'normal' },
    { upto: 850, rarity: 'rare'   },
    { upto: 950, rarity: 'epic'   },
    { upto: 990, rarity: 'legend' },
    { upto: 1000, rarity: 'myth'  },
  ],
  hard: [
    { upto: 400, rarity: 'normal' },
    { upto: 750, rarity: 'rare'   },
    { upto: 920, rarity: 'epic'   },
    { upto: 980, rarity: 'legend' },
    { upto: 1000, rarity: 'myth'  },
  ],
  vhard: [
    { upto: 300, rarity: 'normal' },
    { upto: 700, rarity: 'rare'   },
    { upto: 900, rarity: 'epic'   },
    { upto: 980, rarity: 'legend' },
    { upto: 1000, rarity: 'myth'  },
  ],
  legend: [
    { upto: 195, rarity: 'normal' },
    { upto: 595, rarity: 'rare'   },
    { upto: 845, rarity: 'epic'   },
    { upto: 945, rarity: 'legend' },
    { upto: 995, rarity: 'myth'   },
    { upto: 1000, rarity: 'aether' },
  ],
};

const COMBAT_TIER = {
  easy:   [{p:600,t:'trash'},{p:950,t:'normal'},{p:1000,t:'elite'}],
  normal: [{p:350,t:'trash'},{p:900,t:'normal'},{p:980,t:'elite'},{p:1000,t:'boss'}],
  hard:   [{p:220,t:'trash'},{p:700,t:'normal'},{p:950,t:'elite'},{p:1000,t:'boss'}],
  vhard:  [{p:150,t:'trash'},{p:550,t:'normal'},{p:900,t:'elite'},{p:1000,t:'boss'}],
  legend: [{p:80, t:'trash'},{p:380,t:'normal'},{p:800,t:'elite'},{p:1000,t:'boss'}],
};

// ---- 유틸 ----
const STAMINA_BASE = 10;
function makePrerolls(n=50, mod=1000){
  return Array.from({length:n}, ()=> Math.floor(Math.random()*mod)+1);
}
function popRoll(run, mod=1000){
  const arr = Array.isArray(run.prerolls) ? run.prerolls.slice() : [];
  const v = arr.length ? arr.shift() : (Math.floor(Math.random()*mod)+1);
  return { value: ((v-1)%mod)+1, next: arr };
}

function pickByTable(n, tableArr){
  const v = ((n-1)%1000)+1;
  for(const row of tableArr){
    if(v <= row.upto) return row;
  }
  return tableArr[tableArr.length-1];
}
function pickEvent(difficulty, n){
  const t = EVENT_TABLE[difficulty] || EVENT_TABLE.normal;
  const v = ((n-1)%1000)+1;
  const cuts = [
    ['safe', t.safe],
    ['item', t.safe + t.item],
    ['narrative', t.safe + t.item + t.narrative],
    ['risk', t.safe + t.item + t.narrative + t.risk],
    ['combat', t.safe + t.item + t.narrative + t.risk + t.combat],
  ];
  for(const [kind, upto] of cuts){
    if(v <= upto) return kind;
  }
  return 'safe';
}
function pickCombatTier(difficulty, n){
  const rows = COMBAT_TIER[difficulty] || COMBAT_TIER.normal;
  const v = ((n-1)%1000)+1;
  for(const r of rows){
    if(v <= r.p) return r.t;
  }
  return rows[rows.length-1].t;
}
function rollThreeChoices(run){
  const out = [];
  let next = run.prerolls || [];
  for(let i=0;i<3;i++){
    const r1 = popRoll({prerolls: next}); next = r1.next;
    const eventKind = pickEvent(run.difficulty || 'normal', r1.value);
    const dice = { eventKind, deltaStamina: 0 };

    // --- 💥 [수정] 클라이언트의 동적 스태미나 계산 로직을 여기에 추가 ---
    const diff = run.difficulty || 'normal';
    const sRoll = popRoll({prerolls: next}); next = sRoll.next; // 스태미나용 주사위 하나 더 소모
    const baseDelta = { safe:[0,1], item:[-1,-1], narrative:[-1,-1], risk:[-3,-1], combat:[-5,-2] }[eventKind] || [0,0];
    const mul = { easy:.8, normal:1.0, hard:1.15, vhard:1.3, legend:1.5 }[diff] || 1.0;
    const lo = Math.round(baseDelta[0]*mul), hi = Math.round(baseDelta[1]*mul);
    const deltaStamina = (lo===hi) ? lo : (lo<0 ? -(((sRoll.value-1)%(-lo+ -hi+1)) + -hi) : ((sRoll.value-1)%(hi-lo+1))+lo);
    dice.deltaStamina = deltaStamina;
    // --- 수정 끝 ---

    if(eventKind === 'item'){
      const rrar = popRoll({prerolls: next}); next = rrar.next;
      const row = pickByTable(rrar.value, RARITY_TABLES_BY_DIFFICULTY[diff] || RARITY_TABLES_BY_DIFFICULTY.normal);
      
      // --- 💥 [수정] 클라이언트의 아이템 속성 결정 로직 추가 ---
      const isConsumable = (popRoll({prerolls: next}).value <= 7); // 70% 확률 (10면체 주사위)
      next = popRoll({prerolls: next}).next; // 주사위 소모
      const uses = isConsumable ? (popRoll({prerolls: next}).value % 3) + 1 : 1; // 소모성이면 1~3회
      next = popRoll({prerolls: next}).next; // 주사위 소모

      dice.item = { rarity: row.rarity, isConsumable, uses };
      // --- 수정 끝 ---

    }else if(eventKind === 'combat'){
      const rc = popRoll({prerolls: next}); next = rc.next;
      dice.combat = { enemyTier: pickCombatTier(diff, rc.value) };
      dice.deltaStamina = 0; // 전투 진입 자체는 소모 없음
    }
    out.push(dice);
  }
  return { choices: out, nextPrerolls: next };
}


// ---- 프롬프트 로딩 + Gemini 호출 ----
async function loadPrompt(db, id='adventure_narrative_system'){
  const ref = db.collection('configs').doc('prompts');
  const doc = await ref.get();
  if (!doc.exists) return '';
  const data = doc.data()||{};
  return String(data[id]||'');
}
// ANCHOR: functions/explore_v2.js -> callGemini 함수

async function callGemini({ apiKey, systemText, userText }){
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  const body = {
    // 💥 [수정] 시스템 프롬프트를 별도 instruction으로 분리
    systemInstruction: {
      role: 'system',
      parts: [{ text: String(systemText || '') }]
    },
    contents: [{
      role: 'user',
      parts: [{ text: String(userText || '') }]
    }],
    generationConfig: {
      temperature: 0.9,
      maxOutputTokens: 2048, // 조금 더 넉넉하게
      // 💥 [수정] AI가 반드시 JSON 형식으로 응답하도록 강제
      responseMimeType: "application/json"
    }
  };
  const res = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  if(!res.ok) {
    const errorText = await res.text();
    logger.error("Gemini API Error", { status: res.status, text: errorText });
    throw new Error(`Gemini API Error: ${res.status}`);
  }
  const j = await res.json();
  const text = j?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  
  // 💥 [수정] responseMimeType을 사용하므로 JSON 펜스(```json) 제거 로직이 더 이상 불필요
  try {
    // 이제 text 자체가 유효한 JSON 문자열이므로 바로 파싱
    return JSON.parse(text);
  } catch (e) {
    logger.error("Gemini JSON parse failed", { rawText: text, error: e.message });
    return {}; // 파싱 실패 시 빈 객체 반환 (기존 동작 유지)
  }
}

module.exports = (admin, { onCall, HttpsError, logger, GEMINI_API_KEY }) => {
  const db = admin.firestore();

  const startExploreV2 = onCall({ secrets: [GEMINI_API_KEY] }, async (req) => {
    const uid = req.auth?.uid;
    if(!uid) throw new HttpsError('unauthenticated', '로그인이 필요해');
    const { charId, worldId, worldName, siteId, siteName, difficulty='normal', staminaStart=STAMINA_BASE } = req.data||{};
    if(!charId || !worldId || !siteId) throw new HttpsError('invalid-argument','필수값 누락');

    // 동일 캐릭터 진행중 런 막기
    const qs = await db.collection('explore_runs')
      .where('owner_uid','==', uid)
      .where('charRef','==', `chars/${charId}`)
      .where('status','==','ongoing')
      .limit(1).get();
    if(!qs.empty) throw new HttpsError('failed-precondition','이미 진행 중인 탐험이 있어');

    const payload = {
      charRef: `chars/${charId}`,
      owner_uid: uid,
      world_id: worldId, world_name: worldName||worldId,
      site_id: siteId,   site_name: siteName||siteId,
      difficulty,
      startedAt: Timestamp.now(),
      stamina_start: staminaStart,
      stamina: staminaStart,
      turn: 0,
      status: 'ongoing',
      summary3: '',
      prerolls: makePrerolls(50, 1000),
      events: [],
      rewards: [],
      updatedAt: Timestamp.now(),
    };
    const ref = await db.collection('explore_runs').add(payload);
    // 캐릭터 마킹
    await db.collection('chars').doc(charId).update({ last_explore_startedAt: Timestamp.now() }).catch(()=>{});
    return { ok:true, runId: ref.id };
  });

  const advPrepareNextV2 = onCall({ secrets:[GEMINI_API_KEY] }, async (req)=>{
  // /functions/explore_v2.js

// ... (파일 상단의 다른 함수들은 그대로 유지) ...

  const advPrepareNextV2 = onCall({ secrets:[GEMINI_API_KEY] }, async (req)=>{
    const uid = req.auth?.uid;
    if(!uid) throw new HttpsError('unauthenticated','로그인이 필요해');
    const { runId } = req.data||{};
    if(!runId) throw new HttpsError('invalid-argument','runId 필요');

    const ref = db.collection('explore_runs').doc(runId);
    const s = await ref.get();
    if(!s.exists) throw new HttpsError('not-found','런 없음');
    const run = s.data();
    if(run.owner_uid !== uid) throw new HttpsError('permission-denied','소유자 아님');
    if(run.status !== 'ongoing') throw new HttpsError('failed-precondition','이미 종료된 런');

    // 1) 주사위 3개 굴림 + 프리롤 소모
    const { choices, nextPrerolls } = rollThreeChoices(run);

    // 2) 프롬프트 구성 (클라 ai.js 로직과 동일 구조)
    const charId = String(run.charRef||'').replace(/^chars\//,'');
    const charDoc = await db.collection('chars').doc(charId).get().catch(()=>null);
    const character = charDoc?.exists ? charDoc.data() : {};
    
    // --- ▼▼▼ [수정된 부분 시작] ▼▼▼ ---

    // [수정 1] 장착 스킬 정보를 정확히 가져오도록 수정
    const equippedAbilities = (character.abilities_equipped || [])
      .map(index => (character.abilities_all || [])[index])
      .filter(Boolean); // null, undefined 등 제거
    const skillsAsText = equippedAbilities.length > 0
      ? equippedAbilities.map(s => `${s.name || '스킬'}: ${s.desc_soft || ''}`).join('\n')
      : '없음';

    // [수정 2] 장착 아이템 이름을 가져오도록 수정 (단, 현재 구조에서는 ID만 있으므로 이름은 가져올 수 없음. battle.js처럼 별도 조회가 필요하나 여기선 간소화)
    const equippedItems = (character?.items_equipped||[]).map(it=>it?.name||it?.id||'').filter(Boolean).join(', ') || '없음';
    
    // [수정 3] 캐릭터의 최신 서사와 이전 서사 요약을 프롬프트에 추가
    const narratives = Array.isArray(character.narratives) ? character.narratives : [];
    narratives.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const latestNarrative = narratives[0] || {};
    const previousNarrativeSummary = narratives.slice(1).map(n => n.short).join('; ') || '(없음)';

    const prevTurnLog = (run.events||[]).slice(-1)[0]?.note || '(없음)';

    const systemText = await loadPrompt(db,'adventure_narrative_system'); // 동일 ID
    
    const dicePrompts = choices.map((d,i)=>{
      let result = `종류=${d.eventKind}, 스태미나변화=${d.deltaStamina}`;
      if(d.item)   result += `, 아이템(등급:${d.item.rarity}, 소모성:${d.item.isConsumable}, 사용횟수:${d.item.uses})`;
      if(d.combat) result += `, 전투(적 등급:${d.combat.enemyTier})`;
      return `선택지 ${i+1} 예상 결과: ${result}`;
    }).join('\n');

    // [수정 4] userText 프롬프트에 수정된 캐릭터 정보 변수를 반영
    const userText = [
      '## 플레이어 캐릭터 컨텍스트',
      `- 출신 세계관: ${character?.world_id || '알 수 없음'}`,
      `- 캐릭터 이름: ${character?.name || '-'}`,
      `- 캐릭터 핵심 서사: ${latestNarrative.long || character.summary || '(없음)'}`,
      `- 캐릭터 과거 요약: ${previousNarrativeSummary}`,
      `- 보유 스킬: ${skillsAsText}`,
      `- 장착 아이템: ${equippedItems}`,
      '',
      '## 스토리 컨텍스트',
      `- 현재 탐험 세계관/장소: ${run.world_name || run.world_id}/${run.site_name || run.site_id}`,
      `- 이전 턴 요약: ${prevTurnLog}`,
      `- 현재까지의 3문장 요약: ${run.summary3 || '(없음)'}`,
      '---',
      '## 다음 상황을 생성하라:',
      dicePrompts,
    ].join('\n');
    
    // --- ▲▲▲ [수정된 부분 끝] ▲▲▲ ---

    const parsed = await callGemini({ apiKey: process.env.GEMINI_API_KEY, systemText, userText }) || {};
    const narrative_text = String(parsed?.narrative_text || parsed?.narrative || '').slice(0, 2000);
    const choicesText = Array.isArray(parsed?.choices) ? parsed.choices.slice(0,3).map(c=>String(c).slice(0,100)) : ['선택지 A','선택지 B','선택지 C'];
    const outcomes = Array.isArray(parsed?.choice_outcomes)? parsed.choice_outcomes.slice(0,3) : [{event_type:'narrative'},{event_type:'narrative'},{event_type:'narrative'}];
    const summary3_update = String(parsed?.summary3_update || '').slice(0, 300);

    const pending = {
      narrative_text,
      choices: choicesText,
      choice_outcomes: outcomes,
      diceResults: choices,
      summary3_update, // ✅ 추가: 다음 턴 요약 반영용
      at: Date.now()
    };


    await ref.update({
      pending_choices: pending,
      prerolls: nextPrerolls,
      updatedAt: Timestamp.now()
    });

    return { ok:true, pending };
  });




// ANCHOR: functions/explore_v2.js

// ... (advPrepareNextV2 함수 아래) ...

// ANCHOR: functions/explore_v2.js -> advApplyChoiceV2 함수

// entire function to be replaced
const advApplyChoiceV2 = onCall({ secrets:[GEMINI_API_KEY] }, async (req)=>{
    const uid = req.auth?.uid;
    if(!uid) throw new HttpsError('unauthenticated','로그인이 필요해');
    const { runId, index } = req.data||{};
    const idx = Number(index);
    if(!runId || !Number.isFinite(idx) || idx<0 || idx>2) throw new HttpsError('invalid-argument','index 0..2');

    const ref = db.collection('explore_runs').doc(runId);
    const s = await ref.get();
    if(!s.exists) throw new HttpsError('not-found','런 없음');
    const run = s.data();
    if(run.owner_uid !== uid) throw new HttpsError('permission-denied','소유자 아님');
    if(run.status !== 'ongoing') throw new HttpsError('failed-precondition','이미 종료됨');

    const pend = run.pending_choices;
    if(!pend) throw new HttpsError('failed-precondition','대기 선택 없음');

    const chosenDice = pend.diceResults[idx];
    const chosenOutcome = pend.choice_outcomes[idx] || { event_type:'narrative' };

    // 💥 AI가 생성한 '결과' 텍스트를 가져와 로그에 포함
    const resultText = String(chosenOutcome.result_text || '아무 일도 일어나지 않았다.').trim();
    const narrativeLog = `${pend.narrative_text}\n\n[선택: ${pend.choices[idx] || ''}]\n→ ${resultText}`.trim().slice(0, 2300);

    // 전투 발생 시
    if (chosenOutcome.event_type === 'combat'){
      const battleInfo = { enemy: chosenOutcome.enemy || { tier: (chosenDice?.combat?.enemyTier||'normal') }, narrative: narrativeLog };
      await ref.update({
        battle_pending: battleInfo,
        pending_choices: null,
        turn: (run.turn||0)+1,
        events: FieldValue.arrayUnion({
          t: Date.now(),
          note: narrativeLog,
          dice: chosenDice,
          deltaStamina: 0
        }),
        updatedAt: Timestamp.now()
      });
      const fresh = await ref.get();
      return { ok:true, state: fresh.data(), battle:true };
    }

    // 아이템 지급(선택지에서 item 발생 시)
    let newItem = null;
    if (chosenOutcome.event_type === 'item' && chosenOutcome.item){
      newItem = {
        ...(chosenDice?.item||{}),
        ...chosenOutcome.item,
        id: 'item_' + Date.now() + '_' + Math.random().toString(36).slice(2,9)
      };
    }

    // 아이템이 있으면 유저 인벤토리에 추가
    if (newItem) {
      const userInvRef = db.collection('users').doc(uid);
      await userInvRef.update({
        items_all: FieldValue.arrayUnion(newItem)
      }).catch((e) => {
        logger.error(`[explore_v2] Failed to add item to user inventory for uid: ${uid}`, { error: e.message, newItem });
      });
    }

    const delta = Number(chosenDice?.deltaStamina || 0);
// /functions/explore_v2.js

// ... (advApplyChoiceV2 함수 내부) ...
    const staminaNow = Math.max(0, (run.stamina||0) + delta);
    const updates = {
      stamina: staminaNow,
      turn: (run.turn||0)+1,
      events: FieldValue.arrayUnion({
        t: Date.now(),
        note: narrativeLog,
        dice: { ...(chosenDice||{}), ...(newItem ? { item:newItem } : {}) },
        deltaStamina: delta,
      }),
      summary3: (pend.summary3_update || run.summary3 || ''),
      pending_choices: null,
      prerolls: pend.nextPrerolls || run.prerolls, // ◀◀◀ 이 줄을 추가하세요
      updatedAt: Timestamp.now()
    };
    await ref.update(updates);
// ... (이하 생략) ...

    // 체력 소진 시 종료
    if (staminaNow <= 0){
      await ref.update({
        status: 'ended',
        endedAt: Timestamp.now(),
        reason: 'exhaust',
        pending_battle: null,
        pending_choices: null,
        updatedAt: Timestamp.now()
      });
      const endSnap = await ref.get();
      return { ok:true, state: endSnap.data(), done:true };
    }

    const snap = await ref.get();
    return { ok:true, state: snap.data(), battle:false, done:false };
  });

// ... (파일 끝까지) ...
  

  
  const endExploreV2 = onCall({ secrets:[GEMINI_API_KEY] }, async (req)=>{
    const uid = req.auth?.uid;
    if(!uid) throw new HttpsError('unauthenticated','로그인이 필요해');
    const { runId, reason='ended' } = req.data||{};
    if(!runId) throw new HttpsError('invalid-argument','runId 필요');

    const ref = db.collection('explore_runs').doc(runId);
    const s = await ref.get();
    if(!s.exists) throw new HttpsError('not-found','런 없음');
    const r = s.data();
    if(r.owner_uid !== uid) throw new HttpsError('permission-denied','소유자 아님');
    if(r.status!=='ongoing') return { ok:true, already:true };

    await ref.update({
      status:'ended', endedAt:Timestamp.now(), reason, pending_choices:null, pending_battle:null, updatedAt:Timestamp.now()
    });
    const snap = await ref.get();
    return { ok:true, state: snap.data() };
  });
  const advStartBattleV2 = onCall({ secrets:[GEMINI_API_KEY] }, async (req)=>{
  const uid = req.auth?.uid;
  if(!uid) throw new HttpsError('unauthenticated','로그인이 필요해');
  const { runId } = req.data||{};
  if(!runId) throw new HttpsError('invalid-argument','runId 필요');

  const ref = db.collection('explore_runs').doc(runId);
  const s = await ref.get();
  if(!s.exists) throw new HttpsError('not-found','런 없음');
  const run = s.data();
  if(run.owner_uid !== uid) throw new HttpsError('permission-denied','소유자 아님');
  if(run.status !== 'ongoing') throw new HttpsError('failed-precondition','종료된 런');

  const bp = run.battle_pending;
  if(!bp) throw new HttpsError('failed-precondition','대기중인 전투 없음');

  await ref.update({
    pending_battle: bp,
    battle_pending: null,
    updatedAt: Timestamp.now()
  });

  const fresh = await ref.get();
  return { ok:true, state: fresh.data() };
});

  return { startExploreV2, advPrepareNextV2, advApplyChoiceV2, endExploreV2, advStartBattleV2 };
};
