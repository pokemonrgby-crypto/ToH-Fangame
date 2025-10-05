// public/js/tabs/raidlog.js
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
 * 로그 텍스트 → 리치 HTML 변환 (수정된 최종본)
 * ------------------------------ */
function renderRichLog(logText = '', party = []) {
    if (typeof logText !== 'string') logText = String(logText ?? '');

  // [추가] 0) 줄바꿈/엔티티 정규화 (AI가 '\n'을 문자로 주는 케이스 방지)
let txt = String(logText ?? '');
// CRLF -> LF
txt = txt.replace(/\r\n?/g, '\n');
// 리터럴 '\n'을 실제 줄바꿈으로
if (txt.includes('\\n')) txt = txt.replace(/\\n/g, '\n');
// 안전한 범위의 HTML 엔티티만 복원 (이후 esc()로 다시 이스케이프됨)
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

    // 1. 대화 블록을 고유한 플레이스홀더로 먼저 분리합니다.
    const dialogues = [];
    body = body.replace(/\[대화:([^\]]+)\]「([^」]*)」/g, (match, name, line) => {
        dialogues.push({ name, line });
        return `__DIALOGUE_PLACEHOLDER_${dialogues.length - 1}__`;
    });

    // 2. 나머지 텍스트에 대해 HTML 이스케이프를 먼저 적용합니다.
    let narrativeBody = esc(body)
        // 3. 이제 안전하게 이스케이프된 특수 태그들을 HTML 태그로 되돌립니다.
        //    - 주의: 정규식에서 이스케이프된 문자를 찾아야 합니다. (예: &lbrack;)
        .replace(/\[CUT\]/g, '<div class="cut-scene" aria-hidden="true"></div>')
.replace(/\[SLOW\]([\s\S]*?)\[RESUME\]/g, '<span class="slow-motion">$1</span>')
.replace(/\[SFX\]([\s\S]*?)\[\/SFX\]/g, '<span class="sfx">$1</span>')
.replace(/\[VFX\]([\s\S]*?)\[\/VFX\]/g, '<span class="vfx">$1</span>')
.replace(/\[HUD\]([\s\S]*?)\[\/HUD\]/g, '<span class="hud">$1</span>')
.replace(/\[T\+(.*?)\]/g, '<span class="timestamp">$1</span>')
// HEART: 숫자만 뽑고, 입력에 이미 BPM이 있으면 중복 방지
.replace(/\[HEART x\s*([0-9]{2,3})(?:\s*BPM)?\]/g, (_m, bpm) => `<span class="heart">${bpm} BPM</span>`)
.replace(/\[BREATH:([^\]]+)\]/g, (_m, state) => `<i class="breath" data-state="${esc(state)}"></i>`)
.replace(/\[ITEM:(normal|rare|epic|legend|myth|aether)\]([\s\S]*?)\[\/ITEM\]/g, (_m, r, n) => {

            const color = rarityColors[r.toLowerCase()] || '#fff';
            return `<strong class="item-highlight" style="color:${color}; text-shadow:0 0 6px ${color}80;">${n}</strong>`;
        });

    // 4. 분리해두었던 대화 블록을 다시 HTML 말풍선으로 만들어 삽입합니다.
    dialogues.forEach((dialogue, index) => {
        const charIndex = party.findIndex(p => p.name === dialogue.name.trim());
        const side = (charIndex % 2 === 0) ? 'left' : 'right';
        const character = party[charIndex] || { name: dialogue.name.trim(), thumb_url: '' };
        
        // 대화 내용은 여기서 별도로 이스케이프하고 서식을 적용합니다.
        const processedLine = esc(dialogue.line).replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
      const strippedLine = processedLine.replace(/^「|」$/g, ''); // 양끝 일본 괄호 제거


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

    // 5. 최종적으로 완성된 HTML을 단락으로 나누어 반환합니다.
    const paragraphs = narrativeBody.split(/\n{2,}/)
      .map(p => p.trim())
      .filter(p => p)
      .map(p => {
          if (p.startsWith('<div class="dialogue-bubble-wrap"')) {
              return p;
          }
          return `<div class="log-paragraph">${p.replace(/\n/g, '<br>')}</div>`;
      })
      .join('');
          
      return { title: esc(titleLine), body: paragraphs };
}

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
                .contribution-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 1rem; }
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
                
                .log-paragraph { margin-bottom: 1.5rem; line-height: 1.8; }

                /* 말풍선 스타일 */
                .dialogue-bubble-wrap { display: flex; align-items: flex-start; gap: 10px; margin: 1.5rem 0; max-width: 85%; }
                .dialogue-bubble-wrap[data-side="right"] { margin-left: auto; flex-direction: row-reverse; }
                .dialogue-avatar { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; flex-shrink: 0; }
                .dialogue-bubble {
                  background: #232a3b;
                  padding: 12px 16px;
                  border-radius: 18px;
                  position: relative;
                  max-width: min(560px, 90vw); /* 너무 좁아지지 않도록 상한 설정 */
                }

                .dialogue-bubble-wrap[data-side="left"] .dialogue-bubble { border-top-left-radius: 6px; }
                .dialogue-bubble-wrap[data-side="right"] .dialogue-bubble { border-top-right-radius: 6px; background: #3b3a61; }
                .dialogue-name { font-weight: 700; font-size: 0.9rem; margin-bottom: 6px; color: #e5e7eb; }
                .dialogue-text { line-height: 1.7; }
                /* CJK(한글) 줄 양쪽정렬로 글자 벌어지는 문제 방지 */
                .log-paragraph,
                .dialogue-text {
                  text-align: start !important;    /* 상위의 justify를 덮어쓴다 */
                  text-justify: auto !important;   /* distribute 등 강제 분배 방지 */
                  letter-spacing: normal !important;
                  word-spacing: normal !important;
                  white-space: normal !important;
                  word-break: keep-all;            /* 한글 단어 단위로 줄바꿈 */
                  overflow-wrap: anywhere;         /* 긴 토큰(아이템명 등)만 적당히 줄바꿈 */
                }

                
                /* 말풍선 꼬리 */
                .dialogue-bubble::before {
                    content: ''; position: absolute; top: 10px; width: 0; height: 0;
                    border-top: 8px solid transparent; border-bottom: 8px solid transparent;
                }
                .dialogue-bubble-wrap[data-side="left"] .dialogue-bubble::before { left: -8px; border-right: 10px solid #232a3b; }
                .dialogue-bubble-wrap[data-side="right"] .dialogue-bubble::before { right: -8px; border-left: 10px solid #3b3a61; }

                /* 리치 텍스트 스타일 */
                strong { color: #facc15; font-weight: 700; }
                .vfx { font-style: italic; color: #7dd3fc; text-shadow: 0 0 8px #7dd3fc80; }
                .sfx { font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }
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
