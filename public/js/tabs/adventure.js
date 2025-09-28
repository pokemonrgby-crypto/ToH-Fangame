// /public/js/tabs/adventure.js
import { db, auth, fx } from '../api/firebase.js';
import { fetchWorlds } from '../api/store.js';
import { showToast } from '../ui/toast.js';
import { EXPLORE_COOLDOWN_KEY, getRemain as getCdRemain } from '../api/cooldown.js';
import { createRun } from '../api/explore.js';
import { findMyActiveRun } from '../api/explore.js';
import { formatRemain } from '../api/cooldown.js';
import { getUserInventory, toggleItemLock } from '../api/user.js'; // ◀◀ toggleItemLock 추가
import { rarityStyle } from './char.js'; // [추가] char.js에서 rarityStyle 함수를 가져옵니다.

// adventure.js 파일 상단, import 바로 아래에 추가

// ===== 로딩 오버레이 유틸리티 =====
function showLoadingOverlay(messages = []) {
  const overlay = document.createElement('div');
  overlay.id = 'toh-loading-overlay';
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 10000;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    background: rgba(0,0,0,0.75); color: white; text-align: center;
    backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
    transition: opacity 0.3s;
  `;

  overlay.innerHTML = `
    <div style="font-weight: 900; font-size: 20px;">🧭 모험 준비 중...</div>
    <div id="loading-bar" style="width: 250px; height: 8px; background: #273247; border-radius: 4px; margin-top: 16px; overflow: hidden;">
      <div id="loading-bar-inner" style="width: 0%; height: 100%; background: #4aa3ff; transition: width 0.5s;"></div>
    </div>
    <div id="loading-text" style="margin-top: 12px; font-size: 14px; color: #c8d0dc;">
      모험을 떠나기 위한 준비 중입니다...
    </div>
  `;
  document.body.appendChild(overlay);

  const bar = overlay.querySelector('#loading-bar-inner');
  const text = overlay.querySelector('#loading-text');
  let msgIndex = 0;

  const intervalId = setInterval(() => {
    if (msgIndex < messages.length) {
      text.textContent = messages[msgIndex];
      bar.style.width = `${((msgIndex + 1) / (messages.length + 1)) * 100}%`;
      msgIndex++;
    }
  }, 900);

  return {
    finish: () => {
      clearInterval(intervalId);
      bar.style.width = '100%';
      text.textContent = '모험 시작!';
    },
    remove: () => {
      clearInterval(intervalId);
      overlay.style.opacity = '0';
      setTimeout(() => overlay.remove(), 300);
    }
  };
}



// ===== modal css (adventure 전용) =====
function ensureModalCss(){
  if (document.getElementById('toh-modal-css')) return;
  const st = document.createElement('style');
  st.id = 'toh-modal-css';
  st.textContent = `
    .modal-back{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;
                background:rgba(0,0,0,.45)}
    .modal-card{background:#0e1116;border:1px solid #273247;border-radius:14px;padding:14px;max-width:720px;width:92vw;
                max-height:80vh;overflow:auto}
  `;
  document.head.appendChild(st);
}

// ===== 공용 유틸 =====
const STAMINA_BASE  = 10;
const cooldownRemain = ()=> getCdRemain(EXPLORE_COOLDOWN_KEY);
const diffColor = (d)=>{
  const v = String(d||'').toLowerCase();
  if(['easy','이지','normal','노말'].includes(v)) return '#4aa3ff';
  if(['hard','하드','expert','익스퍼트','rare'].includes(v)) return '#f3c34f';
  return '#ff5b66';
};
const esc = (s)=> String(s??'').replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
function setExploreIntent(into){ sessionStorage.setItem('toh.explore.intent', JSON.stringify(into)); }
function getExploreIntent(){ try{ return JSON.parse(sessionStorage.getItem('toh.explore.intent')||'null'); }catch{ return null; } }


function injectResumeBanner(root, run){
  const host = root.querySelector('.bookview') || root; // 세계관 카드들이 들어가는 상자
  const box = document.createElement('div');
  box.className = 'kv-card';
  box.style = 'margin-bottom:10px;border-left:3px solid #4aa3ff;padding-left:10px';
  box.innerHTML = `
    <div class="row" style="justify-content:space-between;align-items:center;gap:8px">
      <div>
        <div style="font-weight:900">이어서 탐험하기</div>
        <div class="text-dim" style="font-size:12px">
          ${esc(run.world_name||run.world_id)} / ${esc(run.site_name||run.site_id)}
        </div>
      </div>
      <button class="btn" id="btnResumeRun">이어하기</button>
    </div>
  `;
  // 세계관 리스트가 그려진 뒤 제일 위에 끼워넣기
  if (host.firstElementChild) host.firstElementChild.insertAdjacentElement('beforebegin', box);
  else host.appendChild(box);
  box.querySelector('#btnResumeRun').onclick = ()=> location.hash = '#/explore-run/' + run.id;
}







// ===== 1단계: 세계관 선택 =====
async function viewWorldPick(root){
  const worlds = await fetchWorlds().catch(()=>({ worlds: [] }));
  const list = Array.isArray(worlds?.worlds) ? worlds.worlds : [];

  root.innerHTML = `
    <section class="container narrow">
      <div class="book-card">
        <div class="bookmarks">
          <button class="bookmark active" disabled>탐험</button>
          <button class="bookmark ghost" disabled>레이드(준비중)</button>
          <button class="bookmark ghost" id="btnInventory">가방</button>
        </div>
        <div class="bookview p12" id="viewW">
          <div class="kv-label">세계관 선택</div>
          <div class="col" style="gap:10px">
            ${list.map(w=>`
              <button class="kv-card wpick" data-w="${esc(w.id)}" style="display:flex;gap:10px;align-items:center;text-align:left;cursor:pointer">
                <img src="${w?.img ? esc('/assets/'+w.img) : ''}"
                     onerror="this.remove()"
                     style="width:72px;height:72px;border-radius:10px;object-fit:cover;background:#0b0f15">

                <div>
                  <div style="font-weight:900">${esc(w.name||w.id)}</div>
                  <div class="text-dim" style="font-size:12px">${esc(w.intro||'')}</div>
                </div>
              </button>
            `).join('')}
          </div>
        </div>
      </div>
    </section>
  `;

  root.querySelector('#btnInventory').addEventListener('click', () => {
    showSharedInventory(root); 
  });

  root.querySelectorAll('.wpick').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const wid = btn.getAttribute('data-w');
      const w = list.find(x=>x.id===wid);
      if(!w) return;
      viewSitePick(root, w);
    });
  });
}

// ===== 2단계: 명소(사이트) 선택 =====
function viewSitePick(root, world){
  const sites = Array.isArray(world?.detail?.sites) ? world.detail.sites : [];

  root.innerHTML = `
    <section class="container narrow">
      <div class="card p16">
        <div class="row" style="gap:8px;align-items:center">
          <button class="btn ghost" id="btnBackWorld">← 세계관 선택으로</button>
          <div style="font-weight:900;font-size:16px">${esc(world.name||world.id)}</div>
        </div>
        <div class="kv-label mt8">탐험 가능 명소</div>
        <div class="col" style="gap:10px">
          ${sites.map(s=>{
            const diff = s.difficulty || 'normal';
            return `
              <button class="kv-card spick" data-s="${esc(s.id)}" style="text-align:left;cursor:pointer">
                <div style="display:flex;justify-content:space-between;align-items:center">
                  <div style="font-weight:900">${esc(s.name)}</div>
                  <span class="chip" style="background:${diffColor(diff)};color:#121316;font-weight:800">${esc(String(diff).toUpperCase())}</span>
                </div>
                <div class="text-dim" style="font-size:12px;margin-top:4px">${esc(s.description||'')}</div>
                ${s.img? `<div style="margin-top:8px"><img src="${esc('/assets/'+s.img)}"
                     onerror="this.parentNode.remove()"
                     style="width:100%;max-height:180px;object-fit:cover;border-radius:10px;border:1px solid #273247;background:#0b0f15"></div>`:''}

              </button>`;
          }).join('')}
        </div>
      </div>
    </section>
  `;

  root.querySelector('#btnBackWorld')?.addEventListener('click', ()=> viewWorldPick(root));
  root.querySelectorAll('.spick').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const sid = btn.getAttribute('data-s');
      const site = sites.find(x=>x.id===sid);
      if(!site) return;
      openCharPicker(root, world, site);
    });
  });
}

// ===== 3단계: 캐릭터 선택(모달) =====
async function openCharPicker(root, world, site){
  const u = auth.currentUser;
  ensureModalCss();

  if(!u){ showToast('로그인이 필요해'); return; }

  const qs = await fx.getDocs(fx.query(
    fx.collection(db,'chars'),
    fx.where('owner_uid','==', u.uid),
    fx.limit(50)
  ));

  const chars=[]; qs.forEach(d=>chars.push({ id:d.id, ...d.data() }));

  chars.sort((a,b)=>{
    const ta = a?.createdAt?.toMillis?.() ?? 0;
    const tb = b?.createdAt?.toMillis?.() ?? 0;
    return tb - ta;
  });


  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `
    <div class="modal-card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <div style="font-weight:900">탐험할 캐릭터 선택</div>
        <button class="btn ghost" id="mClose">닫기</button>
      </div>
      <div class="col" style="gap:8px">
        ${chars.map(c=>`
          <button class="kv-card cpick" data-c="${c.id}" style="display:flex;gap:10px;align-items:center;text-align:left;cursor:pointer">
            <img src="${esc(c.thumb_url||c.image_url||'')}" onerror="this.src='';this.classList.add('noimg')"
                 style="width:56px;height:56px;border-radius:10px;object-fit:cover;border:1px solid #273247;background:#0b0f15">
            <div>
              <div style="font-weight:900">${esc(c.name||'(이름 없음)')}</div>
              <div class="text-dim" style="font-size:12px">Elo ${esc((c.elo??1000).toString())}</div>
            </div>
          </button>
        `).join('')}
      </div>
    </div>
  `;
  back.addEventListener('click', (e)=>{ if(e.target===back) back.remove(); });
  back.querySelector('#mClose').onclick = ()=> back.remove();
  document.body.appendChild(back);

  back.querySelectorAll('.cpick').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const cid = btn.getAttribute('data-c');
      back.remove();
      viewPrep(root, world, site, chars.find(x=>x.id===cid));
    });
  });
}

// /public/js/tabs/adventure.js 에 추가

// ===== 아이템 등급별 스타일 =====


// ===== 소모품/사용횟수 표기 유틸 =====
function isConsumableItem(it){
  return !!(it?.consumable || it?.isConsumable);
}
function getUsesLeft(it){
  if (typeof it?.uses === 'number') return it.uses;
  if (typeof it?.remainingUses === 'number') return it.remainingUses;
  return null; // 모르면 null
}
function useBadgeHtml(it){
  if (!isConsumableItem(it)) return '';
  const left = getUsesLeft(it);
  const label = (left === null) ? '소모품' : `남은 ${left}회`;
  return `<span class="chip" style="margin-left:auto;font-size:11px;padding:2px 6px">${esc(label)}</span>`;
}



// ===== 아이템 모달용 CSS 및 반짝이는 효과 =====
function ensureItemCss() {
  if (document.getElementById('toh-item-css')) return;
  const st = document.createElement('style');
  st.id = 'toh-item-css';
  st.textContent = `
  .shine-effect {
    position: relative;
    overflow: hidden;
  }
  .shine-effect::after {
    content: '';
    position: absolute;
    top: -50%;
    left: -50%;
    width: 200%;
    height: 200%;
    background: linear-gradient(to right, rgba(255,255,255,0) 0%, rgba(255,255,255,0.3) 50%, rgba(255,255,255,0) 100%);
    transform: rotate(30deg);
    animation: shine 3s infinite ease-in-out;
    pointer-events: none;
  }
  @keyframes shine {
    0% { transform: translateX(-75%) translateY(-25%) rotate(30deg); }
    100% { transform: translateX(75%) translateY(25%) rotate(30deg); }
  }

  /* 카드 공통 개선 */
  .item-card {
    transition: box-shadow .18s ease, transform .18s ease, filter .18s ease;
    will-change: transform, box-shadow;
    outline: none;
  }
  .item-card:hover,
  .item-card:focus-visible {
    transform: translateY(-2px);           /* 확대 대신 살짝 띄우기 */
    box-shadow: 0 6px 18px rgba(0,0,0,.35);
    filter: brightness(1.05);
  }
`;

  document.head.appendChild(st);
}

// ===== 아이템 상세 정보 모달 표시 =====
function showItemDetailModal(item) {
  ensureModalCss();
  const style = rarityStyle(item.rarity);

  // 설명/효과 안전 추출
  const getItemDesc = (it)=>{
    // 우선순위: desc_long > desc_soft > desc > description
    const raw = it?.desc_long || it?.desc_soft || it?.desc || it?.description || '';
    return String(raw || '').replace(/\n/g, '<br>');
  };

  const getEffectsHtml = (it)=>{
    const eff = it?.effects;
    if (!eff) return '';
    // 배열이면 불릿 목록, 문자열이면 그대로, 객체면 key: value 목록
    if (Array.isArray(eff)) {
      return `<ul style="margin:6px 0 0 16px; padding:0;">
        ${eff.map(x=>`<li>${esc(String(x||''))}</li>`).join('')}
      </ul>`;
    } else if (typeof eff === 'object') {
      return `<ul style="margin:6px 0 0 16px; padding:0;">
        ${Object.entries(eff).map(([k,v])=>`<li><b>${esc(k)}</b>: ${esc(String(v??''))}</li>`).join('')}
      </ul>`;
    }
    return `<div>${esc(String(eff))}</div>`;
  };

  const back = document.createElement('div');
  back.className = 'modal-back';
  back.style.zIndex = '10000';

  back.innerHTML = `
    <div class="modal-card">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px;">
        <div>
  <div class="row" style="align-items:center;gap:8px;flex-wrap:wrap">
    <div style="font-weight:900; font-size:18px;">${esc(item.name)}</div>
    <span class="chip" style="background:${style.border}; color:${style.bg}; font-weight:800;">${esc(style.label)}</span>
    ${useBadgeHtml(item)}
  </div>
</div>

        <button class="btn ghost" id="mCloseDetail">닫기</button>
      </div>
      <div class="kv-card" style="padding:12px;">
        <div style="font-size:14px; line-height:1.6;">${getItemDesc(item) || '상세 설명이 없습니다.'}</div>
        ${item.effects ? `<hr style="margin:12px 0; border-color:#273247;">
          <div class="kv-label">효과</div>
          <div style="font-size:13px;">${getEffectsHtml(item)}</div>` : ''}
      </div>
    </div>
  `;

  const closeModal = () => back.remove();
  back.addEventListener('click', e => { if(e.target === back) closeModal(); });
  back.querySelector('#mCloseDetail').onclick = closeModal;
  document.body.appendChild(back);
}


// ===== 4단계: 준비 화면(스킬/아이템 요약 + 시작 버튼) =====
// /public/js/tabs/adventure.js의 viewPrep 함수를 아래 코드로 교체

function viewPrep(root, world, site, char){
  const remain = cooldownRemain();
  const diff = site.difficulty || 'normal';

  root.innerHTML = `
    <section class="container narrow">
      <div class="card p16">
        <div class="row" style="gap:8px;align-items:center">
          <button class="btn ghost" id="btnBackSites">← 명소 선택으로</button>
          <div style="font-weight:900;font-size:16px">${esc(world.name)} / ${esc(site.name)}</div>
          <span class="chip" style="margin-left:auto;background:${diffColor(diff)};color:#121316;font-weight:800">${esc(String(diff).toUpperCase())}</span>
        </div>

        <div class="kv-label mt8">캐릭터</div>
        <div class="kv-card" style="display:flex;gap:10px;align-items:center">
          <img src="${esc(char.thumb_url||char.image_url||'')}" onerror="this.src='';this.classList.add('noimg')"
               style="width:56px;height:56px;border-radius:10px;object-fit:cover;border:1px solid #273247;background:#0b0f15">
          <div>
            <div style="font-weight:900">${esc(char.name||'(이름 없음)')}</div>
            <div class="text-dim" style="font-size:12px">Elo ${esc((char.elo??1000).toString())}</div>
          </div>
        </div>

        <div class="kv-label mt12">스킬 선택 (정확히 2개)</div>
        <div id="skillBox">
          ${
            Array.isArray(char.abilities_all) && char.abilities_all.length
            ? `<div class="grid2 mt8" id="skillGrid" style="gap:8px">
                ${char.abilities_all.map((ab,i)=>`
                  <label class="kv-card" style="display:flex;gap:8px;align-items:flex-start;padding:10px;cursor:pointer">
                    <input type="checkbox" data-i="${i}" ${(Array.isArray(char.abilities_equipped)&&char.abilities_equipped.includes(i))?'checked':''}
                           style="margin-top:3px">
                    <div>
                      <div style="font-weight:700">${esc(ab?.name || ('스킬 ' + (i+1)))}</div>
                      <div class="text-dim" style="font-size:12px">${esc(ab?.desc_soft || '')}</div>
                    </div>
                  </label>
                `).join('')}
              </div>`
            : `<div class="kv-card text-dim">등록된 스킬이 없어.</div>`
          }
        </div>

        <div class="kv-label mt12">아이템</div>
        {/* [수정] 아이템 요약 부분을 id를 가진 버튼으로 변경 */}
        <button class="kv-card" id="btnManageItems" style="text-align:left; width:100%; cursor:pointer;">
          <div class="row" style="justify-content:space-between; align-items:center;">
            <span>슬롯 3개 — ${
              Array.isArray(char.items_equipped) && char.items_equipped.length
              ? `${char.items_equipped.length}개 장착`
              : '비어 있음'
            }</span>
            <span class="text-dim" style="font-size:12px;">관리하기 →</span>
          </div>
        </button>

        <div class="row" style="gap:8px;justify-content:flex-end;margin-top:12px">
          <button class="btn" id="btnStart"${remain>0?' disabled':''}>탐험 시작</button>
        </div>
        <div class="text-dim" id="cdNote" style="font-size:12px;margin-top:6px"></div>
      </div>
    </section>
  `;

  // [수정] querySelector로 버튼을 찾아서 이벤트를 연결합니다.
  root.querySelector('#btnManageItems').onclick = () => openItemPicker(char);

  // ... 이하 기존 viewPrep 함수의 나머지 코드는 동일 ...
  const btnStart = root.querySelector('#btnStart');
  const skillInputs = root.querySelectorAll('#skillGrid input[type=checkbox][data-i]');
  // (이하 생략)

  
  const updateStartEnabled = ()=>{
    if (!btnStart) return;
    const on = Array.from(skillInputs).filter(x=>x.checked).map(x=>+x.dataset.i);
    const hasNoSkills = !Array.isArray(char.abilities_all) || char.abilities_all.length === 0;
    const cooldownOk = cooldownRemain() <= 0;
    const skillsOk = on.length === 2 || hasNoSkills;
    btnStart.disabled = !(cooldownOk && skillsOk);
  };

  (function bindSkillSelection(){
    const abilities = Array.isArray(char.abilities_all) ? char.abilities_all : [];
    if (!abilities.length) return;

    // 초기 상태 업데이트
    updateStartEnabled();

    skillInputs.forEach(inp=>{
      inp.addEventListener('change', async ()=>{
        const on = Array.from(skillInputs).filter(x=>x.checked).map(x=>+x.dataset.i);
        if (on.length > 2){
          inp.checked = false;
          showToast('스킬은 정확히 2개만 선택 가능해');
          return;
        }
        if (on.length === 2){
          if (!char || !char.id) {
              console.error('[adventure] Invalid character data for saving skills.', char);
              showToast('캐릭터 정보가 올바르지 않아 저장할 수 없어.');
              return;
          }
          try{
            const charRef = fx.doc(db, 'chars', char.id);
            await fx.updateDoc(charRef, { abilities_equipped: on });
            char.abilities_equipped = on;
            showToast('스킬 선택 저장 완료');
          }catch(e){
            console.error('[adventure] abilities_equipped update fail', e);
            showToast('저장 실패: ' + e.message);
          }
        }
        // 변경 시마다 버튼 상태 업데이트
        updateStartEnabled();
      });
    });
  })();
  
  root.querySelector('#btnBackSites')?.addEventListener('click', ()=> viewSitePick(root, world));

  const cdNote = root.querySelector('#cdNote');
  // const btnStart = root.querySelector('#btnStart'); // 위에서 이미 선언됨
  
  // (btnResumeChar 관련 코드는 변경 없음)
  const btnRow = btnStart?.parentNode;
  if (btnRow){
    const btnResume = document.createElement('button');
    btnResume.className = 'btn ghost';
    btnResume.id = 'btnResumeChar';
    btnResume.textContent = '이어하기';
    btnResume.style.display = 'none';
    btnRow.insertBefore(btnResume, btnStart);

    (async ()=>{
      try{
        const q = fx.query(
          fx.collection(db,'explore_runs'),
          fx.where('owner_uid','==', auth.currentUser.uid),
          fx.where('charRef','==', `chars/${char.id}`),
          fx.where('status','==','ongoing'),
          fx.limit(1)
        );
        const s = await fx.getDocs(q);
        if (!s.empty){
          const d = s.docs[0];
          btnResume.style.display = '';
          btnResume.onclick = ()=> location.hash = '#/explore-run/' + d.id;
        }
      }catch(e){ /* 조용히 무시 */ }
    })();
  }

  let intervalId = null;
  const tick = ()=>{
      const r = cooldownRemain();
      if(cdNote) cdNote.textContent = r > 0 ? `탐험 쿨타임: ${formatRemain(r)}` : '탐험 가능!';
      
      // 이제 updateStartEnabled가 정상적으로 호출됨
      updateStartEnabled();

      if (r <= 0 && intervalId) {
          clearInterval(intervalId);
          intervalId = null;
      }
  };
  intervalId = setInterval(tick, 500);
  tick();

// ANCHOR: btnStart?.addEventListener('click', async ()=>{

  btnStart?.addEventListener('click', async ()=>{
    if (btnStart.disabled) return;

    if (Array.isArray(char.abilities_all) && char.abilities_all.length){
      const eq = Array.isArray(char.abilities_equipped) ? char.abilities_equipped : [];
      if (eq.length !== 2){
        showToast('스킬을 딱 2개 선택해줘!');
        return;
      }
    }

    if(cooldownRemain()>0) return showToast('쿨타임이 끝나면 시작할 수 있어!');

    btnStart.disabled = true;
    
    // 1. 로딩 UI 표시 및 메시지 목록 정의
    const loadingMessages = [
      "운명의 주사위를 굴립니다...",
      "캐릭터의 서사를 확인하는 중...",
      "모험 장소로 이동 중입니다...",
    ];
    const loader = showLoadingOverlay(loadingMessages);

    // 기존 탐험 확인 로직 (에러 발생 시 로딩창 닫고 버튼 활성화)
    try {
      const q = fx.query(
        fx.collection(db, 'explore_runs'),
        fx.where('charRef', '==', `chars/${char.id}`),
        fx.where('status', '==', 'ongoing'),
        fx.limit(1)
      );
      const s = await fx.getDocs(q);
      if (!s.empty) {
        const doc = s.docs[0];
        loader.finish();
        setTimeout(() => location.hash = `#/explore-run/${doc.id}`, 300);
        return;
      }
    } catch (_) { /* 권한/인덱스 이슈는 무시하고 새로 생성으로 진행 */ }

    // 2. 런 생성 (createRun)
    let runId = '';
    try {
      runId = await createRun({ world, site, char });
    } catch (e) {
      console.error('[explore] create run fail', e);
      showToast(e?.message || '탐험 시작에 실패했습니다. 잠시 후 다시 시도해주세요.');
      
      // 실패 시 로딩 UI 제거 및 버튼 복구
      loader.remove();
      btnStart.disabled = false;
      return;
    }

    // 3. 성공 시 로딩 UI 완료 처리 후 페이지 이동
    loader.finish();
    setExploreIntent({ charId: char.id, runId, world: world.id, site: site.id, ts: Date.now() });
    
    // 로딩 완료 메시지를 잠시 보여준 후 이동
    setTimeout(() => {
        location.hash = `#/explore-run/${runId}`;
    }, 500);
  });

}


