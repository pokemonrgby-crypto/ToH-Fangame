// /public/js/tabs/mail.js
// 기능:
// - 우편함: 목록 보기(가독성 테마), 읽음 처리, 일반메일 보상 수령
// - 탭 필터: 전체/공지/우편/경고/기타
// - 페이지네이션: 30개씩 로드, 더 불러오기
// - 전체 읽음(현재 필터에서 화면에 로드된 항목 대상으로)
// - 보상 수령 시 "프롬프트 입력 모달" 표시(필수), 300자 제한
// 비용 최적화: 실시간 onSnapshot 대신 필요할 때만 getDocs + 페이지네이션

import { auth, db, fx, func } from '../api/firebase.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-functions.js';
import { startAfter, getDocs } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, m => (
    {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]
  ));
}

/* === UI 색 테마 (가독성 강화) ===
   전체보기: 유형별 색 적용
   - notice(공지): 연노랑 배경  #FFFBE6 / 테두리 #FDE68A / 본문 텍스트 #111827
   - warning(경고): 연빨강 배경 #FEE2E2 / 테두리 #FECACA / 본문 텍스트 #111827
   - general(우편): 흰색 배경   #FFFFFF / 테두리 #E5E7EB / 본문 텍스트 #111827
   - etc(기타):    연회색 배경 #F8FAFC / 테두리 #E5E7EB / 본문 텍스트 #111827
*/
const KIND = {
  NOTICE : 'notice',
  WARNING: 'warning',
  GENERAL: 'general',
};
const THEMES = {
  [KIND.NOTICE]: { bg:'#FFFBE6', border:'#FDE68A', title:'#111827', text:'#111827', chip:'#B45309' },
  [KIND.WARNING]:{ bg:'#FEE2E2', border:'#FECACA', title:'#111827', text:'#111827', chip:'#B91C1C' },
  [KIND.GENERAL]:{ bg:'#FFFFFF', border:'#E5E7EB', title:'#111827', text:'#111827', chip:'#374151' },
  etc:             { bg:'#F8FAFC', border:'#E5E7EB', title:'#111827', text:'#111827', chip:'#374151' },
  readDim:         { bg:'#FFFFFF', border:'#E5E7EB' } // 읽음 처리 시 살짝 디밍
};

// 탭 정의
const TABS = [
  { id:'all',     label:'전체',   filter: (m)=>true },
  { id:KIND.NOTICE,  label:'공지',   filter: (m)=> (m.kind === KIND.NOTICE) },
  { id:KIND.GENERAL, label:'우편',   filter: (m)=> (m.kind === KIND.GENERAL) },
  { id:KIND.WARNING, label:'경고',   filter: (m)=> (m.kind === KIND.WARNING) },
  { id:'etc',     label:'기타',   filter: (m)=> ![KIND.NOTICE,KIND.GENERAL,KIND.WARNING].includes(m.kind) },
];

const PAGE_SIZE = 30;
const PROMPT_MAX = 300;

function tpl() {
  // 탭 버튼들
  const tabs = TABS.map(t=>`<button class="tab" data-tab="${t.id}">${t.label}</button>`).join('');
  return `
  <section style="padding:12px">
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <div style="font-weight:800;font-size:18px">우편함</div>
      <div id="who" style="font-size:12px;color:#6b7280"></div>

      <div style="margin-left:auto; display:flex; gap:6px; flex-wrap:wrap">
        <button id="btn-refresh" class="btn">새로고침</button>
        <button id="btn-mark-all" class="btn">전체 읽음</button>
      </div>
    </div>

    <div id="mail-tabs" style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap">${tabs}</div>
  </section>

  <section id="mail-list" style="padding:8px 12px 8px;display:grid;gap:10px"></section>

  <section style="padding:0 12px 80px">
    <div style="display:flex;justify-content:center">
      <button id="btn-more" class="btn">더 불러오기</button>
    </div>
    <div id="hint" style="text-align:center;color:#6b7280;font-size:12px;margin-top:6px"></div>
  </section>
  `;
}

