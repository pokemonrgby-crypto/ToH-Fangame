// /functions/match.ts
// ❗️ 이 코드 전체를 복사하여 기존 match.ts 파일에 덮어쓰세요.
import * as admin from 'firebase-admin';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore';
if (!admin.apps.length) admin.initializeApp();

type Mode = 'battle'|'encounter';
const COOLDOWN_SEC = 300;
const LOCK_SEC = 600;

function nowSec(){ return Math.floor(Date.now()/1000); }
// 'battle' 모드를 위해 가우시안 가중치 함수는 유지합니다.
function gaussWeight(delta: number, sigma=150){ return Math.exp(-(delta*delta)/(2*sigma*sigma)); }

export const requestMatch = onCall({ region: 'us-central1' }, async (req) => {
  const uid = req.auth?.uid;
  if(!uid) throw new HttpsError('unauthenticated', '로그인이 필요해');

  const { charId, mode } = (req.data || {}) as { charId: string; mode: Mode };
  if(!charId || (mode!=='battle' && mode!=='encounter'))
    throw new HttpsError('invalid-argument', '인자 오류');

  const db = getFirestore();
  const charRef = db.doc(`chars/${charId}`);
  const userRef = db.doc(`users/${uid}`);

  const [charSnap, userSnap] = await Promise.all([charRef.get(), userRef.get()]);
  if(!charSnap.exists) throw new HttpsError('not-found', '캐릭터 없음');
  const ch = charSnap.data() as any;
  if(ch.owner_uid !== uid) throw new HttpsError('permission-denied', '남의 캐릭터');

  const user = (userSnap.exists ? userSnap.data() : {}) as any;
  const left = (user.cooldown_until || 0) - nowSec();
  if(left > 0) throw new HttpsError('failed-precondition', `쿨타임 ${left}s`);

  // --- [수정] 모드에 따라 후보군 조회 로직 분기 ---
  const poolCol = db.collection('char_pool');
  const cand = new Map<string, any>();
  const push = (d: FirebaseFirestore.QueryDocumentSnapshot) => {
    const v = d.data() as any;
    if(!v || !v.char) return;
    const id = String(v.char).replace(/^chars\//,'');
    if (id === charId) return;
    if (v.owner_uid === uid) return;
    if (v.is_valid === false) return;
    cand.set(id, { id, name: v.name, elo: v.elo, thumb_url: v.thumb_url, refPath: v.char, locked_until: v.locked_until||0 });
  };

  if (mode === 'battle') {
    // 배틀: Elo 기반 조회 (기존 로직 유지)
    const elo = Number(ch.elo||1000);
    const upQs = await poolCol
        .where('can_match','==', true)
        .orderBy('elo','asc').startAfter(elo)
        .limit(24).get();
    const downQs = await poolCol
        .where('can_match','==', true)
        .orderBy('elo','desc').startAfter(elo)
        .limit(24).get();
    upQs.docs.slice(0, 20).forEach(push);
    downQs.docs.slice(0, 20).forEach(push);
  } else {
    // 조우: 랜덤 ID 기반 조회 (완전 랜덤)
    // Firestore에서 진정한 랜덤 조회를 위한 기법: 랜덤 ID를 생성하고 그 지점부터 스캔
    const randomKey = db.collection('char_pool').doc().id;
    const q = await poolCol
      .where('can_match', '==', true)
      .orderBy(admin.firestore.FieldPath.documentId())
      .startAt(randomKey)
      .limit(50) // 충분한 후보군 확보
      .get();
    
    // 만약 문서 끝까지 가서 50개를 못 채웠다면, 처음부터 다시 스캔해서 보충
    if (q.docs.length < 50) {
      const q2 = await poolCol
        .where('can_match', '==', true)
        .orderBy(admin.firestore.FieldPath.documentId())
        .limit(50 - q.docs.length)
        .get();
      q2.docs.forEach(push);
    }
    q.docs.forEach(push);
  }

  const list = Array.from(cand.values());
  if(list.length === 0) throw new HttpsError('unavailable', '후보 없음');

  // [수정] mode에 따라 상대 선택 방식을 분기합니다.
  let pick: any;
  if (mode === 'battle') {
    // 'battle' 모드: Elo 기반 가우시안 가중치 추첨 (기존 방식)
    const elo = Number(ch.elo||1000);
    const weights = list.map((c:any)=> gaussWeight(Math.abs((c.elo||1000) - elo), 150));
    const sum = weights.reduce((a,b)=>a+b,0) || 1;
    let r = Math.random()*sum;
    pick = list[0]; // fallback
    for(let i=0;i<list.length;i++){ r -= weights[i]; if(r<=0){ pick = list[i]; break; } }
  } else {
    // 'encounter' 모드: 완전 랜덤 추첨
    pick = list[Math.floor(Math.random() * list.length)];
  }
  const oppRef = db.doc(pick.refPath);
  const matchesRef = db.collection('matches').doc();
  const expires = nowSec() + LOCK_SEC;

  await db.runTransaction(async (tx)=>{
    const [meSnap, opSnap] = await Promise.all([tx.get(charRef), tx.get(oppRef)]);
    if(!opSnap.exists) throw new HttpsError('aborted','상대 사라짐');
    const me = meSnap.data() as any;
    const op = opSnap.data() as any;
    if((me.match?.locked_until||0) > nowSec()) throw new HttpsError('aborted','이미 잠금 중');
    if((op.match?.locked_until||0) > nowSec()) throw new HttpsError('aborted','상대 잠금 중');
    tx.update(charRef, { match: { mode, opponent: oppRef.path, locked_until: expires } });
    tx.update(oppRef,  { match: { mode, opponent: charRef.path, locked_until: expires } });
    tx.set(matchesRef, {
      a: charRef.path, b: oppRef.path, mode, token: matchesRef.id,
      createdAt: Timestamp.now(), expiresAt: Timestamp.fromMillis((expires)*1000), state: 'ready'
    });
    tx.set(userRef, { cooldown_until: nowSec()+COOLDOWN_SEC }, { merge: true });
    tx.set(db.doc(`char_pool/${charId}`), { can_match:false, locked_until: expires }, { merge:true });
    tx.set(db.doc(`char_pool/${pick.id}`), { can_match:false, locked_until: expires }, { merge:true });
  });

  return {
    ok: true,
    token: matchesRef.id,
    opponent: { id: pick.id, name: pick.name || '(상대)', elo: pick.elo || 1000, thumb_url: pick.thumb_url || '' }
  };
});

// cancelMatch 함수는 변경하지 않습니다.
export const cancelMatch = onCall({ region: 'us-central1' }, async (req)=>{
    const uid = req.auth?.uid;
    if(!uid) throw new HttpsError('unauthenticated', '로그인이 필요해');
    const { token } = (req.data||{}) as { token:string };
    if(!token) throw new HttpsError('invalid-argument','토큰 없음');
    const db = getFirestore();
    const mRef = db.doc(`matches/${token}`);
    const mSnap = await mRef.get();
    if(!mSnap.exists) return { ok:true };
    const m = mSnap.data() as any;
    const aRef = db.doc(m.a); const bRef = db.doc(m.b);
    await db.runTransaction(async (tx)=>{
        tx.set(aRef, { match: { mode: null, opponent: null, locked_until: 0 } }, { merge:true });
        tx.set(bRef, { match: { mode: null, opponent: null, locked_until: 0 } }, { merge:true });
        tx.set(mRef, { state:'closed' }, { merge:true });
        tx.set(db.doc(`char_pool/${aRef.id}`), { can_match:true, locked_until: 0 }, { merge:true });
        tx.set(db.doc(`char_pool/${bRef.id}`), { can_match:true, locked_until: 0 }, { merge:true });
    });
    return { ok:true };
});
