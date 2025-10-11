// /public/js/tabs/story.js

import { auth, func, db, fx } from '../api/firebase.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-functions.js';
import { showToast } from '../ui/toast.js';
import { fetchMyChars } from '../api/store.js';

const call = (name) => httpsCallable(func, name);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

// --- 모달 관리 ---
let activeModal = null;
function closeModal() {
    if (activeModal) {
        activeModal.remove();
        activeModal = null;
    }
}

function openModal(content) {
    closeModal(); // 기존 모달 닫기

    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal-card">${content}</div>`;

    document.body.appendChild(back);
    activeModal = back;

    back.addEventListener('click', e => { if (e.target === back) closeModal(); });
    const closeBtn = back.querySelector('.btn-close');
    if (closeBtn) closeBtn.onclick = closeModal;

    return back.querySelector('.modal-card');
}


// --- 페이지 로직 ---
export default async function showStoryPage() {
    const root = document.getElementById('view');
    root.innerHTML = `
        <style>
            .story-container { text-align: center; padding: 40px 20px; }
            .story-title { font-size: 2.5rem; font-weight: 900; color: #fff; text-shadow: 0 0 15px rgba(255,255,255,0.3); }
            .modal-back { position:fixed; inset:0; z-index:9990; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,.6); backdrop-filter:blur(4px); }
            .modal-card { background:#0e1116; border:1px solid #273247; border-radius:14px; padding:16px; width:92vw; max-width:560px; max-height:90vh; overflow-y:auto; }
            .char-select-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; }
        </style>
        <div class="story-container">
            <h1 class="story-title">당신만의 캐릭터의<br>이야기를 써 내려가세요.</h1>
            <button id="btn-start-story" class="btn primary large" style="margin-top: 24px;">시작하기</button>
        </div>
    `;

    const startButton = document.getElementById('btn-start-story');
    startButton.onclick = async () => {
        const myChars = await fetchMyChars(auth.currentUser.uid);
        if (myChars.length === 0) {
            showToast('이야기를 만들 캐릭터가 없습니다. 먼저 캐릭터를 생성해주세요.');
            return;
        }
        
        const modalContent = `
            <h3 style="margin-top:0;">캐릭터 선택</h3>
            <p class="text-dim" style="font-size:13px;">이야기를 생성할 캐릭터를 선택해주세요.</p>
            <div class="char-select-grid" style="margin-top:12px;">
                ${myChars.map(char => `
                    <button class="kv-card" data-char-id="${char.id}" style="text-align:left; cursor:pointer;">
                        <div class="row" style="gap:12px; align-items:center;">
                            <img src="${esc(char.thumb_url || char.image_url || '')}" onerror="this.style.display='none'" style="width:48px; height:48px; border-radius:8px; object-fit:cover;">
                            <div>
                                <div style="font-weight:700;">${esc(char.name)}</div>
                                <div class="text-dim" style="font-size:12px;">${esc(char.world_id)}</div>
                            </div>
                        </div>
                    </button>
                `).join('')}
            </div>
        `;
        
        const modal = openModal(modalContent);
        modal.querySelectorAll('button[data-char-id]').forEach(btn => {
            btn.onclick = () => {
                const charId = btn.dataset.charId;
                showKeywordStep(charId);
            };
        });
    };
}

function showKeywordStep(charId) {
    const modalContent = `
        <h3 style="margin-top:0;">스토리 키워드</h3>
        <p class="text-dim" style="font-size:13px;">AI에게 전달할 핵심 키워드를 입력해주세요. (예: 배신, 복수, 각성)</p>
        <textarea id="story-keywords" class="input" rows="3" placeholder="키워드를 쉼표(,)로 구분하여 입력..."></textarea>
        <div class="row" style="justify-content:flex-end; margin-top:12px;">
            <button class="btn ghost btn-close">취소</button>
            <button id="btn-generate-sketch" class="btn primary">이야기 생성</button>
        </div>
    `;
    const modal = openModal(modalContent);
    
    modal.querySelector('#btn-generate-sketch').onclick = async () => {
        const keywords = modal.querySelector('#story-keywords').value.trim();
        if (!keywords) {
            showToast('키워드를 하나 이상 입력해주세요.');
            return;
        }
        
        const btn = modal.querySelector('#btn-generate-sketch');
        btn.disabled = true;
        btn.textContent = '생성 중...';

        try {
            const generateSketchFn = call('generateStorySketch');
            const result = await generateSketchFn({ charId, keywords });
            if (result.data.ok) {
                showSketchResult(charId, keywords, result.data.sketch);
            }
        } catch(e) {
            showToast(`생성 실패: ${e.message}`);
            btn.disabled = false;
            btn.textContent = '이야기 생성';
        }
    };
}

function showSketchResult(charId, keywords, sketch) {
    const modalContent = `
        <h3 style="margin-top:0;">이야기 초안</h3>
        <div class="kv-card" style="white-space: pre-wrap; max-height: 40vh; overflow-y: auto;">${esc(sketch)}</div>
        <div class="row" style="justify-content:flex-end; margin-top:12px;">
            <button class="btn ghost btn-close">닫기</button>
            <button id="btn-reroll" class="btn">다시 생성</button>
            <button id="btn-confirm-story" class="btn primary">이 이야기로 시작</button>
        </div>
    `;
    const modal = openModal(modalContent);
    
    modal.querySelector('#btn-reroll').onclick = async () => {
        const btn = modal.querySelector('#btn-reroll');
        btn.disabled = true;
        btn.textContent = '재생성 중...';
        
        try {
            const generateSketchFn = call('generateStorySketch');
            const result = await generateSketchFn({ charId, keywords });
            if (result.data.ok) {
                showSketchResult(charId, keywords, result.data.sketch);
            }
        } catch(e) {
            showToast(`재생성 실패: ${e.message}`);
            btn.disabled = false;
            btn.textContent = '다시 생성';
        }
    };

    modal.querySelector('#btn-confirm-story').onclick = () => {
        showToast('스토리 확정 기능은 아직 준비 중입니다.');
        closeModal();
    };
}
