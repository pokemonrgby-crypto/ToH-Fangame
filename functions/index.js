 // functions/index.js
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
try { admin.app(); } catch { admin.initializeApp(); }
const db = admin.firestore();
const { initializeApp } = require('firebase-admin/app');

const crypto = require('crypto');
const { Timestamp, FieldValue, FieldPath } = require('firebase-admin/firestore');

const { defineSecret } = require('firebase-functions/params');
const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY'); // 이미 있다면 재사용

const exploreV2 = require('./explore_v2')(admin, { onCall, HttpsError, logger, GEMINI_API_KEY });
const encounterV2 = require('./encounter_v2')(admin, { onCall, HttpsError, logger, GEMINI_API_KEY });


// === [탐험 난이도/룰 테이블 & 헬퍼] ===
const EXPLORE_CONFIG = {
  staminaStart: 10,
  exp: { basePerTurn: 6, min: 10, max: 120 },
  diff: {
    easy:  { rewardMult:1.0, prob:{calm:35, find:25, trap:10, rest:20, battle:10}, trap:[1,2], battle:[1,2], rest:[1,2] },
    normal:{ rewardMult:1.2, prob:{calm:30, find:22, trap:18, rest:15, battle:15}, trap:[1,3], battle:[1,3], rest:[1,2] },
    hard:  { rewardMult:1.4, prob:{calm:25, find:20, trap:25, rest:10, battle:20}, trap:[2,4], battle:[2,4], rest:[1,1] },
    vhard: { rewardMult:1.6, prob:{calm:20, find:18, trap:30, rest: 8, battle:24}, trap:[2,5], battle:[3,5], rest:[1,1] },
    legend:{ rewardMult:1.8, prob:{calm:15, find:15, trap:35, rest: 5, battle:30}, trap:[3,6], battle:[3,6], rest:[1,1] },
  }
};
function pickByProb(prob){
  const entries = Object.entries(prob);
  const total = entries.reduce((s,[,p])=>s+p,0) || 1;
  let r = Math.floor(Math.random()*total)+1;
  for(const [k,p] of entries){ r-=p; if(r<=0) return k; }
  return entries[0][0];
}
function clamp(n,min,max){ return Math.max(min, Math.min(max, n)); }
function nowTs(){ const { Timestamp } = require('firebase-admin/firestore'); return Timestamp.now(); }
function coolMillis(ts){ try{ return ts?.toMillis?.()||0; }catch{ return 0; } }



// 캐릭 EXP에 addExp 더하고, 100단위로 코인을 민팅하여 "소유 유저" 지갑에 적립한다.
// 결과적으로 캐릭 문서에는 exp(0~99), exp_total(누적), updatedAt 이 반영된다.
async function mintByAddExp(tx, charRef, addExp, note) {
  addExp = Math.max(0, Math.floor(Number(addExp) || 0));
  if (addExp <= 0) return { minted: 0, expAfter: null, ownerUid: null };

  const cSnap = await tx.get(charRef);
  if (!cSnap.exists) throw new Error('char not found');
  const c = cSnap.data() || {};
  const ownerUid = c.owner_uid;
  if (!ownerUid) throw new Error('owner_uid missing');

  const exp0  = Math.floor(Number(c.exp || 0));
  const exp1  = exp0 + addExp;
  const mint  = Math.floor(exp1 / 100);
  const exp2  = exp1 - (mint * 100); // 0~99
  const userRef = db.doc(`users/${ownerUid}`);

  tx.update(charRef, {
    exp: exp2,
    exp_total: admin.firestore.FieldValue.increment(addExp),
    updatedAt: Timestamp.now(),
  });
  tx.set(userRef, { coins: admin.firestore.FieldValue.increment(mint) }, { merge: true });

  // (선택) 로그 남기고 싶으면 주석 해제
   tx.set(db.collection('exp_logs').doc(), {
     char_id: charRef.path,
     owner_uid: ownerUid,
     add: addExp, minted: mint,
     note: note || null,
     at: Timestamp.now(),
   });

  return { minted: mint, expAfter: exp2, ownerUid };
}




