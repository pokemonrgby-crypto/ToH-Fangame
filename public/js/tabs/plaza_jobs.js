// /public/js/tabs/plaza_jobs.js
import { auth, db, fx, func } from '../api/firebase.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-functions.js';
import { showToast } from '../ui/toast.js';
import { ensureModalCss } from '../ui/modal.js';
import { fetchMyChars } from '../api/store.js'; // 내 캐릭터 로드 함수 import

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// --- 메인 뷰 렌더링 ---
export async function showPlazaJobs(root) {
    const user = auth.currentUser;
    if (!user) {
        root.innerHTML = `<div class="kv-card text-dim">로그인이 필요합니다.</div>`;
        return;
    }

    root.innerHTML = `<div class="spin-center"></div>`;

    try {
        const myChars = await fetchMyChars(user.uid);
        
        if (myChars.length === 0) {
            root.innerHTML = `<div class="kv-card text-dim">직업을 설정할 캐릭터가 없습니다. 먼저 캐릭터를 생성해주세요.</div>`;
            return;
        }

        root.innerHTML = `
            <div class="kv-card">
                <div class="kv-label">내 캐릭터 목록</div>
                <div class="grid3" style="gap:10px;">
                    ${myChars.map(c => `
                        <button class="kv-card" data-char-id='${c.id}' style="width:100%; text-align:left; cursor:pointer;">
                            <div class="row" style="gap:12px; align-items:center;">
                                <img src="${esc(c.thumb_url || c.image_url || '')}" onerror="this.style.display='none'" style="width:48px; height:48px; border-radius:8px; object-fit:cover;">
                                <div>
                                    <div style="font-weight:700;">${esc(c.name)}</div>
                                    <div class="text-dim" style="font-size:12px;">직업: ${esc(c.job || '백수')}</div>
                                </div>
                            </div>
                        </button>
                    `).join('')}
                </div>
            </div>
        `;

        root.querySelectorAll('button[data-char-id]').forEach(btn => {
            btn.onclick = () => {
                const charId = btn.dataset.charId;
                const selectedChar = myChars.find(c => c.id === charId);
                renderCharDetail(root, selectedChar);
            };
        });
    } catch (e) {
        showToast(`캐릭터 목록 로드 실패: ${e.message}`);
        root.innerHTML = `<div class="kv-card text-dim">캐릭터를 불러오는 중 오류가 발생했습니다.</div>`;
    }
}

// --- 캐릭터 상세 정보 및 직업 설정 UI ---
function renderCharDetail(container, charData) {
    // skills 필드가 없을 경우를 대비하여 기본값 설정
    const skills = charData.skills || {};
    const skillKeys = ['strength', 'charisma', 'gardening', 'art', 'construction', 'speech', 'mining', 'cooking', 'processing', 'crafting', 'research'];

    container.innerHTML = `
        <div class="kv-card">
            <div class="row" style="justify-content:space-between;">
                <h4 style="margin:0;">${esc(charData.name)}</h4>
                <button id="back-to-list" class="btn ghost small">← 캐릭터 목록으로</button>
            </div>
            <div class="kv-card" style="margin-top:12px;">
                <div class="kv-label">현재 직업</div>
                <div style="font-weight:700;">${esc(charData.job || '백수')}</div>
            </div>
            <div class="kv-card" style="margin-top:8px;">
                <div class="kv-label">현재 스탯</div>
                <div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap:8px;">
                    ${skillKeys.map(key => `
                        <div class="text-dim" style="font-size:13px;">
                            ${key}: <b style="color:white;">Lv.${(skills[key] && skills[key].level) || 0}</b>
                        </div>
                    `).join('')}
                </div>
            </div>
            <button id="btn-recommend" class="btn primary" style="width:100%; margin-top:12px;">AI 직업 추천 및 설정</button>
        </div>
    `;

    container.querySelector('#back-to-list').onclick = () => showPlazaJobs(container);
    container.querySelector('#btn-recommend').onclick = async (e) => {
        const btn = e.currentTarget;
        // 이미 직업이 있는 경우, 스탯 재분배 불가
        if (charData.job && charData.job !== '백수') {
            showToast('이미 직업이 설정된 캐릭터입니다.');
            return;
        }

        btn.disabled = true;
        btn.textContent = 'AI 추천 중...';
        try {
            const recommendFn = httpsCallable(func, 'recommendJobs');
            const res = await recommendFn({ charId: charData.id });
            if (res.data.ok) {
                await openJobAndStatModal(charData, res.data.jobs);
            }
        } catch (err) {
            showToast(`추천 실패: ${err.message}`);
        } finally {
            btn.disabled = false;
            btn.textContent = 'AI 직업 추천 및 설정';
        }
    };
}

