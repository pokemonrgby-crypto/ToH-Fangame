// /public/js/tabs/raidlog.js

import { db, fx } from '../api/firebase.js';
import { showToast } from '../ui/toast.js';

/* ------------------------------
 * 유틸리티
 * ------------------------------ */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function parseLogId() {
  const m = location.hash.match(/^#\/raidlog\/([^/]+)$/);
  return m ? m[1] : null;
}

const rarityColors = {
  normal: '#c8d0dc', rare: '#cfe4ff', epic: '#e6dcff',
  legend: '#ffe9ad', myth: '#ffc9ce', aether: '#d6fff7'
};


/* ------------------------------
 * ANCHOR: [전체 교체] 리치 텍스트 렌더러 (battlelog.js와 동일하게)
 * ------------------------------ */
function renderRichLog(logText = '', party = []) {
    if (typeof logText !== 'string') logText = String(logText ?? '');

    let txt = String(logText ?? '');
    txt = txt.replace(/\r\n?/g, '\n');
    if (txt.includes('\\n')) txt = txt.replace(/\\n/g, '\n');

    txt = txt
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');

    const lines = txt.split('\n');
    while (lines.length && !lines[0].trim()) lines.shift();

    let titleLine = (lines.shift() || '레이드 기록').replace(/^배틀로그:\s*|\[AI가 생성한 제목\]\s*/i, '').trim();
    let body = lines.join('\n').trim();
    
    const dialogues = [];
    body = body.replace(/\[대화:([^\]]+)\]「([^」]*)」/g, (match, name, line) => {
        dialogues.push({ name: name.trim(), line });
        return `__DIALOGUE_PLACEHOLDER_${dialogues.length - 1}__`;
    });

    let narrativeBody = esc(body)
        .replace(/\[CUT\]/g, '<div class="cut-scene" aria-hidden="true"></div>')
        .replace(/\[SLOW\]([\s\S]*?)\[RESUME\]/g, '<span class="slow-motion">$1</span>')
        .replace(/\[SFX\]([\s\S]*?)\[\/SFX\]/g, '<span class="sfx">$1</span>')
        .replace(/\[VFX\]([\s\S]*?)\[\/VFX\]/g, '<span class="vfx">$1</span>')
        .replace(/\[HUD\]([\s\S]*?)\[\/HUD\]/g, '<span class="hud">$1</span>')
        .replace(/\[T\+(.*?)\]/g, '<span class="timestamp">$1</span>')
        .replace(/\[HEART x\s*([0-9]{2,3})(?:\s*BPM)?\]/g, (_m, bpm) => `<span class="heart">${bpm} BPM</span>`)
        .replace(/\[BREATH:([^\]]+)\]/g, (_m, state) => `<i class="breath" data-state="${esc(state)}"></i>`)
        .replace(/\[ITEM:(normal|rare|epic|legend|myth|aether|alpha|omega)\]([\s\S]*?)\[\/ITEM\]/g, (_m, r, n) => {
            const color = rarityColors[r.toLowerCase()] || '#fff';
            return `<strong class="item-highlight" style="color:${color}; text-shadow:0 0 6px ${color}80;">${n}</strong>`;
        });

    dialogues.forEach((dialogue, index) => {
        const charIndex = party.findIndex(p => p.name === dialogue.name);
        const side = (charIndex !== -1 && charIndex % 2 === 0) ? 'left' : 'right';
        const character = party[charIndex] || { name: dialogue.name, thumb_url: '' };
        
        const processedLine = esc(dialogue.line).replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        const strippedLine = processedLine.replace(/^「|」$/g, '');

        const bubbleHtml = `
          <div class="dialogue-bubble-wrap" data-side="${side}">
            <img src="${esc(character.thumb_url)}" class="dialogue-avatar" onerror="this.style.display='none'">
            <div class="dialogue-bubble">
              <div class="dialogue-name">${esc(character.name)}</div>
              <div class="dialogue-text">${strippedLine}</div>
            </div>
          </div>
        `;
        narrativeBody = narrativeBody.replace(`__DIALOGUE_PLACEHOLDER_${index}__`, bubbleHtml);
    });

    const paragraphs = narrativeBody.split(/\n{2,}/)
      .map(p => p.trim())
      .filter(p => p)
      .map(p => {
          if (p.startsWith('<div class="dialogue-bubble-wrap"')) return p;
          return `<div class="log-paragraph">${p.replace(/\n/g, '<br>')}</div>`;
      })
      .join('');
          
      return { title: esc(titleLine), body: paragraphs };
}
// ANCHOR_END

/**
 * 스크롤 애니메이션을 설정합니다.
 */
function setupScrollAnimations() {
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('is-visible');
                observer.unobserve(entry.target);
            }
        });
    }, { threshold: 0.1 });

    document.querySelectorAll('.log-paragraph, .contrib-card, .dialogue-bubble-wrap').forEach(el => {
        observer.observe(el);
    });
}

/* ------------------------------
 * 메인 렌더링
 * ------------------------------ */
