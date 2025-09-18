// /public/js/tabs/manage.js
// 관리자 도구: [메일 발송] / [검색] 탭 UI
// - 공지/경고/일반 메일 발송
//   · 일반: 만료 시각(datetime-local), 코인 지급, [선택] 아이템 JSON, 뽑기권(가중치)
// - 검색: 캐릭 ID/이름, 유저 → 자산 조회
// 가시성 강화: 다크 테마여도 입력/카드/버튼은 밝고 선명하게 보이도록 CSS 주입

import { func } from '../api/firebase.js';
import { ensureAdmin, isAdminCached } from '../api/admin.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-functions.js';

function esc(s){return String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}

function stylesOnce(){
  if (document.getElementById('manage-style')) return;
  const css = `
:root{
  --c-bg:#FFFFFF;
  --c-fg:#111827;
  --c-muted:#6B7280;
  --c-border:#9CA3AF;
  --c-border-soft:#E5E7EB;
  --c-accent:#111827;
}

@media (prefers-color-scheme: dark){
  :root{
    --c-bg:#FFFFFF; /* 카드/입력은 항상 밝게 */
    --c-fg:#0B1220;
    --c-muted:#4B5563;
    --c-border:#9CA3AF;
    --c-border-soft:#E5E7EB;
    --c-accent:#111827;
  }
}

/* 레이아웃 */
.container.narrow{max-width:920px;margin:0 auto}
.tabs{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.kv-card{background:var(--c-bg) !important;border:1px solid var(--c-border-soft) !important;border-radius:12px !important;padding:12px !important;box-shadow:0 2px 8px rgba(0,0,0,.06)}

/* 입력/선택 */
.input, textarea, select{
  background:#FFFFFF !important;
  color:var(--c-fg) !important;
  border:1px solid var(--c-border) !important;
  border-radius:10px !important;
  padding:10px !important;
  font-size:14px !important;
}
textarea{min-height:120px;resize:vertical}
.input::placeholder, textarea::placeholder{ color:var(--c-muted) !important; }
.input:focus, textarea:focus, select:focus{
  outline:none !important;
  border-color:var(--c-accent) !important;
  box-shadow:0 0 0 3px rgba(17,24,39,.15) !important;
}

/* 버튼 */
.btn{
  height:38px; padding:0 14px; cursor:pointer;
  border:1px solid var(--c-border) !important;
  border-radius:10px !important;
  background:#FFFFFF !important; color:var(--c-fg) !important;
}
.btn:hover{ background:#F3F4F6 !important; }
.btn.primary{
  background:var(--c-accent) !important; color:#FFFFFF !important;
  border-color:var(--c-accent) !important;
}
.btn.primary:hover{ filter:brightness(1.05) }

/* 탭 */
.tab{
  height:34px; padding:0 12px; cursor:pointer;
  border:1px solid var(--c-border) !important;
  border-radius:999px !important; background:#FFFFFF !important; color:var(--c-fg) !important;
}
.tab.active{ background:var(--c-accent) !important; color:#FFFFFF !important; border-color:var(--c-accent) !important; }

/* 보조 텍스트 */
.mt8{margin-top:8px}
.mt12{margin-top:12px}
.hint{ font-size:12px; color:var(--c-muted) !important; }

/* 라벨-인풋 수평 정렬 */
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.label{font-size:12px;color:var(--c-muted);min-width:110px}
.small{font-size:12px}
`;
  const el = document.createElement('style');
  el.id = 'manage-style';
  el.textContent = css;
  document.head.appendChild(el);
}

function mainTpl(){
  return `
  <section class="container narrow" style="padding:12px">
    <div class="kv-card">
      <h3 style="margin:0 0 6px 0">관리 도구</h3>
      <div class="hint">관리자만 접근 가능</div>
      <div class="tabs">
        <button class="tab active" data-tab="send">메일 발송</button>
        <button class="tab" data-tab="search">검색</button>
      </div>
    </div>

    <div id="tab-send" class="kv-card mt12">
      ${sendTpl()}
    </div>

    <div id="tab-search" class="kv-card mt12" style="display:none">
      ${searchTpl()}
    </div>
  </section>
  `;
}

