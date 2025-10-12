// functions/storyV4.js
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { Timestamp, FieldValue } = require('firebase-admin/firestore');
const { logger } = require('firebase-functions');

// === V2에서 가져온 헬퍼 및 룰 테이블 정의 시작 ===
// (V2 파일에 정의된 프리롤, 클램프, 룰 테이블 등을 복사하여 사용합니다.)

// --- 프리롤 링버퍼 헬퍼 ---
const PREROLL_SIZE = 50;
function d100(){ return Math.floor(Math.random()*100)+1; }
/** Firestore transactions require all reads to be executed before all writes */
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

// --- 공용 유틸 및 룰 테이블 (V2.js에서 복사) ---
const clamp = (n,min,max)=>Math.max(min,Math.min(max,n));
const rangeMap = (r, min, max) => min + ((Math.max(1, r)-1) % (max-min+1));
const choiceFromRoll = (arr, r) => arr[(Math.max(1, r)-1) % arr.length];

function buildStoryRulesV2(){
  // V2.js에서 복사된 전체 규칙을 여기에 포함해야 합니다.
  // 여기서는 생략하고, 필수적인 leveling 및 travel만 명시합니다.
  const travel = { ambushChance: 18 }; // %
  const leveling = { hpBase:100, hpPerLevel:5, expField:'story_exp', maxLevel:100 };
  // ... (다른 규칙들: gradeProb, hpRanges, dmgRanges, blockBase, dropRates 등)
  return { travel, leveling, hpRanges:{easy:{trash:[20,35]}}, dmgRanges:{easy:{trash:[3,6]}} /* ... */ };
}
const STORY_RULES = buildStoryRulesV2();

// --- 레벨/HP 계산 및 EXP 정산 유틸 ---
function getLevelFromExp(exp, maxLevel=100) {
  // 간단화된 레벨링 공식 가정 (실제 공식은 프로젝트에 맞게 조정 필요)
  const L = Math.floor(Math.sqrt(exp / 50 + 1));
  return clamp(L, 1, maxLevel);
}
function getMaxHpFromLevel(level, base=100, perLevel=5) {
  return base + (level - 1) * perLevel;
}

/**
 * 캐릭터 문서에 story_exp_total를 업데이트하고 레벨/최대HP를 계산하며 story_coins를 민팅합니다.
 */
async function mintByAddStoryExp(tx, charRef, ownerUid, addExp, note) {
  addExp = Math.max(0, Math.floor(Number(addExp) || 0));
  if (addExp <= 0) return { minted: 0, levelAfter: 1, maxHpAfter: 100 };

  const db = require('firebase-admin').firestore();
  const cSnap = await tx.get(charRef);
  if (!cSnap.exists) throw new HttpsError('not-found','char not found');
  const runData = cSnap.data().story_run_data || {};

  const expTotal0 = Math.floor(Number(runData.story_exp_total || 0));
  const expTotal1 = expTotal0 + addExp;

  const L = STORY_RULES.leveling;
  const level = getLevelFromExp(expTotal1, L.maxLevel);
  const maxHp = getMaxHpFromLevel(level, L.hpBase, L.hpPerLevel);

  // 코인 민팅: 100 Exp 당 1 Story Coin으로 민팅 (V2 규칙 참조)
  const mintRate = 100;
  const minted = Math.floor(addExp / mintRate);
  
  const userRef = db.doc(`users/${ownerUid}`);

  tx.update(charRef, {
    story_run_data: {
      ...runData,
      story_exp_total: expTotal1,
      level: level,
      maxHp: maxHp,
      updatedAt: Timestamp.now(),
    },
    updatedAt: Timestamp.now(),
  });
  
  // 유저의 story_coins 업데이트
  if (minted > 0) {
    tx.set(userRef, { story_coins: FieldValue.increment(minted) }, { merge: true });
  }

  return { minted: minted, levelAfter: level, maxHpAfter: maxHp };
}
// === V2에서 가져온 헬퍼 및 룰 테이블 정의 끝 ===


