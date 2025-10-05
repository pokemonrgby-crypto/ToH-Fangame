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
    // [수정] 먼저 전체를 이스케이프하지 않고, 각 태그를 처리하면서 내용만 이스케이프합니다.
    let html = logText || '';

    // 1. 강조: **text** -> <strong>text</strong>
    html = html.replace(/\*\*(.*?)\*\*/g, (match, content) => `<strong>${esc(content)}</strong>`);
    
    // 2. 대사: [대화:이름]"대사" -> <div class="dialogue"><name>: text</div>
    // AI 프롬프트와 일치하도록 정규식을 수정하고, 이름으로 캐릭터를 찾습니다.
    html = html.replace(/\[대화:(.*?)\]"(.*?)"/g, (match, charName, text) => {
        const char = party.find(p => p.name === charName.trim());
        const charIndex = party.findIndex(p => p.name === charName.trim()) + 1;
        
        if (!char) {
            // 파티 목록에 없는 이름이면 이름만 표시
            return `<div class="dialogue"><b>${esc(charName)}:</b> ${esc(text)}</div>`;
        }
        // 파티에 있으면 c1, c2, c3, c4 클래스로 색상 부여
        return `<div class="dialogue c${charIndex}"><b>${esc(char.name)}:</b> ${esc(text)}</div>`;
    });

    // 3. 아이템: [ITEM:rarity]name[/ITEM]
    html = html.replace(/\[ITEM:(normal|rare|epic|legend|myth|aether)\](.*?)\[\/ITEM\]/g, (match, rarity, itemName) => {
        const color = rarityColors[rarity.toLowerCase()] || '#fff';
        return `<strong style="color: ${color}; text-shadow: 0 0 4px ${color}80;">${esc(itemName)}</strong>`;
    });

    // 4. 줄바꿈 처리: 최종적으로 남은 텍스트의 줄바꿈만 <br>로 변경합니다.
    // [수정] 마지막에 전체를 esc()로 감싸던 부분을 제거했습니다.
    return html.replace(/\n/g, '<br>');
}



export async function showRaidLog() {
    // (이 함수 내의 다른 부분은 수정할 필요가 없습니다.)
// (기존 내용과 동일)
// ...
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
