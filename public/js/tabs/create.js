// /public/js/tabs/create.js
// 생성 폼: 개수/쿨타임 검사 → 백엔드 함수 호출 → Firestore 저장

import { auth } from '../api/firebase.js';
import { fetchWorlds, getMyCharCount } from '../api/store.js';
import { showToast } from '../ui/toast.js';
// [수정] genCharacterFlash2 대신 백엔드 함수 호출 래퍼를 import합니다.
import { createCharSecure } from '../api/secure-char.js';

const LS_KEY_CREATE_LAST_AT = 'charCreateLastAt';
const MAX_CHAR_COUNT = 10;
const CREATE_COOLDOWN_SEC = 300;
const DEBUG = !!localStorage.getItem('toh_debug_ai');

function nowSec(){ return Math.floor(Date.now()/1000); }

// 구버전(ms)로 저장돼 있던 값을 한 번만 sec로 교정
(function normalizeLegacyCooldown(){
  try{
    const raw = localStorage.getItem(LS_KEY_CREATE_LAST_AT);
    if (!raw) return;
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n > 1e11) { // ms로 보이는 값
      localStorage.setItem(LS_KEY_CREATE_LAST_AT, String(Math.floor(n/1000)));
    }
  }catch(_){}
})();

function readCooldownStartSec(){
  let raw = localStorage.getItem(LS_KEY_CREATE_LAST_AT);
  if (!raw) return 0;
  let n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n > 1e11) n = Math.floor(n/1000); // 혹시 모를 ms 잔재
  const now = nowSec();
  if (n > now) n = now;
  return n;
}
function leftCooldown(){
  const last = readCooldownStartSec();
  const left = CREATE_COOLDOWN_SEC - (nowSec() - last);
  return Math.max(0, left);
}
function startCooldown(){ localStorage.setItem(LS_KEY_CREATE_LAST_AT, String(nowSec())); }