// --- (재사용) 스토리 액세스 권한 확인 함수 ---
async function hasStoryAccess(admin, uid){
  // ... (이전과 동일)
  if (!uid) return false;
  try{
    const db = admin.firestore();
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


module.exports = (admin, { GEMINI_API_KEY }) => {
  const db = admin.firestore();

  // V4-1) 캐릭터 이동 및 인카운터 시작 (Ambush 포함)
  const runStoryAdventure = onCall({ region:'us-central1' }, async (req)=>{
    const uid = req.auth?.uid;
    if (!await hasStoryAccess(admin, uid)) throw new HttpsError('permission-denied','권한 없음');
    const { charId, targetNodeId } = req.data||{};
    if (!charId || !targetNodeId) throw new HttpsError('invalid-argument','charId/targetNodeId 필요');

    const charRef = db.doc(`chars/${charId}`);
    const runRef = db.doc(`storyRuns/${charId}`);
    const prerollRef = runRef;

    let result = null;

    await db.runTransaction(async (tx)=>{
      // [READS] Firestore transactions require all reads to be executed before all writes
      const cSnap = await tx.get(charRef);
      const rSnap = await tx.get(runRef);

      if (!cSnap.exists) throw new HttpsError('not-found','캐릭터 없음');
      const charData = cSnap.data() || {};
      const runData = rSnap.data() || {};
      
      if (!rSnap.exists || charData.owner_uid !== uid || runData.status !== 'running') {
          throw new HttpsError('failed-precondition','유효하지 않은 스토리 런');
      }

      const currentRunData = charData.story_run_data || {};
      const graph = runData.graph;
      const rules = runData.rules || STORY_RULES;

      const currentNodeId = currentRunData.current_node || graph.nodes[0]?.id;
      const currentNode = graph.nodes.find(n=>n.id === currentNodeId);
      const targetNode = graph.nodes.find(n=>n.id === targetNodeId);

      // 1. 유효성 검사 (이동 가능 노드 및 HP 체크)
      if (!currentNode || !targetNode) throw new HttpsError('invalid-argument','잘못된 현재/대상 노드 ID');
      const isConnected = currentNode.connects.some(conn => conn.to === targetNodeId);
      if (!isConnected) throw new HttpsError('permission-denied','연결되지 않은 노드');
      if ((currentRunData.currentHp || 0) <= 0) throw new HttpsError('failed-precondition','캐릭터 HP가 0입니다.');

      // 2. Ambush 체크 (Field -> Field 이동 시)
      const roll = await takeRollTx(tx, prerollRef); // 프리롤 소비
      let nextState = 'move';
      if (currentNode.kind === 'field' && targetNode.kind === 'field') {
          const ambushChance = rules.travel.ambushChance; // 18%
          if (roll <= ambushChance) {
              nextState = 'battle'; // Ambush 발생 시 이동은 일어나지 않음
          }
      }
      
      const prevNodeId = currentNodeId;
      const newCurrentNodeId = (nextState === 'move' ? targetNodeId : currentNodeId);
      
      // 3. 업데이트 (이동 또는 전투 시작)
      const updatePayload = {
        'story_run_data.current_node': newCurrentNodeId,
        'story_run_data.updatedAt': Timestamp.now(),
        'story_run_data.log': FieldValue.arrayUnion({ 
          type: nextState, 
          from: prevNodeId, 
          to: newCurrentNodeId, 
          roll: nextState === 'battle' ? roll : undefined,
          desc: nextState === 'battle' ? `Ambush! ${prevNodeId}에서 전투 시작` : `${prevNodeId}에서 ${newCurrentNodeId}로 이동`, 
          at: Timestamp.now() 
        })
      };
      
      if (nextState === 'battle') {
        // 전투 상태 초기화 (몬스터는 progressBattleTurn에서 확정)
        updatePayload['story_run_data.battle'] = {
          status: 'pending_start', 
          nodeId: newCurrentNodeId,
          type: 'ambush',
          turn: 0,
          monster: null, 
          log: []
        };
      } else {
        // 이동 시에는 전투 상태 해제
        updatePayload['story_run_data.battle'] = FieldValue.delete();
      }

      tx.update(charRef, updatePayload);
      
      result = { ok: true, action: nextState, currentNode: newCurrentNodeId, targetNode: targetNodeId };
    });

    return result;
  });

  // V4-2) 턴 진행 및 전투 로직 (이미 시작된 전투에 한함)
  const progressBattleTurn = onCall({ region:'us-central1' }, async (req)=>{
    const uid = req.auth?.uid;
    if (!await hasStoryAccess(admin, uid)) throw new HttpsError('permission-denied','권한 없음');
    const { charId, action, target } = req.data||{};
    if (!charId || !action) throw new HttpsError('invalid-argument','charId/action 필요');

    const charRef = db.doc(`chars/${charId}`);
    const runRef = db.doc(`storyRuns/${charId}`);
    const prerollRef = runRef;
    
    let battleResult = null;

    await db.runTransaction(async (tx)=>{
      // [READS]
      const cSnap = await tx.get(charRef);
      const rSnap = await tx.get(runRef);

      if (!cSnap.exists) throw new HttpsError('not-found','캐릭터 없음');
      const charData = cSnap.data() || {};
      const runData = rSnap.data() || {};
      
      if (!rSnap.exists || charData.owner_uid !== uid) throw new HttpsError('failed-precondition','유효하지 않은 스토리 런');

      const currentRunData = charData.story_run_data || {};
      let battle = currentRunData.battle || {};
      const rules = runData.rules || STORY_RULES;

      if (battle.status === 'done') throw new HttpsError('failed-precondition','전투 종료됨');
      
      // (1) 몬스터 정보 확정 (pending_start일 때)
      if (battle.status === 'pending_start' || !battle.monster) {
        const roll = await takeRollTx(tx, prerollRef);
        // TODO: V2/V3 규칙(노드 난이도, V3 몬스터 목록)에 따라 몬스터 확정 로직 구현
        const diff = 'easy'; 
        const grade = choiceFromRoll(['trash','normal'], roll); // 임시 등급 선택

        const hpRange = rules.hpRanges[diff][grade];
        const dmgRange = rules.dmgRanges[diff][grade];

        battle.monster = {
          id: 'mon_1',
          name: '더미 몬스터', 
          currentHp: rangeMap(roll, hpRange[0], hpRange[1]),
          maxHp: rangeMap(roll, hpRange[0], hpRange[1]),
          grade: grade,
          difficulty: diff,
          skills: [{name:'할퀴기', desc:'1~3 피해'}],
          hpRange: hpRange,
          dmgRange: dmgRange,
        };
        battle.status = 'running';
        battle.turn = 0;
      }
      
      if (battle.status !== 'running') throw new HttpsError('failed-precondition','전투 상태 이상');

      const log = battle.log || [];
      const maxHp = currentRunData.maxHp || 100;
      let playerHp = currentRunData.currentHp || maxHp;
      let monsterHp = battle.monster.currentHp;
      
      battle.turn++;
      
      // (2) 유저 턴 처리
      if (action === 'attack') {
        const roll = await takeRollTx(tx, prerollRef);
        const playerDmg = rangeMap(roll, 5, 15); // 임시 데미지
        
        // TODO: 블록 확률 체크 및 데미지 계산
        
        monsterHp -= playerDmg;
        log.push({ turn: battle.turn, type: 'player_attack', desc: `캐릭터가 공격하여 ${battle.monster.name}에게 ${playerDmg} 피해를 입혔습니다.` });
      } 

      // (3) 몬스터 턴 처리
      if (monsterHp > 0) {
        const roll = await takeRollTx(tx, prerollRef);
        const monsterDmg = rangeMap(roll, battle.monster.dmgRange[0], battle.monster.dmgRange[1]);
        
        // TODO: 블록 확률 체크 및 데미지 감소/무효화 적용
        
        playerHp -= monsterDmg;
        log.push({ turn: battle.turn, type: 'monster_attack', desc: `${battle.monster.name}이 공격하여 캐릭터에게 ${monsterDmg} 피해를 입혔습니다.` });
      }

      // (4) 전투 종료 조건 체크 및 업데이트
      let battleStatus = 'running';
      let endReason = null;
      if (playerHp <= 0) { playerHp = 0; battleStatus = 'done'; endReason = 'death'; } 
      else if (monsterHp <= 0) { monsterHp = 0; battleStatus = 'done'; endReason = 'victory'; }
      
      const updatePayload = {
        'story_run_data.currentHp': clamp(playerHp, 0, maxHp),
        'story_run_data.battle': {
          ...battle,
          monster: { ...battle.monster, currentHp: monsterHp },
          status: battleStatus,
          turn: battle.turn,
          log: log,
        },
        'story_run_data.updatedAt': Timestamp.now(),
      };
      
      if (battleStatus === 'done') {
        updatePayload['story_run_data.battle'] = FieldValue.delete();
        // 클라이언트에서 endStoryRun을 호출하도록 유도합니다.
      }

      tx.update(charRef, updatePayload);
      
      battleResult = { ok: true, status: battleStatus, playerHp, monsterHp, endReason, logEntry: log.slice(-1)[0] };
    });

    return battleResult;
  });

  // V4-3) 스토리 런 전용 아이템 사용
  const useRunItem = onCall({ region:'us-central1' }, async (req)=>{
    const uid = req.auth?.uid;
    if (!await hasStoryAccess(admin, uid)) throw new HttpsError('permission-denied','권한 없음');
    const { charId, itemId } = req.data||{};
    if (!charId || !itemId) throw new HttpsError('invalid-argument','charId/itemId 필요');

    const charRef = db.doc(`chars/${charId}`);
    
    let result = null;

    await db.runTransaction(async (tx)=>{
      // [READS]
      const cSnap = await tx.get(charRef);

      if (!cSnap.exists) throw new HttpsError('not-found','캐릭터 없음');
      const charData = cSnap.data() || {};
      const currentRunData = charData.story_run_data || {};
      
      if (charData.owner_uid !== uid) throw new HttpsError('permission-denied','본인 캐릭터 아님');
      
      const inventory = currentRunData.inventory || [];
      const itemToUse = inventory.find(i => i.id === itemId);

      if (!itemToUse) throw new HttpsError('not-found', '아이템 없음');
      if (itemToUse.isConsumable !== true || (itemToUse.count || 0) <= 0) throw new HttpsError('failed-precondition', '사용 불가능하거나 수량이 0');
      
      // 1. 아이템 효과 적용 (임시: HP 20 회복)
      const maxHp = currentRunData.maxHp || 100;
      const hpRecover = 20;
      let newHp = clamp((currentRunData.currentHp || 0) + hpRecover, 0, maxHp);

      // 2. 인벤토리 업데이트 (수량 1 감소)
      const newInventory = inventory.map(item => {
        if (item.id === itemId) {
          return { ...item, count: (item.count || 0) - 1 };
        }
        return item;
      }).filter(item => item.count > 0);
      
      // 3. 업데이트
      const updatePayload = {
        'story_run_data.currentHp': newHp,
        'story_run_data.inventory': newInventory,
        'story_run_data.log': FieldValue.arrayUnion({ 
          type: 'item_use', 
          itemId: itemId, 
          desc: `${itemToUse.name}을(를) 사용하여 HP ${hpRecover}을 회복했습니다. (현재 HP: ${newHp}/${maxHp})`, 
          at: Timestamp.now() 
        }),
        'story_run_data.updatedAt': Timestamp.now(),
      };

      tx.update(charRef, updatePayload);
      
      result = { ok: true, itemId: itemId, currentHp: newHp };
    });

    return result;
  });

  // V4-4) 스토리 런 종료 (사망 또는 클리어)
  const endStoryRun = onCall({ region:'us-central1' }, async (req)=>{
    const uid = req.auth?.uid;
    if (!await hasStoryAccess(admin, uid)) throw new HttpsError('permission-denied','권한 없음');
    const { charId, reason } = req.data||{};
    if (!charId || !reason) throw new HttpsError('invalid-argument','charId/reason 필요');

    const charRef = db.doc(`chars/${charId}`);
    const runRef = db.doc(`storyRuns/${charId}`);
    
    let result = null;

    await db.runTransaction(async (tx)=>{
      // [READS]
      const cSnap = await tx.get(charRef);
      const rSnap = await tx.get(runRef);

      if (!cSnap.exists) throw new HttpsError('not-found','캐릭터 없음');
      const charData = cSnap.data() || {};
      const runData = rSnap.data() || {};
      
      if (!rSnap.exists || charData.owner_uid !== uid) throw new HttpsError('failed-precondition','유효하지 않은 스토리 런');
      if (runData.status === 'ended') throw new HttpsError('failed-precondition','이미 종료된 스토리');

      const currentRunData = charData.story_run_data || {};
      const ownerUid = charData.owner_uid;
      
      // 1. 보상 계산
      const turnsPlayed = (currentRunData.log || []).filter(l => l.type === 'move').length;
      let baseExp = turnsPlayed * 10;
      if (reason === 'victory') baseExp *= 2; 

      // 2. EXP 정산 및 레벨/HP 업데이트
      const expResult = await mintByAddStoryExp(tx, charRef, ownerUid, baseExp, `story_run_end:${runRef.id}:${reason}`);
      
      // 3. storyRun 문서 업데이트 (종료 상태)
      tx.update(runRef, {
        status: 'ended', 
        endedAt: Timestamp.now(), 
        reason: reason,
        rewards: { exp: baseExp, mintedCoins: expResult.minted },
      });

      // 4. 캐릭터 문서 초기화 및 HP/레벨 업데이트
      tx.update(charRef, { 
        story_active_run: FieldValue.delete(),
        story_run_data: {
          ...currentRunData, // 기존 exp_total 등을 유지
          level: expResult.levelAfter, 
          maxHp: expResult.maxHpAfter,
          currentHp: expResult.maxHpAfter, // HP 만회
          inventory: [], // 아이템 소멸
          current_node: null,
          battle: FieldValue.delete(),
          updatedAt: Timestamp.now()
        },
        updatedAt: Timestamp.now(),
      });

      result = { ok: true, reason: reason, expEarned: baseExp, mintedCoins: expResult.minted };
    });

    return result;
  });


  return {
    runStoryAdventure,
    progressBattleTurn,
    useRunItem,
    endStoryRun,
  };
};
