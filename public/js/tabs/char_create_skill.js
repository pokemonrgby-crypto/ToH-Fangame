// /public/js/tabs/char_create_skill.js
import { db, auth, fx, func } from '../api/firebase.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-functions.js';
import { showToast } from '../ui/toast.js';
import { ensureModalCss, confirmModal } from '../ui/modal.js';

const CREATE_COOLDOWN_SEC = 180; // 3분

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function parseCharId() { return new URLSearchParams(location.hash.split('?')[1] || '').get('id'); }

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

    if (!charSnap.exists()) throw new Error('캐릭터를 찾을 수 없습니다.');

    const charData = charSnap.data();
    const userData = userSnap.exists() ? userSnap.data() : {};
    const currentCoins = userData.coins || 0;
    const skills = (Array.isArray(charData.abilities_all) ? charData.abilities_all : []).filter(s => s.name && s.desc_soft);
    const canCreate = skills.length < 8;
    const additionalSkills = Math.max(0, skills.length - 4);
    const cost = 500 + (additionalSkills * 500);
    
    const lastCreatedAt = userData.lastSkillCreatedAt?.toMillis() || 0;
    const cooldownLeft = Math.ceil(Math.max(0, (lastCreatedAt + (CREATE_COOLDOWN_SEC * 1000) - Date.now()) / 1000));

    root.innerHTML = `
      <section class="container narrow">
        <div class="card p16">
          <div class="row" style="justify-content:space-between">
              <h3 style="margin-top:0">✨ 새로운 스킬 생성</h3>
              <a href="#/char/${esc(charId)}" class="btn ghost">캐릭터로 돌아가기</a>
          </div>

          <div class="kv-card">
            <p class="text-dim">AI를 이용해 캐릭터의 컨셉에 맞는 새로운 스킬을 생성합니다. 스킬은 최대 8개까지 보유할 수 있습니다.</p>
            <div class="row" style="justify-content:space-between; margin-top: 8px;">
              <span>현재 스킬 수: <b>${skills.length} / 8</b></span>
              <span>보유 코인: 🪙 <b>${currentCoins.toLocaleString()}</b></span>
            </div>
          </div>

          <div class="col" style="gap: 16px; margin-top: 16px;">
            <div>
                <label class="kv-label">1. 생성 방식</label>
                <select id="generation-mode" class="input">
                    <option value="auto">AI 자동 생성</option>
                    <option value="manual">이름 수동 입력</option>
                </select>
            </div>
            <div id="manual-name-wrapper" style="display:none;">
                <label class="kv-label">2. 스킬 이름 (직접 입력)</label>
                <input id="skill-name" class="input" placeholder="스킬 이름 (최대 20자)" maxlength="20">
            </div>
            <div>
                <label class="kv-label">3. 스킬 컨셉 (AI에게 전달할 내용)</label>
                <textarea id="skill-prompt" class="input" rows="4" placeholder="원하는 스킬의 컨셉이나 키워드를 자유롭게 적어주세요. (최대 200자)" maxlength="200"></textarea>
            </div>
          </div>
          
          <div class="row" style="justify-content:flex-end; align-items:center; margin-top: 16px;">
            <div class="text-dim" style="font-size: 14px; margin-right: 12px;">비용: 🪙 <b>${cost.toLocaleString()}</b></div>
            <button id="btn-create-skill" class="btn primary large"></button>
          </div>
        </div>
      </section>
    `;

    const btnCreate = root.querySelector('#btn-create-skill');
    const modeSelect = root.querySelector('#generation-mode');
    const manualNameWrapper = root.querySelector('#manual-name-wrapper');

    modeSelect.addEventListener('change', () => {
        manualNameWrapper.style.display = modeSelect.value === 'manual' ? 'block' : 'none';
    });

    const updateButtonState = (remaining) => {
        if (remaining > 0) {
            btnCreate.disabled = true;
            btnCreate.textContent = `쿨타임 (${remaining}초)`;
        } else if (!canCreate) {
            btnCreate.disabled = true;
            btnCreate.textContent = '더 이상 생성 불가';
        } else if (currentCoins < cost) {
            btnCreate.disabled = true;
            btnCreate.textContent = '코인 부족';
        } else {
            btnCreate.disabled = false;
            btnCreate.textContent = 'AI로 생성하기';
        }
    };

    if (cooldownLeft > 0) {
        let remaining = cooldownLeft;
        updateButtonState(remaining);
        const interval = setInterval(() => {
            remaining--;
            if (remaining <= 0) {
                clearInterval(interval);
            }
            updateButtonState(remaining);
        }, 1000);
    } else {
        updateButtonState(0);
    }

    btnCreate.addEventListener('click', async () => {
        const generationMode = modeSelect.value;
        const customName = document.getElementById('skill-name').value.trim();
        const userPrompt = document.getElementById('skill-prompt').value.trim();

        if (generationMode === 'manual' && !customName) {
            showToast('스킬 이름을 입력해주세요.');
            return;
        }
        if (!userPrompt) {
            showToast('스킬 컨셉을 입력해주세요.');
            return;
        }

        btnCreate.disabled = true;
        btnCreate.textContent = 'AI 생성 중...';

        try {
            const generateNewSkill = httpsCallable(func, 'generateNewSkill');
            const result = await generateNewSkill({ charId, generationMode, customName, userPrompt });

            if (result.data.ok) {
                const { generatedSkill, cost } = result.data;
                const confirmed = await showConfirmationModal(generatedSkill, cost);
                if (confirmed) {
                    await applySkill(charId, generatedSkill);
                } else {
                    // 사용자가 취소했으므로 쿨타임을 다시 설정하지 않도록 페이지를 새로고침합니다.
                    showCreateSkillPage();
                }
            }
        } catch (error) {
            showToast(`생성 실패: ${error.message}`);
            // 실패 시에는 쿨타임이 돌지 않으므로 즉시 버튼 상태를 갱신합니다.
            updateButtonState(0);
        }
    });

  } catch (error) {
    console.error("스킬 생성 페이지 로딩 실패:", error);
    root.innerHTML = `<section class="container narrow"><div class="kv-card error">${esc(error.message)}</div></section>`;
  }
}

