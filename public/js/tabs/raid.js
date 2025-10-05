// public/js/tabs/raid.js
import { db, auth, fx, func } from '../api/firebase.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-functions.js';
import { showToast } from '../ui/toast.js';
import { fetchMyChars } from '../api/store.js';

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

let raidBossCache = null;

async function getActiveRaidBoss() {
    // Basic caching to avoid frequent reads
    if (raidBossCache) return raidBossCache;
    try {
        const getRaidBoss = httpsCallable(func, 'getActiveRaidBoss'); // You need to create this function
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

    // Fetch rankings
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
                        <div class="hp-bar" style="background: linear-gradient(90deg, red ${hpPercent}%, #333 ${hpPercent}%);"></div>
                        <div class="row between">
                            <span>HP: ${raidBoss.currentHp.toLocaleString()} / ${raidBoss.totalHp.toLocaleString()}</span>
                            <span class="text-dim">남은 시간: ${days}일 ${hours}시간</span>
                        </div>
                    </div>
                    <div class="kv-card mt12">
                        <h4>기여도 랭킹</h4>
                        <div class="col" style="gap: 8px;">
                            ${rankings.map((r, i) => `
                                <div class="row between">
                                    <span>${i + 1}. ${esc(r.charName)}</span>
                                    <span>${r.totalContribution.toLocaleString()}</span>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                    <div class="center mt16">
                        <button id="btn-start-raid" class="btn large primary">레이드 시작</button>
                    </div>
                </div>
            </div>
        </section>
    `;

    document.getElementById('btn-start-raid').onclick = async () => {
        // Character selection and party formation logic here
        showToast("레이드 파티 구성 기능은 준비 중입니다.");
    };
}
