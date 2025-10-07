// /public/js/tabs/char_enhance_skill.js

import { db, auth, fx, func } from '../api/firebase.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-functions.js';
import { showToast } from '../ui/toast.js';
import { confirmModal } from '../ui/modal.js';

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function parseCharId() { return new URLSearchParams(location.hash.split('?')[1] || '').get('id'); }

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
                .skill-card-enhance {
                    border: 1px solid #2a2f36;
                    border-radius: 12px;
                    padding: 12px;
                    background: #151922;
                }
                .skill-card-enhance[disabled] {
                    opacity: 0.6;
                    background: #11151c;
                }
                .req-met { color: #a3e635; }
                .req-unmet { color: #ef4444; }
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

                const targetLevel = (skill.level || 0) + 1;
                const costs = { 1: 100, 2: 300, 3: 500 };
                const expReqs = { 1: 1000, 2: 3000, 3: 10000 };

                if (await confirmModal({
                    title: '스킬 성장 확인',
                    lines: [
                        `'${skill.name}' 스킬을 Lv.${targetLevel}로 성장시키겠습니까?`,
                        `필요 조건: 총 경험치 ${expReqs[targetLevel].toLocaleString()}, 🪙 ${costs[targetLevel].toLocaleString()} 코인`
                    ],
                    okText: '성장시키기'
                })) {
                    btn.disabled = true;
                    btn.textContent = 'AI 생성 중...';
                    try {
                        const enhanceSkill = httpsCallable(func, 'enhanceSkill');
                        const result = await enhanceSkill({ charId, skillIndex });
                        if (result.data.ok) {
                            showToast('스킬이 성공적으로 성장했습니다!');
                            showEnhanceSkillPage(); // 페이지 새로고침
                        }
                    } catch (error) {
                        showToast(`성장 실패: ${error.message}`);
                        btn.disabled = false;
                        btn.textContent = '성장';
                    }
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
