// /public/js/tabs/battle.js
import { auth, db, fx } from '../api/firebase.js';
import { showToast } from '../ui/toast.js';
import { logInfo } from '../api/logs.js';
import { autoMatch } from '../api/match_client.js';
// ai.js에서 새로운 함수들을 가져오도록 수정
import { fetchBattlePrompts, generateBattleSketches, chooseBestSketch, generateFinalBattleLog } from '../api/ai.js'; 
// getRelationBetween을 추가
import { updateAbilitiesEquipped, updateItemsEquipped, getRelationBetween } from '../api/store.js'; 
import { getUserInventory } from '../api/user.js';
import { showItemDetailModal } from '../ui/item.js';
import { rarityStyle, ensureItemCss, esc } from '../ui/utils.js';

import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-functions.js';
import { func } from '../api/firebase.js';

const getCooldownStatus = httpsCallable(func, 'getCooldownStatus');
const setGlobalCooldown = httpsCallable(func, 'setGlobalCooldown');
const resetCooldownWithCoins = httpsCallable(func, 'resetCooldownWithCoins');



// ---------- utils ----------
function intentGuard(mode){
  try {
    const raw = sessionStorage.getItem('toh.match.intent');
    if (!raw) return null;
    const data = JSON.parse(raw);
    // 현재 페이지의 모드와 저장된 정보의 모드가 일치하는지 확인
    if (data.mode !== mode) {
      console.warn(`Intent mismatch: expected ${mode}, found ${data.mode}`);
      return null;
    }
    return data;
  } catch (e) {
    console.error('Failed to parse match intent', e);
    return null;
  }
}


function truncate(s, n){ s=String(s||''); return s.length>n ? s.slice(0,n-1)+'…' : s; }
function ensureSpinCss(){
  if(document.getElementById('toh-spin-css')) return;
  const st=document.createElement('style'); st.id='toh-spin-css';
  st.textContent = `
  .spin{width:24px;height:24px;border-radius:50%;border:3px solid rgba(255,255,255,.15);border-top-color:#8fb7ff;animation:spin .9s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
  .chip-mini{display:inline-block;padding:.18rem .5rem;border-radius:999px;border:1px solid #273247;background:#0b0f15;font-size:12px;margin:2px 4px 0 0}
  .modal-back{position:fixed;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;z-index:9999}
  .modal-card{background:#0e1116;border:1px solid #273247;border-radius:14px;padding:16px;max-width:800px;width:94vw;max-height:90vh;display:flex;flex-direction:column;}
  `;
  document.head.appendChild(st);
}

function _lockKey(mode, charId){ return `toh.match.lock.${mode}.${String(charId).replace(/^chars\//,'')}`; }
function loadMatchLock(mode, charId){
  try{
    const raw = sessionStorage.getItem(_lockKey(mode,charId)); if(!raw) return null;
    const j = JSON.parse(raw);
    if(+j.expiresAt > Date.now()) return j;
    sessionStorage.removeItem(_lockKey(mode,charId)); return null;
  }catch(_){ return null; }
}
function saveMatchLock(mode, charId, payload){
  const until = payload.expiresAt || (Date.now() + 3*60*1000);
  const j = { opponent: payload.opponent, token: payload.token||null, expiresAt: until };
  sessionStorage.setItem(_lockKey(mode,charId), JSON.stringify(j));
}

function getCooldownRemainMs(){ const v = +localStorage.getItem('toh.cooldown.allUntilMs') || 0; return Math.max(0, v - Date.now()); }
function applyGlobalCooldown(seconds){ const until = Date.now() + (seconds*1000); localStorage.setItem('toh.cooldown.allUntilMs', String(until)); }