function themeByKind(kind, read){
  const base = kind===KIND.NOTICE ? THEMES[KIND.NOTICE]
             : kind===KIND.WARNING? THEMES[KIND.WARNING]
             : kind===KIND.GENERAL? THEMES[KIND.GENERAL]
             : THEMES.etc;
  if (read) return { ...base, bg:THEMES.readDim.bg, border:THEMES.readDim.border };
  return base;
}

// 카드 템플릿
function cardHtml(doc) {
  const sentAt = (typeof doc.sentAt?.toDate === 'function'
    ? doc.sentAt.toDate().toLocaleString()
    : '') || '';
  const read    = !!doc.read;
  const kind    = (doc.kind || '').toLowerCase();
  const theme   = themeByKind(kind, read);

  const expiresAtMs = (doc.expiresAt && doc.expiresAt.toDate)
    ? doc.expiresAt.toDate().getTime()
    : null;
  const expired = !!(expiresAtMs && expiresAtMs < Date.now());
  const claimed = !!doc.claimed;

  const hasAttach =
    !!(doc.attachments &&
      (((doc.attachments.coins|0) > 0) ||
       (Array.isArray(doc.attachments.items) && doc.attachments.items.length) ||
       !!doc.attachments.ticket));

  const attachHtml = hasAttach ? (`
    <div style="margin-top:10px;padding:10px;border-radius:10px;background:#F9FAFB;border:1px solid #E5E7EB;color:${theme.text}">
      <div style="font-weight:700;margin-bottom:6px">첨부</div>
      ${ doc.attachments?.ticket ? `<div>뽑기권: 가중치 지정됨</div>` : '' }
      ${ (doc.attachments?.coins|0) > 0 ? `<div>코인: +${doc.attachments.coins|0}</div>` : '' }
      ${ Array.isArray(doc.attachments?.items) && doc.attachments.items.length ? `
        <div style="margin-top:4px">
          아이템:
          <ul style="margin:6px 0 0 16px">
            ${doc.attachments.items.map(it =>
              `<li>${esc(it.name||'아이템')} x${it.count||1} (${esc(it.rarity||'common')}${it.consumable?'·소모':''})</li>`
            ).join('')}
          </ul>
        </div>` : '' }
      ${ expiresAtMs ? `<div style="margin-top:6px;color:${expired?'#B91C1C':'#6B7280'};font-size:12px">
          유효기간: ${new Date(expiresAtMs).toLocaleString()} ${expired?'(만료됨)':''}
        </div>` : '' }
    </div>
  `) : '';

  const canClaim = (kind===KIND.GENERAL) && hasAttach && !expired && !claimed;

  const chip = kind ? `<span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;background:${theme.border};color:white">${kind}</span>` : '';

  return `
  <article class="mail-card"
    data-id="${esc(doc.__id)}"
    data-kind="${esc(kind||'')}"
    data-read="${read?'1':'0'}"
    style="border:1px solid ${theme.border};border-radius:12px;padding:14px;background:${theme.bg};color:${theme.text}">
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      ${chip}
      <div style="font-weight:800;color:${theme.title};">${esc(doc.title || '(제목 없음)')}</div>
      <div style="font-size:12px;color:#4B5563">· ${sentAt}</div>
      ${read ? `<span style="margin-left:auto;font-size:12px;color:#6B7280">읽음</span>` : ''}
    </div>
    <div style="margin-top:10px;white-space:pre-wrap;line-height:1.7;color:${theme.text}">${esc(doc.body || '')}</div>
    ${attachHtml}
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">
      ${canClaim ? `<button data-act="claim" data-id="${esc(doc.__id)}" class="btn">보상 받기</button>` : ''}
      ${read ? '' : `<button data-act="read" data-id="${esc(doc.__id)}" class="btn">읽음 처리</button>`}
      ${(!canClaim && claimed) ? `<span style="font-size:12px;color:#10B981">수령 완료</span>` : ''}
      ${(!canClaim && expired && hasAttach && !claimed) ? `<span style="font-size:12px;color:#B91C1C">만료됨</span>` : ''}
    </div>
  </article>`;
}

