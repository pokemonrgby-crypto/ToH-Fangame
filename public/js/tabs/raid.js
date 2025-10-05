// /public/js/tabs/raid.js

import { db, auth, fx, func } from '../api/firebase.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-functions.js';
import { showToast } from '../ui/toast.js';
import { fetchMyChars } from '../api/store.js';

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// [신규] 레이드 설명용 리치 텍스트 렌더러
function renderRaidRichText(text) {
    if (!text) return '';
    return esc(text)
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>') // **굵게** 처리
        .replace(/\n/g, '<br>'); // 줄바꿈 처리
}


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
      padding:16px; width:92vw; max-width:560px; max-height:90vh; overflow-y:auto;
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

    /* --- 보스 정보 모달용 스타일 --- */
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
    .boss-skill-card {
      padding: 10px;
      background: var(--panel, #11151c);
    }
    .boss-phase-card {
      padding: 12px;
      border-left: 3px solid var(--bd, #212a36);
    }
    .boss-phase-card[data-phase="1"] { border-color: #f59e0b; }
    .boss-phase-card[data-phase="2"] { border-color: #ef4444; }
    .boss-phase-card[data-phase="3"] { border-color: #8b5cf6; }

    /* [추가] 메인 카드 설명 3줄 요약 스타일 */
    .description-truncate {
        display: -webkit-box;
        -webkit-line-clamp: 3;
        -webkit-box-orient: vertical;
        overflow: hidden;
        text-overflow: ellipsis;
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

// ANCHOR: [전체 교체] openBossDetailModal
async function openBossDetailModal(raidBoss) {
    ensureRaidModalCss();
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.style.zIndex = 10000;
    
    // 보스 설명 텍스트를 페이즈별로 분리
    const descText = raidBoss.description || '';
    const phase1Match = descText.match(/\[페이즈 1: 홍염의 용광로\]([\s\S]*?)(\[페이즈 2:|$)/);
    const phase2Match = descText.match(/\[페이즈 2: 격동하는 거신\]([\s\S]*?)(\[페이즈 3:|$)/);
    const phase3Match = descText.match(/\[페이즈 3: 탈출하라, 거신의 화염에게\]([\s\S]*)/);
    
    const generalDesc = descText.split('[페이즈 1:')[0].trim();
    const phase1Desc = phase1Match ? phase1Match[1].trim() : '';
    const phase2Desc = phase2Match ? phase2Match[1].trim() : '';
    const phase3Desc = phase3Match ? phase3Match[1].trim() : '';

    const skillsHtml = (raidBoss.skills || []).map(skill => `
        <div class="kv-card boss-skill-card">
            <div style="font-weight: 700;">${esc(skill.name)}</div>
            <div class="text-dim" style="font-size: 12px; margin-top: 4px; line-height: 1.6;">${renderRaidRichText(skill.description)}</div>
        </div>
    `).join('');

    back.innerHTML = `
        <div class="modal-card">
            <div class="col" style="gap: 16px;">
                <div class="col" style="align-items: center; gap: 12px; text-align: center;">
                    <img src="${esc(raidBoss.imageUrl || '')}" onerror="this.style.display='none'" 
                         style="width: 150px; height: 150px; border-radius: 50%; object-fit: cover; border: 2px solid #ff5b66;">
                    <div style="font-weight:900; font-size:22px;">${esc(raidBoss.name)}</div>
                    <p class="text-dim" style="margin: 0; line-height: 1.6;">${renderRaidRichText(generalDesc)}</p>
                </div>
                
                <div>
                    <div class="kv-label">핵심 스킬</div>
                    <div class="col" style="gap: 8px;">${skillsHtml}</div>
                </div>

                <div>
                    <div class="kv-label">페이즈 정보</div>
                    <div class="col" style="gap: 12px;">
                        ${phase1Desc ? `
                        <div class="kv-card boss-phase-card" data-phase="1">
                            <div style="font-weight: 700;">페이즈 1: 홍염의 용광로</div>
                            <p class="text-dim" style="font-size: 13px; line-height: 1.6; margin: 6px 0 0;">${renderRaidRichText(phase1Desc)}</p>
                        </div>` : ''}
                        ${phase2Desc ? `
                        <div class="kv-card boss-phase-card" data-phase="2">
                            <div style="font-weight: 700;">페이즈 2: 격동하는 거신</div>
                            <p class="text-dim" style="font-size: 13px; line-height: 1.6; margin: 6px 0 0;">${renderRaidRichText(phase2Desc)}</p>
                        </div>` : ''}
                        ${phase3Desc ? `
                        <div class="kv-card boss-phase-card" data-phase="3">
                            <div style="font-weight: 700;">페이즈 3: 탈출하라, 거신의 화염에게</div>
                            <p class="text-dim" style="font-size: 13px; line-height: 1.6; margin: 6px 0 0;">${renderRaidRichText(phase3Desc)}</p>
                        </div>` : ''}
                    </div>
                </div>
            </div>
            <button class="btn ghost" id="modal-close" style="margin-top: 24px;">닫기</button>
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
                                <p class="text-dim description-truncate" style="font-size: 13px; margin: 4px 0 0;">${esc(raidBoss.description.split('[페이즈 1:')[0].trim())}</p>
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


// ... (openCharPickerForRaid, openPartySetupModal 함수는 기존과 동일) ...
async function openCharPickerForRaid(onSelect) {
    ensureRaidModalCss();
    const myChars = await fetchMyChars(auth.currentUser.uid);
    if (myChars.length === 0) {
        showToast('레이드에 참여할 캐릭터가 없습니다.');
        return;
    }

    const back = document.createElement('div');
    back.className = 'modal-back';
    back.style.zIndex = '10001';
    back.innerHTML = `
        <div class="modal-card" style="max-width: 720px;">
          <div style="font-weight:900; font-size:18px; margin-bottom:12px;">레이드에 참여할 캐릭터 선택</div>
          <div class="grid3" style="gap:10px; max-height: 400px; overflow-y: auto;">
            ${myChars.map(char => `
              <button class="kv-card" data-char-id="${char.id}" data-guild-id="${char.guildId || ''}" style="text-align:left; cursor:pointer;">
                <div class="row" style="gap:10px; align-items:center;">
                    <img src="${esc(char.thumb_url || char.image_url)}" onerror="this.style.display='none'" style="width:56px; height:56px; border-radius:8px; object-fit:cover;">
                    <div>
                        <div style="font-weight:700;">${esc(char.name)}</div>
                        <div class="text-dim" style="font-size:12px;">Elo: ${char.elo || 1000}</div>
                    </div>
                </div>
              </button>
            `).join('')}
          </div>
          <div style="text-align:right; margin-top:12px;">
            <button class="btn ghost" id="mClose">닫기</button>
          </div>
        </div>
    `;

    document.body.appendChild(back);

    const closeModal = () => back.remove();
    back.querySelector('#mClose').onclick = closeModal;
    back.addEventListener('click', e => {
        if (e.target === back) closeModal();
    });

    back.querySelectorAll('button[data-char-id]').forEach(btn => {
        btn.onclick = () => {
            const selectedChar = {
                id: btn.dataset.charId,
                guildId: btn.dataset.guildId,
                name: btn.querySelector('div[style*="font-weight:700"]').textContent
            };
            closeModal();
            onSelect(selectedChar);
        };
    });
}

async function openPartySetupModal(raidBoss) {
    ensureRaidModalCss();
    const myChars = await fetchMyChars(auth.currentUser.uid);
    if (myChars.length === 0) {
        showToast('레이드에 참여할 내 캐릭터가 없습니다.');
        return;
    }

    let selectedChar = myChars[0]; // 기본으로 첫 번째 캐릭터 선택

    const back = document.createElement('div');
    back.className = 'modal-back';
    back.style.zIndex = 10000;

    const render = () => {
        back.innerHTML = `
            <div class="modal-card" style="max-width: 500px;">
                <div style="font-weight:900; font-size:18px; margin-bottom:12px;">레이드 파티 구성</div>
                <div class="manage-col">
                    <div>
                        <label class="manage-label">내 캐릭터:</label>
                        <div class="kv-card" id="selected-char-card" style="cursor:pointer;">
                           <div class="row" style="gap:10px; align-items:center;">
                                <img src="${esc(selectedChar.thumb_url || selectedChar.image_url)}" onerror="this.style.display='none'" style="width:48px; height:48px; border-radius:8px; object-fit:cover;">
                                <div>
                                    <div style="font-weight:700;">${esc(selectedChar.name)}</div>
                                    <div class="text-dim" style="font-size:12px;">클릭하여 변경</div>
                                </div>
                            </div>
                        </div>
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

        back.querySelector('#selected-char-card').onclick = () => {
            openCharPickerForRaid((char) => {
                selectedChar = myChars.find(c => c.id === char.id) || myChars[0];
                render(); // 선택 후 모달 다시 렌더링
            });
        };

        back.querySelector('#modal-close').onclick = closeModal;
        back.addEventListener('click', e => { if (e.target === back) closeModal(); });
        back.querySelector('#modal-start').onclick = startRaid;
    };
    
    const startRaid = async () => {
        const myCharId = selectedChar.id;
        const myGuildId = selectedChar.guildId;
        const method = back.querySelector('#party-method-select').value;

                // 👇 버튼을 미리 가져와서 비활성화 준비
        const startButton = back.querySelector('#modal-start');
        if (startButton) startButton.disabled = true;
        
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
            const startRaidFn = httpsCallable(func, 'startRaid');
            const result = await startRaidFn({ myCharId, partyCharIds: partyResult.data.partyCharIds });

            showToast('레이드 전투 시작!');
            location.hash = `#/raidlog/${result.data.logId}`;

        } catch(e) {
            showToast(`레이드 시작 실패: ${e.message}`);
            // 👇 실패 시 버튼을 다시 활성화해야 하므로, 모달을 다시 열어줍니다. (선택적)
            // openPartySetupModal(raidBoss); 
        } finally {
            showLoading(false);
            // 👇 성공/실패 여부와 관계없이 버튼 비활성화 상태는 유지되거나,
            //    모달이 닫혔으므로 별도 처리가 필요 없습니다.
        }
    };

    const closeModal = () => back.remove();
    
    render();
    document.body.appendChild(back);
}