function pickWeighted(cands, myElo){
  const bag=[];
  for(const c of cands){
    const e = Math.abs((c.elo ?? 1000) - myElo);
    const w = Math.max(1, Math.ceil(200/(1+e)+1));
    for(let i=0;i<w;i++) bag.push(c);
  }
  return bag.length ? bag[Math.floor(Math.random()*bag.length)] : null;
}

// moved: delegate to new matcher (TS/JS)
exports.requestMatch = require('./match').requestMatch;


exports.setGlobalCooldown = onCall({ region:'us-central1' }, async (req)=>{
  try{
    const uid = req.auth?.uid;
    if(!uid) throw new HttpsError('unauthenticated','로그인이 필요해');

    const seconds = Math.max(1, Math.min(600, Number(req.data?.seconds || 60)));
    const userRef = db.doc(`users/${uid}`);

    await db.runTransaction(async (tx)=>{
      const now = Timestamp.now();
      const snap = await tx.get(userRef);
      const exist = snap.exists ? snap.get('cooldown_all_until') : null;
      const baseMs = Math.max(exist?.toMillis?.() || 0, now.toMillis());
      const until = Timestamp.fromMillis(baseMs + seconds*1000);
      tx.set(userRef, { cooldown_all_until: until }, { merge:true });
    });

    return { ok:true };
  }catch(err){
    logger.error('[setGlobalCooldown] fail', err);
    if (err instanceof HttpsError) throw err;
    throw new HttpsError('internal','cooldown-internal-error',{message:err?.message||String(err)});
  }
});


// === [탐험 시작] onCall ===
exports.startExplore = onCall({ region:'us-central1' }, async (req)=>{
  const uid = req.auth?.uid;
  if(!uid) throw new HttpsError('unauthenticated','로그인이 필요해');

  const { charId, worldId, siteId, difficulty } = req.data || {};
  if(!charId || !worldId || !siteId) throw new HttpsError('invalid-argument','필수값 누락');

  const charRef = db.doc(`chars/${charId}`);
  const userRef = db.doc(`users/${uid}`);
  const runRef  = db.collection('explore_runs').doc();

  // [탐험 전용 쿨타임] 1시간 — 시작 시점에 검사
  const userSnap = await userRef.get();
  const cd = userSnap.exists ? userSnap.get('cooldown_explore_until') : null;
  if (cd && cd.toMillis() > Date.now()){
    return { ok:false, reason:'cooldown', until: cd.toMillis() };
  }

  // 캐릭/소유권 검사 + 동시진행 금지
  const charSnap = await charRef.get();
  if(!charSnap.exists) throw new HttpsError('failed-precondition','캐릭터 없음');
  const ch = charSnap.data()||{};
  if (ch.owner_uid !== uid) throw new HttpsError('permission-denied','내 캐릭만 시작 가능');
  if (ch.explore_active_run) {
    const old = await db.doc(ch.explore_active_run).get();
    if (old.exists) return { ok:true, reused:true, runId: old.id, data: old.data() };
  }

  const diffKey = (EXPLORE_CONFIG.diff[difficulty] ? difficulty : 'normal');
  const payload = {
    charRef: charRef.path, owner_uid: uid,
    worldId, siteId, difficulty: diffKey,
    status:'running',
    staminaStart: EXPLORE_CONFIG.staminaStart,
    staminaNow:  EXPLORE_CONFIG.staminaStart,
    turn:0, events: [],
    createdAt: nowTs(), updatedAt: nowTs()
  };

  await db.runTransaction(async (tx)=>{
    const cdoc = await tx.get(charRef);
    const c = cdoc.data()||{};
    if (c.explore_active_run) throw new HttpsError('aborted','이미 진행중');

    tx.set(runRef, payload);
    tx.update(charRef, { explore_active_run: runRef.path, updatedAt: Date.now() });

    // [쿨타임 1시간] — 현재 남은 쿨타임보다 “연장만”
    const baseMs = Math.max(coolMillis(userSnap.get?.('cooldown_explore_until')), Date.now());
    const until  = require('firebase-admin/firestore').Timestamp.fromMillis(baseMs + 60*60*1000);
    tx.set(userRef, { cooldown_explore_until: until }, { merge:true });
  });

  return { ok:true, runId: runRef.id, data: payload, cooldownApplied:true };
});

