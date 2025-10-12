// functions/storyV2.js
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { Timestamp } = require('firebase-admin/firestore');
const { logger } = require('firebase-functions');

// --- 프리롤 링버퍼 ---
const PREROLL_SIZE = 50;
function d100(){ return Math.floor(Math.random()*100)+1; }

async function ensurePreroll(docRef){
  const snap = await docRef.get();
  if (snap.exists) {
    const d = snap.data()||{};
    if (Array.isArray(d.prerolls) && d.prerolls.length === PREROLL_SIZE) return d;
  }
  const prerolls = Array.from({length:PREROLL_SIZE},()=>d100());
  const payload = { prerolls, cursor:0, updatedAt: Timestamp.now() };
  await docRef.set(payload, { merge:true });
  return payload;
}
async function takeRollTx(tx, docRef){
  const snap = await tx.get(docRef);
  let d = snap.exists ? (snap.data()||{}) : {};
  if (!Array.isArray(d.prerolls) || d.prerolls.length !== PREROLL_SIZE) {
    d = { prerolls: Array.from({length:PREROLL_SIZE},()=>d100()), cursor:0 };
  }
  const i = (d.cursor||0) % PREROLL_SIZE;
  const roll = d.prerolls[i];
  d.prerolls[i] = d100();
  d.cursor = (i+1) % PREROLL_SIZE;
  d.updatedAt = Timestamp.now();
  tx.set(docRef, d, { merge:true });
  return roll;
}

// --- 스키마 유틸 ---
const DIFFICULTIES = ['easy','normal','hard','vhard','legend','impossible'];
const clamp = (n,min,max)=>Math.max(min,Math.min(max,n));
function pick(arr){ return arr[Math.floor(Math.random()*arr.length)]||null; }

function normalizeWorld(w={}){
  return {
    id: String(w.id||'').trim(),
    name: String(w.name||w.id||'').trim(),
    intro: String(w.intro||w.summary||'').trim(),
    detail: String(w.detail?.lore_long||w.detail?.lore||w.detail||'').trim(),
  };
}
function makeNPCsSkeleton(min=5,max=10){
  const n = clamp(Math.floor(Math.random()*(max-min+1))+min, 5, 10);
  const npcs = [];
  for (let i=0;i<n;i++){
    npcs.push({ id:`npc_${i+1}`, name:`NPC ${i+1}`, role: pick(['상인','수습기사','도적','학자','장로','용병','사서']) });
  }
  // 관계 매트릭스는 V3에서 정교화(여긴 자리만)
  return { list:npcs, relations:{} };
}
function ladder(len){
  return Array.from({length:len},(_,i)=>{
    const idx = Math.min(DIFFICULTIES.length-1, Math.floor(i/Math.max(1,(len-1)/(DIFFICULTIES.length-1))));
    return DIFFICULTIES[idx];
  });
}

