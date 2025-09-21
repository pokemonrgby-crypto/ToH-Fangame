/* === functions/battle/index.js (FULL) ===
 * - Firebase Functions v2 (Node 18)
 * - 무승부 금지
 * - 프롬프트: battle_sketch_system → battle_choice_system → battle_final_system
 * - EXP: 스케치의 exp_char0/exp_char1 그대로 적용 (100 누적 시 코인 +1 민팅)
 * - Elo 갱신 (무승부 없음)
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
try { admin.app(); } catch { admin.initializeApp(); }
const db = admin.firestore();
const { Timestamp, FieldValue } = require('firebase-admin/firestore');

const { defineSecret } = require('firebase-functions/params');
const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY'); // firebase functions:secrets:set GEMINI_API_KEY

// ---------- 공통 유틸 ----------
function stripFences(s=''){
  return String(s).trim().replace(/^```(?:json)?\s*/,'').replace(/```$/,'').trim();
}
function tryJsonSafe(t){
  if(!t) return null;
  try { return JSON.parse(stripFences(t)); } catch { return null; }
}
function esc(s){ return String(s ?? '').replace(/[<>]/g, m=>({ '<':'&lt;','>':'&gt;' }[m])); }

// Gemini 호출 (서버 직통)
async function callGeminiServer(model, systemText, userText, temperature=0.8, maxOutputTokens=1200){
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY.value()}`;
  const body = {
    systemInstruction: { role: 'system', parts: [{ text: String(systemText||'') }] },
    contents: [{ role: 'user', parts: [{ text: String(userText||'') }] }],
    generationConfig: {
      temperature,
      maxOutputTokens,
      topK: 40,
      topP: 0.95,
      candidateCount: 1,
      responseMimeType: "application/json"
    },
    safetySettings: [
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_UNSPECIFIED", threshold: "BLOCK_NONE" }
    ]
  };
  const res = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  if(!res.ok){
    const txt = await res.text().catch(()=> '');
    throw new HttpsError('internal', `Gemini ${model} 호출 실패: ${res.status} ${txt}`);
  }
  const j = await res.json().catch(()=>null);
  // 응답 파싱 (v1beta 공통)
  const text =
    j?.candidates?.[0]?.content?.parts?.[0]?.text ??
    j?.candidates?.[0]?.content?.parts?.[0]?.raw_text ??
    j?.candidates?.[0]?.content?.parts?.[0]?.inline_data?.data ??
    j?.candidates?.[0]?.groundingMetadata?.searchEntryPoint ??
    j?.text ?? '';
  if(!text) throw new HttpsError('internal', 'Gemini 응답이 비어 있음');
  return text;
}

// 서버에서 프롬프트 로드 (configs/prompts)
async function fetchPromptDocServer(id){
  const ref = db.doc('configs/prompts');
  const snap = await ref.get();
  if(!snap.exists) throw new HttpsError('failed-precondition','프롬프트 저장소(configs/prompts)가 없어');
  const all = snap.data() || {};
  const raw = all[id];
  if (raw === undefined || raw === null) throw new HttpsError('not-found', `프롬프트 ${id} 가 없어`);
  let content = (typeof raw === 'object' ? (raw.content ?? raw.text ?? raw.value ?? '') : String(raw ?? '')).trim();
  if(!content) throw new HttpsError('failed-precondition', `프롬프트 ${id} 내용이 비어 있어`);
  return content;
}

// EXP → 코인 민팅 (100 EXP당 +1 coin)
async function mintByAddExp(tx, charRef, addExp, note){
  addExp = Math.max(0, Math.floor(Number(addExp)||0));
  if (addExp <= 0) return { minted:0, expAfter:null, ownerUid:null };

  const cSnap = await tx.get(charRef);
  if(!cSnap.exists) throw new HttpsError('not-found','char not found');
  const c = cSnap.data() || {};
  const ownerUid = c.owner_uid;
  if (!ownerUid) throw new HttpsError('failed-precondition','char.owner_uid missing');

  const exp0 = Math.floor(Number(c.exp || 0));
  const exp1 = exp0 + addExp;
  const minted = Math.floor(exp1 / 100);
  const exp2 = exp1 - minted*100;

  const userRef = db.doc(`users/${ownerUid}`);
  tx.update(charRef, {
    exp_total: FieldValue.increment(addExp),
    exp: exp2,
    updatedAt: Timestamp.now(),
  });
  if (minted > 0) {
    tx.set(userRef, { coins: FieldValue.increment(minted) }, { merge:true });
  }
  tx.set(db.collection('exp_logs').doc(), {
    char_id: charRef.path,
    owner_uid: ownerUid,
    add: addExp, minted,
    note: note || null,
    at: Timestamp.now(),
  });
  return { minted, expAfter: exp2, ownerUid };
}

