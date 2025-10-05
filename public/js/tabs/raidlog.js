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
    let html = logText || '';

    // 1. 강조: **text** -> <strong>text</strong>
    // 이 처리가 먼저 실행되어야 대사 안의 강조도 반영됩니다.
    html = html.replace(/\*\*(.*?)\*\*/g, (match, content) => `<strong>${esc(content)}</strong>`);

    // 2. 대사: [대화:이름]"대사" -> <div class="dialogue"><name>: text</div>
    html = html.replace(/\[대화:(.*?)\]"(.*?)"/g, (match, charName, text) => {
        const char = party.find(p => p.name === charName.trim());
        const charIndex = party.findIndex(p => p.name === charName.trim()) + 1;
        
        // ANCHOR: [수정] 대사 내용(text)을 esc()로 감싸지 않아 내부의 <strong> 태그가 유지되도록 합니다.
        const dialogueContent = text; 

        if (!char) {
            return `<div class="dialogue"><b>${esc(charName)}:</b> ${dialogueContent}</div>`;
        }
        return `<div class="dialogue c${charIndex}"><b>${esc(char.name)}:</b> ${dialogueContent}</div>`;
    });

    // 3. 아이템: [ITEM:rarity]name[/ITEM]
    html = html.replace(/\[ITEM:(normal|rare|epic|legend|myth|aether)\](.*?)\[\/ITEM\]/g, (match, rarity, itemName) => {
        const color = rarityColors[rarity.toLowerCase()] || '#fff';
        return `<strong style="color: ${color}; text-shadow: 0 0 4px ${color}80;">${esc(itemName)}</strong>`;
    });

    // 4. 줄바꿈 처리
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
            
            .contribution-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
            @media (max-width: 500px) { .contribution-grid { grid-template-columns: 1fr; } }
            .contrib-card { display: flex; align-items: center; gap: 10px; background: #151922; padding: 10px; border-radius: 10px; transition: background-color 0.2s; }
            .contrib-card:hover { background-color: #1f2738; }
            .contrib-avatar { width: 48px; height: 48px; border-radius: 50%; object-fit: cover; background: #0e1116; flex-shrink: 0; }
        </style>
        <section class="container narrow">
            <div class="card p16">
                <button class="btn ghost" onclick="history.back()">← 뒤로가기</button>
                
                <div class="mt16">
                    <h3 style="margin-top:0; text-align:center;">전투 결과</h3>
                    <div style="text-align:center; margin-bottom: 12px;">총 피해량: <strong>${log.totalDamage.toLocaleString()}</strong></div>
                    <div class="contribution-grid">
                        ${(log.contributions || []).map(c => {
                            const p = (log.party || []).find(p => p.id === c.charId) || { id: c.charId, name: 'Unknown', thumb_url: '' };
                            // ANCHOR: [수정] a 태그로 카드 전체를 감싸서 링크로 만듭니다.
                            return `
                                <a href="#/char/${esc(p.id)}" style="text-decoration: none; color: inherit;">
                                    <div class="contrib-card">
                                        <img src="${esc(p.thumb_url)}" class="contrib-avatar" onerror="this.style.display='none'">
                                        <div>
                                            <div style="font-weight: 700;">${esc(p.name)}</div>
                                            <div class="text-dim" style="font-size: 12px;">
                                                기여도: ${c.contribution.toLocaleString()} (EXP +${c.exp})
                                            </div>
                                        </div>
                                    </div>
                                </a>
                            `;
                        }).join('')}
                    </div>
                </div>

                <hr style="margin: 24px 0; border-color: #2a2f36;">
                
                <h3 class="mt12" style="text-align:center;">${esc(log.raidName)} 전투 기록</h3>
                <div class="log-content mt12" style="white-space: pre-wrap; line-height: 1.7;">
                    ${renderRichLog(log.log, log.party)}
                </div>
            </div>
        </section>
    `;
}