// /public/js/tabs/adventure.js 의 기존 openItemPicker 함수를 교체

// ===== 아이템 목록 및 상세 정보 표시 =====
async function openItemPicker(char) {
  const allItems = await getUserInventory(); // ◀◀◀ 이 줄을 수정하세요.
  
  // 필요한 CSS 주입
  ensureModalCss();
  ensureItemCss();

  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `
    <div class="modal-card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div style="font-weight:900">보유 아이템</div>
        <button class="btn ghost" id="mClose">닫기</button>
      </div>
      <div id="inventoryItems" class="grid3" style="gap:12px; max-height:450px; overflow-y:auto; padding:8px 4px 4px 0;"></div>

    </div>
  `;
  document.body.appendChild(back);

  const inventoryItemsBox = back.querySelector('#inventoryItems');
  
  if (allItems.length > 0) {
    inventoryItemsBox.innerHTML = '';
    allItems.forEach(item => {
      const style = rarityStyle(item.rarity);
      const isShiny = ['epic', 'legend', 'myth'].includes((item.rarity || '').toLowerCase());
      const isAether = (item.rarity || '').toLowerCase() === 'aether';
      
      const card = document.createElement('button');
      card.type = 'button';
      card.className = `kv-card item-card ${isShiny ? 'shine-effect' : ''}`;
      card.className = `kv-card item-card ${isShiny ? 'shine-effect' : ''} ${isAether ? 'rarity-aether' : ''}`;
      card.style.cssText = `
        padding: 8px;
        cursor: pointer;
        border: 1px solid ${style.border};
        background: ${style.bg};
        color: ${style.text};
        transition: transform 0.2s;
        width: 100%;
        text-align: left;
      `;
      card.innerHTML = `
        <div class="row" style="align-items:center;gap:8px">
          <div style="font-weight:700;line-height:1.2">${esc(item.name)}</div>
          ${useBadgeHtml(item)}
        </div>
        <div style="font-size:12px;opacity:.85;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">
          ${esc(item.desc_soft || item.desc || item.description || (item.desc_long ? String(item.desc_long).split('\n')[0] : ''))}
        </div>
      `;

      card.addEventListener('click', () => showItemDetailModal(item));
      inventoryItemsBox.appendChild(card);
    });
  } else {
    inventoryItemsBox.innerHTML = `<div class="text-dim">보유한 아이템이 없습니다.</div>`;
  }

  
  const closeModal = () => back.remove();
  back.addEventListener('click', (e) => { if(e.target === back) closeModal(); });
  back.querySelector('#mClose').onclick = closeModal;
}


