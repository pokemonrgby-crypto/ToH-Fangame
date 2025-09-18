// /public/js/tabs/manage.js
// 관리자 도구: [메일 발송] / [검색] 탭 UI
// - 공지/경고/일반(뽑기권)
// - 일반: 가중치 기반 등급 추첨(서버), 만료시각(datetime-local)
// - 검색: 캐릭 ID/이름, 유저 → 자산 조회

import { func } from '../api/firebase.js';
import { ensureAdmin, isAdminCached } from '../api/admin.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-functions.js';

function esc(s){return String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}

function stylesOnce(){
  if (document.getElementById('manage-style')) return;
  const css = `
  .btn{height:32px;padding:0 12px;cursor:pointer;border:1px solid #D1D5DB;border-radius:8px;background:#fff}
  .btn:hover{background:#F3F4F6}
  .tabs{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}
  .tab{height:32px;padding:0 12px;border:1px solid #D1D5DB;border-radius:999px;background:#fff;cursor:pointer}
  .tab.active{background:#111827;color:#fff;border-color:#111827}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .input, textarea{border:1px solid #D1D5DB;border-radius:8px;padding:8px}
  .kv-card{border:1px solid #E5E7EB;border-radius:12px;padding:12px;background:#fff}
  .mt12{margin-top:12px}
  .hint{font-size:12px;color:#6B7280}
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
      <h3>관리 도구</h3>
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
  <h4>우편 발송</h4>
  <div class="col" style="gap:10px">

    <div class="grid2">
      <input id="mail-target" class="input" placeholder="대상 UID (전체: all)">
      <select id="mail-kind" class="input">
        <option value="notice">공지</option>
        <option value="warning">경고</option>
        <option value="general">일반(뽑기권/만료)</option>
      </select>
    </div>

    <input id="mail-title" class="input" placeholder="제목 (최대 100자)" maxlength="100">
    <textarea id="mail-body" rows="5" class="input" placeholder="내용 (최대 1500자)" maxlength="1500"></textarea>

    <div class="grid2">
      <div class="kv-card">
        <div style="font-weight:700;margin-bottom:6px">만료 시각</div>
        <input id="mail-expire-dt" class="input" type="datetime-local">
        <div class="hint">일반(뽑기권)일 때만 사용. 비워두면 만료 없음.</div>
      </div>

      <details class="kv-card">
        <summary style="font-weight:700">뽑기권(일반 메일용)</summary>
        <div class="grid2" style="margin-top:8px">
          <label>normal 가중치 <input id="w-normal" type="number" class="input" value="2" min="0"></label>
          <label>rare 가중치 <input id="w-rare" type="number" class="input" value="1" min="0"></label>
          <label>epic 가중치 <input id="w-epic" type="number" class="input" value="0" min="0"></label>
          <label>legend 가중치 <input id="w-legend" type="number" class="input" value="0" min="0"></label>
          <label>myth 가중치 <input id="w-myth" type="number" class="input" value="0" min="0"></label>
          <label>aether 가중치 <input id="w-aether" type="number" class="input" value="0" min="0"></label>
        </div>
        <div class="hint" style="margin-top:6px">정수 가중치의 합으로 확률을 계산(예: normal=2, rare=1 ⇒ 2/3, 1/3)</div>
        <div class="hint">AI 프롬프트 템플릿: Firestore <code>configs/prompts.gacha_item_system</code></div>
      </details>
    </div>

    <button id="btn-send-mail" class="btn">발송</button>
    <div id="mail-send-status" class="hint"></div>
  </div>
  `;
}

function searchTpl(){
  return `
  <h4>검색(관리자)</h4>
  <div class="col" style="gap:10px">
    <div class="grid2">
      <div>
        <div class="hint">캐릭터 ID</div>
        <div style="display:flex;gap:8px">
          <input id="q-char-id" class="input" placeholder="chars/{id} 또는 {id}">
          <button id="btn-q-char-id" class="btn">캐릭 ID 조회</button>
        </div>
      </div>
      <div>
        <div class="hint">캐릭터 이름(정확 일치)</div>
        <div style="display:flex;gap:8px">
          <input id="q-char-name" class="input" placeholder="이름">
          <button id="btn-q-char-name" class="btn">캐릭 이름 검색</button>
        </div>
      </div>
    </div>

    <div>
      <div class="hint">유저 검색 (uid / 이메일 / 닉네임)</div>
      <div style="display:flex;gap:8px">
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

    if (!target || !title || !body){ alert('대상/제목/내용을 채워줘'); return; }

    let payload = { target, title, body, kind };

    if (kind === 'general'){
      // 만료 시각
      const dt = root.querySelector('#mail-expire-dt').value; // "YYYY-MM-DDTHH:mm" 또는 ""
      let expiresAt = null;
      if (dt){
        const ms = new Date(dt).getTime();
        if (Number.isFinite(ms)) expiresAt = ms;
      }

      // 가중치
      const weights = {
        normal: Number(root.querySelector('#w-normal').value || 0) | 0,
        rare: Number(root.querySelector('#w-rare').value || 0) | 0,
        epic: Number(root.querySelector('#w-epic').value || 0) | 0,
        legend: Number(root.querySelector('#w-legend').value || 0) | 0,
        myth: Number(root.querySelector('#w-myth').value || 0) | 0,
        aether: Number(root.querySelector('#w-aether').value || 0) | 0,
      };

      payload.attachments = { ticket: { weights } };
      if (expiresAt) payload.expiresAt = expiresAt;
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