// 이 함수는 이제 서버에서 직접 쿨타임 정보를 가져와 버튼에 반영합니다.
// 이 함수는 이제 서버에서 직접 쿨타임 정보를 가져와 버튼에 반영합니다.
async function mountCooldownOnButton(btn, mode, labelReady) {
  const btnReset = document.getElementById('btnResetCooldown'); // 리셋 버튼
  let intervalId = null;
  let remainMs = 0;

  const tick = () => {
    remainMs = Math.max(0, remainMs - 500);
    const s = Math.ceil(remainMs / 1000);
    if (remainMs > 0) {
      btn.disabled = true;
      btn.textContent = `${labelReady} (${s}s)`;
      if (btnReset) btnReset.style.display = 'inline-flex'; // 쿨타임 있을 때 보이기
    } else {
      btn.disabled = false;
      btn.textContent = labelReady;
      if (btnReset) btnReset.style.display = 'none'; // 쿨타임 없으면 숨기기
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    }
  };

  try {
    const { data } = await getCooldownStatus();
    if (data.ok) {
      const localRemain = (typeof getCooldownRemainMs==='function') ? getCooldownRemainMs() : 0;
      const serverRemain = Number(data?.[mode] || 0);
      remainMs = Math.max(serverRemain, localRemain);

      tick();
      if (remainMs > 0) {
        intervalId = setInterval(tick, 500);
      }
    }
  } catch (e) {
    console.warn('쿨타임 정보를 가져오지 못했습니다.', e);
    btn.textContent = '정보 조회 실패';
  }
}
// ---------- Battle Progress & Logic ----------

