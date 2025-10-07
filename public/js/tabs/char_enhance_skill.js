// /public/js/tabs/char_enhance_skill.js

import { db, auth, fx, func } from '../api/firebase.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-functions.js';
import { showToast } from '../ui/toast.js';
import { confirmModal, ensureModalCss } from '../ui/modal.js';

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function parseCharId() { return new URLSearchParams(location.hash.split('?')[1] || '').get('id'); }

/**
 * [신규] 스킬 성장을 위한 프롬프트(이름, 방향)를 입력받는 모달
 * @param {object} skill - 성장시킬 스킬 객체
 * @returns {Promise<{newName: string|null, userPrompt: string}|null>}
 */
async function openEnhancePromptModal(skill) {
    ensureModalCss();
    return new Promise(resolve => {
        const back = document.createElement('div');
        back.className = 'modal-back';
        back.innerHTML = `
            <div class="modal-card" style="max-width: 560px;">
                <div style="font-weight:900; font-size:18px;">'${esc(skill.name)}' 성장</div>
                <div class="text-dim" style="font-size:13px; margin-top:4px;">스킬의 새로운 이름과 성장 방향을 AI에게 알려주세요.</div>
                
                <div style="margin-top:12px;">
                    <label class="kv-label">새로운 스킬 이름 (선택, 최대 20자)</label>
                    <input id="new-skill-name" class="input" placeholder="${esc(skill.name)}" maxlength="20">
                </div>

                <div style="margin-top:12px;">
                    <label class="kv-label">성장 방향 프롬프트 (필수, 최대 300자)</label>
                    <textarea id="skill-prompt" class="input" rows="4" placeholder="예: 좀 더 방어적으로 사용하거나, 아군을 보조하는 효과를 추가하고 싶어요." maxlength="300"></textarea>
                </div>
                
                <div class="row" style="justify-content:flex-end; gap:8px; margin-top:12px;">
                    <button id="modal-cancel" class="btn ghost">취소</button>
                    <button id="modal-ok" class="btn primary">AI에게 요청</button>
                </div>
            </div>
        `;
        document.body.appendChild(back);
        const close = (val) => { back.remove(); resolve(val); };
        
        const newNameInput = back.querySelector('#new-skill-name');
        const promptInput = back.querySelector('#skill-prompt');

        back.querySelector('#modal-cancel').onclick = () => close(null);
        back.querySelector('#modal-ok').onclick = () => {
            const userPrompt = promptInput.value.trim();
            if (!userPrompt) {
                showToast('성장 방향 프롬프트를 입력해주세요.');
                return;
            }
            close({
                newName: newNameInput.value.trim() || null,
                userPrompt
            });
        };
        back.addEventListener('click', e => { if (e.target === back) close(null); });
        promptInput.focus();
    });
}


export default async function showEnhanceSkillPage() {
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
        const totalExp = charData.exp_total || 0;

        const skills = (Array.isArray(charData.abilities_all) ? charData.abilities_all : [])
            .map((skill, index) => ({ ...skill, originalIndex: index })) // 원래 인덱스 저장
            .filter(s => s.name && s.desc_soft);

        root.innerHTML = `
            <style>
                .skill-card-enhance { border: 1px solid #2a2f36; border-radius: 12px; padding: 12px; background: #151922; }
                .skill-card-enhance[disabled] { opacity: 0.6; background: #11151c; }
                .req-met { color: #a3e635; } .req-unmet { color: #ef4444; }
            </style>
            <section class="container narrow">
                <div class="card p16">
                    <div class="row" style="justify-content:space-between">
                        <h3 style="margin-top:0">🚀 스킬 성장</h3>
                        <a href="#/char/${esc(charId)}" class="btn ghost">캐릭터로 돌아가기</a>
                    </div>
                    <div class="kv-card row" style="justify-content:space-between;">
                        <span>총 경험치: <b>${totalExp.toLocaleString()}</b></span>
                        <span>보유 코인: 🪙 <b>${currentCoins.toLocaleString()}</b></span>
                    </div>
                    <div id="skill-list" class="col" style="gap: 12px; margin-top: 16px;">
                        ${skills.length > 0 ? skills.map(skill => renderSkillCard(skill, totalExp, currentCoins)).join('') : '<div class="kv-card text-dim">성장시킬 스킬이 없습니다.</div>'}
                    </div>
                </div>
            </section>
        `;

        root.querySelectorAll('.btn-enhance').forEach(btn => {
            btn.onclick = async (e) => {
                const skillIndex = parseInt(e.currentTarget.dataset.index, 10);
                const skill = skills.find(s => s.originalIndex === skillIndex);
                if (!skill) return;

                const result = await openEnhancePromptModal(skill);
                if (result === null) return;
                const { newName, userPrompt } = result;

                btn.disabled = true;
                btn.textContent = 'AI 생성 중...';

                try {
                    const initiateEnhanceSkill = httpsCallable(func, 'initiateEnhanceSkill');
                    const response = await initiateEnhanceSkill({ charId, skillIndex, userPrompt, newName });

                    if (response.data.ok) {
                        const { enhancedSkill, cost } = response.data;
                        const confirmed = await showConfirmationModal(enhancedSkill, cost, skill);
                        if (confirmed) {
                            await applySkillEnhancement(charId, skillIndex, enhancedSkill);
                        } else {
                           showToast('성장을 취소했습니다.');
                           showEnhanceSkillPage();
                        }
                    }
                } catch (error) {
                    showToast(`성장 실패: ${error.message}`);
                    showEnhanceSkillPage();
                }
            };
        });

    } catch (error) {
        console.error("스킬 성장 페이지 로딩 실패:", error);
        root.innerHTML = `<section class="container narrow"><div class="kv-card error">${esc(error.message)}</div></section>`;
    }
}

