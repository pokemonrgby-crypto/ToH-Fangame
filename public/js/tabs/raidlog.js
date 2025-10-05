// public/js/tabs/raidlog.js
import { db, fx } from '../api/firebase.js';
import { showToast } from '../ui/toast.js';

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

function parseLogId() {
    const m = location.hash.match(/^#\/raidlog\/([^/]+)$/);
    return m ? m[1] : null;
}

const rarityColors = {
    normal: '#c8d0dc', rare: '#cfe4ff', epic: '#e6dcff',
    legend: '#ffe9ad', myth: '#ffc9ce', aether: '#f8f8f2'
};

function renderRichLog(logText, party) {
    let html = esc(logText);
    // 1. 강조: **text** -> <strong>text</strong>
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    // 2. 대사: <1>text</1> -> <div class="dialogue c1"><name>: text</div>
    html = html.replace(/<(\d)>(.*?)<\/\1>/g, (match, charIndex, text) => {
        const char = party[parseInt(charIndex, 10) - 1];
        return `<div class="dialogue c${charIndex}"><b>${esc(char.name)}:</b> ${esc(text)}</div>`;
    });
    // 3. 아이템: [ITEM:rarity]name[/ITEM]
    html = html.replace(/\[ITEM:(normal|rare|epic|legend|myth|aether)\](.*?)\[\/ITEM\]/g, (match, rarity, itemName) => {
        const color = rarityColors[rarity.toLowerCase()] || '#fff';
        return `<strong style="color: ${color}; text-shadow: 0 0 4px ${color}80;">${esc(itemName)}</strong>`;
    });
    return html.replace(/\n/g, '<br>');
}


export async function showRaidLog() {
    const root = document.getElementById('view');
    const logId = parseLogId();
    if (!logId) {
        root.innerHTML = `<section class="container narrow"><div class="kv-card">잘못된 로그 ID입니다.</div></section>`;
        return;
    }
    root.innerHTML = `<section class="container narrow"><div class="spin-center"></div></section>`;

    const logSnap = await fx.getDoc(fx.doc(db, 'raid_logs', logId));
    if (!logSnap.exists()) {
        root.innerHTML = `<section class="container narrow"><div class="kv-card">로그를 찾을 수 없습니다.</div></section>`;
        return;
    }
    const log = logSnap.data();

    root.innerHTML = `
        <style>
            .dialogue { margin: 1em 0; padding: 0.8em 1em; border-radius: 8px; background: #1a1f2c; border-left: 3px solid #555; }
            .dialogue.c1 { border-color: #4CAF50; }
            .dialogue.c2 { border-color: #2196F3; }
            .dialogue.c3 { border-color: #FFC107; }
            .dialogue.c4 { border-color: #E91E63; }
        </style>
        <section class="container narrow">
            <div class="card p16">
                <button class="btn ghost" onclick="history.back()">← 뒤로가기</button>
                <h3 class="mt12">레이드 전투 기록: ${esc(log.raidName)}</h3>
                <div class="log-content mt12" style="white-space: pre-wrap; line-height: 1.7;">
                    ${renderRichLog(log.log, log.party)}
                </div>
                <div class="mt16">
                    <h4>전투 결과</h4>
                    <p>총 피해량: <strong>${log.totalDamage.toLocaleString()}</strong></p>
                    <h5>개별 기여도:</h5>
                    <ul>
                        ${log.contributions.map(c => `<li><strong>${esc(log.party.find(p => p.id === c.charId)?.name || 'Unknown')}</strong>: ${c.contribution.toLocaleString()} (EXP +${c.exp})</li>`).join('')}
                    </ul>
                </div>
            </div>
        </section>
    `;
}