// === [탐험 한 턴 진행] onCall ===
exports.stepExplore = onCall({ region:'us-central1' }, async (req)=>{
  const uid = req.auth?.uid;
  if(!uid) throw new HttpsError('unauthenticated','로그인이 필요해');
  const { runId } = req.data||{};
  if(!runId) throw new HttpsError('invalid-argument','runId 필요');

  const runRef = db.doc(`explore_runs/${runId}`);
  const snap = await runRef.get();
  if(!snap.exists) throw new HttpsError('not-found','run 없음');
  const r = snap.data()||{};
  if (r.owner_uid !== uid) throw new HttpsError('permission-denied', '내 진행만 가능');
  if (r.status !== 'running') return { ok:false, reason:'not-running' };

  const DC = EXPLORE_CONFIG.diff[r.difficulty] || EXPLORE_CONFIG.diff.normal;
  const kind = pickByProb(DC.prob);
  const roll = 1 + Math.floor(Math.random()*100);
  const rnd  = (a,b)=> a + Math.floor(Math.random()*(b-a+1));

  let delta = 0, text='';
  if (kind==='calm'){   delta=-1;                text='고요한 이동… 체력 -1'; }
  else if (kind==='find'){ delta=-1;             text='무언가를 발견했어! (임시 보상 후보) 체력 -1'; }
  else if (kind==='trap'){ delta= -rnd(DC.trap[0],   DC.trap[1]); text=`함정! 체력 ${delta}`; }
  else if (kind==='rest'){ delta=  rnd(DC.rest[0],   DC.rest[1]); text=`짧은 휴식… 체력 +${delta}`; }
  else if (kind==='battle'){delta= -rnd(DC.battle[0], DC.battle[1]); text=`소규모 교전! 체력 ${delta}`; }

  const staminaNow = clamp((r.staminaNow|0) + delta, 0, 999);
  const turn = (r.turn|0) + 1;
  const ev = { step:turn, kind, deltaStamina:delta, desc:text, roll:{d:'d100', value:roll}, ts: nowTs() };
  const willEnd = staminaNow<=0;

  const { FieldValue, Timestamp } = require('firebase-admin/firestore');
  await runRef.update({
    staminaNow, turn,
    events: FieldValue.arrayUnion(ev),
    status: willEnd ? 'done' : 'running',
    endedAt: willEnd ? Timestamp.now() : FieldValue.delete(),
    updatedAt: Timestamp.now()
  });

  return { ok:true, done:willEnd, step:turn, staminaNow, event: ev };
});

