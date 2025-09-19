// /public/js/api/explore.js
import { db, auth, fx, func } from './firebase.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-functions.js';
import { logInfo } from './logs.js';
import { EXPLORE_COOLDOWN_KEY, EXPLORE_COOLDOWN_MS, apply as applyCooldown } from './cooldown.js';


// ===== 서버 호출 래퍼: V2 =====
export async function serverStartRun({ char, world, site, staminaStart }){
  const { data } = await call('startExploreV2')({
    charId: char.id,
    worldId: world.id, worldName: world.name,
    siteId: site.id,   siteName: site.name,
    difficulty: site.difficulty || 'normal',
    staminaStart
  });
  if(!data?.ok) throw new Error('startExploreV2 실패');
  return data.runId;
}

export async function serverPrepareNext(runId){
  const { data } = await call('advPrepareNextV2')({ runId });
  if(!data?.ok) throw new Error('advPrepareNextV2 실패');
  return data.pending;
}

export async function serverApplyChoice(runId, index){
  const { data } = await call('advApplyChoiceV2')({ runId, index });
  if(!data?.ok) throw new Error('advApplyChoiceV2 실패');
  return data;
}

export async function serverEndRun(runId, reason='ended'){
  const { data } = await call('endExploreV2')({ runId, reason });
  if(!data?.ok) throw new Error('endExploreV2 실패');
  return data.state;
}

export async function serverStartBattle(runId){
  const { data } = await call('advStartBattleV2')({ runId });
  if(!data?.ok) throw new Error('advStartBattleV2 실패');
  return data.state;
}

// [신규] 전투 행동 서버 호출 함수
export async function serverBattleAction(runId, actionType, actionIndex) {
  const { data } = await call('advBattleActionV2')({ runId, actionType, actionIndex });
  if (!data?.ok) throw new Error('advBattleActionV2 실패');
  return data;
}

// [신규] 전투 후퇴 서버 호출 함수
export async function serverBattleFlee(runId) {
  const { data } = await call('advBattleFleeV2')({ runId });
  if (!data?.ok) throw new Error('advBattleFleeV2 실패');
  return data;
}

export const call = (name) => httpsCallable(func, name);




// 진행 중인 내 탐험 1개 찾기
export async function findMyActiveRun(){
  const u = auth.currentUser; if(!u) return null;
  const q = fx.query(
    fx.collection(db,'explore_runs'),
    fx.where('owner_uid','==', u.uid),
    fx.where('status','==','ongoing'),
    fx.orderBy('startedAt','desc'),
    fx.limit(1)
  );
  const s = await fx.getDocs(q);
  return s.empty ? null : { id: s.docs[0].id, ...s.docs[0].data() };
}


// ✅ createRun: 서버 시작 래퍼
const STAMINA_BASE = 10;
export async function createRun({ world, site, char }){
  // 길드 버프(있으면) 반영
  let staminaStart = STAMINA_BASE;
  try{
    const { data: gb } = await call('getGuildBuffsForChar')({ charId: char.id });
    if (gb?.ok) staminaStart = Math.max(1, STAMINA_BASE + Number(gb.stamina_bonus || 0));
  }catch(_){}

  const runId = await serverStartRun({ char, world, site, staminaStart });

  // 쿨타임 캐시
  applyCooldown(EXPLORE_COOLDOWN_KEY, EXPLORE_COOLDOWN_MS);

  // 시작 로그(선택)
  try {
    await logInfo('explore', '탐험 시작', {
      code: 'explore_start',
      world: world.name || world.id,
      site:  site.name  || site.id,
      charId: char.id
    }, `explore_runs/${runId}`);
  } catch (_){}

  return runId;
}

// ✅ 읽기 전용 도우미
export async function getActiveRun(runId){
  const ref = fx.doc(db,'explore_runs', runId);
  const s = await fx.getDoc(ref);
  if(!s.exists()) throw new Error('런이 없어');
  return { id:s.id, ...s.data() };
}
