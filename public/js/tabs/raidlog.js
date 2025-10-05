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
    // [수정] 원본 텍스트를 먼저 이스케이프 처리하지 않고, 각 태그를 처리한 후 내용만 이스케이프합니다.
    let html = logText || '';

    // HTML과 유사한 문자를 먼저 처리하여 충돌을 방지합니다.
    html = html.replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // [수정] 정규식 패턴을 HTML 엔티티 코드(e.g., &#91;)가 아닌 실제 문자(e.g., \[)를 찾도록 변경했습니다.
    html = html.replace(/\[CUT\]/g, '<div class="cut-scene"></div>');
    html = html.replace(/\[SLOW\]([\s\S]*?)\[RESUME\]/gs, (m, c) => `<span class="slow-motion">${esc(c)}</span>`);
    html = html.replace(/\[SFX\]([\s\S]*?)\[\/SFX\]/g, (m, c) => `<span class="sfx">${esc(c)}</span>`);
    html = html.replace(/\[VFX\]([\s\S]*?)\[\/VFX\]/g, (m, c) => `<span class="vfx">${esc(c)}</span>`);
    html = html.replace(/\[HUD\]([\s\S]*?)\[\/HUD\]/g, (m, c) => `<span class="hud">${esc(c)}</span>`);
    html = html.replace(/\[T\+(.*?)\]/g, (m, c) => `<span class="timestamp">${esc(c)}</span>`);
    html = html.replace(/\[HEART x (.*?)\]/g, (m, c) => `<span class="heart">${esc(c)} BPM</span>`);
    html = html.replace(/\[BREATH:(.*?)\]/g, (m, c) => `<span class="breath">${esc(c)}</span>`);

    html = html.replace(/(?:`|'|")?\*\*([\s\S]*?)\*\*(?:`|'|")?/g, '<strong>$1</strong>');

    html = html.replace(/\[ITEM:(normal|rare|epic|legend|myth|aether)\]([\s\S]*?)\[\/ITEM\]/g, (m, r, n) => {
        const color = rarityColors[r.toLowerCase()] || '#fff';
        return `<strong class="item-highlight" style="color: ${color}; text-shadow: 0 0 5px ${color}80;">${esc(n)}</strong>`;
    });

    html = html.replace(/\[대화:(.*?)\]\s*"(.*?)"/g, (match, charName, text) => {
        const char = party.find(p => p.name === charName.trim());
        const charIndex = party.findIndex(p => p.name === charName.trim()) + 1;
        const dialogueContent = esc(text);

        if (!char) {
            return `<div class="dialogue"><b>${esc(charName)}:</b> ${dialogueContent}</div>`;
        }
        return `<div class="dialogue c${charIndex}"><b>${esc(char.name)}:</b> ${dialogueContent}</div>`;
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

    // [수정] log.log 필드에서 제목을 추출하고 "배틀로그: " 접두사를 제거합니다.
    const logLines = (log.log || '').split('\n');
    const title = (logLines.shift() || '레이드 기록').replace(/^배틀로그:\s*/, '');
    const content = logLines.join('\n').trim();

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
            
            .sfx, .vfx, .hud, .timestamp, .heart, .breath { display: inline; font-size: 0.9em; opacity: 0.7; }
            .sfx { font-style: italic; }
            .vfx { font-style: italic; color: #7dd3fc; }
            .hud { font-family: 'SF Mono', 'Roboto Mono', Menlo, monospace; font-weight: 600; color: #a7f3d0; background: rgba(6, 78, 59, 0.4); padding: 2px 5px; border-radius: 4px; border: 1px solid rgba(16, 185, 129, 0.3); }
            .timestamp::before { content: 'T+'; }
            .timestamp, .heart { font-family: 'SF Mono', 'Roboto Mono', Menlo, monospace; color: #9ca3af; }
            .breath::before { content: '['; }
            .breath::after { content: ']'; }
            .cut-scene { text-align: center; margin: 2em 0; height: 1px; background: linear-gradient(to right, transparent, rgba(255,255,255,0.2), transparent); }
            .slow-motion { font-style: italic; letter-spacing: 0.5px; }
            .item-highlight { font-weight: 800; text-shadow: 0 0 6px var(--color-shadow, rgba(255,255,255,0.5)); }
        </style>
        <section class="container narrow">
            <div class="card p16">
                <button class="btn ghost" onclick="history.back()">← 뒤로가기</button>
                
                <h1 class="mt12" style="font-size: 24px; font-weight: 900; text-align: center; margin-bottom: 16px;">${esc(title)}</h1>

                <div class="mt16">
                    <h3 style="margin-top:0; margin-bottom: 8px; font-size: 16px; color: var(--muted);">전투 결과</h3>
                    <div style="text-align:center; margin-bottom: 12px; font-size: 14px;">총 피해량: <strong>${log.totalDamage.toLocaleString()}</strong></div>
                    <div class="contribution-grid">
                        ${(log.contributions || []).map(c => {
                            const p = (log.party || []).find(p => p.id === c.charId) || { id: c.charId, name: 'Unknown', thumb_url: '' };
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
                
                <h3 class="mt12" style="font-size: 16px; color: var(--muted);">전투 기록</h3>
                <div class="log-content mt12" style="white-space: pre-wrap; line-height: 1.7;">
                    ${renderRichLog(content, log.party)}
                </div>
            </div>
        </section>
    `;
}
