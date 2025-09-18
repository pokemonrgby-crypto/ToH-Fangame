// /public/js/tabs/manage.js
// 기능: 관리자 전용 — 우편 발송(공지/경고/일반[보상/유효기간]), 관리자 검색(캐릭 ID/이름, 유저 → 자산 조회)

import { auth, func } from '../api/firebase.js';
import { ensureAdmin, isAdminCached } from '../api/admin.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-functions.js';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]
  ));
}

function tpl() {
  return `
  <section class="container narrow" style="padding:12px">
    <div class="kv-card">
      <h3>관리 도구</h3>
      <div style="font-size:12px;color:#6b7280">관리자만 접근 가능</div>
    </div>

    <div class="kv-card mt12">
      <h4>우편 발송</h4>
      <div class="col" style="gap:10px;">
        <input id="mail-target" class="input" placeholder="대상 UID (전체 발송은 all)">
        <select id="mail-kind" class="input" style="min-width:160px">
          <option value="notice">공지</option>
          <option value="warning">경고</option>
          <option value="general">일반(보상/유효기간)</option>
        </select>
        <input id="mail-expires" class="input" type="number" min="1" max="365" value="7" placeholder="유효기간(일) - 일반 전용" style="width:180px">
        <input id="mail-title" class="input" placeholder="제목 (최대 100자)" maxlength="100">
        <textarea id="mail-body" class="input" rows="5" placeholder="내용 (최대 1500자)" maxlength="1500"></textarea>

        <details class="kv-card" style="margin-top:8px">
          <summary>보상(일반 메일용)</summary>
          <div class="col" style="gap:8px">
            <input id="mail-coins" class="input" type="number" min="0" value="0" placeholder="코인 (+숫자)">
            <textarea id="mail-items" class="input" rows="3" placeholder='아이템 JSON 배열 예시:
[{"name":"포션","rarity":"normal","consumable":true,"count":2}]'></textarea>
          </div>
        </details>

        <button id="btn-send-mail" class="btn primary">발송</button>
        <div id="mail-send-status" style="font-size:12px;color:#6b7280"></div>
      </div>
    </div>

    <div class="kv-card mt12">
      <h4>검색(관리자)</h4>
      <div class="col" style="gap:10px;">
        <div class="row" style="gap:8px;flex-wrap:wrap">
          <input id="q-char-id" class="input" placeholder="캐릭터 ID">
          <button id="btn-q-char-id" class="btn">캐릭 ID 조회</button>
        </div>
        <div class="row" style="gap:8px;flex-wrap:wrap">
          <input id="q-char-name" class="input" placeholder="캐릭터 이름(정확 일치)">
          <button id="btn-q-char-name" class="btn">캐릭 이름 검색</button>
        </div>
        <div class="row" style="gap:8px;flex-wrap:wrap">
          <input id="q-user" class="input" placeholder="유저 검색 (uid / 이메일 / 닉네임)">
          <button id="btn-q-user" class="btn">유저 검색</button>
        </div>
        <div id="search-result" class="kv-card" style="min-height:40px"></div>
      </div>
    </div>
  </section>
  `;
}

export default async function showManage() {
  const root = document.getElementById('view');

  // 권한 확인 (캐시 → 실검증)
  if (!isAdminCached()) {
    try { await ensureAdmin(); } catch (_) {}
  }
  if (!isAdminCached()) {
    root.innerHTML = `<section class="container narrow"><div class="kv-card">관리자만 접근할 수 있습니다.</div></section>`;
    return;
  }

  root.innerHTML = tpl();

  // --- 우편 발송 ---
  const $sendBtn  = root.querySelector('#btn-send-mail');
  const $status   = root.querySelector('#mail-send-status');

  $sendBtn?.addEventListener('click', async ()=>{
    const target = root.querySelector('#mail-target').value.trim();
    const title  = root.querySelector('#mail-title').value.trim();
    const body   = root.querySelector('#mail-body').value.trim();
    const kind   = root.querySelector('#mail-kind')?.value || 'notice';
    const expiresDays = Number(root.querySelector('#mail-expires')?.value || 0);
    const prizeCoins  = Number(root.querySelector('#mail-coins')?.value || 0);
    let prizeItems = [];
    try {
      prizeItems = JSON.parse(root.querySelector('#mail-items')?.value || '[]');
    } catch {
      alert('아이템 JSON 형식이 잘못됐어');
      return;
    }

    if (!target || !title || !body) {
      alert('대상, 제목, 내용을 입력해줘');
      return;
    }

    $sendBtn.disabled = true;
    $status.textContent = '발송 중…';

    try {
      const sendMail = httpsCallable(func, 'sendMail');
      const r = await sendMail({ target, title, body, kind, expiresDays, prizeCoins, prizeItems });
      $status.textContent = `발송 완료: ${r?.data?.sentCount ?? 0}건`;
      alert('발송했어!');
    } catch (e) {
      console.warn('[manage] sendMail failed', e);
      $status.textContent = '발송 실패';
      alert('발송 실패: ' + (e?.message || e));
    } finally {
      $sendBtn.disabled = false;
    }
  });

  // --- 관리자 검색 ---
  const call = (name)=> httpsCallable(func, name);
  const $res = root.querySelector('#search-result');

  root.querySelector('#btn-q-char-id')?.addEventListener('click', async ()=>{
    const id = root.querySelector('#q-char-id').value.trim();
    if(!id) { $res.textContent = 'ID를 입력해줘'; return; }
    try {
      const r = await call('adminGetCharById')({ id });
      if(!r.data?.ok || !r.data?.found) { $res.textContent = '결과 없음'; return; }
      $res.innerHTML = `<pre>${esc(JSON.stringify(r.data, null, 2))}</pre>`;
    } catch(e) {
      $res.textContent = '오류: ' + (e?.message || e);
    }
  });

  root.querySelector('#btn-q-char-name')?.addEventListener('click', async ()=>{
    const name = root.querySelector('#q-char-name').value.trim();
    if(!name) { $res.textContent = '이름을 입력해줘'; return; }
    try {
      const r = await call('adminSearchCharsByName')({ name, limit:20 });
      $res.innerHTML = `<pre>${esc(JSON.stringify(r.data, null, 2))}</pre>`;
    } catch(e) {
      $res.textContent = '오류: ' + (e?.message || e);
    }
  });

  root.querySelector('#btn-q-user')?.addEventListener('click', async ()=>{
    const q = root.querySelector('#q-user').value.trim();
    if(!q) { $res.textContent = '검색어를 입력해줘'; return; }
    try {
      const r1 = await call('adminFindUser')({ q });
      if(!r1.data?.ok || !r1.data?.users?.length) { $res.textContent = '유저 없음'; return; }
      const u = r1.data.users[0];
      const r2 = await call('adminListAssets')({ uid: u.uid });
      $res.innerHTML =
        `<div style="font-weight:700">유저</div><pre>${esc(JSON.stringify(u, null, 2))}</pre>
         <div style="font-weight:700;margin-top:8px">캐릭터</div><pre>${esc(JSON.stringify(r2.data?.chars||[], null, 2))}</pre>
         <div style="font-weight:700;margin-top:8px">아이템</div><pre>${esc(JSON.stringify(r2.data?.items||[], null, 2))}</pre>`;
    } catch(e) {
      $res.textContent = '오류: ' + (e?.message || e);
    }
  });
}

// 라우터 호환용 별칭
export const showAdmin = showManage;