// 간단 버튼/모달 스타일
const baseCss = `
.btn{
  height:32px; padding:0 12px; cursor:pointer; border:1px solid #D1D5DB;
  border-radius:8px; background:#FFFFFF; color:#111827;
}
.btn:hover{ background:#F3F4F6; }
.tab{
  height:30px; padding:0 10px; cursor:pointer; border:1px solid #D1D5DB;
  border-radius:999px; background:#FFFFFF; color:#111827;
}
.tab.active{ background:#111827; color:#FFFFFF; border-color:#111827 }
.mail-modal-backdrop{
  position:fixed; inset:0; background:rgba(0,0,0,.35); display:flex; align-items:center; justify-content:center; z-index:9999;
}
.mail-modal{
  width:min(560px, 92vw); background:#fff; border:1px solid #E5E7EB; border-radius:14px; padding:16px;
  box-shadow:0 10px 30px rgba(0,0,0,.15);
}
.mail-modal textarea{
  width:100%; min-height:120px; border:1px solid #D1D5DB; border-radius:8px; padding:8px; resize:vertical;
}
.mail-modal .row{ display:flex; gap:8px; justify-content:flex-end; align-items:center; flex-wrap:wrap; }
.mail-modal .hint{ font-size:12px; color:#6B7280; }
.mail-modal .count{ font-size:12px; color:#6B7280; margin-right:auto; }
.mail-modal .danger{ color:#B91C1C; }
`;

function mountStyleOnce(){
  if (document.getElementById('mail-style')) return;
  const style = document.createElement('style');
  style.id = 'mail-style';
  style.textContent = baseCss;
  document.head.appendChild(style);
}

// === 프롬프트 입력 모달 ===
// 반환: Promise<string|null>  (확인 시 프롬프트 문자열, 뒤로가기/닫기 시 null)
function promptModal({ title='보상 수령', maxLen=PROMPT_MAX }={}){
  return new Promise((resolve)=>{
    const $backdrop = document.createElement('div');
    $backdrop.className = 'mail-modal-backdrop';

    const $modal = document.createElement('div');
    $modal.className = 'mail-modal';
    $modal.innerHTML = `
      <div style="font-weight:800; font-size:16px">${esc(title)}</div>
      <div class="hint" style="margin-top:4px">수령 전에 프롬프트를 작성해줘. (최대 ${maxLen}자)</div>
      <div style="margin-top:10px">
        <textarea id="pm-text" maxlength="${maxLen}" placeholder="예) 고풍스러운 느낌의 장신구, 밤하늘/별/바람 키워드 센스 있게, 사용 시 빛나는 이펙트..."></textarea>
      </div>
      <div class="row" style="margin-top:8px">
        <div class="count"><span id="pm-count">0</span> / ${maxLen}</div>
        <button id="pm-cancel" class="btn">뒤로가기</button>
        <button id="pm-ok" class="btn">확인</button>
      </div>
      <div id="pm-warn" class="hint danger" style="display:none;margin-top:6px"></div>
    `;

    $backdrop.appendChild($modal);
    document.body.appendChild($backdrop);

    const $ta = $modal.querySelector('#pm-text');
    const $ok = $modal.querySelector('#pm-ok');
    const $cancel = $modal.querySelector('#pm-cancel');
    const $count = $modal.querySelector('#pm-count');
    const $warn = $modal.querySelector('#pm-warn');

    function updateCount(){
      const len = $ta.value.length;
      $count.textContent = String(len);
      const bad = (len === 0 || len > maxLen);
      $ok.disabled = bad;
      $warn.style.display = bad ? '' : 'none';
      if (len === 0) $warn.textContent = '프롬프트를 입력해줘.';
      else if (len > maxLen) $warn.textContent = `최대 ${maxLen}자까지 입력 가능해.`;
    }

    $ta.addEventListener('input', updateCount);
    $ta.addEventListener('keydown', (e)=>{
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault(); $ok.click();
      }
      if (e.key === 'Escape') { e.preventDefault(); $cancel.click(); }
    });

    $cancel.addEventListener('click', ()=>{
      cleanup(); resolve(null);
    });

    $ok.addEventListener('click', ()=>{
      const v = ($ta.value || '').trim();
      if (!v || v.length > maxLen) { updateCount(); return; }
      cleanup(); resolve(v);
    });

    function cleanup(){
      try { document.body.removeChild($backdrop); } catch {}
    }

    // 포커스
    setTimeout(()=>{ $ta.focus(); updateCount(); }, 0);
  });
}

