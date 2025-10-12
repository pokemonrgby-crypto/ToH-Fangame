// functions/storyV4.js
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { Timestamp, FieldValue } = require('firebase-admin/firestore');
const { logger } = require('firebase-functions');

// --- (재사용) 스토리 액세스 권한 확인 함수 ---
async function hasStoryAccess(admin, uid){
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

    // [TODO: 트랜잭션]
    // 1. char, storyRun 문서 읽기 (reads before writes)
    // 2. 유효성 검사, 쿨타임/HP 체크, 이동 가능 노드 검증
    // 3. 필드 이동 시 Ambush 확률 체크 (V2의 rules.travel.ambushChance 참조)
    // 4. char 문서의 current_node 업데이트 또는 전투 상태 저장
    // 5. 결과 반환 (이동 성공/전투 시작/이벤트 발생)

    logger.info(`[V4] Adventure attempt: ${charId} to ${targetNodeId}`);
    return { ok:false, msg:'[WIP] Adventure logic not yet implemented.' };
  });

  // V4-2) 턴 진행 및 전투 로직 (이미 시작된 전투에 한함)
  const progressBattleTurn = onCall({ region:'us-central1' }, async (req)=>{
    const uid = req.auth?.uid;
    if (!await hasStoryAccess(admin, uid)) throw new HttpsError('permission-denied','권한 없음');
    const { runId, charId, action, target } = req.data||{};
    if (!runId || !charId || !action) throw new HttpsError('invalid-argument','필수 인자 누락');

    // [TODO: 트랜잭션]
    // 1. storyRun 문서 읽기 (전투 상태, 몬스터, HP 등) (reads before writes)
    // 2. 유저 턴 처리: 데미지/블록 확률 계산 (V2의 규칙 테이블 참조)
    // 3. 몬스터 턴 처리: 스킬 선택, 유저의 블록 확률 체크, 데미지 계산, 로그 기록
    // 4. 전투 종료 조건 체크 및 정산 로직 호출 (HP가 0이 되었는지)

    logger.info(`[V4] Battle Turn: ${charId} in ${runId} with action ${action}`);
    return { ok:false, msg:'[WIP] Battle turn logic not yet implemented.' };
  });

  // V4-3) 스토리 런 전용 아이템 사용
  const useRunItem = onCall({ region:'us-central1' }, async (req)=>{
    const uid = req.auth?.uid;
    if (!await hasStoryAccess(admin, uid)) throw new HttpsError('permission-denied','권한 없음');
    const { runId, charId, itemId } = req.data||{};
    if (!runId || !charId || !itemId) throw new HttpsError('invalid-argument','필수 인자 누락');

    // [TODO: 트랜잭션]
    // 1. storyRun 문서 읽기 (아이템 목록) (reads before writes)
    // 2. 아이템 효과 하드코딩 로직 실행 (HP 회복, 무효화 등)
    // 3. 아이템 사용 횟수 또는 count 감소 처리 (consumable:true, uses:1 규칙 적용)

    logger.info(`[V4] Item use: ${charId} used ${itemId} in ${runId}`);
    return { ok:false, msg:'[WIP] Item use logic not yet implemented.' };
  });

  // V4-4) 스토리 런 종료 (사망 또는 클리어)
  const endStoryRun = onCall({ region:'us-central1' }, async (req)=>{
    const uid = req.auth?.uid;
    if (!await hasStoryAccess(admin, uid)) throw new HttpsError('permission-denied','권한 없음');
    const { runId, reason } = req.data||{};
    if (!runId || !reason) throw new HttpsError('invalid-argument','runId/reason 필요');

    // [TODO: 트랜잭션]
    // 1. storyRun 문서 읽기 (reads before writes)
    // 2. 보상 계산 (경험치, 드랍 아이템 등)
    // 3. 경험치/코인 정산 (index.js의 mintByAddExp 재활용 또는 이동 필요)
    // 4. storyRun.status = 'ended', char.story_active_run = FieldValue.delete()

    logger.info(`[V4] Story end: ${runId} by reason ${reason}`);
    return { ok:false, msg:'[WIP] End run logic not yet implemented.' };
  });

  return {
    runStoryAdventure,
    progressBattleTurn,
    useRunItem,
    endStoryRun,
  };
};