// === [탐험 종료 & 보상 확정] onCall ===
exports.endExplore = onCall({ region:'us-central1' }, async (req)=>{
  const uid = req.auth?.uid;
  if(!uid) throw new HttpsError('unauthenticated','로그인이 필요해');
  const { runId } = req.data||{};
  if(!runId) throw new HttpsError('invalid-argument','runId 필요');

  const runRef = db.doc(`explore_runs/${runId}`);
  const snap = await runRef.get();
  if(!snap.exists) throw new HttpsError('not-found','run 없음');
  const r = snap.data()||{};
  if (r.owner_uid !== uid) throw new HttpsError('permission-denied','내 진행만 가능');

  const charId = (r.charRef||'').replace('chars/','');
  const charRef = db.doc(`chars/${charId}`);

  const CFG = EXPLORE_CONFIG, DC = CFG.diff[r.difficulty] || CFG.diff.normal;
  const turns = (r.turn|0);
  const runMult = 1 + Math.min(0.6, 0.05*Math.max(0, turns-1));
  let exp = Math.round(CFG.exp.basePerTurn * turns * DC.rewardMult * runMult);
  exp = clamp(exp, CFG.exp.min, CFG.exp.max);

  const { Timestamp, FieldValue } = require('firebase-admin/firestore');
  const itemRef = db.collection('char_items').doc();
  const itemPayload = {
    owner_uid: uid,
    char_id: r.charRef,
    item_name: '탐험 더미 토큰',
    rarity: 'common',
    uses_remaining: 3,
    desc_short: '탐험 P0 보상 아이템(더미)',
    createdAt: Timestamp.now(),
    source: { type:'explore', runRef: runRef.path, worldId: r.worldId, siteId: r.siteId }
  };

  await db.runTransaction(async (tx)=>{
    tx.set(itemRef, itemPayload, { merge:true });
    tx.update(runRef, {
      status:'done', endedAt: Timestamp.now(),
      rewards: { exp, items:[{ id:itemRef.id, rarity:itemPayload.rarity, name:itemPayload.item_name }] },
      updatedAt: Timestamp.now()
    });

    // EXP→코인 민팅 (캐릭 exp는 0~99로, 유저 지갑 coins는 +minted)
    const result = await mintByAddExp(tx, charRef, exp, `explore:${runRef.id}`);

    // 진행중 플래그 해제
    tx.update(charRef, { explore_active_run: FieldValue.delete() });

  });

  return { ok:true, exp, itemId: itemRef.id };
});

// === [일반 EXP 지급 + 코인 민팅] onCall ===
// 호출: httpsCallable('grantExpAndMint')({ charId, exp, note })
exports.grantExpAndMint = onCall({ region:'us-central1' }, async (req)=>{
  const uid = req.auth?.uid;
  if(!uid) throw new Error('unauthenticated');

  const { charId, exp, note } = req.data || {};
  if(!charId || !Number.isFinite(Number(exp))) throw new Error('bad-args');

  const charRef = db.doc(`chars/${String(charId).replace(/^chars\//,'')}`);

  const res = await db.runTransaction(async (tx)=>{
    return await mintByAddExp(tx, charRef, Number(exp)||0, note||'misc');
  });

  return { ok:true, ...res };
});








// --- 공통 로직으로 분리 ---
// 기존 onCall 핸들러 내부 내용을 이 함수에 그대로 둡니다.
// (차이점: req.auth?.uid → uid, req.data → data 로 바뀝니다)
async function sellItemsCore(uid, data) {
  if (!uid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }

  const { itemIds } = data || {};
  if (!Array.isArray(itemIds) || itemIds.length === 0) {
    throw new HttpsError('invalid-argument', '판매할 아이템 ID 목록이 올바르지 않습니다.');
  }

  const userRef = db.doc(`users/${uid}`);

  try {
    const { goldEarned, itemsSoldCount } = await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) {
        throw new HttpsError('not-found', '사용자 정보를 찾을 수 없습니다.');
      }

      const userData = userSnap.data() || {};
      const currentItems = userData.items_all || [];
      let totalGold = 0;

      // 판매 가격 정책
      const prices = {
        consumable: { normal: 1, rare: 5, epic: 25, legend: 50, myth: 100, aether: 250 },
        non_consumable: { normal: 2, rare: 10, epic: 50, legend: 100, myth: 200, aether: 500 }
      };

      const itemsToKeep = [];
      const soldItemIds = new Set(itemIds);

      // 1. 판매될 아이템을 장착한 내 모든 캐릭터를 찾습니다.
      const charsRef = db.collection('chars');
      const query = charsRef.where('owner_uid', '==', uid).where('items_equipped', 'array-contains-any', itemIds);
      const equippedCharsSnap = await tx.get(query);

      // 2. 각 캐릭터의 장착 목록에서 판매될 아이템 ID를 제거합니다.
      equippedCharsSnap.forEach(doc => {
        const charData = doc.data();
        const newEquipped = (charData.items_equipped || []).filter(id => !soldItemIds.has(id));
        tx.update(doc.ref, { items_equipped: newEquipped });
      });

      for (const item of currentItems) {
        if (soldItemIds.has(item.id)) {
          // 'consume' 속성도 확인하도록 수정된 부분입니다.
          const isConsumable = item.isConsumable || item.consumable || item.consume;
          const priceTier = isConsumable ? prices.consumable : prices.non_consumable;
          const price = priceTier[item.rarity] || 0;
          totalGold += price;
        } else {
          itemsToKeep.push(item);
        }
      }

      if (totalGold > 0) {
        tx.update(userRef, {
          items_all: itemsToKeep,
          coins: admin.firestore.FieldValue.increment(totalGold)
        });
      }

      const soldCount = currentItems.length - itemsToKeep.length;
      return { goldEarned: totalGold, itemsSoldCount: soldCount };
    });

    logger.info(`User ${uid} sold ${itemsSoldCount} items for ${goldEarned} gold.`);
    return { ok: true, goldEarned, itemsSoldCount };

  } catch (error) {
    logger.error(`Error selling items for user ${uid}:`, error);
    if (error instanceof HttpsError) {
      throw error;
    }
    throw new HttpsError('internal', '아이템 판매 중 오류가 발생했습니다.');
  }
}

