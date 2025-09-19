// /public/js/tabs/explore_run.js
import { db, auth, fx } from '../api/firebase.js';
import { showToast } from '../ui/toast.js';
import { getActiveRun } from '../api/explore.js';
import { serverPrepareNext, serverApplyChoice, serverEndRun } from '../api/explore.js';

const STAMINA_MIN = 0;

// ---------- 유틸리티 함수 (전체 포함) ----------

function esc(s){ return String(s??'').replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

function rt(raw) {
  if (!raw) return '';
  let s = String(raw);
  s = esc(s);
  s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  s = s.replace(/_(.+?)_/g, '<i>$1</i>');
  s = s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/\n/g, '<br>');
  return s;
}

async function prepareNextTurnServer(run){
  const pending = await serverPrepareNext(run.id);
  return pending; // { narrative_text, choices[3], choice_outcomes[3], diceResults[3] }
}


function parseRunId(){
  const h = location.hash || '';
  const m = h.match(/^#\/explore-run\/([^/]+)/);
  return m ? m[1] : null;
}

function renderHeader(box, run){
  box.innerHTML = `
    <div class="row" style="gap:8px;align-items:center">
      <button class="btn ghost" id="btnBack">← 탐험 선택으로</button>
      <div style="font-weight:900">${esc(run.world_name||run.world_id)} / ${esc(run.site_name||run.site_id)}</div>
    </div>
    <div class="kv-card" style="margin-top:8px">
      <div class="row" style="gap:10px;align-items:center">
        <div style="flex:1">체력</div>
        <div class="text-dim" style="font-size:12px">${run.stamina}/${run.stamina_start}</div>
      </div>
      <div style="height:10px;border:1px solid #273247;border-radius:999px;overflow:hidden;background:#0d1420;margin-top:6px">
        <div style="height:100%;width:${Math.max(0, Math.min(100, (run.stamina/run.stamina_start)*100))}%;
                    background:linear-gradient(90deg,#4ac1ff,#7a9bff,#c2b5ff)"></div>
      </div>
    </div>
  `;
}

function eventLineHTML(ev) {
  const kind = ev.dice?.eventKind || ev.kind || 'narrative';
  const note = ev.note || '이벤트가 발생했습니다.';
  
  const styleMap = {
    combat: { border: '#ff5b66', title: '전투 발생' },
    item:   { border: '#f3c34f', title: '아이템 발견' },
    risk:   { border: '#f3c34f', title: '위험 감수' },
    safe:   { border: '#4aa3ff', title: '안전한 휴식' },
    narrative: { border: '#6e7b91', title: '이야기 진행' },
    'combat-retreat': { border: '#ff5b66', title: '후퇴' },
  };

  const { border, title } = styleMap[kind] || styleMap.narrative;
  const formattedNote = esc(note).replace(/(\[선택:.*?\])/g, '<span style="color: #8c96a8;">$1</span>');

  return `<div class="kv-card" style="border-left:3px solid ${border};padding-left:10px">
      <div style="font-weight:800">${title}</div>
      <div class="text-dim" style="font-size:12px; white-space: pre-wrap; line-height: 1.6;">${formattedNote}</div>
    </div>`;
}

function calcRunExp(run) {
  const turn = run.turn || 0;
  const events = run.events || [];
  const chestCnt = events.filter(e => e.dice?.eventKind === 'chest').length;
  const allyCnt  = events.filter(e => e.dice?.eventKind === 'ally').length;
  return Math.max(0, Math.round(turn * 1.5 + chestCnt + allyCnt));
}

function showLoading(show = true, text = '불러오는 중...') {
  let overlay = document.getElementById('toh-loading-overlay');
  if (show) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'toh-loading-overlay';
      overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:9999;color:white;`;
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = `<div>${text}</div>`;
    overlay.style.display = 'flex';
  } else {
    if (overlay) overlay.style.display = 'none';
  }
}

// ---------- 메인 로직 ----------

export async function showExploreRun() {
  const loadingOverlay = document.getElementById('toh-loading-overlay');
  if (loadingOverlay) {
    loadingOverlay.remove();
  }

  showLoading(true, '탐험 정보 확인 중...');
  const root = document.getElementById('view');
  const runId = parseRunId();

  if (!auth.currentUser || !runId) {
    root.innerHTML = `<section class="container narrow"><div class="kv-card">잘못된 접근입니다.</div></section>`;
    showLoading(false);
    return;
  }

  // --- [수정된 로직 시작] ---

  let state = await getActiveRun(runId);
  
  // 1. 캐릭터 존재 여부 확인
  const charId = state.charRef.split('/')[1];
  const charSnap = await fx.getDoc(fx.doc(db, 'chars', charId));

    if (!charSnap.exists()) {
    showToast('탐험 중인 캐릭터가 삭제되어 탐험을 종료합니다.');
    await serverEndRun(runId, 'char_deleted'); // ✅ 서버 함수로 종료
    setTimeout(() => location.hash = '#/adventure', 1500);
    showLoading(false);
    return;
  }


  
  if (state.pending_battle) {
    location.hash = `#/explore-battle/${runId}`;
    return;
  }

  if (state.owner_uid !== auth.currentUser.uid) {
    root.innerHTML = `<section class="container narrow"><div class="kv-card">이 탐험의 소유자가 아닙니다.</div></section>`;
    showLoading(false);
    return;
  }

  const worldsResponse = await fetch('/assets/worlds.json').catch(() => null);
  const worldsData = worldsResponse ? await worldsResponse.json() : { worlds: [] };
  const world = worldsData.worlds.find(w => w.id === state.world_id) || {};
  const site = (world.detail?.sites || []).find(s => s.id === state.site_id) || {};

  const render = (runState) => {
    root.innerHTML = `
      <section class="container narrow">
        <div id="runHeader"></div>
        <div class="card p16 mt12">
          <div class="kv-label">서사</div>
          <div id="narrativeBox" style="white-space:pre-wrap; line-height:1.6; min-height: 60px;"></div>
          <div id="choiceBox" class="col mt12" style="gap:8px;"></div>
        </div>
        <div class="card p16 mt12">
          <div class="kv-label">이동 로그 (${runState.turn}턴)</div>
          <div id="logBox" class="col" style="gap:8px; max-height: 200px; overflow-y: auto;"></div>
        </div>
      </section>
    `;

    renderHeader(root.querySelector('#runHeader'), runState);
    root.querySelector('#runHeader #btnBack').onclick = () => location.hash = '#/adventure';
    root.querySelector('#logBox').innerHTML = (runState.events || []).slice().reverse().map(eventLineHTML).join('');

    const narrativeBox = root.querySelector('#narrativeBox');
    const choiceBox = root.querySelector('#choiceBox');
    
    const pendingTurn = runState.pending_choices;
    if (pendingTurn) {
      narrativeBox.innerHTML = rt(pendingTurn.narrative_text);
      choiceBox.innerHTML = pendingTurn.choices.map((label, index) =>
        `<button class="btn choice-btn" data-index="${index}">${esc(label)}</button>`
      ).join('');
    } else {
      const lastEvent = runState.events?.slice(-1)[0];
      narrativeBox.innerHTML = rt(lastEvent?.note || `당신은 ${site.name} 에서의 탐험을 시작했습니다...`);
      // [수정] 전투 대기 상태일 경우 '전투 시작' 버튼 표시
      if (runState.battle_pending) {
        choiceBox.innerHTML = `<div class="row" style="gap:8px;justify-content:flex-end;"><button class="btn" id="btnStartBattle">⚔️ 전투 시작</button></div>`;
      } else if (runState.status === 'ended') {
        choiceBox.innerHTML = `<div class="text-dim">탐험이 종료되었습니다.</div>`;
      } else {
        choiceBox.innerHTML = `<div class="row" style="gap:8px;justify-content:flex-end;"><button class="btn ghost" id="btnGiveUp">탐험 포기</button><button class="btn" id="btnMove">계속 탐험</button></div>`;
      }
    }
    bindButtons(runState);
  };

  const bindButtons = (runState) => {
  if (runState.status !== 'ongoing') return;
  
  const btnStartBattle = root.querySelector('#btnStartBattle');
  if (btnStartBattle) {
    btnStartBattle.onclick = async () => {
      showLoading(true, '전투 준비 중...');
      await serverStartBattle(state.id);   // 서버에서 battle_pending → pending_battle 전환
      location.hash = `#/explore-battle/${state.id}`;
    };
    return; // 전투 대기 중에는 다른 버튼(탐험 계속 등) 비활성화
  }

  if (runState.pending_choices) {
    root.querySelectorAll('.choice-btn').forEach(btn => {
      btn.onclick = () => handleChoice(parseInt(btn.dataset.index, 10));
    });
  } else {
    const btnMove = root.querySelector('#btnMove');
    if (btnMove) {
      btnMove.disabled = runState.stamina <= STAMINA_MIN;
      btnMove.onclick = prepareNextTurn;
    }
    const btnGiveUp = root.querySelector('#btnGiveUp');
    if (btnGiveUp) btnGiveUp.onclick = () => endRun('giveup');
  }
};


  const prepareNextTurn = async () => {
    showLoading(true, 'AI가 다음 상황을 생성 중...');
    try {
      const pendingTurn = await serverPrepareNext(state.id); // ✅ 서버가 AI 호출 + 선택지 생성
      state.pending_choices = pendingTurn;
      render(state);
    } catch (e) {
      console.error('[explore] prepareNextTurn failed', e);
      showToast('오류: 시나리오 생성에 실패했어');
    } finally {
      showLoading(false);
    }
  };


// /public/js/tabs/explore_run.js의 handleChoice 함수를 교체하세요.

  const handleChoice = async (index) => {
    showLoading(true, '선택지 적용 중...');
    try {
      const result = await serverApplyChoice(state.id, index); // ✅ 서버에서 이벤트 반영
      state = { ...state, ...result.state }; // 💥 해결책: 기존 state와 새 state를 병합합니다.

      if (result.battle) {
        // 서버가 battle_pending 세팅함
        location.hash = `#/explore-battle/${state.id}`;
        return; // 전투 화면에서 로딩 해제
      }
      if (result.done) {
        showToast('탐험이 종료되었어');
      }
      render(state);
    } catch (e) {
      console.error('[explore] handleChoice failed', e);
      showToast('선택 적용 중 오류가 발생했어');
    } finally {
      // 전투 화면 이동 시엔 위에서 return 했으니 여기 도달 안 함
      const stillHere = location.hash.startsWith('#/explore-run/');
      if (stillHere) showLoading(false);
    }
  };


  const endRun = async (reason) => {
  if (state.status !== 'ongoing') return;
  showLoading(true, '탐험 종료 중...');
  try {
    const s = await serverEndRun(state.id, reason);
    state = s || state;
    showToast('탐험이 종료되었어');
    render(state);
  } catch (e) {
    console.error('[explore] endRun failed', e);
    showToast('탐험 종료 중 오류가 발생했어');
  } finally {
    showLoading(false);
  }
};

  
  render(state);
  showLoading(false);
}

export default showExploreRun;