function showBattleProgressUI(myChar, opponentChar) {
  const overlay = document.createElement('div');
  overlay.id = 'battle-progress-overlay';
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 10000; display: flex; flex-direction: column; align-items: center; justify-content: center;
    background: rgba(10, 15, 25, 0.9); color: white; backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
    opacity: 0; transition: opacity 0.5s ease;
  `;

  overlay.innerHTML = `
    <div style="display: flex; align-items: center; justify-content: center; gap: 20px; width: 100%; max-width: 700px;">
      <div style="text-align: center; animation: slideInLeft 0.8s ease-out;">
        <img src="${esc(myChar.thumb_url || myChar.image_url || '')}" onerror="this.src=''"
             style="width: 150px; height: 150px; border-radius: 50%; object-fit: cover; border: 4px solid #3b82f6; box-shadow: 0 0 20px #3b82f6;">
        <div style="font-weight: 900; font-size: 20px; margin-top: 10px; text-shadow: 0 0 5px #000;">${esc(myChar.name)}</div>
      </div>
      <div style="font-size: 50px; font-weight: 900; color: #e5e7eb; text-shadow: 0 0 10px #ff425a; animation: fadeIn 1s 0.5s ease both;">VS</div>
      <div style="text-align: center; animation: slideInRight 0.8s ease-out;">
        <img src="${esc(opponentChar.thumb_url || opponentChar.image_url || '')}" onerror="this.src=''"
             style="width: 150px; height: 150px; border-radius: 50%; object-fit: cover; border: 4px solid #ef4444; box-shadow: 0 0 20px #ef4444;">
        <div style="font-weight: 900; font-size: 20px; margin-top: 10px; text-shadow: 0 0 5px #000;">${esc(opponentChar.name)}</div>
      </div>
    </div>
    <div style="margin-top: 40px; text-align: center; animation: fadeIn 1s 1s ease both;">
      <div style="font-size: 18px; font-weight: 700; margin-bottom: 12px;" id="progress-text">배틀 시퀀스를 생성하는 중...</div>
      <div style="width: 300px; height: 10px; background: #273247; border-radius: 5px; overflow: hidden;">
        <div id="progress-bar-inner" style="width: 0%; height: 100%; background: linear-gradient(90deg, #4ac1ff, #7a9bff); transition: width 0.5s ease-out;"></div>
      </div>
    </div>
  `;

  const ensureProgressCss = () => {
      if (document.getElementById('battle-progress-css')) return;
      const st = document.createElement('style');
      st.id = 'battle-progress-css';
      st.textContent = `@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } } @keyframes slideInLeft { from { transform: translateX(-50px); opacity: 0; } to { transform: translateX(0); opacity: 1; } } @keyframes slideInRight { from { transform: translateX(50px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }`;
      document.head.appendChild(st);
  };
  ensureProgressCss();

  document.body.appendChild(overlay);
  setTimeout(() => { overlay.style.opacity = '1'; }, 10);

  const textEl = overlay.querySelector('#progress-text');
  const barEl = overlay.querySelector('#progress-bar-inner');
  return {
    update: (text, percent) => { if (textEl) textEl.textContent = text; if (barEl) barEl.style.width = `${percent}%`; },
    remove: () => { overlay.style.opacity = '0'; setTimeout(() => overlay.remove(), 500); }
  };
}

async function startBattleProcess(myChar, opponentChar) {
    const progress = showBattleProgressUI(myChar, opponentChar);
    try {
        progress.update('배틀 데이터 준비 중...', 20);

        // [신규] AI 입력 데이터 구성
        const myInv = await getUserInventory(myChar.owner_uid);
        const oppInv = await getUserInventory(opponentChar.owner_uid);

        const simplifyForAI = (char, inv) => {
            const equippedSkills = (char.abilities_equipped || []).map(idx => (char.abilities_all || [])[idx]).filter(Boolean);
            const equippedItems = (char.items_equipped || []).map(id => inv.find(i => i.id === id)).filter(Boolean);
            
            const skillsAsText = equippedSkills.map(s => `${s.name}: ${s.desc_soft}`).join('\n') || '없음';
            const itemsAsJson = equippedItems.map(i => ({
                name: i.name,
                description: i.desc_soft || i.desc || i.description || '',
                properties: i.properties || {}, // 아이템 속성 전체 포함
                rarity: i.rarity
            }));

            const narrativeSummary = char.narratives?.slice(1).map(n => n.short).join(' ') || char.narratives?.[0]?.short || '특이사항 없음';
            
            return {
                name: char.name,
                narrative_long: char.narratives?.[0]?.long || char.summary,
                narrative_short_summary: narrativeSummary,
                skills: skillsAsText,
                items: itemsAsJson,
                origin: char.world_id,
            };
        };

        const attackerData = simplifyForAI(myChar, myInv);
        const defenderData = simplifyForAI(opponentChar, oppInv);
        const relation = await getRelationBetween(myChar.id, opponentChar.id);

        progress.update('AI가 배틀 시나리오 생성 중...', 50);

        const intentNow = (() => {
           try { return JSON.parse(sessionStorage.getItem('toh.match.intent') || '{}'); }
           catch(_) { return {}; }
        })();
        const isSimNow = !!intentNow?.sim;

        // [신규] 단일 서버 함수 호출
        const runBattleFn = httpsCallable(func, 'runBattleV2');
        const result = await runBattleFn({
            attackerId: myChar.id,
            defenderId: opponentChar.id,
            worldId: myChar.world_id,
            simulate: isSimNow,
            // AI용 데이터는 서버에서 다시 만들지만, 클라이언트 데이터를 함께 보내면 디버깅에 용이할 수 있음
            // _clientData: { attacker: attackerData, defender: defenderData, relation } 
        });

        if (!result.data.ok) {
            throw new Error(result.data.error || '서버에서 배틀 생성에 실패했습니다.');
        }

        progress.update('완료! 결과 페이지로 이동합니다.', 100);
        
        // 쿨타임 적용
        try { await setGlobalCooldown({ seconds: 300 }); } catch (e) { console.warn('setGlobalCooldown post-finish failed', e); }
        try { if (typeof applyGlobalCooldown === 'function') applyGlobalCooldown(300); } catch (_) {}

        setTimeout(() => {
            progress.remove();
            location.hash = `#/battlelog/${result.data.logId}`;
        }, 800);

    } catch (e) {
        console.error("Battle process failed:", e);
        showToast('배틀 생성에 실패했습니다: ' + e.message);
        progress.remove();
        const btnStart = document.getElementById('btnStart');
        const simCatch = (()=>{
          try { return !!JSON.parse(sessionStorage.getItem('toh.match.intent')||'{}')?.sim; }
          catch(_){ return false; }
        })();
        if (btnStart) mountCooldownOnButton(btnStart, 'battle', simCatch ? '모의전투 시작' : '배틀 시작');
    }
}
// ---------- entry ----------
export async function showBattle(){
  ensureSpinCss();
  const intent = intentGuard('battle');
  const root   = document.getElementById('view');

  if(!intent){
    root.innerHTML = `<section class="container narrow"><div class="kv-card">잘못된 접근이야. 캐릭터 화면에서 ‘배틀 시작’으로 들어와줘.</div></section>`;
    return;
  }
  if(!auth.currentUser){
    root.innerHTML = `<section class="container narrow"><div class="kv-card">로그인이 필요해.</div></section>`;
    return;
  }
  
  const isSim = !!intent?.sim;
  const labelReady = isSim ? '모의전투 시작' : '배틀 시작';

  
  root.innerHTML = `
  <section class="container narrow">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <button class="btn ghost" id="btnBack">← 캐릭터로 돌아가기</button>
    </div>
    <div class="card p16" id="matchPanel">
      <div class="kv-label">자동 매칭</div>
      <div id="matchArea" class="kv-card" style="display:flex;gap:10px;align-items:center;min-height:72px">
        <div class="spin"></div><div>상대를 찾는 중…</div>
      </div>
    </div>
    <div class="card p16 mt12" id="loadoutPanel">
      <div class="kv-label">내 스킬 / 아이템</div>
      <div id="loadoutArea"><div class="p12 text-dim">캐릭터 정보 로딩 중...</div></div>
    </div>
    <div class="card p16 mt16" id="toolPanel">
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="btn ghost" id="btnResetCooldown" style="display:none;">쿨타임 초기화 (1000 코인)</button>
        <button class="btn" id="btnStart" disabled>${labelReady}</button>
      </div>
    </div>
  </section>`;

  document.getElementById('btnBack').onclick = ()=>{
    location.hash = intent?.charId ? `#/char/${intent.charId}` : '#/home';
  };

  const btnReset = document.getElementById('btnResetCooldown');
  if (btnReset) {
    btnReset.onclick = async () => {
      if (!confirm('1000 코인을 사용하여 배틀 쿨타임을 초기화하시겠습니까?')) return;
      btnReset.disabled = true;
      try {
        await resetCooldownWithCoins();
        showToast('쿨타임이 초기화되었습니다.');
        // ▼▼▼ [수정된 부분] ▼▼▼
        localStorage.removeItem('toh.cooldown.allUntilMs');
        // ▲▲▲ [수정된 부분] ▲▲▲
        const btnStart = document.getElementById('btnStart');
        if (btnStart) {
          await mountCooldownOnButton(btnStart, 'battle', labelReady);
        }
      } catch (e) {
        showToast(`초기화 실패: ${e.message}`);
      } finally {
        btnReset.disabled = false;
      }
    };
  }

  let myCharData = null;
  let opponentCharData = null;

  try {
    const meSnap = await fx.getDoc(fx.doc(db, 'chars', intent.charId));
    if (!meSnap.exists()) throw new Error('내 캐릭터 정보를 찾을 수 없습니다.');
    myCharData = { id: meSnap.id, ...meSnap.data() };
    await renderLoadoutForMatch(document.getElementById('loadoutArea'), myCharData);
    ensureItemCss();


    if (intent.targetId) {
  // ★ 모의전: targetId가 있으면 그 캐릭터를 상대 고정
  const targetId = String(intent.targetId).replace(/^chars\//,'');
  const oppDoc = await fx.getDoc(fx.doc(db,'chars', targetId));
  if (!oppDoc.exists()) throw new Error('상대 캐릭터를 찾을 수 없습니다.');
  opponentCharData = { id: oppDoc.id, ...oppDoc.data() };
  renderOpponentCard(document.getElementById('matchArea'), opponentCharData);
} else {
  // 일반전: 기존 자동매칭 유지
  let matchData = null;
  const persisted = loadMatchLock('battle', intent.charId);
  if (persisted) {
    matchData = { ok:true, token: persisted.token||null, opponent: persisted.opponent };
  } else {
    matchData = await autoMatch({ db, fx, charId: intent.charId, mode: 'battle' });
    if(!matchData?.ok || !matchData?.opponent) throw new Error('매칭 상대를 찾지 못했습니다.');
    saveMatchLock('battle', intent.charId, { token: matchData.token, opponent: matchData.opponent });
  }

  const oppId = String(matchData.opponent.id||matchData.opponent.charId||'').replace(/^chars\//,'');
  const oppDoc = await fx.getDoc(fx.doc(db,'chars', oppId));
  if (!oppDoc.exists()) {
    showToast('상대 정보가 없어 다시 매칭할게.');
    sessionStorage.removeItem(_lockKey('battle', intent.charId));
    setTimeout(() => showBattle(), 1000);
    return;
  }
  opponentCharData = { id: oppDoc.id, ...oppDoc.data() };
  renderOpponentCard(document.getElementById('matchArea'), opponentCharData);
}

    const btnStart = document.getElementById('btnStart');
    mountCooldownOnButton(btnStart, 'battle', labelReady);  // <-- 'battle' 모드와 기본 라벨을 전달하도록 수정
    btnStart.onclick = async () => {
        const hasSkills = myCharData.abilities_all && myCharData.abilities_all.length > 0;
        if (hasSkills && myCharData.abilities_equipped?.length !== 2) {
            return showToast('배틀을 시작하려면 스킬을 2개 선택해야 합니다.');
        }
        btnStart.disabled = true;

      // ▼▼▼ [수정된 부분] ▼▼▼
      // 쿨타임을 미리 설정하던 코드를 모두 삭제합니다.
      // try { await setGlobalCooldown({ seconds: 300 }); } catch (e) { console.warn('setGlobalCooldown pre-start failed', e); }
      // try { if (typeof applyGlobalCooldown === 'function') applyGlobalCooldown(300); } catch (_) {}

      try {
        // 실제 배틀 시작 로직만 남겨둡니다.
        await startBattleProcess(myCharData, opponentCharData);
      } catch (e) {
        showToast(e?.message || '시작에 실패했어.');
        // 실패 시 버튼 쿨타임을 다시 마운트합니다.
        await mountCooldownOnButton(btnStart, 'battle', labelReady);
      }
      // ▲▲▲ [수정된 부분] ▲▲▲
    };


  } catch(e) {
    console.error('[battle] setup error', e);
    document.getElementById('matchArea').innerHTML = `<div class="text-dim">매칭 중 오류 발생: ${e.message}</div>`;
  }
}

function renderOpponentCard(matchArea, opp) {
    const intro = truncate(opp.summary || opp.intro || '', 160);
    const abilities = Array.isArray(opp.abilities_all)
        ? opp.abilities_all.map(skill => skill?.name || '스킬').filter(Boolean)
        : [];

    matchArea.innerHTML = `
      <div id="oppCard" style="display:flex;gap:12px;align-items:center;cursor:pointer;width:100%;">
        <div style="width:72px;height:72px;border-radius:10px;overflow:hidden;border:1px solid #273247;background:#0b0f15; flex-shrink:0;">
          ${opp.thumb_url ? `<img src="${esc(opp.thumb_url)}" style="width:100%;height:100%;object-fit:cover">` : ''}
        </div>
        <div style="flex:1; min-width:0;">
          <div style="display:flex;gap:6px;align-items:center">
            <div style="font-weight:900;font-size:16px">${esc(opp.name || '상대')}</div>
            <div class="chip-mini">Elo ${esc((opp.elo ?? 1000).toString())}</div>
          </div>
          <div class="text-dim" style="margin-top:4px;font-size:13px;">${esc(intro || '소개가 아직 없어')}</div>
          <div style="margin-top:6px">${abilities.map(name =>`<span class="chip-mini">${esc(name)}</span>`).join('')}</div>
        </div>
      </div>
    `;
    matchArea.querySelector('#oppCard').onclick = () => { if(opp.id) location.hash = `#/char/${opp.id}`; };
}

async function renderLoadoutForMatch(box, myChar){
  const abilities = Array.isArray(myChar.abilities_all) ? myChar.abilities_all : [];
  let equippedSkills = Array.isArray(myChar.abilities_equipped) ? myChar.abilities_equipped.slice(0,2) : [];
  const inv = await getUserInventory();
  let equippedItems = (myChar.items_equipped || []).map(id => inv.find(item => item.id === id)).filter(Boolean);

  const render = () => {
      box.innerHTML = `
        <div class="p12">
          <div style="font-weight:800;margin-bottom:8px">내 스킬 (정확히 2개 선택)</div>
          ${abilities.length ? `<div class="grid2" style="gap:8px">
              ${abilities.map((ab,i)=>`
                <label class="kv-card" style="display:flex;gap:8px;align-items:flex-start;padding:10px;cursor:pointer">
                  <input type="checkbox" data-i="${i}" ${equippedSkills.includes(i)?'checked':''}>
                  <div>
                    <div style="font-weight:700">${esc(ab?.name||'스킬')}</div>
                    <div class="text-dim" style="font-size:12px">${esc(ab?.desc_soft||'')}</div>
                  </div>
                </label>`).join('')}
            </div>` : `<div class="kv-card text-dim">등록된 스킬이 없어.</div>`
          }
          <div style="font-weight:800;margin:12px 0 6px">내 아이템</div>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">
            ${[0,1,2].map(i => {
                const item = equippedItems[i];
                if (!item) return `<div class="kv-card item-card" style="min-height:44px;display:flex; flex-direction:column; align-items:center;justify-content:center;padding:8px;font-size:13px;text-align:center;">(비어 있음)</div>`;
                
                const style = rarityStyle(item.rarity);
                const isAether = (String(item.rarity||'').toLowerCase()) === 'aether';
                const inlineStyle = isAether ? '' : `border-left: 3px solid ${style.border}; background:${style.bg};`;

              return `<div class="kv-card item-card ${isAether ? 'rarity-aether' : ''}" style="min-height:44px;display:flex; flex-direction:column; align-items:center;justify-content:center;padding:8px;font-size:13px;text-align:center; ${inlineStyle}">
                        <div>
                          <div style="font-weight:bold; color:${style.text};">${esc(item.name)}</div>

                          <div style="font-size:12px; opacity:.8">${esc(item.desc_soft || item.desc || item.description || (item.desc_long ? String(item.desc_long).split('\n')[0] : ''))}</div>
                        </div>
                      </div>`;
          }).join('')}
          </div>
          <button class="btn mt8" id="btnManageItems">아이템 교체</button>
        </div>
      `;

      if (abilities.length) {
        const inputs = box.querySelectorAll('input[type=checkbox][data-i]');
        inputs.forEach(inp => {
          inp.onchange = async () => {
            let on = Array.from(inputs).filter(x => x.checked).map(x => +x.dataset.i);
            if (on.length > 2) {
              inp.checked = false;
              showToast('스킬은 2개만 선택할 수 있습니다.');
              return;
            }
            if (on.length === 2) {
              try {
                await updateAbilitiesEquipped(myChar.id, on);
                myChar.abilities_equipped = on;
                equippedSkills = on;
                showToast('스킬 선택이 저장되었습니다.');
              } catch (e) { showToast('스킬 저장 실패: ' + e.message); }
            }
          };
        });
      }
      
      box.querySelector('#btnManageItems').onclick = () => {
        openItemPicker(myChar, async (selectedIds) => {
            await updateItemsEquipped(myChar.id, selectedIds);
            myChar.items_equipped = selectedIds;
            const newInv = await getUserInventory();
            equippedItems = selectedIds.map(id => newInv.find(item => item.id === id)).filter(Boolean);
            render();
        });
      };
  };
  render();
}

async function openItemPicker(c, onSave) {
  const inv = await getUserInventory();
  ensureItemCss();

  let selectedIds = [...(c.items_equipped || [])];

  const back = document.createElement('div');
  back.className = 'modal-back';
  back.style.zIndex = '8000';

  const renderModalContent = () => {
    back.innerHTML = `
      <div class="modal-card" style="background:#0e1116;border:1px solid #273247;border-radius:14px;padding:16px;max-width:800px;width:94vw;max-height:90vh;display:flex;flex-direction:column;">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-shrink:0;">
          <div style="font-weight:900; font-size: 18px;">아이템 장착 관리</div>
          <button class="btn ghost" id="mClose">닫기</button>
        </div>
        <div class="text-dim" style="font-size:13px; margin-top:4px;">아이템을 클릭하여 상세 정보를 보고, 다시 클릭하여 장착/해제하세요. (${selectedIds.length} / 3)</div>
        <div class="item-picker-grid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; overflow-y: auto; padding: 5px; margin: 12px 0; flex-grow: 1;">
          ${inv.length === 0 ? '<div class="text-dim" style="grid-column: 1 / -1;">보유한 아이템이 없습니다.</div>' :
            inv.map(item => {
              const style = rarityStyle(item.rarity);
              const isSelected = selectedIds.includes(item.id);
              return `
                <div class="kv-card item-card item-picker-card ${isSelected ? 'selected' : ''}" data-item-id="${item.id}"
                     style="padding:10px; outline:${isSelected ? '2px solid #4aa3ff' : 'none'}; cursor:pointer;">

                  <div style="font-weight:700; color: ${style.text}; pointer-events:none;">${esc(item.name)}</div>
                  <div style="font-size:12px; opacity:.8; margin-top: 4px; height: 3em; overflow:hidden; pointer-events:none;">${esc(item.desc_soft || item.desc || item.description || (item.desc_long ? String(item.desc_long).split('\n')[0] : '-') )}</div>
                </div>
              `;
            }).join('')
          }
        </div>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:auto;flex-shrink:0;padding-top:12px;">
          <button class="btn large" id="btnSaveItems">선택 완료</button>
        </div>
      </div>
    `;

    back.querySelectorAll('.item-picker-card').forEach(card => {
        card.addEventListener('click', () => {
            const itemId = card.dataset.itemId;
            const item = inv.find(it => it.id === itemId);
            if (!item) return;

            // ◀◀◀ 이 부분을 통째로 교체하세요.
            // 상세 모달을 호출하고, 선택 결과를 콜백으로 받아 picker를 새로고침합니다.
            showItemDetailModal(item, {
                equippedIds: selectedIds,
                onUpdate: (newSelectedIds) => {
                    selectedIds = newSelectedIds;
                    renderModalContent(); // 부모 모달(picker) UI 새로고침
                }
            });
        });
    });

    back.querySelector('#mClose').onclick = () => back.remove();
    back.querySelector('#btnSaveItems').onclick = () => {
        onSave(selectedIds);
        back.remove();
    };
  };

  renderModalContent();
  document.body.appendChild(back);
  back.onclick = (e) => { if (e.target === back) back.remove(); };
}


export default showBattle;
