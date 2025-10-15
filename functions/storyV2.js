// functions/storyV2.js
/**
 * Story V2 - 스토리 모드 골격(Skeleton) 시스템
 * 
 * 이 모듈은 포켓몬 스타일 RPG의 스토리 월드 구조를 생성합니다.
 * V2는 "뼈대"만 만들며, AI 생성 콘텐츠는 V3에서 처리합니다.
 * 
 * 주요 기능:
 * 1. 월드맵 생성: 필드(몬스터 등장)와 비-필드(마을/거점) 노드
 * 2. NPC 시스템: 각 비-필드마다 5-10명의 NPC와 관계도 생성
 * 3. 난이도 시스템: 6단계 (easy → normal → hard → vhard → legend → impossible)
 * 4. 적 등급: trash, normal, elite, boss, hidden (각 확률 테이블 있음)
 * 5. 전투 규칙: HP/데미지 범위, 블록 확률, 레벨링 시스템
 * 6. 아이템 드랍: 7등급 (normal → rare → epic → legend → aether → alpha → omega)
 * 7. 프리롤 시스템: d100 링버퍼로 모든 랜덤 요소 결정
 * 
 * 설계 철학:
 * - 모든 수치는 프리롤로 사전 결정 (재현 가능)
 * - V2는 구조와 숫자만, V3는 이름과 설명 생성
 * - 개발자 콘솔 출력을 통한 디버깅 지원
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { Timestamp } = require('firebase-admin/firestore');
const { logger } = require('firebase-functions');
const { StoryLogger } = require('./storyLogger');

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

// --- 공용 유틸 ---
const DIFFICULTIES = ['easy','normal','hard','vhard','legend','impossible'];
const clamp = (n,min,max)=>Math.max(min,Math.min(max,n));
const rangeMap = (r, min, max) => min + ((Math.max(1, r)-1) % (max-min+1)); // [min..max] 균등 매핑
const choiceFromRoll = (arr, r) => arr[(Math.max(1, r)-1) % arr.length];

function normalizeWorld(w={}){
  return {
    id: String(w.id||'').trim(),
    name: String(w.name||w.id||'').trim(),
    intro: String(w.intro||w.summary||'').trim(),
    detail: String(w.detail?.lore_long||w.detail?.lore||w.detail||'').trim(),
  };
}

// NPC 스켈레톤(개수/역할 선택도 프리롤 기반)
function makeNPCsSkeleton(count, nextRoll){
  const roles = ['상인','수습기사','도적','학자','장로','용병','사서'];
  const npcs = [];
  const n = clamp(count,5,10);
  for (let i=0;i<n;i++){
    const r = nextRoll();
    npcs.push({ id:`npc_${i+1}`, name:`NPC ${i+1}`, role: choiceFromRoll(roles, r) });
  }
  return { list:npcs, relations:{} }; // relations는 아래에서 프리롤로 꽉 채움
}

function ladder(len){
  return Array.from({length:len},(_,i)=>{
    const idx = Math.min(DIFFICULTIES.length-1, Math.floor(i/Math.max(1,(len-1)/(DIFFICULTIES.length-1))));
    return DIFFICULTIES[idx];
  });
}

// 우호도 프리롤 → 입력값
function groupAttitudeFromRoll(r, diff){
  const idx = DIFFICULTIES.indexOf(diff);   // 뒤로 갈수록 더 냉랭해지는 편향
  const shift = Math.max(0, idx)*5;         // 난이도 한 단계당 5%씩 우호도 하향
  const friendlyCut = Math.max(10, 45 - shift); // 최소 10%는 유지
  const neutralCut  = Math.max(friendlyCut+1, 85 - shift);
  if (r <= friendlyCut) return 'friendly';
  if (r <= neutralCut)  return 'neutral';
  return 'hostile';
}
function attitudeBiasFromAttitude(a){ return a==='friendly' ? -1 : (a==='neutral' ? 0 : +1); }

// --- 룰 테이블(전투/드랍/이동) ---
const ENEMY_GRADES = ['trash','normal','elite','boss','hidden'];
const DROP_RARITIES = ['normal','rare','epic','legend','aether','alpha','omega'];

function buildStoryRulesV2(){
  // hidden은 난이도와 무관하게 1% 고정
  const gradeProb = {
    easy:      {trash:55, normal:35, elite:8,  boss:1, hidden:1},
    normal:    {trash:45, normal:40, elite:12, boss:2, hidden:1},
    hard:      {trash:35, normal:42, elite:18, boss:4, hidden:1},
    vhard:     {trash:25, normal:44, elite:22, boss:8, hidden:1},
    legend:    {trash:15, normal:45, elite:25, boss:14,hidden:1},
    impossible:{trash:10, normal:40, elite:28, boss:21,hidden:1},
  };

  const hpRanges = {
    easy:      {trash:[20,35], normal:[30,50], elite:[60,90],  boss:[120,180], hidden:[50,200]},
    normal:    {trash:[30,45], normal:[40,65], elite:[90,130], boss:[160,240], hidden:[60,260]},
    hard:      {trash:[40,60], normal:[60,90], elite:[130,190],boss:[220,320], hidden:[80,340]},
    vhard:     {trash:[55,80], normal:[85,120],elite:[180,260],boss:[300,420], hidden:[100,480]},
    legend:    {trash:[70,95], normal:[110,150],elite:[240,340],boss:[380,560], hidden:[120,620]},
    impossible:{trash:[85,120],normal:[140,190],elite:[320,450],boss:[500,750], hidden:[140,820]},
  };

  const dmgRanges = {
    easy:      {trash:[3,6],  normal:[5,9],  elite:[10,18], boss:[16,26], hidden:[8,28]},
    normal:    {trash:[5,8],  normal:[7,12], elite:[14,24], boss:[22,34], hidden:[10,36]},
    hard:      {trash:[7,11], normal:[10,16],elite:[20,34], boss:[30,46], hidden:[14,48]},
    vhard:     {trash:[9,14], normal:[13,20],elite:[28,46], boss:[40,62], hidden:[18,66]},
    legend:    {trash:[12,18],normal:[17,26],elite:[38,60], boss:[52,78], hidden:[22,82]},
    impossible:{trash:[15,22],normal:[21,32],elite:[50,78], boss:[66,100],hidden:[26,110]},
  };

  const blockBase = {
    easy:      {trash:55, normal:45, elite:35, boss:25, hidden:20},
    normal:    {trash:45, normal:38, elite:30, boss:20, hidden:18},
    hard:      {trash:38, normal:32, elite:24, boss:16, hidden:14},
    vhard:     {trash:32, normal:26, elite:20, boss:12, hidden:10},
    legend:    {trash:26, normal:21, elite:16, boss:10, hidden:8},
    impossible:{trash:22, normal:18, elite:14, boss:9,  hidden:7},
  };
  const levelAdj = { perLevel: 1.5, min: -20, max: +20 };

  const dropRates = {
    common: { normal:60, rare:28, epic:9,  legend:3,  aether:0, alpha:0, omega:0 },
    tough:  { normal:50, rare:30, epic:14, legend:6,  aether:0, alpha:0, omega:0 },
    elite:  { normal:35, rare:34, epic:20, legend:10, aether:1, alpha:0, omega:0 },
    boss:   { normal:20, rare:34, epic:26, legend:18, aether:2, alpha:0, omega:0 },
    hidden: { normal:10, rare:22, epic:28, legend:26, aether:12, alpha:1, omega:1 },
  };
  const dropKeyByGrade = { trash:'common', normal:'tough', elite:'elite', boss:'boss', hidden:'hidden' };

  const travel = { ambushChance: 18 }; // %

  const idScheme = "{charId}_{runId}_{serial}";
  const currencies = { story_coins: true };
  const leveling = { hpBase:100, hpPerLevel:5, expField:'story_exp', maxLevel:100 };

  return { ENEMY_GRADES, DROP_RARITIES, gradeProb, hpRanges, dmgRanges, blockBase, levelAdj, dropRates, dropKeyByGrade, travel, idScheme, currencies, leveling };
}

module.exports = (admin) => {
  const db = admin.firestore();
  const log = new StoryLogger('[StoryV2]');

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

  /**
   * V2-1) 스토리 런 뼈대 생성
   * 
   * 월드맵의 전체 구조를 생성합니다:
   * - 비-필드 노드 4~6개 (마을, 거점, 랜드마크)
   * - 각 비-필드 사이에 1~5개의 필드 노드
   * - 각 비-필드마다 5~10명의 NPC와 그들 간의 관계도
   * - 5개의 주요 이벤트 (조력자 만남, 시련, 절망, 각성, 최종 결전)
   * 
   * 모든 수치는 프리롤로 결정되어 재현 가능합니다.
   * 
   * @param {string} charId - 캐릭터 ID
   * @param {object} world - 월드 정보 (name, intro, detail)
   * @returns {object} { ok, runId, nodes, keyEvents }
   */
  const createStoryPlanV2 = onCall({ region:'us-central1' }, async (req)=>{
    const uid = req.auth?.uid;
    if (!await hasStoryAccess(uid)) throw new HttpsError('permission-denied','권한 없음');

    const { charId, world } = req.data||{};
    if (!charId || !world) throw new HttpsError('invalid-argument','charId/world 필요');
    
    logger.info('[createStoryPlanV2] Starting story plan creation', { charId, worldName: world.name });

    const ch = await db.doc(`chars/${charId}`).get();
    if (!ch.exists) throw new HttpsError('not-found','캐릭터 없음');
    if (ch.data()?.owner_uid && ch.data().owner_uid !== uid) throw new HttpsError('permission-denied','본인 캐릭터 아님');

    const worldNorm = normalizeWorld(world);

    // 프리롤 준비 + 로컬 소비 도우미
    const runRef = db.doc(`storyRuns/${charId}`);
    let pre = await ensurePreroll(runRef);
    const nextRoll = ()=>{ // 로컬로 소비(마지막에 저장)
      const i = (pre.cursor||0) % PREROLL_SIZE;
      const roll = pre.prerolls[i];
      pre.prerolls[i] = d100();
      pre.cursor = (i+1) % PREROLL_SIZE;
      pre.updatedAt = Timestamp.now();
      return roll;
    };

    // 비-필드 골격 개수(4~6) ← 프리롤
    const spineCount = rangeMap(nextRoll(), 4, 6);
    const diffs = ladder(spineCount);
    logger.info('[createStoryPlanV2] Generated spine structure', { spineCount, difficulties: diffs });
    const nonField = [];
    for (let i=0;i<spineCount;i++){
      const kind =
        (i===0) ? 'town' :
        (i===spineCount-1) ? 'landmark' :
        choiceFromRoll(['town','hub','landmark'], nextRoll());

      // NPC 수(5~10), 우호도 입력값, 바이어스, 관계 프리셋 생성
      const npcCount = rangeMap(nextRoll(), 5, 10);
      const gaRoll = nextRoll();
      const ga = (i===0 ? 'friendly' : groupAttitudeFromRoll(gaRoll, diffs[i]));
      const bias = attitudeBiasFromAttitude(ga);
      const relationsSeed = nextRoll();
      
      logger.info(`[createStoryPlanV2] Non-field node ${i+1}`, { npcCount, groupAttitude: ga, bias });

      // NPC 스켈레톤(역할까지 프리롤)
      const npcSkeleton = makeNPCsSkeleton(npcCount, nextRoll);

      // 관계도 행렬(1..5, 대칭, 대각=3) ← 전부 프리롤로 고정
      const ids = npcSkeleton.list.map(n=>n.id);
      const relations = {};
      for (const a of ids){
        relations[a] = relations[a]||{};
        for (const b of ids){
          if (a===b){ relations[a][b]=3; continue; }
          // 한 번만 굴리고 대칭 복사
          if (relations[a][b]) continue;
          const val = rangeMap(nextRoll(), 1, 5);
          relations[a][b] = val;
          relations[b] = relations[b]||{};
          relations[b][a] = val;
        }
      }
      npcSkeleton.relations = relations;

      nonField.push({
        id: `N${i+1}`,
        kind,
        name: `${worldNorm.name} ${i===0?'시작 마을': (i===spineCount-1?'최종 거점':'거점')} ${i+1}`,
        difficulty: diffs[i],
        npc: npcSkeleton,                 // count/roles/relations까지 프리롤로 고정됨
        groupAttitude: ga==='friendly'?'town':kind, // 표기용(맵 타입), 의미적 용도 없음
        groupAttitudeToPlayerInput: ga,   // V3가 그대로 사용
        npcAttitudeBias: bias,            // V3가 분포에 참고
        relationsSeed,                    // 기록용(현재는 미사용)
        connects: []
      });
    }

    // 비-필드 사이 필드 수(1~5) ← 프리롤
    const nodes=[...nonField];
    const edges=[];
    let fieldSerial=0;
    logger.info('[createStoryPlanV2] Creating field connections between non-field nodes', { nonFieldCount: nonField.length });
    for (let i=0;i<nonField.length-1;i++){
      const a = nonField[i], b = nonField[i+1];
      const k = rangeMap(nextRoll(), 1, 5); // 1~5
      logger.info(`[createStoryPlanV2] Connecting ${a.id} to ${b.id} with ${k} field(s)`);
      let prev = a.id;
      for (let f=0; f<k; f++){
        const id = `F${++fieldSerial}`;
        // 뒤로 갈수록 어려워짐(대략적인 구배, 랜덤 없음)
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

    // 필연 Key Events(타이틀/위치만): 4~5개 (랜덤 없음)
    const keyEvents = [
      { id:'EV1', title:'조력자와의 만남', loc:nodes.find(n=>n.kind!=='field' && n.id!=='N1')?.id || 'N1', status:'pending' },
      { id:'EV2', title:'첫 번째 시련', loc:nodes.find(n=>n.kind==='field')?.id || 'N2', status:'pending' },
      { id:'EV3', title:'절망의 골짜기', loc: nonField[Math.floor(nonField.length/2)]?.id || 'N2', status:'pending' },
      { id:'EV4', title:'각성의 조짐',   loc: nodes.slice(-2)[0]?.id || 'N3', status:'pending' },
      { id:'EV5', title:'최종 결전',     loc: nonField[nonField.length-1]?.id || 'N4', status:'pending' },
    ];

    const runId = 'r'+Date.now();
    
    const planInfo = {
      runId,
      totalNodes: nodes.length,
      fieldNodes: nodes.filter(n=>n.kind==='field').length,
      nonFieldNodes: nonField.length,
      keyEvents: keyEvents.length
    };
    
    log.planCreated(planInfo);

    // 저장(프리롤 커서/버퍼 업데이트 포함)
    await runRef.set({
      prerolls: pre.prerolls, cursor: pre.cursor, updatedAt: pre.updatedAt,
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

  /**
   * V2-4) 스토리 규칙 생성
   * 
   * 전투 및 드랍 시스템의 규칙을 생성하고 저장합니다:
   * - 적 등급별 출현 확률 (난이도별 차등)
   * - HP/데미지 범위 (난이도별, 등급별)
   * - 블록 기본 확률 (레벨에 따라 조정됨)
   * - 아이템 드랍 확률 (등급별)
   * - 이동 중 조우 확률
   * - 레벨링 시스템 (HP 100 기본, 레벨당 +5)
   * 
   * @param {string} charId - 캐릭터 ID
   * @returns {object} { ok, rules }
   */
  const createStoryRulesV2 = onCall({ region:'us-central1' }, async (req)=>{
    const uid = req.auth?.uid;
    if (!await hasStoryAccess(uid)) throw new HttpsError('permission-denied','권한 없음');
    const { charId } = req.data||{};
    if (!charId) throw new HttpsError('invalid-argument','charId 필요');

    logger.info('[createStoryRulesV2] Creating story rules', { charId });

    const ref = db.doc(`storyRuns/${charId}`);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('failed-precondition','V2 뼈대가 먼저 필요합니다.');

    const rules = buildStoryRulesV2();
    
    log.rulesCreated({ 
      enemyGrades: rules.ENEMY_GRADES.length,
      dropRarities: rules.DROP_RARITIES.length,
      difficulties: Object.keys(rules.gradeProb).length
    });
    
    await ref.set({ rules, rulesUpdatedAt: Timestamp.now() }, { merge:true });
    return { ok:true, rules };
  });

  // V2-5) 룰 조회(개발자 콘솔 출력용)
  const getStoryRulesV2 = onCall({ region:'us-central1' }, async (req)=>{
    const uid = req.auth?.uid;
    if (!await hasStoryAccess(uid)) throw new HttpsError('permission-denied','권한 없음');
    const { charId } = req.data||{};
    if (!charId) throw new HttpsError('invalid-argument','charId 필요');
    const ref = db.doc(`storyRuns/${charId}`);
    const d = (await ref.get()).data()||null;
    return { ok: !!d?.rules, rules: d?.rules||null };
  });

  /**
   * V2-6) 필드 통계 물리화
   * 
   * 각 필드(전투 지역)의 적 등급별 HP/데미지 범위를 
   * 하위 컬렉션에 저장합니다. 이는 실시간 전투에서 참조됩니다.
   * 
   * 예: storyRuns/{charId}/fields/F1_elite
   *     { hpRange: {min: 90, max: 130}, dmgRange: {min: 14, max: 24} }
   * 
   * @param {string} charId - 캐릭터 ID
   * @returns {object} { ok, count } - 생성된 통계 문서 수
   */
  const materializeFieldStatsV2 = onCall({ region:'us-central1' }, async (req)=>{
    const uid = req.auth?.uid;
    if (!await hasStoryAccess(uid)) throw new HttpsError('permission-denied','권한 없음');
    const { charId } = req.data||{};
    if (!charId) throw new HttpsError('invalid-argument','charId 필요');

    logger.info('[materializeFieldStatsV2] Starting field stats materialization', { charId });

    const runRef = db.doc(`storyRuns/${charId}`);
    const run = (await runRef.get()).data();
    if (!run?.graph?.nodes) throw new HttpsError('failed-precondition','V2 뼈대가 먼저 필요합니다.');
    const rules = run.rules || buildStoryRulesV2();

    const fields = run.graph.nodes.filter(n=>n.kind==='field');
    const batch = db.batch();
    for (const f of fields){
      const diff = f.difficulty;
      for (const g of rules.ENEMY_GRADES){
        const hp = rules.hpRanges[diff][g];
        const dmg = rules.dmgRanges[diff][g];
        const docRef = db.doc(`storyRuns/${charId}/fields/${f.id}_${g}`);
        batch.set(docRef, {
          fieldId: f.id,
          grade: g,
          difficulty: diff,
          hpRange: { min: hp[0], max: hp[1] },
          dmgRange:{ min: dmg[0], max: dmg[1] },
          updatedAt: Timestamp.now()
        }, { merge:true });
      }
    }
    await batch.commit();
    
    const totalCount = fields.length * rules.ENEMY_GRADES.length;
    log.fieldStatsCreated({ 
      count: totalCount, 
      fieldCount: fields.length, 
      gradesPerField: rules.ENEMY_GRADES.length 
    });
    
    return { ok:true, count: totalCount };
  });

  // V2-7) 특정 필드/등급 범위 조회(디버그)
  const getFieldStatsV2 = onCall({ region:'us-central1' }, async (req)=>{
    const uid = req.auth?.uid;
    if (!await hasStoryAccess(uid)) throw new HttpsError('permission-denied','권한 없음');
    const { charId, fieldId } = req.data||{};
    if (!charId || !fieldId) throw new HttpsError('invalid-argument','charId/fieldId 필요');

    const runRef = db.doc(`storyRuns/${charId}`);
    const run = (await runRef.get()).data();
    if (!run) throw new HttpsError('failed-precondition','V2 뼈대가 먼저 필요합니다.');
    const rules = run.rules || buildStoryRulesV2();
    const grades = rules.ENEMY_GRADES;

    const col = db.collection(`storyRuns/${charId}/fields`);
    const snaps = await Promise.all(grades.map(g=>col.doc(`${fieldId}_${g}`).get()));
    const out = [];
    snaps.forEach((s)=>{ if (s.exists) out.push(s.data()); });
    return { ok:true, stats: out };
  });

  return {
    createStoryPlanV2,
    getRunSkeletonV2,
    devTakeRollV2,
    createStoryRulesV2,
    getStoryRulesV2,
    materializeFieldStatsV2,
    getFieldStatsV2,
  };
};
