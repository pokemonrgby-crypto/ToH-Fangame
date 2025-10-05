// pokemonrgby-crypto/toh-fangame/ToH-Fangame-3817634fe4bd22d3cff873690d80130ec120c435/public/js/tabs/raid.js
import { db, auth, fx, func } from '../api/firebase.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-functions.js';
import { showToast } from '../ui/toast.js';
import { fetchMyChars } from '../api/store.js';

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

// ... (ensureRaidModalCss, showLoading, getActiveRaidBoss, openBossDetailModal 함수는 기존과 동일) ...
function ensureRaidModalCss() {
  if (document.getElementById('toh-raid-modal-css')) return;
  const st = document.createElement('style');
  st.id = 'toh-raid-modal-css';
  st.textContent = `
    .modal-back{
      position:fixed; inset:0; z-index:9990;
      display:flex; align-items:center; justify-content:center;
      background:rgba(0,0,0,.6); backdrop-filter:blur(4px);
    }
    .modal-card{
      background:#0e1116; border:1px solid #273247; border-radius:14px;
      padding:16px; width:92vw; max-width:500px; max-height:90vh; overflow-y:auto;
    }
    /* --- 공용 레이아웃 --- */
    .col{ display:flex; flex-direction:column; }
    .row{ display:flex; align-items:center; }
    .text-dim{ color: var(--muted, #7a828e); }

    /* --- 파티 구성 모달용 스타일 --- */
    .manage-col { display: flex; flex-direction: column; gap: 12px; }
    .manage-label { font-size:13px; color:var(--muted); margin-bottom: 4px; display: block; }
    .manage-select {
        flex: 1;
        background: var(--bg, #0c0f14);
        color: var(--text, #eef1f6);
        border: 1px solid var(--bd, #212a36);
        border-radius: 10px;
        padding: 10px;
        font-size: 14px;
        width: 100%;
    }

    /* --- [추가] 보스 정보 모달용 스타일 --- */
    .kv-card {
        background: var(--panel-quote, #181e29);
        border: 1px solid var(--bd, #212a36);
        border-radius: 10px;
        padding: 12px;
        color: var(--text, #eef1f6);
    }
    .kv-label {
        color: var(--muted, #7a828e);
        font-size: 13px;
        margin-bottom: 8px;
        font-weight: 500;
    }
  `;
  document.head.appendChild(st);
}


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
    try {
        const getRaidBoss = httpsCallable(func, 'getActiveRaidBoss');
        const result = await getRaidBoss();
        return result.data;
    } catch (e) {
        console.error("Error fetching raid boss:", e);
        return null;
    }
}

async function openBossDetailModal(raidBoss) {
    ensureRaidModalCss(); // [수정] 강화된 CSS 주입 함수 호출
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.style.zIndex = 10000;
    
    const skillsHtml = (raidBoss.skills || []).map(skill => `
        <div class="kv-card" style="padding: 10px;">
            <div style="font-weight: 700;">${esc(skill.name)}</div>
            <div class="text-dim" style="font-size: 12px; margin-top: 4px;">${esc(skill.description)}</div>
        </div>
    `).join('');

    back.innerHTML = `
        <div class="modal-card" style="max-width: 500px;">
            <div style="display: flex; flex-direction: column; align-items: center; gap: 12px;">
                <img src="${esc(raidBoss.imageUrl || '')}" onerror="this.style.display='none'" style="width: 150px; height: 150px; border-radius: 50%; object-fit: cover; border: 2px solid #ff5b66;">
                <div style="font-weight:900; font-size:20px;">${esc(raidBoss.name)}</div>
                <p class="text-dim" style="text-align: center; margin: 0;">${esc(raidBoss.description)}</p>
            </div>
            <div class="kv-label" style="margin-top: 24px;">보스 스킬</div>
            <div class="col" style="gap: 8px;">
                ${skillsHtml}
            </div>
            <button class="btn ghost" id="modal-close" style="margin-top: 16px;">닫기</button>
        </div>
    `;

    document.body.appendChild(back);
    const closeModal = () => back.remove();
    back.querySelector('#modal-close').onclick = closeModal;
    back.addEventListener('click', e => { if (e.target === back) closeModal(); });
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
                    <div class="kv-card" id="raid-boss-card" style="cursor: pointer;">
                        <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
                            <img src="${esc(raidBoss.imageUrl || '')}" onerror="this.style.display='none'" style="width: 64px; height: 64px; border-radius: 10px; object-fit: cover; background: #111;">
                            <div>
                                <h3 style="margin:0;">${esc(raidBoss.name)}</h3>
                                <p class="text-dim" style="font-size: 13px; margin: 4px 0 0;">${esc(raidBoss.description)}</p>
                            </div>
                        </div>
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

    document.getElementById('raid-boss-card').onclick = () => openBossDetailModal(raidBoss);
    document.getElementById('btn-start-raid').onclick = () => openPartySetupModal(raidBoss);
}


async function openPartySetupModal(raidBoss) {
    ensureRaidModalCss();
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
                <div>
                    <label class="manage-label">내 캐릭터 선택:</label>
                    <select id="my-char-select" class="manage-select">
                        ${myChars.map(c => `<option value="${c.id}" data-guild-id="${c.guildId || ''}">${esc(c.name)}</option>`).join('')}
                    </select>
                </div>
                <div>
                    <label class="manage-label">파티원 구성 방식:</label>
                    <select id="party-method-select" class="manage-select">
                        <option value="guild">길드원 중에서</option>
                        <option value="random" selected>랜덤 매칭</option>
                    </select>
                </div>
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
    back.addEventListener('click', e => { if (e.target === back) closeModal(); });

    back.querySelector('#modal-start').onclick = async () => {
        const charSelect = back.querySelector('#my-char-select');
        const myCharId = charSelect.value;
        const selectedOption = charSelect.options[charSelect.selectedIndex];
        const myGuildId = selectedOption.dataset.guildId;
        const method = back.querySelector('#party-method-select').value;
        
        closeModal();
        
        let findPartyFn;
        let payload;
        let loadingText;

        if (method === 'guild') {
            if (!myGuildId) {
                showToast('선택한 캐릭터가 길드에 소속되어 있지 않습니다.');
                return;
            }
            findPartyFn = httpsCallable(func, 'findGuildPartyForRaid');
            payload = { myCharId, guildId: myGuildId };
            loadingText = '길드원 파티 찾는 중...';
        } else {
            findPartyFn = httpsCallable(func, 'findRandomPartyForRaid');
            payload = { myCharId };
            loadingText = '랜덤 파티원 찾는 중...';
        }

        showLoading(true, loadingText);
        
        try {
            const partyResult = await findPartyFn(payload);
            
            showLoading(true, '레이드 전투 생성 중...');
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
