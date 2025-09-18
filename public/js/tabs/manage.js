// pokemonrgby-crypto/toh-fangame/ToH-Fangame-23b32a5f81701f6655ba119074435fa979f65b24/public/js/tabs/manage.js
import { auth, func } from '../api/firebase.js';
import { ensureAdmin, isAdminCached } from '../api/admin.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-functions.js';
import { showToast } from '../ui/toast.js';
import { isAdminCached } from '../api/admin.js';

export async function showManage() {
  const root = document.getElementById('view');
    if (!isAdminCached()) {
      try { await ensureAdmin(); } catch(e) {}
    }
    if (!isAdminCached()) {
      root.innerHTML = `<section class="container narrow"><div class="kv-card">관리자만 접근할 수 있습니다.</div></section>`;
      return;
    }

  root.innerHTML = `
    <section class="container narrow">
      <div class="card p16">
        <h3>관리자 패널</h3>
        <div class="kv-card mt12">
          <h4>우편 발송</h4>
          <div class="col" style="gap:10px;">
            <input id="mail-target" class="input" placeholder="대상 UID (전체 발송은 'all' 입력)">
            <input id="mail-title" class="input" placeholder="제목 (최대 100자)" maxlength="100">
            <textarea id="mail-body" class="input" rows="5" placeholder="내용 (최대 1500자)" maxlength="1500"></textarea>
            <button id="btn-send-mail" class="btn primary">발송</button>
          </div>
        </div>
      </div>
    </section>
  `;

  const btnSend = root.querySelector('#btn-send-mail');
  btnSend.onclick = async () => {
    const target = root.querySelector('#mail-target').value.trim();
    const title = root.querySelector('#mail-title').value.trim();
    const body = root.querySelector('#mail-body').value.trim();

    if (!target || !title || !body) {
      showToast('모든 필드를 입력해주세요.');
      return;
    }

    if (!confirm(`'${target}'에게 메일을 발송할까요?`)) return;

    btnSend.disabled = true;
    btnSend.textContent = '발송 중...';

    try {
      const sendMail = httpsCallable(func, 'sendMail');
      const result = await sendMail({ target, title, body });
      if (result.data.ok) {
        showToast(`${result.data.sentCount}건의 메일을 성공적으로 발송했습니다.`);
        root.querySelector('#mail-target').value = '';
        root.querySelector('#mail-title').value = '';
        root.querySelector('#mail-body').value = '';
      } else {
        throw new Error('서버에서 발송 실패');
      }
    } catch (e) {
      console.error('Mail send error:', e);
      showToast(`발송 실패: ${e.message}`);
    } finally {
      btnSend.disabled = false;
      btnSend.textContent = '발송';
    }
  };
}