function sendTpl(){
  return `
  <h4 style="margin-top:0">우편 발송</h4>
  <div class="col" style="gap:10px">

    <!-- 대상/종류 -->
    <div class="grid2">
      <div class="row" style="gap:8px">
        <span class="label">대상</span>
        <input id="mail-target" class="input" placeholder="UID 입력 (전체: all)">
      </div>
      <div class="row" style="gap:8px">
        <span class="label">종류</span>
        <select id="mail-kind" class="input">
          <option value="notice">공지</option>
          <option value="warning">경고</option>
          <option value="general">일반(보상/만료)</option>
        </select>
      </div>
    </div>

    <!-- 제목/내용 -->
    <input id="mail-title" class="input" placeholder="제목 (최대 100자)" maxlength="100">
    <textarea id="mail-body" rows="5" class="input" placeholder="내용 (최대 1500자)" maxlength="1500"></textarea>

    <!-- 옵션: 만료/보상 -->
    <div class="grid2">
      <div class="kv-card">
        <div style="font-weight:700">만료 시각</div>
        <div class="row mt8">
          <input id="mail-expire-dt" class="input" type="datetime-local" style="width:260px">
          <span class="hint">일반 메일일 때만 적용. 비우면 만료 없음.</span>
        </div>
      </div>

      <div class="kv-card">
        <div style="font-weight:700">보상 (일반 메일용)</div>

        <div class="row mt8">
          <span class="label">코인</span>
          <input id="mail-coins" class="input" type="number" min="0" value="0" style="width:160px">
          <span class="hint">숫자만, 0이면 미지급</span>
        </div>

        <details class="mt8">
          <summary class="small">아이템 JSON (선택)</summary>
          <textarea id="mail-items" class="input" rows="3" placeholder='예시:
[{"name":"포션","rarity":"normal","consumable":true,"count":2}]'></textarea>
          <div class="hint">형식 오류면 발송이 취소돼.</div>
        </details>

        <details class="mt8">
          <summary class="small">뽑기권(가중치) — 선택</summary>
          <div class="grid2 mt8">
            <label>normal <input id="w-normal" type="number" class="input" value="0" min="0"></label>
            <label>rare <input id="w-rare" type="number" class="input" value="0" min="0"></label>
            <label>epic <input id="w-epic" type="number" class="input" value="0" min="0"></label>
            <label>legend <input id="w-legend" type="number" class="input" value="0" min="0"></label>
            <label>myth <input id="w-myth" type="number" class="input" value="0" min="0"></label>
            <label>aether <input id="w-aether" type="number" class="input" value="0" min="0"></label>
          </div>
          <div class="hint mt8">정수 가중치의 합으로 확률 계산(예: normal=2, rare=1 ⇒ 2/3, 1/3). 모두 0이면 뽑기권 미포함.</div>
          <div class="hint">AI 프롬프트 템플릿: Firestore <code>configs/prompts.gacha_item_system</code></div>
        </details>
      </div>
    </div>

    <button id="btn-send-mail" class="btn primary">발송</button>
    <div id="mail-send-status" class="hint"></div>
  </div>
  `;
}

function searchTpl(){
  return `
  <h4 style="margin-top:0">검색(관리자)</h4>
  <div class="col" style="gap:10px">
    <div class="grid2">
      <div>
        <div class="hint">캐릭터 ID</div>
        <div class="row" style="gap:8px">
          <input id="q-char-id" class="input" placeholder="chars/{id} 또는 {id}">
          <button id="btn-q-char-id" class="btn">캐릭 ID 조회</button>
        </div>
      </div>
      <div>
        <div class="hint">캐릭터 이름(정확 일치)</div>
        <div class="row" style="gap:8px">
          <input id="q-char-name" class="input" placeholder="이름">
          <button id="btn-q-char-name" class="btn">캐릭 이름 검색</button>
        </div>
      </div>
    </div>

    <div>
      <div class="hint">유저 검색 (uid / 이메일 / 닉네임)</div>
      <div class="row" style="gap:8px">
        <input id="q-user" class="input" placeholder="검색어">
        <button id="btn-q-user" class="btn">유저 검색</button>
      </div>
    </div>

    <div id="search-result" class="kv-card" style="min-height:40px"></div>
  </div>
  `;
}

