// public/js/tabs/raid.js
import { db, auth, fx, func } from '../api/firebase.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-functions.js';
import { showToast } from '../ui/toast.js';
import { fetchMyChars } from '../api/store.js';
import { ensureModalCss } from '../ui/modal.js';

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

let raidBossCache = null;

// 로딩 오버레이 함수 추가
function showLoading(show = true, text = '처리 중...') {
    let overlay = document.getElementById('toh-loading-overlay');
    if (show) {
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'toh-loading-overlay';
            overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:9999;color:white;`;
            document.body.appendChild(overlay);
        }
        overlay.innerHTML = `<div>${text}</div>`;
        overlay.style.display = 'flex';
    } else {
        if (overlay) overlay.style.display = 'none';
    }
}


async function getActiveRaidBoss() {
    // 캐시를 사용하지 않고 항상 새로 불러옵니다.
    try {
        const getRaidBoss = httpsCallable(func, 'getActiveRaidBoss');
        const result = await getRaidBoss();
        raidBossCache = result.data;
        return raidBossCache;
    } catch (e) {
        console.error("Error fetching raid boss:", e);
        return null;
    }
}

export async function showRaid() {
    const root = document.getElementById('view');
    root.innerHTML = `<section class="container narrow"><div class="spin-center"></div></section>`;

    const raidBoss = await getActiveRaidBoss();

    if (!raidBoss) {
        root.innerHTML = `<section class="container narrow"><div class="kv-card text-dim">현재 진행 중인 레이드가 없습니다.</div></section>`;
        return;
    }

    const hpPercent = (raidBoss.currentHp / raidBoss.totalHp) * 100;
    const timeLeft = new Date(raidBoss.endsAt._seconds * 1000) - Date.now();
    const days = Math.floor(timeLeft / (1000 * 60 * 60 * 24));
    const hours = Math.floor((timeLeft % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

    const getRaidRankings = httpsCallable(func, 'getRaidRankings');
    const rankingsResult = await getRaidRankings({ raidId: raidBoss.id });
    const rankings = rankingsResult.data.rankings || [];

    root.innerHTML = `
        <section class="container narrow">
            <div class="book-card">
                <div class="bookmarks">
                    <a href="#/adventure" class="bookmark">🗺️ 모험</a>
                    <a href="#/raid" class="bookmark active">⚔️ 레이드</a>
                </div>
                <div class="bookview p12">
                    <div class="kv-card">
                        <h3>${esc(raidBoss.name)}</h3>
                        <p class="text-dim">${esc(raidBoss.description)}</p>
                        <div style="height:12px; background:#1a2230; border-radius:8px; overflow:hidden; border:1px solid #2a3346;">
                            <div style="width:${hpPercent}%; height:100%; background:#ff7a7a; transition: width 0.5s ease;"></div>
                        </div>
                        <div class="row" style="justify-content:space-between; font-size:12px; margin-top: 6px;">
                            <span>HP: ${raidBoss.currentHp.toLocaleString()} / ${raidBoss.totalHp.toLocaleString()}</span>
                            <span class="text-dim">남은 시간: ${days}일 ${hours}시간</span>
                        </div>
                    </div>
                    <div class="kv-card mt12">
                        <h4>기여도 랭킹 (Top 10)</h4>
                        <div class="col" style="gap: 8px;">
                            ${rankings.length > 0 ? rankings.map((r, i) => `
                                <div class="row" style="justify-content:space-between">
                                    <span>${i + 1}. ${esc(r.charName)}</span>
                                    <span>${r.totalContribution.toLocaleString()}</span>
                                </div>
                            `).join('') : '<div class="text-dim">아직 참여자가 없습니다.</div>'}
                        </div>
                    </div>
                    <div class="center mt16">
                        <button id="btn-start-raid" class="btn large primary">레이드 파티 구성</button>
                    </div>
                </div>
            </div>
        </section>
    `;

    document.getElementById('btn-start-raid').onclick = () => openPartySetupModal(raidBoss);
}

async function openPartySetupModal(raidBoss) {
    ensureModalCss(); // 모달 CSS 주입
    const myChars = await fetchMyChars(auth.currentUser.uid);
    if (myChars.length === 0) {
        showToast('레이드에 참여할 내 캐릭터가 없습니다.');
        return;
    }

    const back = document.createElement('div');
    back.className = 'modal-back';
    back.style.zIndex = 10000;
    back.innerHTML = `
        <div class="modal-card" style="max-width: 500px;">
            <div style="font-weight:900; font-size:18px; margin-bottom:12px;">레이드 파티 구성</div>
            <div class="manage-col">
                <label class="manage-label">내 캐릭터 선택:</label>
                <select id="my-char-select" class="manage-select">
                    ${myChars.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
                </select>
                <label class="manage-label" style="margin-top:12px;">파티원 구성 방식:</label>
                <select id="party-method-select" class="manage-select">
                    <option value="guild">길드원 중에서 (곧 지원 예정)</option>
                    <option value="random" selected>랜덤 매칭</option>
                </select>
            </div>
            <div class="row" style="justify-content:flex-end; gap:8px; margin-top:16px;">
                <button class="btn ghost" id="modal-close">취소</button>
                <button class="btn primary" id="modal-start">레이드 시작</button>
            </div>
        </div>
    `;

    document.body.appendChild(back);
    const closeModal = () => back.remove();
    back.querySelector('#modal-close').onclick = closeModal;
    back.querySelector('#modal-start').onclick = async () => {
        const myCharId = back.querySelector('#my-char-select').value;
        const method = back.querySelector('#party-method-select').value;
        
        closeModal();
        showLoading(true, '레이드 전투 생성 중...');
        
        try {
            // 현재는 랜덤 매칭만 지원
            const findParty = httpsCallable(func, 'findRandomPartyForRaid');
            const partyResult = await findParty({ myCharId });
            
            const startRaid = httpsCallable(func, 'startRaid');
            const result = await startRaid({ myCharId, partyCharIds: partyResult.data.partyCharIds });

            showToast('레이드 전투 시작!');
            location.hash = `#/raidlog/${result.data.logId}`;

        } catch(e) {
            showToast(`레이드 시작 실패: ${e.message}`);
        } finally {
            showLoading(false);
        }
    };
}
