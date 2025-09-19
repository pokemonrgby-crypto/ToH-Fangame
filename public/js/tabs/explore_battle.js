// /public/js/tabs/explore_battle.js
import { auth, db, fx } from '../api/firebase.js';
import { showToast } from '../ui/toast.js';
import { serverBattleAction, serverBattleFlee } from '../api/explore.js';

// --- 유틸리티 함수 ---
function esc(s){ return String(s??'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function parseRunIdFromBattle() { /* ... 기존 코드 ... */ }
function showLoading(show = true, text = '불러오는 중...') { /* ... 기존 코드 ... */ }

export async function showExploreBattle() {
  showLoading(true, '전투 정보 불러오는 중...');
  const root = document.getElementById('view');
  const runId = parseRunIdFromBattle();
  
  if (!auth.currentUser || !runId) { /* ... 에러 처리 ... */ }

  const runRef = fx.doc(db, 'explore_runs', runId);
  const runSnap = await fx.getDoc(runRef);

  if (!runSnap.exists() || !runSnap.data().pending_battle) {
    root.innerHTML = `<section class="container narrow"><div class="kv-card">활성화된 전투가 없습니다. 탐험 화면으로 돌아갑니다.</div></section>`;
    setTimeout(() => location.hash = `#/explore-run/${runId}`, 1500);
    showLoading(false);
    return;
  }

  let runState = runSnap.data();
  let battleState = runState.pending_battle;

  const charSnap = await fx.getDoc(fx.doc(db, runState.charRef));
  const character = charSnap.exists() ? { id: charSnap.id, ...charSnap.data() } : {};

  // --- UI 렌더링 함수 ---
  const render = () => {
    // 템플릿 렌더링 (최초 1회)
    if (!root.querySelector('#battleRoot')) {
      root.innerHTML = `
        <section class="container narrow" id="battleRoot">
          <div class="card p12">
            <div class="row" style="justify-content:space-between; align-items:center;">
              <div id="enemyName" style="font-weight:800;"></div>
              <div id="enemyHpText" class="text-dim" style="font-size:12px;"></div>
            </div>
            <div class="hp-bar-outer"><div id="enemyHpBar" class="hp-bar-inner enemy"></div></div>
          </div>

          <div class="kv-label mt16">전투 기록</div>
          <div id="battleLog" class="card p16" style="min-height:150px; max-height: 250px; overflow-y:auto; font-size:14px; line-height:1.6;"></div>

          <div class="card p12 mt16">
            <div class="row" style="justify-content:space-between; align-items:center;">
              <div id="playerName" style="font-weight:800;"></div>
              <div id="playerHpText" class="text-dim" style="font-size:12px;"></div>
            </div>
            <div class="hp-bar-outer"><div id="playerHpBar" class="hp-bar-inner player"></div></div>
            
            <div class="kv-label mt12">행동 선택</div>
            <div id="actionBox" class="grid2" style="gap:8px;"></div>
          </div>
          
          <div style="text-align:right; margin-top:16px;">
            <button id="fleeBtn" class="btn ghost">후퇴</button>
          </div>
        </section>
      `;
      bindEvents(); // 이벤트는 한 번만 바인딩
    }

    // 데이터 업데이트
    const enemyHpPercent = Math.max(0, (battleState.enemy.hp / battleState.enemy.maxHp) * 100);
    const playerHpPercent = Math.max(0, (battleState.playerHp / runState.stamina_start) * 100);

    root.querySelector('#enemyName').textContent = esc(battleState.enemy.name);
    root.querySelector('#enemyHpText').textContent = `${battleState.enemy.hp} / ${battleState.enemy.maxHp}`;
    root.querySelector('#enemyHpBar').style.width = `${enemyHpPercent}%`;
    
    root.querySelector('#playerName').textContent = esc(character.name);
    root.querySelector('#playerHpText').textContent = `${battleState.playerHp} / ${runState.stamina_start}`;
    root.querySelector('#playerHpBar').style.width = `${playerHpPercent}%`;

    root.querySelector('#battleLog').innerHTML = battleState.log.map(l => `<p>${esc(l)}</p>`).join('');
    root.querySelector('#battleLog').scrollTop = root.querySelector('#battleLog').scrollHeight;
    
    // 행동 버튼 렌더링
    let actionButtonsHTML = '';
    const equippedSkills = (character.abilities_equipped || []).map(idx => (character.abilities_all || [])[idx]).filter(Boolean);
    equippedSkills.forEach((skill, i) => {
        actionButtonsHTML += `<button class="btn action-btn" data-type="skill" data-index="${i}">${esc(skill.name)}</button>`;
    });

    const equippedItems = (character.items_equipped || []).map(id => (character.allItems || []).find(it => it.id === id)).filter(Boolean);
    equippedItems.forEach((item, i) => {
        const usesLeft = (item.isConsumable || item.consumable) && typeof item.uses === 'number' ? ` (${item.uses})` : '';
        actionButtonsHTML += `<button class="btn ghost action-btn" data-type="item" data-index="${i}">${esc(item.name)}${usesLeft}</button>`;
    });
    actionButtonsHTML += `<button class="btn ghost action-btn" data-type="interact" data-index="0">상호작용</button>`;
    root.querySelector('#actionBox').innerHTML = actionButtonsHTML;
  };

  // --- 이벤트 핸들러 ---
  const handleAction = async (e) => {
    const btn = e.target.closest('.action-btn');
    if (!btn) return;

    const type = btn.dataset.type;
    const index = parseInt(btn.dataset.index, 10);
    
    showLoading(true, 'AI가 행동을 처리하는 중...');
    try {
      const result = await serverBattleAction(runId, type, index);
      battleState = result.battle_state; // 새 전투 상태로 교체
      render();

      if (result.battle_over) {
        showToast(result.outcome === 'win' ? '전투에서 승리했습니다!' : '전투에서 패배했습니다.');
        setTimeout(() => location.hash = `#/explore-run/${runId}`, 2000);
      }
    } catch (err) {
      console.error('Battle action failed', err);
      showToast(err.message || '행동 처리에 실패했습니다.');
    } finally {
      if (!location.hash.includes('battle')) return; // 페이지 이동 시 로딩창 끄지 않음
      showLoading(false);
    }
  };

  const handleFlee = async () => {
    showLoading(true, '후퇴하는 중...');
    try {
      await serverBattleFlee(runId);
      showToast('성공적으로 후퇴했습니다.');
      location.hash = `#/explore-run/${runId}`;
    } catch (err) {
      console.error('Flee failed', err);
      showToast(err.message || '후퇴에 실패했습니다.');
      showLoading(false);
    }
  };
  
  const bindEvents = () => {
    root.querySelector('#actionBox').addEventListener('click', handleAction);
    root.querySelector('#fleeBtn').addEventListener('click', handleFlee);
  };

  // --- 초기 실행 ---
  const userSnap = await fx.getDoc(fx.doc(db, 'users', auth.currentUser.uid));
  character.allItems = userSnap.exists() ? userSnap.data().items_all || [] : []; // 아이템 정보 주입
  
  render();
  showLoading(false);
}

export default showExploreBattle;
