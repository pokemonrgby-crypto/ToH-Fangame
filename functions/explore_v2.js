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

const MODEL_POOL = [
  'gemini-2.0-flash-lite', // 가장 빠르고 저렴한 모델을 우선으로
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-2.5-flash',
  
];

function pickModels() {
  const shuffled = [...MODEL_POOL].sort(() => 0.5 - Math.random());
  const primary = shuffled[0];
  const fallback = shuffled[1] || shuffled[0];
  return { primary, fallback };
}


// [추가] 적 등급 기반 희귀도 표(1000 스케일)
const TIER_RARITY_TABLE = {
  trash: [
    { upto: 600, rarity: 'normal' },
    { upto: 900, rarity: 'rare'   },
    { upto: 990, rarity: 'epic'   },
    { upto: 1000, rarity: 'legend' },
  ],
  normal: [
    { upto: 500, rarity: 'normal' },
    { upto: 850, rarity: 'rare'   },
    { upto: 970, rarity: 'epic'   },
    { upto: 995, rarity: 'legend' },
    { upto: 1000, rarity: 'myth'  },
  ],
  elite: [
    { upto: 300, rarity: 'normal' },
    { upto: 700, rarity: 'rare'   },
    { upto: 930, rarity: 'epic'   },
    { upto: 990, rarity: 'legend' },
    { upto: 1000, rarity: 'myth'  },
  ],
  boss: [
    { upto: 100, rarity: 'normal' },
    { upto: 400, rarity: 'rare'   },
    { upto: 850, rarity: 'epic'   },
    { upto: 970, rarity: 'legend' },
    { upto: 995, rarity: 'myth'   },
    { upto: 1000, rarity: 'aether' },
  ],
};

// [추가] 희귀도 서열(더 큰 값이 더 희귀)
const RARITY_RANK = { normal:1, rare:2, epic:3, legend:4, myth:5, aether:6 };

// [추가] 더 좋은 희귀도 뽑기(둘 중 최댓값)
function betterRarity(a, b){
  return (RARITY_RANK[a]||0) >= (RARITY_RANK[b]||0) ? a : b;
}


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
      // --- [교체] 소모성/사용횟수 정확 계산 (주사위 소비 포함) ---
      // 소모성: 10면체에서 1~7 → 70%
      const rConsum = popRoll({ prerolls: next }, 10); next = rConsum.next;
      const isConsumable = (rConsum.value <= 7);

      // 사용횟수: 3면체 1~3 → 균등
      const rUses = popRoll({ prerolls: next }, 3); next = rUses.next;
      const uses = isConsumable ? rUses.value : 1;

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

async function callGemini({ apiKey, systemText, userText, logger, modelName }) {
  if (!modelName) throw new Error("callGemini에 modelName이 제공되지 않았습니다.");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
  // ...
  const body = {
    systemInstruction: { role: 'system', parts: [{ text: String(systemText || '') }] },
    contents: [{ role: 'user', parts: [{ text: String(userText || '') }] }],
    generationConfig: { temperature: 0.9, maxOutputTokens: 8192, responseMimeType: "application/json" }
  };
  const res = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });

  if(!res.ok) {
    const errorText = await res.text().catch(()=> '');
    logger?.error?.("Gemini API Error", { status: res.status, text: errorText });
    throw new Error(`Gemini API Error: ${res.status}`);
  }

  const j = await res.json().catch(e=>{
    logger?.error?.("Gemini JSON decode failed", { error: String(e?.message||e) });
    return {};
  });

  const text = j?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  try {
    return JSON.parse(text);
  } catch (e) {
    logger?.error?.("Gemini JSON parse failed", { rawText: text.slice(0, 500) , error: String(e?.message||e) });
    return {};
  }
}