async function showConfirmationModal(skill, cost) {
    ensureModalCss();
    return new Promise(resolve => {
        const back = document.createElement('div');
        back.className = 'modal-back';
        back.innerHTML = `
            <div class="modal-card">
                <div style="font-weight:900; font-size:18px;">스킬 생성 완료</div>
                <div class="kv-card" style="margin-top: 12px;">
                    <div class="kv-label">이름</div>
                    <p><b>${esc(skill.name)}</b></p>
                    <div class="kv-label" style="margin-top: 8px;">설명 (140자 이내)</div>
                    <p>${esc(skill.desc_soft)}</p>
                </div>
                <div class="text-dim" style="font-size:13px; margin-top: 12px;">이 스킬을 🪙 ${cost.toLocaleString()} 코인을 지불하고 캐릭터에 적용하시겠습니까?</div>
                <div class="row" style="justify-content:flex-end; gap:8px; margin-top:12px;">
                    <button id="modal-cancel" class="btn ghost">취소</button>
                    <button id="modal-confirm" class="btn primary">적용하기</button>
                </div>
            </div>
        `;
        document.body.appendChild(back);
        const close = (val) => { back.remove(); resolve(val); };
        back.querySelector('#modal-cancel').onclick = () => close(false);
        back.querySelector('#modal-confirm').onclick = async () => {
            const finalConfirm = await confirmModal({
                title: '최종 확인',
                lines: ['한 번 적용된 스킬은 삭제할 수 없습니다. 정말로 적용하시겠습니까?'],
                okText: '적용',
                cancelText: '취소'
            });
            if (finalConfirm) {
                close(true);
            }
        };
    });
}

async function applySkill(charId, skill) {
    try {
        const confirmAddSkill = httpsCallable(func, 'confirmAddSkill');
        await confirmAddSkill({ charId, skill });
        showToast('새로운 스킬을 성공적으로 적용했습니다!');
        location.hash = `#/char/${charId}`;
    } catch (error) {
        showToast(`적용 실패: ${error.message}`);
        // 적용 실패 시, 다시 시도할 수 있도록 페이지를 새로고침합니다.
        showCreateSkillPage();
    }
}
