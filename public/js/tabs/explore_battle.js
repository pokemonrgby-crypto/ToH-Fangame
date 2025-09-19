// /public/js/tabs/explore_battle.js

import { auth, db, fx } from '../api/firebase.js';
import { showToast } from '../ui/toast.js';
import { requestAdventureNarrative, callGemini, fetchPromptDoc } from '../api/ai.js'; // AI 호출 함수 추가

// ---------- 유틸리티 함수 ----------

function esc(s){
  const str = String(s ?? '');
  return str.replace(/[&<>"']/g, ch => (
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;'  : ch === '>' ? '&gt;'  : ch === '"' ? '&quot;': '&#39;'
  ));
}

function rarityStyle(r) {
  const map = {
    normal: { bg: '#2a2f3a', border: '#5f6673', text: '#c8d0dc', label: '일반' },
    rare:   { bg: '#0f2742', border: '#3b78cf', text: '#cfe4ff', label: '레어' },
    epic:   { bg: '#20163a', border: '#7e5cff', text: '#e6dcff', label: '유니크' },
    legend: { bg: '#2b220b', border: '#f3c34f', text: '#ffe9ad', label: '레전드' },
    myth:   { bg: '#3a0f14', border: '#ff5b66', text: '#ffc9ce', label: '신화' },
  };
  return map[(r || '').toLowerCase()] || map.normal;
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

function ensureBattleCss(){ /* 필요 시 CSS 추가 */ }

function parseRunIdFromBattle() {
  const h = location.hash || '';
  const m = h.match(/^#\/explore-battle\/([^/]+)/);
  return m ? m[1] : null;
}

// ---------- 메인 로직 ----------

export async function showExploreBattle() {
  ensureBattleCss();
  showLoading(true, '전투 정보 불러오는 중...');
  const root = document.getElementById('view');
  const runId = parseRunIdFromBattle();
  
  if (!auth.currentUser || !runId) {
    root.innerHTML = `<section class="container narrow"><div class="kv-card">잘못된 접근입니다.</div></section>`;
    showLoading(false);
    return;
  }
  
  const runRef = fx.doc(db, 'explore_runs', runId);
  const runSnap = await fx.getDoc(runRef);

  if (!runSnap.exists() || !runSnap.data().pending_battle) {
      root.innerHTML = `<section class="container narrow"><div class="kv-card">전투 정보를 찾을 수 없습니다. 탐험 화면으로 돌아갑니다.</div></section>`;
      setTimeout(() => location.hash = `#/explore-run/${runId}`, 1500);
      showLoading(false);
      return;
  }

  const runState = runSnap.data();
  const battleInfo = runState.pending_battle;
  const enemy = battleInfo.enemy;

  const charSnap = await fx.getDoc(fx.doc(db, runState.charRef));
  const character = charSnap.exists() ? { id: charSnap.id, ...charSnap.data() } : {};
  
  // [신규] 전투 상태를 관리할 객체
  let battleState = {
    playerHp: runState.stamina,
    enemyHp: enemy.hp || 10,
    log: [battleInfo.narrative],
    isPlayerTurn: true,
  };

  // [신규] 전투 UI를 업데이트하는 함수
  const renderBattleUI = () => {
    const enemyHpPercent = Math.max(0, (battleState.enemyHp / (enemy.hp || 10)) * 100);
    const playerHpPercent = Math.max(0, (battleState.playerHp / runState.stamina_start) * 100);

    root.querySelector('#enemyName').textContent = esc(enemy.name || '상대');
    root.querySelector('#enemyHpText').textContent = `${battleState.enemyHp} / ${enemy.hp || 10}`;
    root.querySelector('#enemyHpBar').style.width = `${enemyHpPercent}%`;
    
    root.querySelector('#playerName').textContent = esc(character.name || '플레이어');
    root.querySelector('#playerHpText').textContent = `${battleState.playerHp} / ${runState.stamina_start}`;
    root.querySelector('#playerHpBar').style.width = `${playerHpPercent}%`;

    root.querySelector('#battleLog').innerHTML = battleState.log.map(l => `<p>${esc(l)}</p>`).join('');
    root.querySelector('#battleLog').scrollTop = root.querySelector('#battleLog').scrollHeight; // 자동 스크롤

    // 플레이어 턴일 때만 버튼 활성화
    root.querySelectorAll('.action-btn').forEach(btn => {
      btn.disabled = !battleState.isPlayerTurn;
    });
  };

  // [신규] 플레이어 행동 처리 및 AI 호출 함수
  const handlePlayerAction = async (actionType, index) => {
    battleState.isPlayerTurn = false;
    renderBattleUI(); // 버튼 즉시 비활성화
    showLoading(true, 'AI가 상황을 처리 중입니다...');

    let actionDetail = '';
    if (actionType === 'skill') {
      actionDetail = character.abilities_equipped[index] || null;
    } else if (actionType === 'item') {
      actionDetail = character.items_equipped[index] || null;
    }

    try {
      const systemPrompt = await fetchPromptDoc('battle_turn_system');
      const userPrompt = `
        ## 현재 전투 상황
        - 플레이어: ${character.name} (HP: ${battleState.playerHp}/${runState.stamina_start})
        - 적: ${enemy.name} (HP: ${battleState.enemyHp}/${enemy.hp || 10})
        - 이전 로그: ${battleState.log.slice(-1)[0]}

        ## 플레이어 행동
        - 종류: ${actionType}
        - 상세: ${JSON.stringify(actionDetail)}

        ## 지시
        플레이어의 행동에 따른 결과를 JSON 형식으로 생성하라. 결과에는 다음이 포함되어야 한다:
        - narrative (String): 무슨 일이 일어났는지 서술.
        - playerHpChange (Number): 플레이어 HP 변화량 (회복은 +, 데미지는 -).
        - enemyHpChange (Number): 적 HP 변화량.
        - turnOver (Boolean): 턴이 종료되었는지 여부.
      `;
      
      const aiResponseRaw = await callGemini('gemini-1.5-flash-latest', systemPrompt, userPrompt);
      const aiResult = JSON.parse(aiResponseRaw.replace(/^```json\s*|```$/g, ''));
      
      battleState.log.push(aiResult.narrative);
      battleState.playerHp += (aiResult.playerHpChange || 0);
      battleState.enemyHp += (aiResult.enemyHpChange || 0);
      
      // 승리/패배 조건 확인
      if (battleState.enemyHp <= 0) {
        // ... 승리 로직 (나중에 구현) ...
        showToast('승리했습니다!');
        // 임시로 탐험 복귀
        root.querySelector('#giveUpBtn').click();
      } else if (battleState.playerHp <= 0) {
        // ... 패배 로직 (나중에 구현) ...
        showToast('패배했습니다...');
        root.querySelector('#giveUpBtn').click();
      } else {
        battleState.isPlayerTurn = true;
      }
      
    } catch(e) {
      console.error("전투 AI 호출 실패:", e);
      showToast('AI가 응답하지 않습니다. 잠시 후 다시 시도해주세요.');
      battleState.isPlayerTurn = true; // 오류 시 턴 복구
    } finally {
      renderBattleUI();
      showLoading(false);
    }
  };

  // --- 전체 레이아웃 렌더링 (생략 없이 완성) ---
  root.innerHTML = `
    <section class="container narrow">
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