function phImg(w=160){ return `<div style="width:${w}px;aspect-ratio:1/1;background:#0e0f12;border-radius:12px;display:block"></div>`; }
function el(tag, attrs={}, inner=''){
  const d = document.createElement(tag);
  for(const k in attrs){
    if(k==='className') d.className = attrs[k];
    else if(k==='style') d.style.cssText = attrs[k];
    else if(k.startsWith('on') && typeof attrs[k]==='function') d.addEventListener(k.slice(2), attrs[k]);
    else d.setAttribute(k, attrs[k]);
  }
  if(typeof inner==='string') d.innerHTML = inner; else if(inner instanceof Node) d.appendChild(inner);
  return d;
}
function resolveWorldImg(img){
  if(!img) return null;
  if(/^https?:\/\//.test(img)) return img;
  if(img.startsWith('/')) return img;
  return `/assets/${img}`;
}

export async function showCreate(){
  const root = document.getElementById('view');
  const u = auth.currentUser;
  if(!u){
    root.innerHTML = `<section class="container narrow"><p>로그인해야 캐릭터를 만들 수 있어.</p></section>`;
    return;
  }

  // 개수 제한
  const cnt = await getMyCharCount();
  if(cnt >= MAX_CHAR_COUNT){
    root.innerHTML = `<section class="container narrow"><p>캐릭터는 최대 ${MAX_CHAR_COUNT}개까지 만들 수 있어.</p></section>`;
    return;
  }

  // 세계관 로드
  const cfg = await fetchWorlds();
  const worlds = (cfg && cfg.worlds) ? cfg.worlds : [];

  root.innerHTML = `
    <section class="container narrow">
      <h2>새 캐릭터 만들기</h2>
      <div id="worldsCol" style="display:flex; flex-direction:column; gap:12px; margin-top:12px;"></div>
      <div id="createArea" style="margin-top:18px;"></div>
      ${DEBUG ? `<div id="aiDebug" class="card p12 mt12" style="white-space:pre-wrap;font-family:ui-monospace,Menlo,Consolas,monospace"></div>` : ''}
    </section>
  `;

  const col = document.getElementById('worldsCol');
  if(worlds.length === 0){
    col.innerHTML = `<div class="card p12">세계관 정보가 로드되지 않았어. /assets/worlds.json을 확인해줘.</div>`;
    return;
  }

  // 목록
  worlds.forEach(w=>{
    const src = resolveWorldImg(w.img);
    const card = el('div',{className:'card p12 clickable'}, `
      <div style="display:flex; gap:12px; align-items:center;">
        <div style="width:80px;flex-shrink:0">
          ${src ? `<img src="${src}" alt="${w.name}" style="width:80px;aspect-ratio:1/1;border-radius:10px;object-fit:cover;display:block">` : phImg(80)}
        </div>
        <div style="flex:1">
          <div style="font-weight:800;font-size:16px;margin-bottom:6px">${w.name}</div>
          <div style="color:var(--dim);font-size:13px">${w.intro||''}</div>
        </div>
      </div>
    `);
    card.onclick = ()=> selectWorld(w);
    col.appendChild(card);
  });

  function selectWorld(w){
    const area = document.getElementById('createArea');
    const src = resolveWorldImg(w.img);
    const loreLong = w?.detail?.lore_long
      ? `<div style="color:var(--dim); text-align:left; max-width:720px; font-size:13px; white-space:pre-line;">${w.detail.lore_long}</div>`
      : '';

    area.innerHTML = `
      <div class="card p16" id="selWorld">
        <div style="display:flex; flex-direction:column; align-items:center; gap:12px;">
          ${src ? `<img id="selWorldImg" src="${src}" alt="${w.name}" style="width:min(380px, 100%); aspect-ratio:1/1; object-fit:cover; border-radius:14px; display:block;">` : phImg(380)}
          <div style="font-weight:900;font-size:18px">${w.name}</div>
          <div style="color:var(--dim); text-align:center; max-width:720px;">${w.intro||''}</div>
          <div style="color:var(--dim); text-align:left; max-width:720px; font-size:13px;">${(w.detail && w.detail.lore) ? w.detail.lore : ''}</div>
          ${loreLong}
          <div class="text-dim" style="font-size:12px">이 카드를 다시 클릭하면 세계관 정보 탭으로 이동(더미)</div>
        </div>

        <hr style="margin:14px 0; border:none; border-top:1px solid rgba(255,255,255,.06)">

        <form id="charForm" style="display:flex; flex-direction:column; gap:10px;">
          <label>이름 (≤20자)</label>
          <input id="charName" class="input" placeholder="이름" maxlength="20" />
          <label>설명 (≤1000자)</label>
          <textarea id="charDesc" class="input" rows="8" maxlength="1000" required placeholder="캐릭터 소개/설정 (최대 1000자)"></textarea>

          <div id="descCount" class="text-dim" style="font-size:12px;text-align:right">0 / 1000</div>

          <div style="display:flex; gap:8px; align-items:center;">
            <button id="btnCreate" class="btn primary">생성</button>
            <div id="createHint" style="color:var(--dim); font-size:13px;">AI 호출은 서버에서 처리돼. 생성 시작 시 쿨타임이 걸려.</div>
          </div>
        </form>
      </div>
    `;

    area.querySelector('#selWorld').onclick = (e)=>{
      const isInsideForm = e.target.closest?.('#charForm');
      if(isInsideForm) return;
      location.hash = `#/world/${w.id || w.name || 'default'}`;
    };

    // 1000자 카운터
    const descEl = document.getElementById('charDesc');
    const cntEl  = document.getElementById('descCount');
    function updateDescCnt(){
      const v = descEl.value || '';
      if(v.length > 1000) descEl.value = v.slice(0,1000);
      if(cntEl) cntEl.textContent = `${descEl.value.length} / 1000`;
    }
    descEl.addEventListener('input', updateDescCnt);
    updateDescCnt();

    document.getElementById('charForm').onsubmit = async (ev)=>{
      ev.preventDefault();

      const countNow = await getMyCharCount();
      if(countNow >= MAX_CHAR_COUNT){ showToast(`캐릭터는 최대 ${MAX_CHAR_COUNT}개야`); return; }

      const remain = leftCooldown();

      if(remain>0){ showToast(`잠시만! ${remain}초 후에 다시 시도해줘`); return; }

      const name = document.getElementById('charName').value.trim();
      const descEl = document.getElementById('charDesc');
      const desc = descEl.value.trim();

      if(!name){ showToast('이름을 입력해줘'); return; }
      if(name.length > 20){ showToast('이름은 20자 이하'); return; }
      if(!desc){ showToast('설정을 입력해줘'); descEl.focus(); return; }
      if(desc.length > 1000){ showToast('설명은 1000자 이하'); return; }


      startCooldown();

      const btn = document.getElementById('btnCreate');
      btn.disabled = true;
      btn.textContent = '서버에서 생성 중...';

      try{
        const userInput = `이름: ${name}\n설정:\n${desc}`;
        
        // 서버 함수에 필요한 모든 정보를 payload로 전달합니다.
        const payload = {
            world: {
                id: w.id,
                name: w.name,
                summary: w.summary || w.intro || '',
                detail: (w.detail && (w.detail.lore_long || w.detail.lore)) || '',
                rawJson: w
            },
            userInput,
            name,
            desc
        };

        const res = await createCharSecure(payload);
        
        showToast('캐릭터 생성 완료!');
        location.hash = `#/char/${res.id}`;
      }catch(e){
        console.error('[create] error', e);
        showToast('생성에 실패했어: ' + (e?.message || e?.code || 'unknown'));
        // 실패 시 쿨타임 초기화 (선택적)
        localStorage.removeItem(LS_KEY_CREATE_LAST_AT);
      }finally{
        btn.disabled = false;
        btn.textContent = '생성';
      }
    };

    setTimeout(()=> document.getElementById('charName')?.focus(), 50);
  }
}
