// /public/js/tabs/encounter.js
import { auth, db, fx, func } from '../api/firebase.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-functions.js';
import { showToast } from '../ui/toast.js';
import { requestMatch } from '../api/match.js';
import { getUserInventory } from '../api/user.js';
import { showItemDetailModal, rarityStyle, ensureItemCss, esc } from './char.js';
import { getRelationBetween } from '../api/store.js';
import { fetchBattlePrompts, generateBattleSketches, chooseBestSketch, generateFinalBattleLog } from '../api/ai.js';


// ---------- utils (기존과 동일) ----------
function truncate(s, n){ s=String(s||''); return s.length>n ? s.slice(0,n-1)+'…' : s; }
function ensureSpinCss(){
  if(document.getElementById('toh-spin-css')) return;
  const st=document.createElement('style'); st.id='toh-spin-css';
  st.textContent = `
  .spin{width:24px;height:24px;border-radius:50%;border:3px solid rgba(255,255,255,.15);border-top-color:#8fb7ff;animation:spin .9s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
  .chip-mini{display:inline-block;padding:.18rem .5rem;border-radius:999px;border:1px solid #273247;background:#0b0f15;font-size:12px;margin:2px 4px 0 0}
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
function mountCooldownOnButton(btn, labelReady){
  let intervalId = null;
  const tick = ()=>{
    const r = getCooldownRemainMs();
    if(r>0){
      const s = Math.ceil(r/1000);
      btn.disabled = true;
      btn.textContent = `${labelReady} (${s}s)`;
    }else{
      btn.disabled = false;
      btn.textContent = labelReady;
      if (intervalId) { clearInterval(intervalId); intervalId = null; }
    }
  };
  tick();
  intervalId = setInterval(tick, 500);
}
function intentGuard(mode){
  let j=null; try{ j=JSON.parse(sessionStorage.getItem('toh.match.intent')||'null'); }catch(_){}
  if(!j || j.mode!==mode || (Date.now()-(+j.ts||0))>90_000) return null;
  return j;
}

// --- [교체] battle.js의 Progress UI를 가져와 중앙 정렬 강화 ---
function showProgressUI(myChar, opponentChar) {
  const overlay = document.createElement('div');
  overlay.id = 'encounter-progress-overlay';
  overlay.style.cssText = `position:fixed;inset:0;z-index:10000;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(10,15,25,.9);color:white;backdrop-filter:blur(8px);opacity:0;transition:opacity .5s ease;`;
  overlay.innerHTML = `
    <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 24px; animation: fadeIn 1s ease both;">
      <div style="font-size:24px;font-weight:900;">${esc(myChar.name)}와(과) ${esc(opponentChar.name)}의 만남</div>
      
      <div style="display: flex; align-items: center; justify-content: center; gap: 20px;">
        <img src="${esc(myChar.thumb_url || myChar.image_url || '')}" onerror="this.src=''"
             style="width: 120px; height: 120px; border-radius: 50%; object-fit: cover; border: 3px solid #3b82f6;">
        <div style="font-size: 40px; font-weight: 700; color: #9aa5b2;">&</div>
        <img src="${esc(opponentChar.thumb_url || opponentChar.image_url || '')}" onerror="this.src=''"
             style="width: 120px; height: 120px; border-radius: 50%; object-fit: cover; border: 3px solid #ccc;">
      </div>
      
      <div style="text-align: center;">
        <div id="progress-text" style="font-size:16px;font-weight:700;margin-bottom:12px;">AI가 조우 시나리오를 생성하는 중...</div>
        <div style="width:300px;height:10px;background:#273247;border-radius:5px;overflow:hidden;">
            <div id="progress-bar-inner" style="width:10%;height:100%;background:linear-gradient(90deg, #34c759, #30d3a0);transition:width .5s ease-out;"></div>
        </div>
      </div>
    </div>
    <style>@keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }</style>
  `;
  document.body.appendChild(overlay);
  setTimeout(() => { overlay.style.opacity = '1'; }, 10);
  
  const textEl = overlay.querySelector('#progress-text');
  const barEl = overlay.querySelector('#progress-bar-inner');

  return {
    update: (text, percent) => { if (textEl) textEl.textContent = text; if (barEl) barEl.style.width = `${percent}%`; },
    remove: () => { overlay.style.opacity = '0'; setTimeout(() => overlay.remove(), 500); }
  };
}


// --- [추가] battle.js에서 가져온 startBattleProcess 함수를 조우에 맞게 수정 ---
async function startEncounterProcess(myChar, opponentChar) {
    const progress = showProgressUI(myChar, opponentChar);
    try {
        progress.update('AI가 조우 서사를 구상하는 중...', 30);

        // AI 입력을 위해 캐릭터 정보와 아이템 정보를 가공
        const myInv = await getUserInventory(myChar.owner_uid);
        const oppInv = await getUserInventory(opponentChar.owner_uid);
        
        const simplifyForAI = (char, inv) => {
            const equippedItems = (char.items_equipped || []).map(id => inv.find(i => i.id === id)).filter(Boolean);
            const itemsAsText = equippedItems.length > 0
                ? equippedItems.map(i => `- ${i.name} (${i.rarity}): ${i.desc_soft || i.desc || i.description || ''}`).join('\n')
                : '없음';

            return {
                name: char.name,
                summary: char.summary,
                narrative: (char.narratives?.[0]?.long || ''),
                items_equipped: itemsAsText,
            };
        };

        const myCharForAI = simplifyForAI(myChar, myInv);
        const opponentCharForAI = simplifyForAI(opponentChar, oppInv);
        
        // 두 캐릭터의 관계 조회
        const relation = await getRelationBetween(myChar.id, opponentChar.id);

        progress.update('서버에 조우 생성을 요청하는 중...', 60);

        const startEncounter = httpsCallable(func, 'startEncounter');
        const result = await startEncounter({
            myCharId: myChar.id,
            opponentCharId: opponentChar.id,
            // AI 입력을 위해 가공된 데이터를 함께 전송
            myChar_forAI: myCharForAI,
            opponentChar_forAI: opponentCharForAI,
            relation_note: relation
        });
        
        progress.update('완료! 로그 페이지로 이동합니다.', 100);
        
        setTimeout(() => {
            progress.remove();
            location.hash = `#/encounter-log/${result.data.logId}`;
        }, 800);

    } catch (e) {
        console.error("Encounter process failed:", e);
        showToast('조우 생성에 실패했습니다: ' + e.message);
        progress.remove();
        const btnStart = document.getElementById('btnStart');
        if (btnStart) mountCooldownOnButton(btnStart, '조우 시작');
    }
}