export async function showRaidLog() {
    const root = document.getElementById('view');
    const logId = parseLogId();
    if (!logId) {
        root.innerHTML = `<section class="container narrow"><div class="kv-card">잘못된 로그 ID입니다.</div></section>`;
        return;
    }
    root.innerHTML = `<section class="container narrow"><div class="spin-center"></div></section>`;

    try {
        const logSnap = await fx.getDoc(fx.doc(db, 'raid_logs', logId));
        if (!logSnap.exists()) {
            root.innerHTML = `<section class="container narrow"><div class="kv-card">로그를 찾을 수 없습니다.</div></section>`;
            return;
        }
        const log = logSnap.data();
        const { title, body } = renderRichLog(log.log, log.party);
        const totalDamage = Number(log.totalDamage || 0);

        const totalContribution = (log.contributions || []).reduce((sum, c) => sum + (c.contribution || 0), 0);

        root.innerHTML = `
            <style>
                /* 전체 레이아웃과 폰트, 색상 재정의 */
                .raidlog-container { max-width: 800px; margin: 0 auto; padding: 20px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; }
                .raidlog-header { text-align: center; margin-bottom: 3rem; }
                .raidlog-title { font-size: 2.25rem; font-weight: 800; letter-spacing: -0.5px; margin: 0.5rem 0; line-height: 1.2; }
                .raidlog-subtitle { font-size: 1rem; color: #94a3b8; }

                /* 기여도 카드 디자인 */
                .contribution-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 1rem; }
                @media (max-width: 640px) { .contribution-grid { grid-template-columns: 1fr; } }
                
                .contrib-card {
                    display: flex; align-items: center; gap: 1rem; background: #1a1f2c;
                    padding: 1rem; border-radius: 12px; border: 1px solid #2a2f36;
                    opacity: 0; transform: translateY(20px); transition: opacity 0.5s ease, transform 0.5s ease;
                }
                .contrib-card.is-visible { opacity: 1; transform: translateY(0); }
                .contrib-avatar { width: 48px; height: 48px; border-radius: 50%; object-fit: cover; flex-shrink: 0; border: 2px solid #3e485e; }
                .contrib-info { flex: 1; min-width: 0; }
                .contrib-name { font-weight: 700; }
                .contrib-meta { font-size: 0.8rem; color: #94a3b8; }
                .contrib-bar { height: 6px; background: rgba(0,0,0,0.3); border-radius: 3px; margin-top: 6px; overflow: hidden; }
                .contrib-bar-inner { height: 100%; background: linear-gradient(90deg, #3b82f6, #8b5cf6); }
                
                /* 로그 본문 */
                .log-body { margin-top: 3rem; border-top: 1px solid #2a2f36; padding-top: 2rem; }
                .log-paragraph, .dialogue-bubble-wrap {
                    opacity: 0; transform: translateY(20px);
                    transition: opacity 0.6s ease-out, transform 0.6s ease-out;
                }
                .log-paragraph.is-visible, .dialogue-bubble-wrap.is-visible { opacity: 1; transform: translateY(0); }
                .log-paragraph { margin-bottom: 1.5rem; line-height: 1.8; word-break: keep-all; }

                /* 말풍선 스타일 */
                .dialogue-bubble-wrap { display: flex; align-items: flex-start; gap: 10px; margin: 1.5rem 0; max-width: 85%; }
                .dialogue-bubble-wrap[data-side="right"] { margin-left: auto; flex-direction: row-reverse; }
                .dialogue-avatar { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; flex-shrink: 0; }
                .dialogue-bubble { background: #232a3b; padding: 12px 16px; border-radius: 18px; position: relative; max-width: min(560px, 90vw); }
                .dialogue-bubble-wrap[data-side="left"] .dialogue-bubble { border-top-left-radius: 6px; }
                .dialogue-bubble-wrap[data-side="right"] .dialogue-bubble { border-top-right-radius: 6px; background: #3b3a61; }
                .dialogue-name { font-weight: 700; font-size: 0.9rem; margin-bottom: 6px; color: #e5e7eb; }
                .dialogue-text { line-height: 1.7; word-break: keep-all; }

                /* ANCHOR: [추가] 리치 텍스트 스타일 */
                .cut-scene { border: none; border-top: 1px dashed rgba(255,255,255,0.2); margin: 2em 0; }
                .slow-motion { font-style: italic; color: #a5b4fc; }
                .sfx { font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }
                .vfx { font-style: italic; color: #7dd3fc; text-shadow: 0 0 8px #7dd3fc80; }
                .hud { font-family: monospace; background: rgba(239, 68, 68, 0.2); color: #fca5a5; padding: 2px 6px; border-radius: 4px; }
            </style>

            <section class="container narrow raidlog-container">
                <header class="raidlog-header">
                    <h1 class="raidlog-title">${esc(title)}</h1>
                    <p class="raidlog-subtitle">보스: ${esc(log.raidName)} / 총 피해량: ${totalDamage.toLocaleString()}</p>
                    <button class="btn ghost" onclick="history.back()" style="margin-top: 1rem;">← 돌아가기</button>
                </header>

                <div class="contribution-grid">
                    ${(log.party || []).map((p, i) => {
                        const c = (log.contributions || []).find(con => con.charId === p.id) || { contribution: 0, exp: 0 };
                        const percentage = totalContribution > 0 ? (c.contribution / totalContribution) * 100 : 0;
                        return `
                            <a href="#/char/${esc(p.id)}" style="text-decoration: none; color: inherit;">
                                <div class="contrib-card" style="transition-delay: ${i * 100}ms;">
                                    <img src="${esc(p.thumb_url)}" class="contrib-avatar" onerror="this.style.display='none'">
                                    <div class="contrib-info">
                                        <div class="contrib-name">${esc(p.name)}</div>
                                        <div class="contrib-bar"><div class="contrib-bar-inner" style="width: ${percentage}%;"></div></div>
                                        <div class="contrib-meta">기여도: ${c.contribution.toLocaleString()} (EXP +${c.exp})</div>
                                    </div>
                                </div>
                            </a>
                        `;
                    }).join('')}
                </div>

                <div class="log-body">
                    ${body}
                </div>
            </section>
        `;
        
        setupScrollAnimations();

    } catch (e) {
        console.error("Failed to render raid log:", e);
        root.innerHTML = `<section class="container narrow"><div class="kv-card error">${esc(e.message)}</div></section>`;
    }
}