function renderSkillCard(skill, totalExp, currentCoins) {
    const currentLevel = skill.level || 0;
    const targetLevel = currentLevel + 1;
    const costs = { 1: 100, 2: 300, 3: 500 };
    const expReqs = { 1: 1000, 2: 3000, 3: 10000 };
    const cost = costs[targetLevel];
    const expReq = expReqs[targetLevel];
    const canEnhance = targetLevel <= 3 && currentCoins >= cost && totalExp >= expReq;

    return `
        <div class="skill-card-enhance" ${!canEnhance ? 'disabled' : ''}>
            <div class="row" style="justify-content:space-between; align-items:flex-start;">
                <div>
                    <div style="font-weight:700;">${esc(skill.name)} <span class="chip">Lv.${currentLevel}</span></div>
                    <div class="text-dim" style="font-size:13px; margin-top:4px;">${esc(skill.desc_soft)}</div>
                </div>
                ${canEnhance ? `<button class="btn primary btn-enhance" data-index="${skill.originalIndex}">성장</button>` : ''}
            </div>
            ${targetLevel <= 3 ? `
            <div class="kv-card" style="margin-top:12px; padding:8px; font-size:12px;">
                <div class="kv-label">다음 레벨(Lv.${targetLevel}) 성장 조건</div>
                <div class="row" style="justify-content:space-between">
                    <span class="${totalExp >= expReq ? 'req-met' : 'req-unmet'}">총 경험치: ${expReq.toLocaleString()}</span>
                    <span class="${currentCoins >= cost ? 'req-met' : 'req-unmet'}">코인: 🪙 ${cost.toLocaleString()}</span>
                </div>
            </div>
            ` : `<div class="kv-card text-dim" style="margin-top:12px; padding:8px; font-size:12px;">최고 레벨에 도달했습니다.</div>`}
        </div>
    `;
}

async function showConfirmationModal(newSkill, cost, oldSkill) {
    ensureModalCss();
    const nameChanged = newSkill.name !== oldSkill.name;
    return new Promise(resolve => {
        const back = document.createElement('div');
        back.className = 'modal-back';
        back.innerHTML = `
            <div class="modal-card">
                <div style="font-weight:900; font-size:18px;">스킬 성장 결과 확인</div>
                <div class="kv-card" style="margin-top: 12px;">
                    <div class="kv-label">이름</div>
                    <p>
                        ${nameChanged ? `<span class="text-dim" style="text-decoration: line-through;">${esc(oldSkill.name)}</span> → ` : ''}
                        <b>${esc(newSkill.name)}</b> 
                        <span class="chip">Lv.${oldSkill.level || 0} → Lv.${newSkill.level}</span>
                    </p>
                    
                    <div class="kv-label" style="margin-top: 8px;">이전 설명</div>
                    <p class="text-dim" style="font-size:13px;">${esc(oldSkill.desc_soft)}</p>

                    <div class="kv-label" style="margin-top: 8px;">새로운 설명</div>
                    <p>${esc(newSkill.desc_soft)}</p>
                </div>
                <div class="text-dim" style="font-size:13px; margin-top: 12px;">이 내용으로 스킬을 성장시키겠습니까? (비용: 🪙 ${cost.toLocaleString()})</div>
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
                lines: ['한 번 성장시킨 스킬은 되돌릴 수 없습니다. 정말로 적용하시겠습니까?'],
                okText: '적용',
                cancelText: '취소'
            });
            if (finalConfirm) {
                close(true);
            }
        };
    });
}

async function applySkillEnhancement(charId, skillIndex, skill) {
    try {
        const confirmEnhanceSkill = httpsCallable(func, 'confirmEnhanceSkill');
        await confirmEnhanceSkill({ charId, skillIndex, enhancedSkill: skill });
        showToast('스킬을 성공적으로 성장시켰습니다!');
        location.hash = `#/char/${charId}`;
    } catch (error) {
        showToast(`적용 실패: ${error.message}`);
        showEnhanceSkillPage();
    }
}