export async function showManage(){
  stylesOnce();
  const root = document.getElementById('view');

  if (!isAdminCached()){
    try { await ensureAdmin(); } catch {}
  }
  if (!isAdminCached()){
    root.innerHTML = `<section class="container narrow"><div class="kv-card">관리자만 접근할 수 있습니다.</div></section>`;
    return;
  }

  root.innerHTML = mainTpl();

  // 탭 전환
  const tabsWrap = root.querySelector('.tabs');
  tabsWrap.addEventListener('click', (e)=>{
    const t = e.target;
    if (!(t instanceof HTMLElement) || !t.classList.contains('tab')) return;
    tabsWrap.querySelectorAll('.tab').forEach(b=>b.classList.remove('active'));
    t.classList.add('active');
    const which = t.dataset.tab;
    root.querySelector('#tab-send').style.display   = (which==='send') ? '' : 'none';
    root.querySelector('#tab-search').style.display = (which==='search') ? '' : 'none';
  });

  // =====================[ 발송 ]=====================
  const $sendBtn = root.querySelector('#btn-send-mail');
  const $status  = root.querySelector('#mail-send-status');

  $sendBtn.addEventListener('click', async ()=>{
    const target = root.querySelector('#mail-target').value.trim();
    const title  = root.querySelector('#mail-title').value.trim();
    const body   = root.querySelector('#mail-body').value.trim();
    const kind   = root.querySelector('#mail-kind').value;

    if (!target || !title || !body){
      alert('대상/제목/내용을 채워줘'); return;
    }

    const payload = { target, title, body, kind };

    if (kind === 'general'){
      // 만료 시각
      const dt = root.querySelector('#mail-expire-dt').value; // "YYYY-MM-DDTHH:mm" 또는 ""
      if (dt){
        const ms = new Date(dt).getTime();
        if (Number.isFinite(ms)) payload.expiresAt = ms;
      }

      // 코인
      const coins = Math.max(0, Number(root.querySelector('#mail-coins').value || 0) | 0);
      // 아이템 JSON(선택)
      let items = [];
      const rawItems = (root.querySelector('#mail-items').value || '').trim();
      if (rawItems){
        try{
          const parsed = JSON.parse(rawItems);
          if (!Array.isArray(parsed)) throw new Error('items는 배열이어야 해');
          items = parsed;
        }catch(e){
          alert('아이템 JSON 형식이 잘못됐어. 예시를 참고해서 배열로 넣어줘.\n' + (e?.message || e));
          return;
        }
      }

      // 뽑기권 가중치 (모두 0이면 포함하지 않음)
      const weights = {
        normal: Number(root.querySelector('#w-normal').value || 0) | 0,
        rare:   Number(root.querySelector('#w-rare').value || 0) | 0,
        epic:   Number(root.querySelector('#w-epic').value || 0) | 0,
        legend: Number(root.querySelector('#w-legend').value || 0) | 0,
        myth:   Number(root.querySelector('#w-myth').value || 0) | 0,
        aether: Number(root.querySelector('#w-aether').value || 0) | 0,
      };
      const weightSum = Object.values(weights).reduce((s,v)=>s+(Number(v)||0),0);

      // attachments 조립
      payload.attachments = {};
      if (coins > 0) payload.attachments.coins = coins;
      if (items.length) payload.attachments.items = items;
      if (weightSum > 0) payload.attachments.ticket = { weights };
    }

    try {
      $sendBtn.disabled = true;
      $status.textContent = '발송 중…';
      const sendMail = httpsCallable(func, 'sendMail');
      const r = await sendMail(payload);
      $status.textContent = `발송 완료: ${r?.data?.sentCount ?? 0}건`;
      alert('발송했어!');
    } catch (e) {
      console.warn('[manage] sendMail fail', e);
      $status.textContent = '발송 실패';
      alert('발송 실패: ' + (e?.message || e));
    } finally {
      $sendBtn.disabled = false;
    }
  });

  // =====================[ 검색 ]=====================
  const call = (name)=> httpsCallable(func, name);
  const $res = root.querySelector('#search-result');

  root.querySelector('#btn-q-char-id').addEventListener('click', async ()=>{
    const id = root.querySelector('#q-char-id').value.trim();
    if(!id) return $res.textContent = 'ID를 입력해줘';
    try {
      const r = await call('adminGetCharById')({ id });
      if(!r.data?.ok || !r.data?.found) return $res.textContent = '결과 없음';
      $res.innerHTML = `<pre>${esc(JSON.stringify(r.data, null, 2))}</pre>`;
    } catch(e){ $res.textContent = '오류: ' + (e?.message||e); }
  });

  root.querySelector('#btn-q-char-name').addEventListener('click', async ()=>{
    const name = root.querySelector('#q-char-name').value.trim();
    if(!name) return $res.textContent = '이름을 입력해줘';
    try {
      const r = await call('adminSearchCharsByName')({ name, limit:20 });
      $res.innerHTML = `<pre>${esc(JSON.stringify(r.data, null, 2))}</pre>`;
    } catch(e){ $res.textContent = '오류: ' + (e?.message||e); }
  });

  root.querySelector('#btn-q-user').addEventListener('click', async ()=>{
    const q = root.querySelector('#q-user').value.trim();
    if(!q) return $res.textContent = '검색어를 입력해줘';
    try {
      const r1 = await call('adminFindUser')({ q });
      if(!r1.data?.ok || !r1.data?.users?.length) return $res.textContent = '유저 없음';
      const u = r1.data.users[0];
      const r2 = await call('adminListAssets')({ uid: u.uid });
      $res.innerHTML = `<div style="font-weight:700">유저</div><pre>${esc(JSON.stringify(u, null, 2))}</pre>
      <div style="font-weight:700;margin-top:8px">캐릭터</div><pre>${esc(JSON.stringify(r2.data?.chars||[], null, 2))}</pre>
      <div style="font-weight:700;margin-top:8px">아이템</div><pre>${esc(JSON.stringify(r2.data?.items||[], null, 2))}</pre>`;
    } catch(e){ $res.textContent = '오류: ' + (e?.message||e); }
  });
}

// 호환 별칭
export const showAdmin = showManage;
export default showManage;