// 상태 저장
const State = {
  tab: 'all',            // 현재 탭
  lastDoc: null,         // 페이지네이션 시작점
  exhausted: false,      // 더 없음
  cache: [],             // 현재 탭에 로드된 메시지
  loading: false,
  uid: null,
};

// Firestore에서 페이지 단위로 가져오기
async function fetchPage(uid, startDoc, pageSize) {
  const col = fx.collection(db, 'mail', uid, 'msgs');
  const base = [ fx.orderBy('sentAt','desc'), fx.limit(pageSize) ];
  const q = startDoc
    ? fx.query(col, ...[fx.orderBy('sentAt','desc'), startAfter(startDoc), fx.limit(pageSize)])
    : fx.query(col, ...base);
  const snap = await getDocs(q);
  return snap;
}

export default async function mountMailTab(viewEl) {
  mountStyleOnce();
  viewEl.innerHTML = tpl();

  const $list  = viewEl.querySelector('#mail-list');
  const $who   = viewEl.querySelector('#who');
  const $btnR  = viewEl.querySelector('#btn-refresh');
  const $btnM  = viewEl.querySelector('#btn-more');
  const $btnAll= viewEl.querySelector('#btn-mark-all');
  const $tabs  = viewEl.querySelector('#mail-tabs');
  const $hint  = viewEl.querySelector('#hint');

  const u = auth.currentUser;
  if (!u) {
    $who.textContent = '로그인 필요';
    $list.innerHTML = `<div style="color:#6b7280;font-size:14px;padding:24px;border:1px dashed #d1d5db;border-radius:12px;background:#fcfcfd">로그인이 필요해</div>`;
    $btnR.disabled = $btnM.disabled = $btnAll.disabled = true;
    return;
  }
  State.uid = u.uid;
  $who.textContent = `${u.displayName || u.email || u.uid}`;

  // 탭 렌더러
  function renderTabs(){
    $tabs.querySelectorAll('.tab').forEach(btn=>{
      btn.classList.toggle('active', btn.dataset.tab === State.tab);
    });
  }

  function renderList(){
    if (!State.cache.length) {
      $list.innerHTML = `<div style="color:#6b7280;font-size:14px;padding:24px;border:1px dashed #d1d5db;border-radius:12px;background:#fcfcfd">도착한 우편이 없어</div>`;
      $hint.textContent = State.exhausted ? '더 이상 우편이 없어' : '';
      return;
    }
    $list.innerHTML = State.cache.map(cardHtml).join('');
    $hint.textContent = State.exhausted ? '모든 우편을 다 불러왔어' : '';
  }

  // 현재 탭 기준 필터
  const currentFilter = (m)=> (TABS.find(t=>t.id===State.tab)?.filter ?? (()=>true))(m);

  // 초기화 + 첫 페이지
  async function reload(){
    State.lastDoc = null;
    State.exhausted = false;
    State.cache = [];
    renderList();
    await loadMore(true);
  }

  // 더 불러오기
  async function loadMore(firstPage=false){
    if (State.loading || State.exhausted) return;
    State.loading = true;
    $btnM.textContent = '불러오는 중…';
    try {
      let collected = [];
      let scanned = 0;
      let startDoc = State.lastDoc;

      // 원하는 수(30개) 채울 때까지 스캔을 몇 번(최대 5 페이지) 반복
      while (collected.length < PAGE_SIZE && scanned < 5 && !State.exhausted) {
        const snap = await fetchPage(State.uid, startDoc, PAGE_SIZE);
        scanned++;
        if (snap.empty) {
          State.exhausted = true;
          break;
        }
        startDoc = snap.docs[snap.docs.length - 1];
        const rows = snap.docs.map(d => ({ __id:d.id, ...d.data() }));
        const filtered = rows.filter(currentFilter);
        collected.push(...filtered);

        if (snap.docs.length < PAGE_SIZE) {
          State.exhausted = true;
          break;
        }
      }

      if (collected.length) {
        State.cache.push(...collected.slice(0, PAGE_SIZE));
      }
      State.lastDoc = startDoc;
      renderList();
    } catch (e) {
      console.warn('[mail] loadMore failed', e);
      $list.innerHTML = `<div style="color:#b91c1c;font-size:14px;padding:24px;border:1px solid #fecaca;background:#fff7f7;border-radius:12px">
        우편을 불러오지 못했어: ${esc(e?.message || e)}
      </div>`;
    } finally {
      State.loading = false;
      $btnM.textContent = '더 불러오기';
      if (State.exhausted) $btnM.disabled = true; else $btnM.disabled = false;
    }
  }

  // 이벤트들
  $tabs.addEventListener('click', async (ev)=>{
    const t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    const tab = t.dataset.tab;
    if (!tab || tab === State.tab) return;
    State.tab = tab;
    renderTabs();
    await reload();
  });

  $btnR.addEventListener('click', reload);
  $btnM.addEventListener('click', ()=>loadMore(false));

  // 전체 읽음(현재 화면에 로드된 목록만 대상으로 처리 — 비용 절감)
  $btnAll.addEventListener('click', async ()=>{
    const uid = State.uid;
    if (!uid) return;
    const targets = State.cache.filter(m => !m.read); // 현재 로드된 것 중 미읽음만
    if (!targets.length) { alert('읽을 우편이 없어'); return; }

    if (!confirm(`현재 표시된 우편 중 ${targets.length}건을 읽음 처리할까?`)) return;

    $btnAll.disabled = true;
    try {
      // 배치로 처리(작게 나눠서)
      const chunks = [];
      const SIZE = 20; // updateDoc 20개씩
      for (let i=0;i<targets.length;i+=SIZE) chunks.push(targets.slice(i,i+SIZE));
      for (const chunk of chunks) {
        const promises = chunk.map(m => {
          const ref = fx.doc(db, 'mail', uid, 'msgs', m.__id);
          return fx.updateDoc(ref, { read: true }).catch(()=>null);
        });
        await Promise.all(promises);
      }
      // 로컬 캐시 갱신
      State.cache = State.cache.map(m => ({ ...m, read:true }));
      renderList();
    } catch (e) {
      console.warn('[mail] mark all read failed', e);
      alert('전체 읽음 실패: ' + (e?.message || e));
    } finally {
      $btnAll.disabled = false;
    }
  });

  // 카드 내 버튼(읽음/클레임)
  $list.addEventListener('click', async (ev)=>{
    const t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    const act = t.dataset.act;
    const id  = t.dataset.id;
    if (!act || !id) return;

    if (act === 'claim') {
      // 1) 프롬프트 모달 열기 (최대 300자, 비어 있으면 확인 비활성화)
      const userPrompt = await promptModal({ title:'보상 수령', maxLen: PROMPT_MAX });
      if (userPrompt == null) return; // 뒤로가기

      // 2) 수령 호출
      t.disabled = true;
      try {
        const claimMail = httpsCallable(func, 'claimMail');
        await claimMail({ mailId: id, prompt: userPrompt });
        alert('보상을 수령했어!');
        // 로컬 반영: claimed 표시만 즉시 갱신 (서버 컬럼은 다음 로드 때 정확히 동기화)
        State.cache = State.cache.map(m => m.__id===id ? ({ ...m, claimed:true, read:true }) : m);
        renderList();
      } catch (e) {
        console.warn('[mail] claim failed', e);
        alert('수령 실패: ' + (e?.message || e));
        t.disabled = false;
      }
      return;
    }

    if (act === 'read') {
      t.disabled = true;
      try {
        const ref = fx.doc(db, 'mail', State.uid, 'msgs', id);
        await fx.updateDoc(ref, { read: true });
        // 로컬 캐시 갱신
        State.cache = State.cache.map(m => m.__id===id ? ({ ...m, read:true }) : m);
        renderList();
      } catch (e) {
        console.warn('[mail] mark read failed', e);
        alert('읽음 처리 실패: ' + (e?.message || e));
        t.disabled = false;
      }
      return;
    }
  });

  // 초기
  renderTabs();
  await reload();
}

// 라우터 호환용 별칭
export async function showMailbox() {
  const view = document.getElementById('view');
  return (await (typeof mountMailTab === 'function' ? mountMailTab(view) : null));
}
export const showMail = showMailbox;
export const showmail = showMailbox;
