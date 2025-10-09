// /public/js/tabs/plaza_jobs.js
import { auth, func } from '../api/firebase.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-functions.js';
import { showToast } from '../ui/toast.js';
import { ensureModalCss } from '../ui/modal.js';
import { fetchMyChars } from '../api/store.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// 스탯 영문 key를 한글로 변환하기 위한 객체
const statTranslations = {
    strength: '근력', charisma: '매력', gardening: '원예', art: '예술',
    construction: '건설', speech: '화술', mining: '채굴', cooking: '조리',
    processing: '가공', crafting: '제작', research: '연구'
};
const skillKeys = Object.keys(statTranslations);

// 직업 데이터를 한 번만 불러와 캐시에 저장하는 함수
let jobsDataCache = null;
async function getJobsData() {
    if (jobsDataCache) return jobsDataCache;
    try {
        const response = await fetch('/assets/jobs.json');
        if (!response.ok) throw new Error('Network response was not ok');
        jobsDataCache = await response.json();
        return jobsDataCache;
    } catch (e) {
        console.error("Failed to load jobs.json", e);
        showToast('직업 정보를 불러오는 데 실패했습니다.');
        return []; // 실패 시 빈 배열 반환
    }
}


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

// --- 캐릭터 상세 정보 UI ---
function renderCharDetail(container, charData) {
    const skills = charData.skills || {};
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
                            ${statTranslations[key] || key}: <b style="color:white;">Lv.${(skills[key] && skills[key].level) || 0}</b>
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
    
    const allJobs = await getJobsData(); // 직업 보너스 표시를 위해 전체 직업 데이터 로드
    let selectedJob = recommendedJobs[0] || '';
    
    const currentStats = JSON.parse(JSON.stringify(char.skills || {}));
    const originalStats = JSON.parse(JSON.stringify(char.skills || {}));

    skillKeys.forEach(key => {
        if (!currentStats[key]) currentStats[key] = { level: 0 };
        if (!originalStats[key]) originalStats[key] = { level: 0 };
    });

    const back = document.createElement('div');
    back.className = 'modal-back';
    
    const renderModal = () => {
        let usedPoints = 0;
        for (const key of skillKeys) {
            const currentLevel = currentStats[key].level;
            const originalLevel = originalStats[key].level;
            if (currentLevel > originalLevel) {
                usedPoints += (currentLevel * (currentLevel + 1) / 2) - (originalLevel * (originalLevel + 1) / 2);
            }
        }
        const remainingPoints = 20 - usedPoints;

        // ▼▼▼ [추가된 부분] ▼▼▼
        // 선택된 직업의 스탯 보너스 정보를 생성
        const selectedJobData = allJobs.find(j => j.name === selectedJob);
        let bonusText = '보너스 스탯 정보가 없습니다.';
        if (selectedJobData) {
            const { stat1, stat2 } = selectedJobData;
            const stat1Kor = statTranslations[stat1];
            const stat2Kor = statTranslations[stat2];

            if (stat1 && !stat2) {
                bonusText = `주요 스탯: <b style="color:#81C784;">${stat1Kor} (성장 보너스 x4)</b>`;
            } else if (stat1 && stat2) {
                bonusText = `주요 스탯: <b style="color:#81C784;">${stat1Kor} (x2)</b>, <b style="color:#81C784;">${stat2Kor} (x2)</b>`;
            }
        }
        // ▲▲▲ [추가된 부분] ▲▲▲

        back.innerHTML = `
            <div class="modal-card">
                <div style="font-weight:900; font-size:18px;">직업 설정: ${esc(char.name)}</div>
                <div class="kv-card" style="margin-top:12px;">
                    <label class="kv-label">AI 추천 직업</label>
                    <select id="job-select" class="input">
                        ${recommendedJobs.map(job => `<option value="${esc(job)}" ${job === selectedJob ? 'selected' : ''}>${esc(job)}</option>`).join('')}
                    </select>
                    <div class="text-dim" style="font-size: 12px; margin-top: 4px; height: 16px;">${bonusText}</div>
                </div>
                <div class="kv-card" style="margin-top:8px;">
                    <div class="row" style="justify-content:space-between;">
                        <span class="kv-label">초기 스탯 분배</span>
                        <span style="font-weight:700;">남은 포인트: <span id="remaining-points" style="${remainingPoints < 0 ? 'color:#E57373;' : ''}">${remainingPoints}</span> / 20</span>
                    </div>
                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px 16px; margin-top:8px;">
                        ${skillKeys.map(key => `
                            <div class="row" style="justify-content:space-between; align-items:center;">
                                <span>${statTranslations[key] || key}</span>
                                <div class="row" style="gap:4px;">
                                    <button class="btn ghost xs btn-stat" data-stat="${key}" data-op="-">-</button>
                                    <span style="width:40px; text-align:center;">Lv.${currentStats[key].level}</span>
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
            renderModal(); // 직업 변경 시 보너스 텍스트를 갱신하기 위해 다시 렌더링
        };

        back.querySelectorAll('.btn-stat').forEach(btn => {
            btn.onclick = () => {
                const key = btn.dataset.stat;
                const op = btn.dataset.op;
                
                if (op === '+') {
                    currentStats[key].level++;
                } else if (op === '-') {
                    if (currentStats[key].level > originalStats[key].level) {
                        currentStats[key].level--;
                    }
                }
                renderModal();
            };
        });

        back.querySelector('#modal-cancel').onclick = () => back.remove();
        back.querySelector('#modal-confirm').onclick = async (e) => {
            let usedPoints = 0;
            for (const key of skillKeys) {
                const currentLevel = currentStats[key].level;
                const originalLevel = originalStats[key].level;
                if (currentLevel > originalLevel) {
                    usedPoints += (currentLevel * (currentLevel + 1) / 2) - (originalLevel * (originalLevel + 1) / 2);
                }
            }
            
            if (usedPoints > 20) {
                showToast('사용한 포인트가 20을 초과할 수 없습니다.');
                return;
            }
            
            if (usedPoints < 20) {
                if (!confirm('남은 스탯 포인트가 있습니다. 사용하지 않은 포인트는 적용되지 않고 사라집니다. 계속하시겠습니까?')) {
                    return;
                }
            }

            const confirmBtn = e.currentTarget;
            confirmBtn.disabled = true;
            confirmBtn.textContent = '적용 중...';
            
            try {
                const setJobFn = httpsCallable(func, 'setCharacterJobAndStats');
                await setJobFn({ charId: char.id, jobName: selectedJob, stats: currentStats });
                showToast(`'${selectedJob}' 직업이 적용되었습니다.`);
                back.remove();
                const plazaContent = document.getElementById('plaza-content');
                if (plazaContent) showPlazaJobs(plazaContent);
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