// 1) 최신 프론트에서 httpsCallable로 부르는 엔드포인트(이름 변경)
exports.sellItems = onCall({ region: 'us-central1' }, async (req) => {

  const uid = req.auth?.uid || req.auth?.token?.uid;
  return await sellItemsCore(uid, req.data);
});

// 2) 옛 코드가 "직접 URL"로 치는 경우를 위한 HTTP 엔드포인트 (CORS 포함)
exports.sellItemsHttp = onRequest({ region: 'us-central1' }, async (req, res) => {

  // CORS 허용 (필요한 출처만 추가)
  const origin = req.get('origin');
  const allow = new Set([
    'https://tale-of-heros---fangame.firebaseapp.com',
    'https://tale-of-heros---fangame.web.app',
    'http://localhost:5000',
    'http://localhost:5173'
  ]);
  if (origin && allow.has(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Credentials', 'true');
  }
  res.set('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');

  // 프리플라이트 응답
  if (req.method === 'OPTIONS') return res.status(204).send('');

  try {
    // (선택) Authorization: Bearer <idToken> 헤더가 오면 검증
    let uid = null;
    const authHeader = req.get('Authorization') || '';
    if (authHeader.startsWith('Bearer ')) {
      const idToken = authHeader.slice(7);
      const decoded = await admin.auth().verifyIdToken(idToken);
      uid = decoded.uid;
    }
    const result = await sellItemsCore(uid, req.body || {});
    res.json(result);
  } catch (e) {
    console.error('sellItems HTTP error', e);
    res.status(500).json({ ok: false, error: e?.message || 'internal' });
  }
});

exports.aiGenerate = onRequest({ region: 'us-central1', secrets: [GEMINI_API_KEY] }, async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).send('');

  try{
    const { model, systemText, userText, temperature, maxOutputTokens } = req.body || {};
    if(!model || !systemText) return res.status(400).json({ error:'bad-args' });

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY.value()}`;
    const body = {
      contents: [{ role: 'user', parts: [{ text: `${systemText}\n\n${userText||''}` }]}],
      generationConfig: { temperature: temperature ?? 0.9, maxOutputTokens: maxOutputTokens ?? 8192 },
      safetySettings: []
    };

    const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const j = await r.json();
    const text = j?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
    return res.json({ text });
  }catch(e){
    console.error('[aiGenerate]', e);
    return res.status(500).json({ error: String(e?.message||e) });
  }
});



// Cloud Functions for Firebase (Gen1/Gen2 상관없음 — HTTP 함수)
// package.json: "firebase-admin", "firebase-functions" 필요

// ===== [메일: 조기 시작 알림] 서버가 관리자 우편함에 1건 작성 =====
// 관리자 UID는 Firestore configs/admins 문서의 allow[0]에서 뽑음. 없으면 아무 것도 안 함.
async function _pickAdminUid() {
  try {
    const snap = await admin.firestore().doc('configs/admins').get();
    const d = snap.exists ? snap.data() : {};
    if (Array.isArray(d?.allow) && d.allow.length) return String(d.allow[0]);
  } catch (_) {}
  return null;
}





// === [helper] 오늘/어제 파티션에서 직전 시작 로그 찾기 (색인 불필요) ===
function __dayStamp(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
function __yester(d = new Date()) {
  const t = new Date(d);
  t.setDate(t.getDate() - 1);
  return t;
}

// 색인 없이: when만 정렬해서 가져오고, who/where는 메모리에서 필터
async function __findPrevStartAt(uid, whereStr, excludePath = null) {
  const days = [__dayStamp(new Date()), __dayStamp(__yester(new Date()))];
  const candidates = [];
  for (const day of days) {
    try {
      const col = admin.firestore().collection('logs').doc(day).collection('rows');
      const snap = await col.orderBy('when', 'desc').limit(50).get(); // 단일 정렬만
      for (const doc of snap.docs) {
        if (excludePath && doc.ref.path === excludePath) continue; // 방금 쓴 현재 로그 제외
        const who = doc.get('who');
        const where = doc.get('where');
        const when = doc.get('when');
        if (when && who === uid && where === whereStr) {
          candidates.push(when);
        }
      }
    } catch (e) {
      console.error('[notifyEarlyStart] scan fail for day', day, e);
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.toMillis() - a.toMillis());
  return candidates[0];
}





// HTTP: POST /notifyEarlyStart
// body: { actor_uid?, kind, where, diffMs, context? }
// Authorization: Bearer <ID_TOKEN> (선택; 있으면 서버에서 검증)
exports.notifyEarlyStart = onRequest({ region:'us-central1' }, async (req, res) => {
  // --- CORS (허용 출처) ---
  const origin = req.get('origin');
  const allow = new Set([
    'https://tale-of-heros---fangame.firebaseapp.com',
    'https://tale-of-heros---fangame.web.app',
    'https://tale-of-heros-staging.firebaseapp.com',
    'https://tale-of-heros-staging.web.app',
    'http://localhost:5000','http://127.0.0.1:5000',
    'http://localhost:5173','http://127.0.0.1:5173'
  ]);
  const okOrigin = origin && (allow.has(origin) || origin.includes('--pr-'));
  if (okOrigin) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Credentials', 'true');
  }
  res.set('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Method Not Allowed' });

  // --- 인증(있으면 신뢰) ---
  let actorUid = null;
  const authz = req.get('Authorization') || '';
  if (authz.startsWith('Bearer ')) {
    try {
      const decoded = await admin.auth().verifyIdToken(authz.slice(7));
      actorUid = decoded.uid;
    } catch (_) {}
  }
  const { actor_uid, kind, where, context } = req.body || {};
  const uid = actorUid || actor_uid || null;
  if (!uid || !where) return res.status(200).json({ ok:true, note:'missing-uid-or-where' });

  // --- 서버에서 diff 계산 (오늘/어제 파티션, 색인 불필요) ---
  const nowTs = admin.firestore.Timestamp.now();
  const excludePath = (context && context.log_ref) ? String(context.log_ref) : null;

  const prevAt = await __findPrevStartAt(uid, String(where), excludePath);
  if (!prevAt) {
    return res.json({ ok: true, note: 'no-prev' }); // 첫 로그거나 과거 기록 없음
  }

  const diffMs = nowTs.toMillis() - prevAt.toMillis();
  console.log('[notifyEarlyStart]', { uid, where, prevAt: prevAt.toMillis(), now: nowTs.toMillis(), diffMs });

  const THRESHOLDS = {
    'battle#start': 4 * 60 * 1000,     // 4분
    'explore#start': 59 * 60 * 1000    // 59분
  };
  const threshold = THRESHOLDS[String(where)] || null;
  if (!threshold) return res.json({ ok:true, note:'unknown-where' });

  // 임계 이내면 메일 발송
  if (diffMs >= 0 && diffMs <= threshold) {
    // 관리자 선택
    let adminUid = null;
    try {
      const snap = await admin.firestore().doc('configs/admins').get();
      const d = snap.exists ? snap.data() : {};
      if (Array.isArray(d?.allow) && d.allow.length) adminUid = String(d.allow[0]);
    } catch (_) {}
    if (!adminUid) return res.status(200).json({ ok:true, note:'no-admin-configured' });

    const mm = Math.floor(diffMs / 60000);
    const ss2 = Math.floor((diffMs % 60000) / 1000);

    const title = `[조기 시작 감지] ${where === 'battle#start' ? '배틀' : '탐험'} 시작`;
    const lines = [
      `이전 시작 로그 이후 ${mm}분 ${ss2}초 만에 새 시작 로그가 생성됨`,
      `사용자: ${uid}`,
      `종류: ${kind || ''}`,
      `where: ${where}`,
      context?.title ? `제목: ${context.title}` : '',
      context?.log_ref ? `ref: ${context.log_ref}` : '',
      `서버기준 diffMs: ${diffMs}`
    ].filter(Boolean);

    await admin.firestore()
      .collection('mail').doc(adminUid).collection('msgs')
      .add({
        title,
        body: lines.join('\n'),
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
        read: false,
        extra: { kind, where, diffMs, uid, context: context || null, prevAt: prevAt.toMillis(), now: nowTs.toMillis() }
      });

    return res.json({ ok:true, mailed:true, diffMs });
  }

  return res.json({ ok:true, mailed:false, diffMs, note:'over-threshold' });
});


exports.startExploreV2   = exploreV2.startExploreV2;
exports.advPrepareNextV2 = exploreV2.advPrepareNextV2;
exports.advApplyChoiceV2 = exploreV2.advApplyChoiceV2;
exports.endExploreV2     = exploreV2.endExploreV2;
exports.advBattleActionV2 = exploreV2.advBattleActionV2; // 추가
exports.advBattleFleeV2 = exploreV2.advBattleFleeV2;     // 추가
exports.startEncounter = encounterV2.startEncounter;

const guildFns = require('./guild')(admin, { onCall, HttpsError, logger });
Object.assign(exports, guildFns);
exports.kickGuildMember = guildFns.kickFromGuild;

// === BEGIN PATCH: battle module export ===
const battleFns = require('./battle'); // functions/battle/index.js
Object.assign(exports, battleFns);
// === END PATCH ===


// === BEGIN PATCH: mail module export ===
const mailFns = require('./mail')(admin, { onCall, HttpsError, logger });
Object.assign(exports, mailFns);
// === END PATCH ===


// === BEGIN: admin tools (search) ===
async function __isAdmin(uid) {
  if (!uid) return false;
  try {
    const snap = await db.doc('configs/admins').get();
    const data = snap.exists ? snap.data() : {};
    const allow = Array.isArray(data.allow) ? data.allow : [];
    const allowEmails = Array.isArray(data.allowEmails) ? data.allowEmails : [];
    if (allow.includes(uid)) return true;
    const user = await admin.auth().getUser(uid);
    return !!(user?.email && allowEmails.includes(user.email));
  } catch (_) { return false; }
}

exports.adminGetCharById = onCall({ region: 'us-central1' }, async (req) => {
  const uid = req.auth?.uid;
  if (!await __isAdmin(uid)) throw new HttpsError('permission-denied', 'admin only');
  const id = String(req.data?.id||'').replace(/^chars\//,'');
  if (!id) throw new HttpsError('invalid-argument', 'id 필요');
  const snap = await db.doc(`chars/${id}`).get();
  if (!snap.exists) return { ok:true, found:false };
  return { ok:true, found:true, id:snap.id, data:snap.data() };
});

exports.adminSearchCharsByName = onCall({ region: 'us-central1' }, async (req) => {
  const uid = req.auth?.uid;
  if (!await __isAdmin(uid)) throw new HttpsError('permission-denied', 'admin only');
  const name = String(req.data?.name||'').trim();
  const limitN = Math.max(1, Math.min(50, Number(req.data?.limit||20)));
  if (!name) throw new HttpsError('invalid-argument', 'name 필요');
  const q = await db.collection('chars').where('name','==', name).limit(limitN).get();
  const rows = q.docs.map(d => ({ id:d.id, ...d.data() }));
  return { ok:true, rows };
});

exports.adminFindUser = onCall({ region: 'us-central1' }, async (req) => {
  const uid = req.auth?.uid;
  if (!await __isAdmin(uid)) throw new HttpsError('permission-denied', 'admin only');
  const q = String(req.data?.q||'').trim();
  if (!q) throw new HttpsError('invalid-argument', 'q 필요');

  const byId = await db.doc(`users/${q}`).get();
  if (byId.exists) return { ok:true, users:[{ uid:byId.id, ...byId.data() }] };

  if (q.includes('@')) {
    try {
      const u = await admin.auth().getUserByEmail(q);
      const us = await db.doc(`users/${u.uid}`).get();
      return { ok:true, users:[{ uid:u.uid, ...(us.exists?us.data():{}) }] };
    } catch(_){}
  }

  const hit = await db.collection('users').where('nick','==', q).limit(10).get();
  const rows = hit.docs.map(d => ({ uid:d.id, ...d.data() }));
  return { ok:true, users: rows };
});

exports.adminListAssets = onCall({ region: 'us-central1' }, async (req) => {
  const uid = req.auth?.uid;
  if (!await __isAdmin(uid)) throw new HttpsError('permission-denied', 'admin only');
  const targetUid = String(req.data?.uid||'');
  if (!targetUid) throw new HttpsError('invalid-argument', 'uid 필요');

  const charsQ = await db.collection('chars').where('owner_uid','==', targetUid).limit(100).get();
  const chars = charsQ.docs.map(d => ({ id:d.id, name:d.get('name'), elo:d.get('elo')||0, thumb_url:d.get('thumb_url')||d.get('image_url')||'' }));

  const uSnap = await db.doc(`users/${targetUid}`).get();
  const items = uSnap.exists ? (uSnap.get('items_all') || []) : [];

  return { ok:true, chars, items };
});
// === END: admin tools (search) ===


// functions/index.js 파일 맨 아래 exports 부분에 추가

// === [추가] 클라이언트용 쿨타임 조회 함수 ===
// functions/index.js

exports.getCooldownStatus = onCall({ region:'us-central1' }, async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  const userSnap = await db.collection('users').doc(uid).get();
  if (!userSnap.exists) return { ok: true, battle: 0, encounter: 0, explore: 0 };
  const data = userSnap.data();
  const now = Date.now();

  // Firestore에 초(second) 단위로 저장된 값을 밀리초로 변환하여 남은 시간 계산
  const getRemainMsFromSec = (sec) => Math.max(0, (sec || 0) * 1000 - now);

  return {
    ok: true,
    battle: getRemainMsFromSec(data.cooldown_battle_until),
    encounter: getRemainMsFromSec(data.cooldown_encounter_until),
    // explore는 Firestore Timestamp 객체이므로 기존 방식 유지
    explore: Math.max(0, (data.cooldown_explore_until?.toMillis() || 0) - now),
  };
});
// /functions/index.js

// (기존 exports 객체 내부에 추가)
exports.setAppVersion = onCall({ region: 'us-central1' }, async (req) => {
  const uid = req.auth?.uid;
  // __isAdmin 함수는 이미 index.js에 있으므로 재사용합니다.
  if (!await __isAdmin(uid)) {
    throw new HttpsError('permission-denied', '관리자만 실행할 수 있습니다.');
  }
  const { version } = req.data;
  if (!version || typeof version !== 'string') {
    throw new HttpsError('invalid-argument', '문자열 타입의 version 값이 필요합니다.');
  }

  const appStatusRef = db.doc('configs/app_status');
  await appStatusRef.set({
    latest_version: version,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });

  logger.info(`App version updated to: ${version} by admin: ${uid}`);
  return { ok: true, version };
});