// ===== 엔트리 =====
export async function showAdventure(){
  const root = document.getElementById('view');
  if(!auth.currentUser){
    root.innerHTML = `<section class="container narrow"><div class="kv-card">로그인이 필요해.</div></section>`;
    return;
  }
  await viewWorldPick(root);
  try{
    const r = await findMyActiveRun();
    if (r) injectResumeBanner(root, r);
  }catch(e){
    console.warn('[adventure] resume check fail', e);
  }

}

export default showAdventure;

// /public/js/tabs/adventure.js 파일 맨 아래에 추가

// ===== 공유 인벤토리 화면 =====
async function showSharedInventory(root) {
  const u = auth.currentUser;
  if (!u) {
    showToast('로그인이 필요합니다.');
    return;
  }

  const userDocRef = fx.doc(db, 'users', u.uid);
  let allItems = [];
  let unsub = null;

  // 실시간으로 인벤토리 변경 감지
  unsub = fx.onSnapshot(userDocRef, (doc) => {
    allItems = doc.exists() ? (doc.data().items_all || []) : [];
    renderInventory();
  });

  // 탭이 닫힐 때 구독 해제
  const view = root.closest('#view');
  if (view) {
    view.__cleanup = () => {
      if (unsub) unsub();
    };
  }
  
  ensureItemCss();

  root.innerHTML = `
    <section class="container narrow">
      <div class="book-card">
        <div class="bookmarks">
          <button class="bookmark ghost" id="btnToExplore">탐험</button>
          <button class="bookmark ghost" disabled>레이드(준비중)</button>
          <button class="bookmark active" disabled>가방</button>
        </div>
        <div class="bookview p12">
          <div class="kv-label">공유 보관함 (아이템 클릭: 상세정보, 🔒: 잠금/해제)</div>
          <div id="inventoryItems" class="grid4" style="gap:12px; max-height:60vh; overflow-y:auto; padding:8px 4px 4px 0;">
            </div>
        </div>
      </div>
    </section>
  `;

  const inventoryItemsBox = root.querySelector('#inventoryItems');
  
  function renderInventory() {
    if (allItems.length > 0) {
      inventoryItemsBox.innerHTML = '';
      allItems.forEach(item => {
        const style = rarityStyle(item.rarity);
        const isShiny = ['epic', 'legend', 'myth'].includes((item.rarity || '').toLowerCase());
        const isLocked = item.isLocked === true; // isLocked 필드가 없으면 false

        const card = document.createElement('div'); // button -> div로 변경
        card.className = `kv-card item-card ${isShiny ? 'shine-effect' : ''}`;
        card.style.cssText = `
          padding: 8px;
          border: 1px solid ${style.border};
          background: ${style.bg};
          color: ${style.text};
          position: relative; /* 자물쇠 아이콘 위치 기준 */
        `;
        card.innerHTML = `
          <div class="item-content-wrapper" style="cursor: pointer;">
            <div class="row" style="align-items:center;gap:8px">
              <div style="font-weight:700;line-height:1.2">${esc(item.name)}</div>
              ${useBadgeHtml(item)}
            </div>
            <div style="font-size:12px;opacity:.85;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">
              ${esc(item.desc_soft || item.desc || item.description || '')}
            </div>
          </div>
          <button class="btn-lock" data-item-id="${item.id}" data-locked="${isLocked}" style="position: absolute; top: 4px; right: 4px; background: none; border: none; font-size: 18px; cursor: pointer; padding: 4px; line-height: 1;">
            ${isLocked ? '🔒' : '🔓'}
          </button>
        `;

        // 아이템 상세 정보 보기 (자물쇠 제외한 영역 클릭 시)
        card.querySelector('.item-content-wrapper').addEventListener('click', () => showItemDetailModal(item));
        
        // 잠금 버튼 이벤트
        card.querySelector('.btn-lock').addEventListener('click', async (e) => {
          e.stopPropagation(); // 상세 정보 모달이 뜨지 않도록 이벤트 전파 중단
          const button = e.currentTarget;
          const itemId = button.dataset.itemId;
          const currentLockState = button.dataset.locked === 'true';
          
          button.disabled = true;
          try {
            await toggleItemLock(itemId, !currentLockState);
            showToast(`아이템을 ${!currentLockState ? '잠갔습니다.' : '해제했습니다.'}`);
            // onSnapshot이 자동으로 UI를 갱신하므로 여기서는 별도 처리 필요 없음
          } catch (err) {
            showToast(`오류: ${err.message}`);
          } finally {
            button.disabled = false;
          }
        });

        inventoryItemsBox.appendChild(card);
      });
    } else {
      inventoryItemsBox.innerHTML = `<div class="kv-card text-dim" style="grid-column: 1 / -1;">보관함에 아이템이 없습니다.</div>`;
    }
  }
  
  root.querySelector('#btnToExplore').addEventListener('click', () => {
    if(unsub) unsub(); // 다른 탭으로 이동 시 구독 해제
    viewWorldPick(root);
  });

  renderInventory(); // 초기 렌더링
}