// Elo 갱신 (무승부 없음)
function nextElo(Ra=1000, Rb=1000, sA=1, sB=0, kA=24, kB=24){
  const Ea = 1/(1+Math.pow(10, (Rb-Ra)/400));
  const Eb = 1 - Ea;
  const Ra2 = Math.round(Ra + kA*(sA - Ea));
  const Rb2 = Math.round(Rb + kB*(sB - Eb));
  return [Ra2, Rb2];
}

// ========== 3) 배틀 실행(텍스트만) ==========
exports.runBattleTextOnly = onCall({ region:'us-central1', secrets:[GEMINI_API_KEY] }, async (req) => {
  const uid = req.auth?.uid;
  if(!uid) throw new HttpsError('unauthenticated','로그인이 필요해');

  const attackerId = String(req.data?.attackerId||'').replace(/^chars\//,'');
  const defenderId = String(req.data?.defenderId||'').replace(/^chars\//,'');
  const worldId    = String(req.data?.worldId||'gionkir');

  const simulate  = !!req.data?.simulate;   // ★ 모의전 플래그

  if(!attackerId || !defenderId) throw new HttpsError('invalid-argument','attackerId/defenderId 필요');

  const userRef = db.doc(`users/${uid}`);

  const nowSec = Math.floor(Date.now() / 1000);
  const userSnap = await userRef.get();
  const userData = userSnap.exists() ? userSnap.data() : {};
  const rawCooldown = userData.cooldown_all_until;
  const cooldownUntil = (typeof rawCooldown === 'number')
  ? (Number(rawCooldown) || 0)
  : (rawCooldown?.toMillis ? Math.floor(rawCooldown.toMillis() / 1000) : 0);

  if (cooldownUntil > nowSec) {
    const left = cooldownUntil - nowSec;
    throw new HttpsError('failed-precondition', `공용 쿨타임이 ${left}초 남았습니다.`);
  }

  const Aref = db.doc(`chars/${attackerId}`);
  const Bref = db.doc(`chars/${defenderId}`);
  const [As, Bs] = await Promise.all([ Aref.get(), Bref.get() ]);
  if(!As.exists || !Bs.exists) throw new HttpsError('not-found','캐릭터 문서를 찾을 수 없어');
  const A = As.data()||{}, B = Bs.data()||{};
  if (A.owner_uid !== uid) throw new HttpsError('permission-denied','내 캐릭터만 배틀 시작 가능');

  let relationNote = '없음';
  try {
    const rId = [attackerId, defenderId].sort().join('__');
    const baseRef = db.doc(`relations/${rId}`);
    const [baseSnap, noteSnap] = await Promise.all([
      baseRef.get(),
      baseRef.collection('meta').doc('note').get()
    ]);
    relationNote = noteSnap.exists
      ? String(noteSnap.data()?.note || '없음')
      : (baseSnap.exists && baseSnap.data()?.note ? String(baseSnap.data().note) : '없음');
  } catch { relationNote = '없음'; }

  const sketchSys = await fetchPromptDocServer('battle_sketch_system');
  const choiceSys = await fetchPromptDocServer('battle_choice_system');
  const finalSys  = await fetchPromptDocServer('battle_final_system');

  const pick = (arr, ids) => (Array.isArray(arr)&&Array.isArray(ids)) ? arr.filter((_,i)=>ids.includes(i)) : [];
  const A_equipped = pick(A.abilities_all, A.abilities_equipped||[]);
  const B_equipped = pick(B.abilities_all, B.abilities_equipped||[]);
  const skillsToText = xs => (xs||[]).map(s => `${s?.name||''}: ${s?.desc_soft||''}`).filter(Boolean).join('\n') || '없음';
  const itemNames = (ids=[]) => Array.isArray(ids) && ids.length ? ids.map(id=>String(id)).join(', ') : '없음';

  const battleConcepts = [
    '좁은 다리 위 근접 난전',
    '지형 고지 선점 전투',
    '시야 차단 · 아이템 난전'
  ];

  const userSketch = `
<INPUT>
  ## 전투 컨셉 (랜덤 3종)
  ${battleConcepts.map((c,i)=>`- 컨셉 ${i+1}: ${c}`).join('\n')}
  ## 캐릭터 관계
  - ${relationNote}
  ## 캐릭터 1 (index 0) 정보
  - 이름: ${A.name}
  - 출신: ${A.world_id || worldId}
  - 최근 서사: ${(A.narratives?.[0]?.long) || A.summary || ''}
  - 이전 서사 요약: ${(A.narratives||[]).slice(1).map(n=>n.short).join(' ') || A.narratives?.[0]?.short || '특이사항 없음'}
  - 스킬: ${skillsToText(A_equipped)}
  - 아이템: ${itemNames(A.items_equipped)}
  ## 캐릭터 2 (index 1) 정보
  - 이름: ${B.name}
  - 출신: ${B.world_id || worldId}
  - 최근 서사: ${(B.narratives?.[0]?.long) || B.summary || ''}
  - 이전 서사 요약: ${(B.narratives||[]).slice(1).map(n=>n.short).join(' ') || B.narratives?.[0]?.short || '특이사항 없음'}
  - 스킬: ${skillsToText(B_equipped)}
  - 아이템: ${itemNames(B.items_equipped)}
</INPUT>
`.trim();

  const sketchesRaw = await callGeminiServer('gemini-2.0-flash', sketchSys, userSketch, 0.8, 1400);
  let sketches = tryJsonSafe(sketchesRaw);
  if (!Array.isArray(sketches) || sketches.length !== 3) {
    const sketchesRaw2 = await callGeminiServer('gemini-2.0-flash', sketchSys+'\n[STRICT JSON ONLY]', userSketch, 0.3, 1000);
    sketches = tryJsonSafe(sketchesRaw2);
  }
  if (!Array.isArray(sketches) || sketches.length !== 3) {
    logger.error('sketch invalid', { head: String(sketchesRaw||'').slice(0,400) });
    throw new HttpsError('internal', 'AI가 3개의 유효한 스케치를 반환하지 않았어');
  }

  const choiceRaw = await callGeminiServer('gemini-2.0-flash', choiceSys, `<INPUT>${JSON.stringify(sketches)}</INPUT>`, 0.7, 200);
  const choice = tryJsonSafe(choiceRaw) || {};
  const bestIndex = (typeof choice.best_sketch_index==='number' && choice.best_sketch_index>=0 && choice.best_sketch_index<3)
    ? choice.best_sketch_index
    : Math.floor(Math.random()*3);

  const chosen = sketches[bestIndex] || sketches[0];
  const winner_id = (chosen.winner_index === 0) ? 'A' : 'B';
  const expA = Math.max(1, Math.min(100, parseInt(chosen.exp_char0||0,10) || 5));
  const expB = Math.max(1, Math.min(100, parseInt(chosen.exp_char1||0,10) || 5));
  const itemsUsed = []
    .concat((chosen.items_used_by_char0||[]).map(n => ({ who:'A', name:String(n||'') })))
    .concat((chosen.items_used_by_char1||[]).map(n => ({ who:'B', name:String(n||'') })));

  const contextForFinal = `
<CONTEXT>
  ## 선택된 전투 시나리오 (이 내용을 반드시 따라야 합니다)
  - **승자 인덱스**: ${chosen.winner_index} (${chosen.winner_index === 0 ? A.name : B.name}의 승리)
  - **획득 EXP**: 캐릭터1(${A.name}) ${expA}, 캐릭터2(${B.name}) ${expB}
  - **사용된 아이템**: ${JSON.stringify({char0: chosen.items_used_by_char0||[], char1: chosen.items_used_by_char1||[]})}
  - **전투 개요**: ${chosen.sketch_text}
  ## 캐릭터 정보
  - 관계: ${relationNote}
  - 캐릭터 1 (index 0, ${A.name}): ${JSON.stringify(A)}
  - 캐릭터 2 (index 1, ${B.name}): ${JSON.stringify(B)}
</CONTEXT>
`.trim();

  const finalRaw   = await callGeminiServer('gemini-2.0-flash', finalSys, contextForFinal, 0.85, 2000);
  const finalJson  = tryJsonSafe(finalRaw) || {};
  const battleTitle   = String(finalJson.title || '치열한 결투');
  const battleContent = String(finalJson.content || '결과를 생성하는 데 실패했습니다.');

  const WINDOW = 300;
  const nowSecAfter = Math.floor(Date.now() / 1000);
  const uShot = await userRef.get();
  const exist = uShot.exists ? uShot.get('cooldown_all_until') : 0;
  const existSec = (typeof exist === 'number')
    ? (Number(exist) || 0)
    : (exist?.toMillis ? Math.floor(exist.toMillis() / 1000) : 0);
  const nextBoundary = Math.ceil(nowSecAfter / WINDOW) * WINDOW;
  const untilSec = Math.max(existSec, nextBoundary);
  await userRef.set({ cooldown_all_until: untilSec }, { merge: true });

  if (simulate) {
    const logRef = db.collection('battle_logs').doc();
    await logRef.set({
      id: logRef.id,
      world_id: worldId,
      created_at: Timestamp.now(),
      attacker_uid: uid,
      attacker_char: `chars/${attackerId}`,
      defender_char: `chars/${defenderId}`,
      attacker_snapshot: { name: A.name, thumb_url: A.thumb_url || null },
      defender_snapshot: { name: B.name, thumb_url: B.thumb_url || null },
      winner: (chosen.winner_index === 0 ? 'A' : 'B'),
      winner_char_id: (chosen.winner_index === 0 ? attackerId : defenderId),
      exp_char0: 0,
      exp_char1: 0,
      items_used: itemsUsed,
      title: String(finalJson.title || '연습전'),
      content: String(finalJson.content || battleContent || ''),
      sketch_index: (typeof chosen.winner_index==='number' ? chosen.winner_index : null),
      sketch_text: String(chosen?.sketch_text||''),
      relation: relationNote,
      simulated: true,
      endedAt: Timestamp.now()
    });
    return { ok:true, logId: logRef.id, simulated:true, cooldownUntilMs: untilSec * 1000 };
  }

  const logRef = db.collection('battle_logs').doc();
  const score  = [expA, expB];
  const sA = winner_id==='A' ? 1 : 0;
  const sB = winner_id==='B' ? 1 : 0;

  await db.runTransaction(async (tx) => {
    const Ashot = await tx.get(Aref);
    const Bshot = await tx.get(Bref);
    if(!Ashot.exists || !Bshot.exists) throw new HttpsError('aborted','char vanished');

    const A0 = Ashot.data()||{};
    const B0 = Bshot.data()||{};
    const Ra = Math.floor(Number(A0.elo || 1000));
    const Rb = Math.floor(Number(B0.elo || 1000));
    const [Ra2, Rb2] = nextElo(Ra, Rb, sA, sB, 24, 24);

    await mintByAddExp(tx, Aref, score[0], `battle:${logRef.id}`);
    await mintByAddExp(tx, Bref, score[1], `battle:${logRef.id}`);

    tx.update(Aref, {
      elo: Ra2,
      battle_count: FieldValue.increment(1),
      wins:   FieldValue.increment(sA ? 1 : 0),
      losses: FieldValue.increment(sA ? 0 : 1),
      updatedAt: Timestamp.now(),
    });
    tx.update(Bref, {
      elo: Rb2,
      battle_count: FieldValue.increment(1),
      wins:   FieldValue.increment(sB ? 1 : 0),
      losses: FieldValue.increment(sB ? 0 : 1),
      updatedAt: Timestamp.now(),
    });

    tx.set(logRef, {
      id: logRef.id,
      world_id: worldId,
      created_at: Timestamp.now(),
      attacker_id: Aref.id,
      defender_id: Bref.id,
      winner: winner_id,
      winner_char_id: winner_id==='A' ? Aref.id : Bref.id,
      exp_char0: score[0],
      exp_char1: score[1],
      items_used: itemsUsed,
      title: battleTitle,
      content: battleContent,
      sketch_index: (chosen && typeof chosen.winner_index==='number') ? chosen.winner_index : null,
      sketch_text: String(chosen?.sketch_text||''),
      relation: relationNote,
    });
  });

  return { ok:true, logId: logRef.id, winner: winner_id, itemsUsed, cooldownUntilMs: untilSec * 1000 };
});
