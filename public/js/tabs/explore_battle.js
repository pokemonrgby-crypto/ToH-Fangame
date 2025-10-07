// /public/js/tabs/explore_battle.js
import { auth, db, fx } from '../api/firebase.js';
import { showToast } from '../ui/toast.js';
import { serverBattleAction, serverBattleFlee } from '../api/explore.js';
// [추가] Firestore 서버에서 직접 데이터를 가져오기 위한 함수를 import합니다.
import { getDocFromServer } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js';

// --- 유틸리티 함수 ---
function esc(s){ return String(s??'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function parseRunIdFromBattle() {
  const h = location.hash || '';
  const m = h.match(/^#\/explore-battle\/([^/]+)/);
  return m ? m[1] : null;
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

// --- 메인 로직 ---
export async function showExploreBattle() {
  showLoading(true, '전투 정보 불러오는 중...');
  const root = document.getElementById('view');
  const runId = parseRunIdFromBattle();
  
  if (!auth.currentUser || !runId) {
      root.innerHTML = `<section class="container narrow"><div class="kv-card">잘못된 접근입니다.</div></section>`;
      showLoading(false);
      return;
  }

  const runRef = fx.doc(db, 'explore_runs', runId);
  // [수정] getDoc 대신 getDocFromServer를 사용하여 항상 최신 데이터를 가져옵니다.
  const runSnap = await getDocFromServer(runRef);

  if (!runSnap.exists() || !runSnap.data().pending_battle) {
    root.innerHTML = `<section class="container narrow"><div class="kv-card">활성화된 전투가 없습니다. 탐험 화면으로 돌아갑니다.</div></section>`;
    setTimeout(() => location.hash = `#/explore-run/${runId}`, 1500);
    showLoading(false);
    return;
  }

  let runState = runSnap.data();
  let battleState = runState.pending_battle;

  const charRef = fx.doc(db, runState.charRef);
  const charSnap = await fx.getDoc(charRef);
  const character = charSnap.exists() ? { id: charSnap.id, ...charSnap.data() } : {};

  // [수정] 전투 시작 시 유저의 전체 아이템 목록을 한 번만 가져옵니다.
  const userSnap = await fx.getDoc(fx.doc(db, 'users', auth.currentUser.uid));
  let allUserItems = userSnap.exists() ? userSnap.data().items_all || [] : [];
  // [PATCH] 이전 HP 저장(피해/회복 팝업용)
  let prevEnemyHp = battleState.enemy.hp;
  let prevPlayerHp = battleState.playerHp;
  // [PATCH] 피격 팝업/흔들림
  function spawnHitPop(targetEl, text, cls='dmg'){
    if(!targetEl) return;
    const box = targetEl.getBoundingClientRect();
    const pop = document.createElement('div');
    pop.className = `hit-pop ${cls}`;
    // 화면 좌표 기준 → body에 고정 배치
    pop.style.left = (box.left + box.width*0.7) + 'px';
    pop.style.top  = (box.top  - 6 + window.scrollY) + 'px';
    pop.textContent = text;
    document.body.appendChild(pop);
    setTimeout(()=> pop.remove(), 650);
  }
  function shake(el){
    if(!el) return;
    el.classList.remove('shake');
    // 다음 프레임 강제 리플로우 후 다시 추가(중복 애니 재생)
    void el.offsetWidth;
    el.classList.add('shake');
  }


const render = () => {
    if (!root.querySelector('#battleRoot')) {
        // [수정] 비어있던 section 내부에 전체 HTML 구조를 추가합니다.
        root.innerHTML = `
            <section class="container narrow" id="battleRoot">
                <div class="card p12">
                    <div class="row" style="justify-content:space-between; align-items:center;">
                      <div>
                        <span id="enemyName" style="font-weight:800;"></span>
                        <span id="enemyTierChip" class="chip chip-tier" style="margin-left:6px;"></span>
                      </div>
                      <div id="enemyHpText" class="text-dim" style="font-size:12px;"></div>
                    </div>

                    <div class="hp-bar-outer"><div id="enemyHpBar" class="hp-bar-inner enemy"></div></div>
                    <div id="enemySkills" class="text-dim" style="font-size:12px; margin-top:6px"></div>
                </div>

                <div class="kv-label mt16">전투 기록</div>
                <div id="battleLog" class="card p16" style="min-height:150px; max-height: 250px; overflow-y:auto; font-size:14px; line-height:1.6;"></div>

                <div class="card p12 mt16">
                    <div class="row" style="justify-content:space-between; align-items:center;">
                        <div id="playerName" style="font-weight:800;"></div>
                        <div id="playerHpText" class="text-dim" style="font-size:12px;"></div>
                    </div>
                    <div class="hp-bar-outer"><div id="playerHpBar" class="hp-bar-inner player"></div></div>

                    <div class="row mt8" style="justify-content:space-between; align-items:center;">
                      <div class="row" style="gap:8px; align-items:center;">
                        <span class="text-dim" style="font-size:12px;">스태미나</span>
                        <div class="hp-bar-outer" style="width:140px;"><div id="staminaBar" class="hp-bar-inner stamina"></div></div>
                        <span id="staminaText" class="text-dim" style="font-size:12px;"></span>
                      </div>
                      <div id="turnText" class="text-dim" style="font-size:12px;"></div>
                    </div>
                    

                    <div class="kv-label mt12">행동 선택</div>
                    <div id="actionBox" class="grid2" style="gap:8px;"></div>
                </div>

                <div style="text-align:right; margin-top:16px;">
                    <button id="fleeBtn" class="btn ghost">후퇴</button>
                </div>
            </section>
        `;
      // [PATCH] 전투 UI 스타일(최초 1회만)
if (!document.getElementById('battle-ui-styles')) {
  const st = document.createElement('style');
  st.id = 'battle-ui-styles';
  st.textContent = `
    .hp-bar-outer{height:10px;background:#1a2230;border:1px solid #2a3346;border-radius:8px;overflow:hidden}
    .hp-bar-inner{height:100%;width:0%;transition:width .35s ease}
    .hp-bar-inner.player{background:#5bd4a5}
    .hp-bar-inner.enemy{background:#ff7a7a}
    .hp-bar-inner.stamina{background:#a0b3ff}

    #battleLog p{margin:0 0 8px 0;opacity:0;animation:fadeInUp .25s forwards}
    @keyframes fadeInUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}

    /* 적 스킬 목록 */
    .enemy-skill-list{margin:4px 0 0 16px;padding:0}
    .enemy-skill-list li{margin:2px 0;line-height:1.4}

    /* 피격 팝업 */
    .hit-pop{position:absolute;pointer-events:none;font-weight:800;animation:popfade .6s ease forwards}
    .hit-pop.dmg{color:#ff8a8a;text-shadow:0 0 6px rgba(255,80,80,.4)}
    .hit-pop.heal{color:#8ef7c2;text-shadow:0 0 6px rgba(80,255,160,.3)}
    @keyframes popfade{from{opacity:0;transform:translateY(6px)}20%{opacity:1}to{opacity:0;transform:translateY(-14px)}}

    /* 흔들림(피격 느낌) */
    .shake{animation:shake .25s ease}
    @keyframes shake{
      0%{transform:translateX(0)}25%{transform:translateX(-3px)}50%{transform:translateX(3px)}
      75%{transform:translateX(-2px)}100%{transform:translateX(0)}
    }

    /* 등급 칩 */
    .chip-tier{font-size:11px;font-weight:800;border:1px solid transparent;padding:2px 6px;border-radius:8px;vertical-align:1px}
    .chip-tier.trash  { background:#2a2f3a; color:#c8d0dc; border-color:#5f6673; }
    .chip-tier.normal { background:#0f2742; color:#cfe4ff; border-color:#3b78cf; }
    .chip-tier.elite  { background:#20163a; color:#e6dcff; border-color:#7e5cff; }
    .chip-tier.boss   { background:#000;    color:#ff4d4f; border-color:#ff4d4f; text-transform:uppercase; letter-spacing:.5px; }

    
  `;
  document.head.appendChild(st);
}

        bindEvents();
    }
    // ... 이하 업데이트 로직은 정상적으로 동작합니다.

    // 데이터 업데이트
    const enemyHpPercent = Math.max(0, (battleState.enemy.hp / battleState.enemy.maxHp) * 100);
    const playerHpPercent = Math.max(0, (battleState.playerHp / runState.stamina_start) * 100);
    const staminaMax = runState.stamina_start;
    const staminaNow = runState.stamina ?? staminaMax;
    const staminaPercent = Math.max(0, (staminaNow / staminaMax) * 100);


    root.querySelector('#enemyName').textContent = esc(battleState.enemy.name);
    root.querySelector('#enemyHpText').textContent = `${battleState.enemy.hp} / ${battleState.enemy.maxHp}`;
    root.querySelector('#enemyHpBar').style.width = `${enemyHpPercent}%`;

    const staminaBar = root.querySelector('#staminaBar');
    if (staminaBar) staminaBar.style.width = `${staminaPercent}%`;
    const staminaText = root.querySelector('#staminaText');
    if (staminaText) staminaText.textContent = `${staminaNow} / ${staminaMax}`;
    const turnText = root.querySelector('#turnText');
    if (turnText) turnText.textContent = `턴 ${battleState.turn}`;

    // 등급 라벨 표시
    const chip = root.querySelector('#enemyTierChip');
    if (chip){
      const tier = String(battleState.enemy.tier || 'normal').toLowerCase();
      chip.textContent = tier;
      chip.className = `chip chip-tier ${tier}`;
    }

    
    root.querySelector('#playerName').textContent = esc(character.name);
    root.querySelector('#playerHpText').textContent = `${battleState.playerHp} / ${runState.stamina_start}`;
    root.querySelector('#playerHpBar').style.width = `${playerHpPercent}%`;

  // [PATCH] 적 스킬 렌더링
const skBox = root.querySelector('#enemySkills');
if (skBox && Array.isArray(battleState?.enemy?.skills)) {
  const lis = battleState.enemy.skills.map(s => `<li><b>${esc(s.name||'스킬')}</b> — ${esc(s.description||'')}</li>`).join('');
  skBox.innerHTML = lis ? `<ul class="enemy-skill-list">${lis}</ul>` : '';
}

// [PATCH] 피해/회복 팝업 + 흔들림
const enemyBar = root.querySelector('#enemyHpBar');
const playerBar = root.querySelector('#playerHpBar');
const enemyCard = enemyBar?.closest('.card');
const playerCard = playerBar?.closest('.card');

// 적 HP 변화
const dEnemy = battleState.enemy.hp - prevEnemyHp;
if (dEnemy !== 0 && enemyBar) {
  if (dEnemy < 0) { // 데미지
    spawnHitPop(enemyBar, String(dEnemy), 'dmg');
    shake(enemyCard);
  } else { // 회복
    spawnHitPop(enemyBar, `+${dEnemy}`, 'heal');
  }
  prevEnemyHp = battleState.enemy.hp;
}

// 플레이어 HP 변화
const dPlayer = battleState.playerHp - prevPlayerHp;
if (dPlayer !== 0 && playerBar) {
  if (dPlayer < 0) {
    spawnHitPop(playerBar, String(dPlayer), 'dmg');
    shake(playerCard);
  } else {
    spawnHitPop(playerBar, `+${dPlayer}`, 'heal');
  }
  prevPlayerHp = battleState.playerHp;
}


    root.querySelector('#battleLog').innerHTML = battleState.log.map(l => `<p>${esc(l)}</p>`).join('');
    root.querySelector('#battleLog').scrollTop = root.querySelector('#battleLog').scrollHeight;
    
    // 행동 버튼 렌더링
    let actionButtonsHTML = '';
    const equippedSkills = (character.abilities_equipped || []).map(idx => (character.abilities_all || [])[idx]).filter(Boolean);
    equippedSkills.forEach((skill, i) => {
        // 스킬에 코스트가 있다면 표시
        const costText = skill.stamina_cost > 0 ? ` (S-${skill.stamina_cost})` : '';
        actionButtonsHTML += `<button class="btn action-btn" data-type="skill" data-index="${i}">${esc(skill.name)}${costText}</button>`;

    });
    
    // 장착된 아이템 ID 목록을 기반으로 전체 아이템 목록에서 정보를 찾아 렌더링
    const equippedItems = (character.items_equipped || [])
        .map(id => allUserItems.find(it => it.id === id))
        .filter(Boolean);

    equippedItems.forEach((item, i) => {
        const isConsumable = item.isConsumable || item.consumable;
        const usesLeft = isConsumable && typeof item.uses === 'number' ? ` (${item.uses})` : '';
        actionButtonsHTML += `<button class="btn ghost action-btn" data-type="item" data-index="${i}">${esc(item.name)}${usesLeft}</button>`;
    });

    actionButtonsHTML += `<button class="btn ghost action-btn" data-type="interact" data-index="0">상호작용</button>`;
    root.querySelector('#actionBox').innerHTML = actionButtonsHTML;
  };


  // --- 이벤트 핸들러 ---
  const handleAction = async (e) => {
    // ... (기존과 동일, 에러 메시지 표시 강화) ...
    const btn = e.target.closest('.action-btn');
    if (!btn || btn.disabled) return;
    
    document.querySelectorAll('.action-btn, #fleeBtn').forEach(b => b.disabled = true);
    
    const type = btn.dataset.type;
    const index = parseInt(btn.dataset.index, 10);
    
    showLoading(true, 'AI가 행동을 처리하는 중...');
    try {
      const result = await serverBattleAction(runId, type, index);
      
      // 서버에서 아이템이 소모되었다면 클라이언트의 아이템 목록도 갱신
      if (type === 'item') {
        const userSnap = await fx.getDoc(fx.doc(db, 'users', auth.currentUser.uid));
        if (userSnap.exists()) allUserItems = userSnap.data().items_all || [];
      }

      battleState = result.battle_state;
      // [변경] 전투HP와 스태미나 분리: 스태미나는 서버에서 별도 관리(10턴마다 -1). 덮어쓰지 않음.

      // runState.stamina = battleState ? battleState.playerHp : runState.stamina;
      // [추가] 서버에서 최신 런 정보(스태미나 등) 재조회
      const freshRunSnap = await fx.getDoc(runRef);
      if (freshRunSnap.exists()) runState = freshRunSnap.data();

      // 전투 종료 시 분기
      if (result.battle_over) {
        showToast(result.outcome === 'win' ? '전투에서 승리했습니다!' : '전투에서 패배했습니다.');
        setTimeout(() => location.hash = `#/explore-run/${runId}`, 500);
      } else {
        render();
      }
    } catch (err) {
      console.error('Battle action failed', err);
      showToast(err.message || '행동 처리에 실패했습니다.');
    } finally {
      if (!location.hash.includes('battle')) return;
      document.querySelectorAll('.action-btn, #fleeBtn').forEach(b => b.disabled = false);
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
  
  render();
  showLoading(false);
}

export default showExploreBattle;