// --- 직업 선택 및 스탯 분배 모달 ---
async function openJobAndStatModal(char, recommendedJobs) {
    ensureModalCss();
    
    let selectedJob = recommendedJobs[0] || '';
    const initialStats = {
        strength: { level: 0 }, charisma: { level: 0 }, gardening: { level: 0 },
        art: { level: 0 }, construction: { level: 0 }, speech: { level: 0 },
        mining: { level: 0 }, cooking: { level: 0 }, processing: { level: 0 },
        crafting: { level: 0 }, research: { level: 0 }
    };
    const skillKeys = Object.keys(initialStats);
    let remainingPoints = 20;

    const back = document.createElement('div');
    back.className = 'modal-back';
    
    const renderModal = () => {
        const totalCost = skillKeys.reduce((sum, key) => {
            const level = initialStats[key].level;
            return sum + (level * (level + 1) / 2);
        }, 0);
        remainingPoints = 20 - totalCost;

        back.innerHTML = `
            <div class="modal-card">
                <div style="font-weight:900; font-size:18px;">직업 설정: ${esc(char.name)}</div>
                <div class="kv-card" style="margin-top:12px;">
                    <label class="kv-label">AI 추천 직업</label>
                    <select id="job-select" class="input">
                        ${recommendedJobs.map(job => `<option value="${esc(job)}" ${job === selectedJob ? 'selected' : ''}>${esc(job)}</option>`).join('')}
                    </select>
                </div>
                <div class="kv-card" style="margin-top:8px;">
                    <div class="row" style="justify-content:space-between;">
                        <span class="kv-label">초기 스탯 분배</span>
                        <span style="font-weight:700;">남은 포인트: <span id="remaining-points">${remainingPoints}</span></span>
                    </div>
                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px 16px; margin-top:8px;">
                        ${skillKeys.map(key => `
                            <div class="row" style="justify-content:space-between; align-items:center;">
                                <span style="text-transform: capitalize;">${key}</span>
                                <div class="row" style="gap:4px;">
                                    <button class="btn ghost xs btn-stat" data-stat="${key}" data-op="-">-</button>
                                    <span style="width:40px; text-align:center;">Lv.${initialStats[key].level}</span>
                                    <button class="btn ghost xs btn-stat" data-stat="${key}" data-op="+">+</button>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
                <div class="row" style="justify-content:flex-end; gap:8px; margin-top:12px;">
                    <button id="modal-cancel" class="btn ghost">취소</button>
                    <button id="modal-confirm" class="btn primary">확정 및 적용</button>
                </div>
            </div>
        `;
        attachModalEvents();
    };

    const attachModalEvents = () => {
        back.querySelector('#job-select').onchange = (e) => {
            selectedJob = e.target.value;
        };

        back.querySelectorAll('.btn-stat').forEach(btn => {
            btn.onclick = () => {
                const key = btn.dataset.stat;
                const op = btn.dataset.op;
                const currentLevel = initialStats[key].level;

                if (op === '+') {
                    const cost = currentLevel + 1;
                    if (remainingPoints >= cost) {
                        initialStats[key].level++;
                    } else {
                        showToast('포인트가 부족합니다.');
                    }
                } else if (op === '-') {
                    if (currentLevel > 0) {
                        initialStats[key].level--;
                    }
                }
                renderModal();
            };
        });

        back.querySelector('#modal-cancel').onclick = () => back.remove();
        back.querySelector('#modal-confirm').onclick = async (e) => {
            if (remainingPoints < 0) {
                showToast('사용 포인트가 20을 초과할 수 없습니다.');
                return;
            }
            if (remainingPoints > 0) {
                if (!confirm('남은 포인트가 있습니다. 그대로 진행하시겠습니까?')) {
                    return;
                }
            }
            const confirmBtn = e.currentTarget;
            confirmBtn.disabled = true;
            confirmBtn.textContent = '적용 중...';
            
            try {
                const setJobFn = httpsCallable(func, 'setCharacterJobAndStats'); // 변경된 함수 이름 호출
                await setJobFn({ charId: char.id, jobName: selectedJob, stats: initialStats });
                showToast(`'${selectedJob}' 직업이 적용되었습니다.`);
                back.remove();
                // 부모 컨테이너(plaza-content)를 찾아 전체 탭을 다시 로드
                const plazaContent = document.getElementById('plaza-content');
                if (plazaContent) {
                    showPlazaJobs(plazaContent);
                }
            } catch (err) {
                showToast(`적용 실패: ${err.message}`);
                confirmBtn.disabled = false;
                confirmBtn.textContent = '확정 및 적용';
            }
        };
    };

    document.body.appendChild(back);
    renderModal();
}