// ---------- entry (기존 showEncounter 함수) ----------
export async function showEncounter(){
  ensureSpinCss();
  const intent = intentGuard('encounter');
  const root   = document.getElementById('view');

  if(!intent || !auth.currentUser){
    root.innerHTML = `<section class="container narrow"><div class="kv-card">${!intent ? '잘못된 접근이야.' : '로그인이 필요해.'}</div></section>`;
    return;
  }

  // --- UI 레이아웃 (기존과 동일) ---
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
        <button class="btn" id="btnStart" disabled>조우 시작</button>
      </div>
    </div>
  </section>`;

  document.getElementById('btnBack').onclick = ()=>{
    location.hash = intent?.charId ? `#/char/${intent.charId}` : '#/home';
  };

  let myCharData = null;
  let opponentCharData = null;

  try {
    const meSnap = await fx.getDoc(fx.doc(db, 'chars', intent.charId));
    if (!meSnap.exists()) throw new Error('내 캐릭터 정보를 찾을 수 없습니다.');
    myCharData = { id: meSnap.id, ...meSnap.data() };
    await renderLoadoutForMatch(document.getElementById('loadoutArea'), myCharData);
    ensureItemCss();

    let matchData = null;
    const persisted = loadMatchLock('encounter', intent.charId);
    if (persisted) {
      matchData = { ok:true, token: persisted.token||null, opponent: persisted.opponent };
    } else {
      matchData = await requestMatch(intent.charId, 'encounter');
      if(!matchData?.ok || !matchData?.opponent) throw new Error('매칭 상대를 찾지 못했습니다.');
      saveMatchLock('encounter', intent.charId, { token: matchData.token, opponent: matchData.opponent });
    }

    const oppId = String(matchData.opponent.id||matchData.opponent.charId||'').replace(/^chars\//,'');
    const oppDoc = await fx.getDoc(fx.doc(db,'chars', oppId));
    
    if (!oppDoc.exists()) {
      showToast('상대 정보가 없어 다시 매칭할게.');
      sessionStorage.removeItem(_lockKey('encounter', intent.charId));
      setTimeout(() => showEncounter(), 1000);
      return;
    }
    
    opponentCharData = { id: oppDoc.id, ...oppDoc.data() };
    
    renderOpponentCard(document.getElementById('matchArea'), opponentCharData);

    const btnStart = document.getElementById('btnStart');
    mountCooldownOnButton(btnStart, '조우 시작');
    
    // --- [교체] 시작 버튼 클릭 시 startEncounterProcess 함수 호출 ---

  btnStart.onclick = async () => {
    if (getCooldownRemainMs() > 0) return;
    btnStart.disabled = true;
    applyGlobalCooldown(300); 
    await startEncounterProcess(myCharData, opponentCharData);
  };

  } catch(e) {
    console.error('[encounter] setup error', e);
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

// [수정] battle.js의 로드아웃/아이템 관리 코드를 그대로 가져와 아이템 표시 오류 해결 및 교체 기능 추가
async function renderLoadoutForMatch(box, myChar){
  const abilities = Array.isArray(myChar.abilities_all) ? myChar.abilities_all : [];
  let equippedSkills = Array.isArray(myChar.abilities_equipped) ? myChar.abilities_equipped.slice(0,2) : [];
  const inv = await getUserInventory();
  let equippedItems = (myChar.items_equipped || []).map(id => inv.find(item => item.id === id)).filter(Boolean);

  const render = () => {
      box.innerHTML = `
        <div class="p12">
          <div style="font-weight:800;margin-bottom:8px">내 스킬 (2개까지 선택 가능)</div>
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
                const style = item ? rarityStyle(item.rarity) : null;
                const isAether = item && (String(item.rarity||'').toLowerCase()==='aether');
                const borderStyle = isAether ? '' : (item ? `border-left: 3px solid ${style.border};` : '');
                return `<div class="kv-card item-card ${isAether ? 'rarity-aether' : ''}" style="min-height:44px;display:flex; flex-direction:column; align-items:center;justify-content:center;padding:8px;font-size:13px;text-align:center; ${borderStyle} ${item && !isAether ? `background:${style.bg};` : ''}">
                          ${item ? `<div>
                            <div style="font-weight:bold; color:${style.text};">${esc(item.name)}</div>
                            <div style="font-size:12px; opacity:.8">${esc(item.desc_soft || item.desc || '-')}</div>
                          </div>` : '(비어 있음)'}
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
              showToast('스킬은 2개까지만 선택할 수 있습니다.');
              return;
            }
            equippedSkills = on;
            // 조우에서는 스킬 저장을 필수로 요구하지 않으므로, 로컬에서만 상태 변경
          };
        });
      }
      
      box.querySelector('#btnManageItems').onclick = () => {
        openItemPicker(myChar, async (selectedIds) => {
            await fx.updateDoc(fx.doc(db, 'chars', myChar.id), { items_equipped: selectedIds });
            myChar.items_equipped = selectedIds;
            const newInv = await getUserInventory();
            equippedItems = selectedIds.map(id => newInv.find(item => item.id === id)).filter(Boolean);
            render();
            showToast('아이템 장착이 저장되었습니다.');
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
  back.style.zIndex = '10000';

  const renderModalContent = () => {
    back.innerHTML = `
      <div class="modal-card" style="background:#0e1116;border:1px solid #273247;border-radius:14px;padding:16px;max-width:800px;width:94vw;max-height:90vh;display:flex;flex-direction:column;">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-shrink:0;">
          <div style="font-weight:900; font-size: 18px;">아이템 장착 관리</div>
          <button class="btn ghost" id="mClose">닫기</button>
        </div>
        <div class="text-dim" style="font-size:13px; margin-top:4px;">아이템을 클릭하여 상세 정보를 보고 장착/해제하세요. (${selectedIds.length} / 3)</div>
        <div class="item-picker-grid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; overflow-y: auto; padding: 5px; margin: 12px 0; flex-grow: 1;">
          ${inv.map(item => {
              const isSelected = selectedIds.includes(item.id);
              return `<div class="kv-card item-card item-picker-card ${isSelected ? 'selected' : ''}" data-item-id="${item.id}"
                     style="padding:10px; outline:${isSelected ? '2px solid #4aa3ff' : 'none'}; cursor:pointer;">
                  <div style="font-weight:700; pointer-events:none;">${esc(item.name)}</div>
                  <div style="font-size:12px; opacity:.8; margin-top: 4px; height: 3em; overflow:hidden; pointer-events:none;">${esc(item.desc_soft || item.desc || '-')}</div>
                </div>`;
            }).join('')}
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
            showItemDetailModal(item, {
                equippedIds: selectedIds,
                onUpdate: (newSelectedIds) => {
                    selectedIds = newSelectedIds;
                    renderModalContent();
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

export default showEncounter;
