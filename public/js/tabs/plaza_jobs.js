// /public/js/tabs/plaza_jobs.js
import { auth, db, fx, func } from '../api/firebase.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-functions.js';
import { isAdminCached } from '../api/admin.js';
import { showToast } from '../ui/toast.js';
import { ensureModalCss } from '../ui/modal.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// --- 메인 뷰 렌더링 ---
export async function showPlazaJobs(root) {
    if (!isAdminCached()) {
        root.innerHTML = `<div class="kv-card text-dim">이 기능은 관리자만 사용할 수 있습니다.</div>`;
        return;
    }

    root.innerHTML = `
        <div class="kv-card">
            <div class="kv-label">캐릭터 검색</div>
            <div class="row" style="gap:8px;">
                <input id="char-search-input" class="input" placeholder="캐릭터 이름으로 검색... (정확히 일치)">
                <button id="char-search-btn" class="btn">검색</button>
            </div>
        </div>
        <div id="char-result-area" style="margin-top:12px;"></div>
    `;

    const searchInput = root.querySelector('#char-search-input');
    const searchBtn = root.querySelector('#char-search-btn');
    const resultArea = root.querySelector('#char-result-area');

    const searchChars = async () => {
        const name = searchInput.value.trim();
        if (!name) return;
        resultArea.innerHTML = `<div class="spin-center"></div>`;
        try {
            const searchFn = httpsCallable(func, 'adminSearchCharsByName');
            const res = await searchFn({ name, limit: 10 });
            const chars = res.data.rows || [];
            
            if (chars.length === 0) {
                resultArea.innerHTML = `<div class="kv-card text-dim">검색 결과가 없습니다.</div>`;
                return;
            }

            resultArea.innerHTML = chars.map(c => `
                <button class="kv-card" data-char-id='${c.id}' style="width:100%; text-align:left; cursor:pointer;">
                    <div class="row" style="gap:12px;">
                        <img src="${esc(c.thumb_url || c.image_url || '')}" onerror="this.style.display='none'" style="width:48px; height:48px; border-radius:8px; object-fit:cover;">
                        <div>
                            <div style="font-weight:700;">${esc(c.name)}</div>
                            <div class="text-dim" style="font-size:12px;">직업: ${esc(c.job || '백수')}</div>
                        </div>
                    </div>
                </button>
            `).join('');

            resultArea.querySelectorAll('button[data-char-id]').forEach(btn => {
                btn.onclick = () => {
                    const charId = btn.dataset.charId;
                    const selectedChar = chars.find(c => c.id === charId);
                    renderCharDetail(resultArea, selectedChar);
                };
            });
        } catch (e) {
            showToast(`검색 실패: ${e.message}`);
            resultArea.innerHTML = ``;
        }
    };

    searchBtn.onclick = searchChars;
    searchInput.onkeydown = (e) => { if (e.key === 'Enter') searchChars(); };
}

// --- 캐릭터 상세 정보 및 직업 설정 UI ---
function renderCharDetail(container, charData) {
    const skills = charData.skills || {};
    const skillKeys = ['strength', 'charisma', 'gardening', 'art', 'construction', 'speech', 'mining', 'cooking', 'processing', 'crafting', 'research'];

    container.innerHTML = `
        <div class="kv-card">
            <div class="row" style="justify-content:space-between;">
                <h4 style="margin:0;">${esc(charData.name)}</h4>
                <button id="back-to-search" class="btn ghost small">← 목록으로</button>
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
                            ${key}: <b style="color:white;">Lv.${skills[key]?.level || 0}</b>
                        </div>
                    `).join('')}
                </div>
            </div>
            <button id="btn-recommend" class="btn primary" style="width:100%; margin-top:12px;">AI 직업 추천 및 설정</button>
        </div>
    `;

    container.querySelector('#back-to-search').onclick = () => showPlazaJobs(document.getElementById('plaza-content'));
    container.querySelector('#btn-recommend').onclick = async (e) => {
        const btn = e.currentTarget;
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
                            <div class="row" style="justify-content:space-between;">
                                <span>${key}</span>
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
                renderModal(); // 변경 후 다시 렌더링하여 포인트 갱신
            };
        });

        back.querySelector('#modal-cancel').onclick = () => back.remove();
        back.querySelector('#modal-confirm').onclick = async (e) => {
            if (remainingPoints < 0) {
                showToast('포인트를 모두 사용해야 합니다.');
                return;
            }
            const confirmBtn = e.currentTarget;
            confirmBtn.disabled = true;
            confirmBtn.textContent = '적용 중...';
            
            try {
                const setJobFn = httpsCallable(func, 'adminSetCharacterJobAndStats');
                await setJobFn({ charId: char.id, jobName: selectedJob, stats: initialStats });
                showToast(`'${selectedJob}' 직업이 적용되었습니다.`);
                back.remove();
                showPlazaJobs(document.getElementById('plaza-content')); // 전체 탭 새로고침
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