module.exports = (admin) => {
  const db = admin.firestore();

  async function hasStoryAccess(uid){
    if(!uid) return false;
    try{
      const [a,b] = await Promise.all([db.doc('configs/admins').get(), db.doc('configs/betatesters').get()]);
      const A = a.exists ? a.data() : {}; const B = b.exists ? b.data() : {};
      const allowUids = new Set([...(A.allow||[]), ...(B.allow||[])]);
      if (allowUids.has(uid)) return true;
      const user = await admin.auth().getUser(uid);
      const email = user.email||'';
      const allowEmails = new Set([...(A.allowEmails||[]), ...(B.allowEmails||[])]);
      return allowEmails.has(email);
    }catch(e){ logger.error(e); return false; }
  }

  // V2-1) 스토리 런 뼈대 생성: 그래프 + 키이벤트 + 프리롤만
  const createStoryPlanV2 = onCall({ region:'us-central1' }, async (req)=>{
    const uid = req.auth?.uid;
    if (!await hasStoryAccess(uid)) throw new HttpsError('permission-denied','권한 없음');

    const { charId, world } = req.data||{};
    if (!charId || !world) throw new HttpsError('invalid-argument','charId/world 필요');

    const ch = await db.doc(`chars/${charId}`).get();
    if (!ch.exists) throw new HttpsError('not-found','캐릭터 없음');
    if (ch.data()?.owner_uid && ch.data().owner_uid !== uid) throw new HttpsError('permission-denied','본인 캐릭터 아님');

    const worldNorm = normalizeWorld(world);

    // 비-필드 골격 4~6개
    const spineCount = 4 + Math.floor(Math.random()*3); // 4~6
    const diffs = ladder(spineCount);
    const nonField = [];
    for (let i=0;i<spineCount;i++){
      nonField.push({
        id: `N${i+1}`,
        kind: (i===0?'town': (i===spineCount-1?'landmark': pick(['town','hub','landmark'])) ),
        name: `${worldNorm.name} ${i===0?'시작 마을': (i===spineCount-1?'최종 거점':'거점')} ${i+1}`,
        difficulty: diffs[i],
        npc: makeNPCsSkeleton(),  // 세부는 V3에서 채움
        groupAttitude: (i===0?'friendly':'neutral'), // 시작마을 우호 고정
        connects: []
      });
    }

    // 비-필드 사이 필드 1~5개씩 삽입, 연결 생성
    const nodes=[...nonField]; const edges=[];
    let fieldSerial=0;
    for (let i=0;i<nonField.length-1;i++){
      const a = nonField[i], b = nonField[i+1];
      const k = 1 + Math.floor(Math.random()*5); // 1~5
      let prev = a.id;
      for (let f=0; f<k; f++){
        const id = `F${++fieldSerial}`;
        // 뒤로 갈수록 어려워짐(대략적인 구배)
        const baseIdx = DIFFICULTIES.indexOf(a.difficulty);
        const step = Math.min(DIFFICULTIES.length-1, baseIdx + Math.floor((f+1)/Math.max(1, k/2)));
        nodes.push({
          id, kind:'field', name:`${worldNorm.name} 야외-${id}`,
          difficulty: DIFFICULTIES[step],
          connects: []
        });
        edges.push([prev, id, `자연어 연결: ${prev}→${id}`]);
        prev = id;
      }
      edges.push([prev, b.id, `자연어 연결: ${prev}→${b.id}`]);
    }
    // 양방향 연결 반영
    const map = Object.fromEntries(nodes.map(n=>[n.id,n]));
    edges.forEach(([u,v,desc])=>{
      map[u].connects.push({ to:v, desc });
      map[v].connects.push({ to:u, desc:`역방향: ${desc}` });
    });

    // 필연 Key Events(타이틀/위치만): 4~5개
    const keyEvents = [
      { id:'EV1', title:'조력자와의 만남', loc:nodes.find(n=>n.kind!=='field' && n.id!=='N1')?.id || 'N1', status:'pending' },
      { id:'EV2', title:'첫 번째 시련', loc:nodes.find(n=>n.kind==='field')?.id || 'N2', status:'pending' },
      { id:'EV3', title:'절망의 골짜기', loc: nonField[Math.floor(nonField.length/2)]?.id || 'N2', status:'pending' },
      { id:'EV4', title:'각성의 조짐',   loc: nodes.slice(-2)[0]?.id || 'N3', status:'pending' },
      { id:'EV5', title:'최종 결전',     loc: nonField[nonField.length-1]?.id || 'N4', status:'pending' },
    ];

    const runId = 'r'+Date.now();
    const runRef = db.doc(`storyRuns/${charId}`);
    await ensurePreroll(runRef); // 프리롤 준비

    await runRef.set({
      runId, world: worldNorm,
      graph: { nodes, edges },
      keyEvents,
      createdAt: Timestamp.now(),
      enrichment: { // V3가 채울 자리
        npcs: null, monstersByDifficulty: null, shopInventories: null, dropLore: null
      }
    }, { merge:true });

    return { ok:true, runId, nodes, keyEvents };
  });

  // V2-2) 디버그: 현재 런/그래프/프리롤 커서 열람
  const getRunSkeletonV2 = onCall({ region:'us-central1' }, async (req)=>{
    const uid = req.auth?.uid;
    if (!await hasStoryAccess(uid)) throw new HttpsError('permission-denied','권한 없음');
    const { charId } = req.data||{};
    if (!charId) throw new HttpsError('invalid-argument','charId 필요');

    const ref = db.doc(`storyRuns/${charId}`);
    const d = (await ref.get()).data() || null;
    return { ok: !!d, run: d };
  });

  // V2-3) 디버그: 프리롤 1개 뽑기(개발자 콘솔 확인용)
  const devTakeRollV2 = onCall({ region:'us-central1' }, async (req)=>{
    const uid = req.auth?.uid;
    if (!await hasStoryAccess(uid)) throw new HttpsError('permission-denied','권한 없음');
    const { charId } = req.data||{};
    if (!charId) throw new HttpsError('invalid-argument','charId 필요');
    const ref = db.doc(`storyRuns/${charId}`);
    const roll = await db.runTransaction(tx => takeRollTx(tx, ref));
    return { ok:true, roll };
  });

  return {
    createStoryPlanV2,
    getRunSkeletonV2,
    devTakeRollV2,
  };
};
