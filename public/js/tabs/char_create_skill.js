// /public/js/tabs/char_create_skill.js
import { db, auth, fx } from '../api/firebase.js';
import { showToast } from '../ui/toast.js';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function parseCharId() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  return params.get('id');
}

export default async function showCreateSkillPage() {
  const root = document.getElementById('view');
  const charId = parseCharId();
  const uid = auth.currentUser?.uid;

  if (!uid || !charId) {
    root.innerHTML = `<section class="container narrow"><div class="kv-card">잘못된 접근입니다.</div></section>`;
    return;
  }

  root.innerHTML = `<section class="container narrow"><div class="spin-center"></div></section>`;

  try {
    const [charSnap, userSnap] = await Promise.all([
      fx.getDoc(fx.doc(db, 'chars', charId)),
      fx.getDoc(fx.doc(db, 'users', uid))
    ]);

    if (!charSnap.exists()) {
      throw new Error('캐릭터를 찾을 수 없습니다.');
    }

    const charData = charSnap.data();
    const userData = userSnap.exists() ? userSnap.data() : {};
    const currentCoins = userData.coins || 0;
    const skills = Array.isArray(charData.abilities_all) ? charData.abilities_all : [];
    const canCreate = skills.length < 8;
    const cost = 1000;

    root.innerHTML = `
      <section class="container narrow">
        <div class="card p16">
          <div class="row" style="justify-content:space-between">
              <h3 style="margin-top:0">새로운 스킬 생성</h3>
              <a href="#/char/${esc(charId)}" class="btn ghost">캐릭터로 돌아가기</a>
          </div>

          <div class="kv-card">
            <p class="text-dim">새로운 스킬의 이름과 설명을 입력해주세요. 스킬은 최대 8개까지 보유할 수 있습니다.</p>
            <div class="row" style="justify-content:space-between; margin-top: 8px;">
              <span>현재 스킬 수: <b>${skills.length} / 8</b></span>
              <span>보유 코인: 🪙 <b>${currentCoins.toLocaleString()}</b></span>
            </div>
          </div>

          <div class="col" style="gap: 12px; margin-top: 16px;">
            <input id="skill-name" class="input" placeholder="스킬 이름 (최대 20자)" maxlength="20">
            <textarea id="skill-desc" class="input" rows="3" placeholder="스킬 설명 (최대 100자)" maxlength="100"></textarea>
          </div>
          
          <div class="row" style="justify-content:flex-end; align-items:center; margin-top: 16px;">
            <div class="text-dim" style="font-size: 14px; margin-right: 12px;">비용: 🪙 <b>${cost.toLocaleString()}</b></div>
            <button id="btn-create-skill" class="btn primary large" ${!canCreate || currentCoins < cost ? 'disabled' : ''}>
              ${!canCreate ? '더 이상 생성 불가' : currentCoins < cost ? '코인 부족' : '생성하기'}
            </button>
          </div>
        </div>
      </section>
    `;

    root.querySelector('#btn-create-skill').addEventListener('click', () => {
      // 백엔드 로직은 미구현 상태로 둡니다.
      showToast('스킬 생성 기능은 현재 UI만 구현되어 있습니다.');
    });

  } catch (error) {
    console.error("스킬 생성 페이지 로딩 실패:", error);
    root.innerHTML = `<section class="container narrow"><div class="kv-card error">${esc(error.message)}</div></section>`;
  }
}
