// /public/js/tabs/story.js

import { auth, func, db, fx } from '../api/firebase.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-functions.js';
import { showToast } from '../ui/toast.js';
import { fetchMyChars } from '../api/store.js';
import { showModal, closeModal } from '../ui/modal.js'; // [수정] 자체 모달 대신 공용 모달 사용
import { WORLD_LIST } from '../api/world.js';

const call = (name) => httpsCallable(func, name);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

// --- 페이지 로직 ---
export default async function showStoryPage() {
    const root = document.getElementById('view');
    root.innerHTML = `
        <style>
            .story-container { text-align: center; padding: 40px 20px; }
            .story-title { font-size: 2.5rem; font-weight: 900; color: #fff; text-shadow: 0 0 15px rgba(255,255,255,0.3); }
            /* [삭제] 모달 스타일은 modal.js의 것을 따르므로 제거 */
            .char-select-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; }
            .world-select-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px; }
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
                    <button class="kv-card" data-char-id="${char.id}" data-world-id="${char.world_id}" style="text-align:left; cursor:pointer;">
                        <div class="row" style="gap:12px; align-items:center;">
                            <img src="${esc(char.thumb_url || char.image_url || '')}" onerror="this.style.display='none'" style="width:48px; height:48px; border-radius:8px; object-fit:cover;">
                            <div>
                                <div style="font-weight:700;">${esc(char.name)}</div>
                                <div class="text-dim" style="font-size:12px;">${esc(WORLD_LIST[char.world_id]?.name || char.world_id)}</div>
                            </div>
                        </div>
                    </button>
                `).join('')}
            </div>
        `;
        
        const modal = showModal(modalContent); // [수정]
        modal.querySelectorAll('button[data-char-id]').forEach(btn => {
            btn.onclick = () => {
                const charId = btn.dataset.charId;
                const worldId = btn.dataset.worldId;
                showKeywordStep(charId, worldId);
            };
        });
    };
}

function showKeywordStep(charId, worldId) {
    const modalContent = `
        <h3 style="margin-top:0;">스토리 키워드</h3>
        <p class="text-dim" style="font-size:13px;">AI에게 전달할 핵심 키워드를 입력해주세요.<br>선택된 세계관: <b>${esc(WORLD_LIST[worldId]?.name || worldId)}</b></p>
        <textarea id="story-keywords" class="input" rows="3" placeholder="키워드를 쉼표(,)로 구분하여 입력... (예: 배신, 복수, 각성)"></textarea>
        <div class="row" style="justify-content:flex-end; margin-top:12px;">
            <button class="btn ghost" onclick="window.closeModal()">취소</button>
            <button id="btn-generate-sketch" class="btn primary">이야기 생성</button>
        </div>
    `;
    const modal = showModal(modalContent); // [수정]
    
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
            const result = await generateSketchFn({ charId, keywords, worldId }); // [수정] worldId 추가
            if (result.data.ok) {
                showSketchResult(charId, worldId, keywords, result.data.sketch);
            }
        } catch(e) {
            showToast(`생성 실패: ${e.message}`);
            btn.disabled = false;
            btn.textContent = '이야기 생성';
        }
    };
}

function showSketchResult(charId, worldId, keywords, sketch) {
    const modalContent = `
        <h3 style="margin-top:0;">이야기 초안</h3>
        <div class="kv-card" style="white-space: pre-wrap; max-height: 40vh; overflow-y: auto;">${esc(sketch)}</div>
        <div class="row" style="justify-content:flex-end; margin-top:12px;">
            <button class="btn ghost" onclick="window.closeModal()">닫기</button>
            <button id="btn-reroll" class="btn">다시 생성</button>
            <button id="btn-confirm-story" class="btn primary">이 이야기로 시작</button>
        </div>
    `;
    const modal = showModal(modalContent); // [수정]
    
    modal.querySelector('#btn-reroll').onclick = async () => {
        const btn = modal.querySelector('#btn-reroll');
        btn.disabled = true;
        btn.textContent = '재생성 중...';
        
        try {
            const generateSketchFn = call('generateStorySketch');
            const result = await generateSketchFn({ charId, keywords, worldId }); // [수정] worldId 추가
            if (result.data.ok) {
                showSketchResult(charId, worldId, keywords, result.data.sketch);
            }
        } catch(e) {
            showToast(`재생성 실패: ${e.message}`);
            btn.disabled = false;
            btn.textContent = '다시 생성';
        }
    };

    modal.querySelector('#btn-confirm-story').onclick = () => {
        // [추가] 7일 쿨타임 경고창
        const confirmContent = `
            <h3 style="margin-top:0; color:var(--color-warn);">정말 시작하시겠습니까?</h3>
            <p>이야기를 시작하면 <b>7일 동안</b> 다른 캐릭터로 새 이야기를 시작할 수 없습니다.</p>
            <p>또한, 현재 진행 중인 이야기는 포기하기 전까지 계속됩니다.</p>
            <div class="row" style="justify-content:flex-end; margin-top:16px;">
                <button class="btn ghost" onclick="window.closeModal()">취소</button>
                <button id="btn-final-confirm" class="btn danger">네, 시작하겠습니다</button>
            </div>
        `;
        const confirmModal = showModal(confirmContent);

        confirmModal.querySelector('#btn-final-confirm').onclick = async () => {
            const btn = confirmModal.querySelector('#btn-final-confirm');
            btn.disabled = true;
            btn.textContent = '처리 중...';
            try {
                const startStoryFn = call('startStory');
                const result = await startStoryFn({
                    charId,
                    worldId,
                    initialSketch: sketch
                });
                if (result.data.ok) {
                    closeModal();
                    showToast('새로운 이야기가 시작되었습니다! 모험을 떠나보세요.', 'success');
                    // TODO: 실제 스토리 진행 화면으로 이동하는 로직 (예: location.hash = `#/story/${charId}`)
                }
            } catch (e) {
                showToast(`시작 실패: ${e.message}`, 'error');
                btn.disabled = false;
                btn.textContent = '네, 시작하겠습니다';
            }
        };
    };
}