module.exports = (admin, { onCall, HttpsError, logger, GEMINI_API_KEY }) => {
  const db = admin.firestore();

  const startExploreV2 = onCall({ secrets: [GEMINI_API_KEY] }, async (req) => {
      // ... 이 함수는 변경 없습니다 ...
      const uid = req.auth?.uid;
      if(!uid) throw new HttpsError('unauthenticated', '로그인이 필요해');
      const { charId, worldId, worldName, siteId, siteName, difficulty='normal', staminaStart=10 } = req.data||{};
      if(!charId || !worldId || !siteId) throw new HttpsError('invalid-argument','필수값 누락');

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
      await db.collection('chars').doc(charId).update({ last_explore_startedAt: Timestamp.now() }).catch(()=>{});
      return { ok:true, runId: ref.id };
  });

  const advPrepareNextV2 = onCall({ secrets:[GEMINI_API_KEY] }, async (req)=>{
    // ... (대부분 동일) ...
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

    const { choices, nextPrerolls } = rollThreeChoices(run); // preroll 소모 후 남은 값(nextPrerolls)을 받음

    const charId = String(run.charRef||'').replace(/^chars\//,'');
    const charDoc = await db.collection('chars').doc(charId).get().catch(()=>null);
    const character = charDoc?.exists ? charDoc.data() : {};
    
    const equippedAbilities = (character.abilities_equipped || []).map(index => (character.abilities_all || [])[index]).filter(Boolean);
    const skillsAsText = equippedAbilities.length > 0 ? equippedAbilities.map(s => `${s.name || '스킬'}: ${s.desc_soft || ''}`).join('\n') : '없음';
    const equippedItems = (character?.items_equipped||[]).map(it=>it?.name||it?.id||'').filter(Boolean).join(', ') || '없음';
    const narratives = Array.isArray(character.narratives) ? character.narratives : [];
    narratives.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const latestNarrative = narratives[0] || {};
    const previousNarrativeSummary = narratives.slice(1).map(n => n.short).join('; ') || '(없음)';
    const prevTurnLog = (run.events||[]).slice(-1)[0]?.note || '(없음)';
    const systemText = await loadPrompt(db,'adventure_narrative_system');
    const dicePrompts = choices.map((d,i)=>{
      let result = `종류=${d.eventKind}, 스태미나변화=${d.deltaStamina}`;
      if(d.item)   result += `, 아이템(등급:${d.item.rarity}, 소모성:${d.item.isConsumable}, 사용횟수:${d.item.uses})`;
      if(d.combat) result += `, 전투(적 등급:${d.combat.enemyTier})`;
      return `선택지 ${i+1} 예상 결과: ${result}`;
    }).join('\n');
    const userText = [
      '## 플레이어 캐릭터 컨텍스트',
      `- 출신 세계관: ${character?.world_id || '알 수 없음'}`,
      `- 캐릭터 이름: ${character?.name || '-'}`,
      `- 캐릭터 핵심 서사: ${latestNarrative.long || character.summary || '(없음)'}`,
      `- 캐릭터 과거 요약: ${previousNarrativeSummary}`,
      `- 보유 스킬: ${skillsAsText}`,
      `- 장착 아이템: ${equippedItems}`,
      '','## 스토리 컨텍스트',
      `- 현재 탐험 세계관/장소: ${run.world_name || run.world_id}/${run.site_name || run.site_id}`,
      `- 이전 턴 요약: ${prevTurnLog}`,
      `- 현재까지의 3문장 요약: ${run.summary3 || '(없음)'}`,
      '---','## 다음 상황을 생성하라:', dicePrompts,
    ].join('\n');
    
    const { primary, fallback } = pickModels();
    let parsed = {};
    try {
      parsed = await callGemini({ apiKey: GEMINI_API_KEY.value(), systemText, userText, logger, modelName: primary }) || {};
    } catch(e) {
      logger.warn(`[explore/prepare] 1차 모델(${primary}) 호출 실패, 대체 모델(${fallback})로 재시도합니다.`, { error: e.message });
      parsed = await callGemini({ apiKey: GEMINI_API_KEY.value(), systemText, userText, logger, modelName: fallback }) || {};
    }

    const narrative_text = String(parsed?.narrative_text || parsed?.narrative || '').slice(0, 2000);
    const choicesText = Array.isArray(parsed?.choices) ? parsed.choices.slice(0,3).map(c=>String(c).slice(0,100)) : ['선택지 A','선택지 B','선택지 C'];
    const outcomes = Array.isArray(parsed?.choice_outcomes)? parsed.choice_outcomes.slice(0,3) : [{event_type:'narrative'},{event_type:'narrative'},{event_type:'narrative'}];
    const summary3_update = String(parsed?.summary3_update || '').slice(0, 300);

    const pending = {
      narrative_text,
      choices: choicesText,
      choice_outcomes: outcomes,
      diceResults: choices,
      summary3_update,
      // [핵심 수정 1] 남은 preroll을 pending_choices에 저장합니다.
      nextPrerolls: nextPrerolls, 
      at: Date.now()
    };

    await ref.update({
      pending_choices: pending,
      // [참고] prerolls 필드는 여기서 업데이트하는 것이 아니라, 선택지를 고른 후에 업데이트합니다.
      updatedAt: Timestamp.now()
    });
    return { ok:true, pending };
  });

  // [수정] advApplyChoiceV2 함수 전체
  const advApplyChoiceV2 = onCall({ secrets:[GEMINI_API_KEY] }, async (req)=>{
    const uid = req.auth?.uid;
    if(!uid) throw new HttpsError('unauthenticated','로그인이 필요해');
    const { runId, index } = req.data||{};
    const idx = Number(index);
    if(!runId || !Number.isFinite(idx) || idx<0 || idx>2) throw new HttpsError('invalid-argument','index 0..2');

    const runRef = db.collection('explore_runs').doc(runId);
    const s = await runRef.get();
    if(!s.exists) throw new HttpsError('not-found','런 없음');
    const run = s.data();
    if(run.owner_uid !== uid) throw new HttpsError('permission-denied','소유자 아님');
    if(run.status !== 'ongoing') throw new HttpsError('failed-precondition','이미 종료됨');

    const pend = run.pending_choices;
    if(!pend) throw new HttpsError('failed-precondition','대기 선택 없음');

    const chosenDice = pend.diceResults[idx];
    const chosenOutcome = pend.choice_outcomes[idx] || { event_type:'narrative' };

    const resultText = String(chosenOutcome.result_text || '아무 일도 일어나지 않았다.').trim();
    const narrativeLog = `${pend.narrative_text}\n\n[선택: ${pend.choices[idx] || ''}]\n→ ${resultText}`.trim().slice(0, 2300);
    const diff = run.difficulty || 'normal';
    // [수정] 전투 발생 시 로직 강화
    if (chosenOutcome.event_type === 'combat'){
      const enemyBase = chosenOutcome.enemy || {};
      const tier = chosenDice?.combat?.enemyTier || 'normal';

      const charId = String(run.charRef || '').replace(/^chars\//, '');
      const charSnap = await db.collection('chars').doc(charId).get();
      const character = charSnap.exists ? charSnap.data() : {};
      const playerExp = character.exp_total || 0;

      // [PATCH] 난이도별 적 체력 테이블(기본 HP=10 기준으로 재설계)
      // Easy는 trash: 2~4, normal: 3~4 느낌으로 낮게 고정
      const hpTableByDiff = {
        easy:   { trash: 2,  normal: 3,  elite: 5,  boss: 9 },
        normal: { trash: 6,  normal: 8,  elite: 14, boss: 22 },
        hard:   { trash: 8,  normal: 12, elite: 20, boss: 32 },
        vhard:  { trash: 10, normal: 15, elite: 25, boss: 40 },
        legend: { trash: 12, normal: 18, elite: 30, boss: 50 },
      };

      const baseHp = (hpTableByDiff[diff]?.[tier]) ?? 8;
      // 고레벨 캐릭 보정은 너무 급해지지 않게 완만하게
      const expBonusRatio = Math.floor((playerExp || 0) / 400) * 0.10;
      const finalHp = Math.max(1, Math.round(baseHp * (1 + expBonusRatio)));

      const battleInfo = {
        enemy: {
          name: enemyBase.name || `${tier} 등급의 적`,
          description: enemyBase.description || '',
          skills: enemyBase.skills || [],
          tier: tier,
          hp: finalHp,
          maxHp: finalHp,
        },
        playerHp: run.stamina,
        turn: 0,
        log: [narrativeLog]
      };

      await runRef.update({
        pending_battle: battleInfo, // battle_pending -> pending_battle로 필드명 통일
        pending_choices: null,
        turn: FieldValue.increment(1),
        events: FieldValue.arrayUnion({
          t: Date.now(),
          note: narrativeLog,
          dice: chosenDice,
          deltaStamina: 0
        }),
        prerolls: pend.nextPrerolls || run.prerolls, // [핵심 수정 2-1] 전투 진입 시에도 preroll 업데이트
        
        updatedAt: Timestamp.now()
      });
      const fresh = await runRef.get();
      return { ok:true, state: { id: runId, ...fresh.data() }, battle:true };
    }

    // 아이템 지급 로직
    let newItem = null;
    if (chosenOutcome.event_type === 'item' && chosenOutcome.item){
      newItem = {
        ...(chosenDice?.item||{}),
        ...chosenOutcome.item,
        id: 'item_' + Date.now() + '_' + Math.random().toString(36).slice(2,9)
      };
      const userInvRef = db.collection('users').doc(uid);
      await userInvRef.update({
        items_all: FieldValue.arrayUnion(newItem)
      }).catch((e) => {
        logger.error(`Failed to add item to user inventory for uid: ${uid}`, { error: e.message, newItem });
      });
    }

    const delta = Number(chosenDice?.deltaStamina || 0);
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
      prerolls: pend.nextPrerolls || run.prerolls,
      updatedAt: Timestamp.now()
    };

    await runRef.update(updates);

    if (staminaNow <= 0){
      await runRef.update({
        status: 'ended',
        endedAt: Timestamp.now(),
        reason: 'exhaust',
        pending_choices: null,
        updatedAt: Timestamp.now()
      });
      const endSnap = await runRef.get();
      return { ok:true, state: endSnap.data(), done:true };
    }

    const snap = await runRef.get();
    return { ok:true, state: { id: runId, ...snap.data() }, battle:false, done:false };
  });











  
  
  // ... (endExploreV2 함수는 기존과 동일하게 유지) ...
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

  // [신규] 전투 행동 처리 함수
  const advBattleActionV2 = onCall({ secrets:[GEMINI_API_KEY] }, async (req)=>{
    const uid = req.auth?.uid;
    if(!uid) throw new HttpsError('unauthenticated','로그인이 필요해');
    const { runId, actionType, actionIndex } = req.data||{};
    
    if(!runId || !actionType) throw new HttpsError('invalid-argument','필수값 누락');

    const runRef = db.collection('explore_runs').doc(runId);
    const charCollectionRef = db.collection('chars');
    const userRef = db.collection('users').doc(uid);

    const result = await db.runTransaction(async (tx) => {
        const runSnap = await tx.get(runRef);
        if(!runSnap.exists) throw new HttpsError('not-found','런 없음');
        const run = runSnap.data();

        if(run.owner_uid !== uid) throw new HttpsError('permission-denied','소유자 아님');
        const battle = run.pending_battle;
        if(!battle) throw new HttpsError('failed-precondition','진행중인 전투 없음');

        const charId = String(run.charRef||'').replace(/^chars\//,'');
        const charRef = charCollectionRef.doc(charId);
        const charSnap = await tx.get(charRef);
        const character = charSnap.exists ? charSnap.data() : {};
        
        let actionDetail = { type: actionType, name: '상호작용' };
        let itemToConsume = null;
        let staminaCost = 0; // 스킬 사용 시 스태미나 소모

        if (actionType === 'skill') {
            const skillIndex = Number(actionIndex);
            const equipped = character.abilities_equipped || [];
            const all = character.abilities_all || [];
            const skill = all[equipped[skillIndex]];
            if (!skill) throw new HttpsError('invalid-argument', '선택한 스킬이 없습니다.');
            actionDetail = { type: 'skill', name: skill.name, description: skill.desc_soft || '' };
            staminaCost = skill.stamina_cost || 0;
        } else if (actionType === 'item') {
            const itemIndex = Number(actionIndex);
            const userSnap = await tx.get(userRef);
            const allItems = userSnap.data()?.items_all || [];
            const equipped = character.items_equipped || [];
            const itemId = equipped[itemIndex];
            if (!itemId) throw new HttpsError('invalid-argument', '선택한 아이템이 없습니다.');

            itemToConsume = allItems.find(it => it.id === itemId);
            if (!itemToConsume) throw new HttpsError('not-found', '사용하려는 아이템을 찾을 수 없습니다.');
            actionDetail = { type: 'item', name: itemToConsume.name, description: itemToConsume.description || '' };
        }
        if (actionType === 'interact' && (run?.pending_battle?.enemy?.tier === 'boss')) {
            throw new HttpsError('failed-precondition', '보스에게는 상호작용을 사용할 수 없어');
        }

        if (battle.playerHp < staminaCost) {
            throw new HttpsError('failed-precondition', '스킬을 사용하기 위한 스태미나가 부족합니다.');
        }

        const tier = run?.pending_battle?.enemy?.tier || 'normal';
        const diff = run?.difficulty || 'normal';

        // [추가] 보상 희귀도: 난이도표 1회 + 등급표 1회 뽑아서 더 높은 쪽 선택
                let nextPrerolls = Array.isArray(run.prerolls) ? run.prerolls.slice() : [];
        const r1 = popRoll({prerolls: nextPrerolls}); nextPrerolls = r1.next; // 난이도용
        const r2 = popRoll({prerolls: nextPrerolls}); nextPrerolls = r2.next; // 등급용

        const diffRow = pickByTable(r1.value, RARITY_TABLES_BY_DIFFICULTY[diff] || RARITY_TABLES_BY_DIFFICULTY.normal);
        const tierRow = pickByTable(r2.value, TIER_RARITY_TABLE[tier] || TIER_RARITY_TABLE.normal);

        const rewardRarity = betterRarity(diffRow.rarity, tierRow.rarity);










      
        const promptKey = `battle_turn_system_${diff}_${tier}`;
        let systemPromptRaw = await loadPrompt(db, promptKey);

        if (!systemPromptRaw) {
            systemPromptRaw = await loadPrompt(db, 'battle_turn_system');
        }
        const playerExp = character.exp_total || 0;
        const damageRanges = { easy:{min:1, max:3}, normal:{min:2, max:4}, hard:{min:2, max:5}, vhard:{min:3, max:6}, legend:{min:4, max:8} };
        const baseRange = damageRanges[run.difficulty] || damageRanges.normal;
        const expBonusDamage = Math.floor(playerExp / 500);
        const finalMaxDamage = baseRange.max + expBonusDamage;
        const tierBump = { trash:0, normal:0, elite:1, boss:2 }[run?.pending_battle?.enemy?.tier || 'normal'] || 0;
        const maxDamageClamped = finalMaxDamage + tierBump;
        const rarityMap = {easy:'normal', normal:'rare', hard:'rare', vhard:'epic', legend:'epic'};
      


        const systemPrompt = [
          systemPromptRaw
            .replace(/{min_damage}/g, baseRange.min)
            .replace(/{max_damage}/g, maxDamageClamped)
            .replace(/{reward_rarity}/g, rewardRarity),
          '',
          '## 추가 규칙(중요)',
          '- 이번 호출은 "한 턴"만 처리한다.',
          '  - 1) 플레이어의 행동과 그 결과를 서술한다.',
          '  - 2) 그 후, 적이 플레이어에게 반격하는 행동을 서술한다. (매우 중요)',
          '- [상호작용 규칙] 플레이어 행동 유형이 "interact"일 경우, 상호작용의 성공 여부를 JSON 필드 `interaction_success` (true/false)로 반드시 반환해야 한다. 성공 시 `battle_over`를 true로 설정하고, 적의 반격은 생략한다.',
          '- 플레이어/적 HP가 0 이하가 되는 경우가 아니면 battle_over는 절대 true가 될 수 없다.',
          '- 과도한 피해로 한 턴에 전투가 끝나지 않도록 데미지는 {min_damage}~{max_damage} 안에서 신중히 산정한다.',
          '- narrative는 플레이어 행동과 적의 반격을 모두 포함하여 2~3 문장으로 요약한다. 적의 스킬명을 1회 언급하되 수식은 절제한다.',
          '- [매우 중요] narrative 서술 시, 적의 HP가 0 이하로 떨어지는 경우가 아니라면 "쓰러뜨렸다", "파괴했다", "끝장냈다" 등 전투의 끝을 암시하는 단정적인 표현을 절대 사용해서는 안 된다. 대신 "큰 충격을 주었다", "공격이 명중했다", "비틀거린다" 와 같이 과정에 대한 묘사에 집중해야 한다.',
        ].join('\\n');

        // [PATCH] 캐릭터 최신 서사(long) + 직전 장면을 함께 전달
        const narratives = Array.isArray(character.narratives) ? character.narratives.slice().sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)) : [];
        const latestNarr = narratives[0] || {};
        const lastScene  = (battle.log && battle.log.length > 0) ? battle.log[battle.log.length - 1] 
                          : ((run.events || []).slice(-1)[0]?.note || '(없음)');

        const userPrompt = [
          '## 전투 컨텍스트',
          `- 장소 난이도: ${run.difficulty}`,
          `- 플레이어: ${character.name} (현재 HP: ${battle.playerHp - staminaCost})`,
          `- 적: ${battle.enemy.name} (등급: ${battle.enemy.tier}, 현재 HP: ${battle.enemy.hp})`,
          `- 적 보유 스킬:\n${enemySkillsText || '(없음)'}`, // <-- 💥 이 라인을 추가하세요!
          '',
          '## 캐릭터 서사(최신)',
          String(latestNarr.long || character.summary || '(없음)'),
          '',
          '## 직전 장면 요약',
          String(lastScene),
          '',
          '## 플레이어 행동',
          JSON.stringify(actionDetail, null, 2)
        ].join('\\n');

        
        const { primary, fallback } = pickModels();
        let aiResult = {};
        try {
          aiResult = await callGemini({ apiKey: GEMINI_API_KEY.value(), systemText: systemPrompt, userText: userPrompt, logger, modelName: primary }) || {};
        } catch(e) {
          logger.warn(`[explore/battle] 1차 모델(${primary}) 호출 실패, 대체 모델(${fallback})로 재시도합니다.`, { error: e.message });
          aiResult = await callGemini({ apiKey: GEMINI_API_KEY.value(), systemText: systemPrompt, userText: userPrompt, logger, modelName: fallback }) || {};
        }

        // [PATCH] 플레이어 피해 동적 상한 (난이도/등급 + 시작HP 40% 캡)
        let playerHpChange = Math.round(Number(aiResult.playerHpChange) || 0);

        const toPlayerBase = ({ easy:1, normal:1, hard:2, vhard:2, legend:3 }[diff] ?? 1);
        const toPlayerTier = (tier === 'boss') ? 1 : 0;
        const toPlayerMaxByTable = toPlayerBase + toPlayerTier;

        // 시작 스태미나(기본 HP)의 40%를 초과할 수 없게 캡
        const toPlayerHpCap = Math.max(1, Math.ceil((run.stamina_start || STAMINA_BASE || 10) * 0.40));
        const maxToPlayer = Math.min(toPlayerMaxByTable, toPlayerHpCap);

        // 최종 클램프
        playerHpChange = Math.max(-maxToPlayer, Math.min(+maxToPlayer, playerHpChange));

        const rawEnemyDelta = Math.round(Number(aiResult.enemyHpChange) || 0);
        // [PATCH] 적 피해 상한 = (표상한 vs 적 최대HP의 30%) 중 작은 값
        const hpCap = Math.max(1, Math.ceil((battle.enemy?.maxHp || battle.enemy?.hp || 10) * 0.30));
        const maxToEnemy = Math.min(maxDamageClamped, hpCap);
        const enemyHpChange = Math.max(-maxToEnemy, Math.min(0, rawEnemyDelta));

        const maxStamina = run.stamina_start || STAMINA_BASE || 10;
        const newPlayerHp = Math.max(0, Math.min(maxStamina, battle.playerHp - staminaCost + playerHpChange));
        const newEnemyHp = Math.max(0, battle.enemy.hp + enemyHpChange);

          battle.playerHp = newPlayerHp;
          battle.enemy.hp = newEnemyHp;
          battle.log.push(aiResult.narrative || '아무 일도 일어나지 않았다.');
          battle.turn += 1;

          if (itemToConsume && (itemToConsume.isConsumable || itemToConsume.consumable)) {
              const userSnap = await tx.get(userRef);
              let allItems = userSnap.data()?.items_all || [];
              const itemIdx = allItems.findIndex(it => it.id === itemToConsume.id);
              if (itemIdx > -1) {
                  const currentUses = allItems[itemIdx].uses;
                  if (typeof currentUses === 'number' && currentUses > 1) {
                      allItems[itemIdx].uses -= 1;
                      tx.update(userRef, { items_all: allItems });
                  } else {
                      const newAllItems = allItems.filter(it => it.id !== itemToConsume.id);
                      const newEquippedItems = (character.items_equipped || []).filter(id => id !== itemToConsume.id);
                      tx.update(userRef, { items_all: newAllItems });
                      tx.update(charRef, { items_equipped: newEquippedItems });
                 }
              }
          }

          let battleResult = { battle_over: false, outcome: 'ongoing', battle_state: battle };
          const isBattleOver = newPlayerHp <= 0 || newEnemyHp <= 0 || aiResult.interaction_success === true;

          if (isBattleOver) {
              battleResult.battle_over = true;
            
              if (newEnemyHp <= 0 && newPlayerHp > 0 || aiResult.interaction_success === true) { //  승리 (상호작용 성공 포함)
                  battleResult.outcome = 'win';
                  
                  // [수정] 난이도별 경험치 보상 테이블
                  const baseExp = { trash: 10, normal: 20, elite: 40, boss: 100 }[battle.enemy.tier] || 20;
                  const difficultyMultiplier = { easy: 1.0, normal: 2.0, hard: 3.0, vhard: 7.0, legend: 14.0 }[run.difficulty] || 1.0;
                  const exp = Math.round(baseExp * difficultyMultiplier);

                  // [교체] grantExpAndMint와 동일한 경험치/코인 지급 로직을 여기에 직접 구현합니다.
                  const currentExp = Number(character.exp || 0);
                  const newTotalExp = currentExp + exp;
                  const coinsToMint = Math.floor(newTotalExp / 100);
                  const finalExp = newTotalExp % 100;

                  tx.update(charRef, { 
                      exp_total: FieldValue.increment(exp),
                      exp: finalExp
                  });
                  
                  if (coinsToMint > 0) {
                      tx.set(userRef, { coins: FieldValue.increment(coinsToMint) }, { merge: true });
                  }
                  // --- 로직 교체 끝 ---

                  // [수정] 상호작용 성공 시에는 보상 아이템을 지급하지 않도록 조건 추가
                  if (aiResult.reward_item && aiResult.interaction_success !== true) {
                      const baseRarity = ({ easy:'normal', normal:'rare', hard:'rare', vhard:'epic', legend:'epic' })[run.difficulty] || 'rare';
                      const fallbackItem = {
                          name: `${battle.enemy.name}의 파편`,
                          rarity: baseRarity,
                          description: `${battle.enemy.name}을 쓰러뜨려 얻은 파편. 장소의 기운이 스며 있다.`,
                          isConsumable: false, uses: 1
                      };
                      const reward = (aiResult.reward_item && typeof aiResult.reward_item === 'object')
                        ? { ...aiResult.reward_item, rarity: rewardRarity } // AI가 다른 등급을 써도 서버에서 강제 통일
                        : fallbackItem;
                      const newItem = { ...reward, id: 'item_' + Date.now() + '_' + Math.random().toString(36).slice(2,9) };
                      tx.update(userRef, { items_all: FieldValue.arrayUnion(newItem) });
                  }

                  tx.update(runRef, {
                      pending_battle: null,
                      stamina: newPlayerHp,
                      events: FieldValue.arrayUnion(
                        { t: Date.now(), kind:'combat-log',  note: (battle.log || []).join('\n'), lines: (battle.log || []).length },
                        { t: Date.now(), kind:'combat-win',  note: `${battle.enemy.name}을(를) 처치했다! (경험치 +${exp})`, exp }
                      ),
                      prerolls: nextPrerolls,

                      
                  });

               } else { // 패배 또는 무승부
                  battleResult.outcome = 'loss';
                  tx.update(runRef, {
                    status: 'ended',
                    reason: 'battle_lost',
                    endedAt: Timestamp.now(),
                    pending_battle: null,
                    stamina: 0,
                    prerolls: nextPrerolls,
                    events: FieldValue.arrayUnion(
                      { t: Date.now(), kind:'combat-log',  note: (battle.log || []).join('\n'), lines: (battle.log || []).length },
                      { t: Date.now(), kind:'combat-loss', note: `${battle.enemy.name}에게 패배했다.` }
                    ),
                  });

              }
          } else { // 전투 계속
              tx.update(runRef, { pending_battle: battle, stamina: newPlayerHp, prerolls: nextPrerolls });
          }
  
          return battleResult;
      });

      return { ok: true, ...result };
  });
  // [신규] 전투 후퇴(도망) 함수
  const advBattleFleeV2 = onCall({ secrets:[GEMINI_API_KEY] }, async (req)=>{
    const uid = req.auth?.uid;
    if(!uid) throw new HttpsError('unauthenticated','로그인이 필요해');
    const { runId } = req.data||{};
    if(!runId) throw new HttpsError('invalid-argument','runId 필요');

    const runRef = db.collection('explore_runs').doc(runId);
    const runSnap = await runRef.get();
    if(!runSnap.exists) throw new HttpsError('not-found','런 없음');
    const run = runSnap.data();
    if(run.owner_uid !== uid) throw new HttpsError('permission-denied','소유자 아님');
    const battle = run.pending_battle;
    if(!battle) throw new HttpsError('failed-precondition','진행중인 전투 없음');

    const tier = battle.enemy.tier || 'normal';
    const penaltyMap = { trash: 1, normal: 1, elite: 2, boss: 3 };
    const penalty = penaltyMap[tier] || 1;
    const newStamina = Math.max(0, run.stamina - penalty);
    const note = `${battle.enemy.name}에게서 도망쳤다. (스테미나 -${penalty})`;

    const updates = {
      pending_battle: null,
      stamina: newStamina,
      turn: FieldValue.increment(1),
      events: FieldValue.arrayUnion({ t: Date.now(), note, kind: 'combat-retreat', deltaStamina: -penalty })
    };
   

    if (newStamina <= 0) {
      updates.status = 'ended';
      updates.reason = 'flee_exhaust';
      updates.endedAt = Timestamp.now();
    }
    
    await runRef.update(updates);

    return { ok: true, done: newStamina <= 0, newStamina };
  });

  return { startExploreV2, advPrepareNextV2, advApplyChoiceV2, endExploreV2, advBattleActionV2, advBattleFleeV2 };
};


