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

/**
 * AI가 생성한 로그 텍스트를 풍부한 효과가 적용된 HTML로 변환합니다.
 * @param {string} logText - AI가 생성한 원본 로그 문자열
 * @param {Array} party - 파티원 정보 배열
 * @returns {{title: string, body: string}} - 파싱된 제목과 본문 HTML
 */
function renderRichLog(logText = '', party = []) {
    if (typeof logText !== 'string') logText = String(logText ?? '');

    const lines = logText.split('\n');
    let titleLine = (lines.shift() || '레이드 기록').replace(/^배틀로그:\s*/, '');
    let body = lines.join('\n').trim();

    // 사용자 정의 태그를 HTML로 변환
    body = esc(body)
        .replace(/\[CUT\]/g, '<div class="cut-scene" aria-hidden="true"></div>')
        .replace(/\[SLOW\]([\s\S]*?)\[RESUME\]/g, '<span class="slow-motion">$1</span>')
        .replace(/\[SFX\]([\s\S]*?)\[\/SFX\]/g, '<span class="sfx">$1</span>')
        .replace(/\[VFX\]([\s\S]*?)\[\/VFX\]/g, '<span class="vfx">$1</span>')
        .replace(/\[HUD\]([\s\S]*?)\[\/HUD\]/g, '<span class="hud">$1</span>')
        .replace(/\[T\+(.*?)\]/g, '<span class="timestamp">$1</span>')
        .replace(/\[HEART x (.*?)\]/g, '<span class="heart">$1 BPM</span>')
        .replace(/\[BREATH:([^\]]+)\]/g, (m, state) => `<i class="breath" data-state="${esc(state)}"></i>`)
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\[ITEM:(normal|rare|epic|legend|myth|aether)\]([\s\S]*?)\[\/ITEM\]/g, (m, r, n) => {
            const color = rarityColors[r.toLowerCase()] || '#fff';
            return `<strong class="item-highlight" style="color:${color}; text-shadow:0 0 6px ${color}80;">${n}</strong>`;
        })
        .replace(/\[대화:([^\]]+)\]"([^"]*)"/g, (m, name, line) => {
            const charIndex = party.findIndex(p => p.name === name.trim()) + 1;
            return `<div class="dialogue c${charIndex}"><b>${esc(name)}:</b> “${esc(line)}”</div>`;
        });

    // 두 줄 개행을 기준으로 단락을 나누어 애니메이션 대상으로 삼습니다.
    const paragraphs = body.split(/\n{2,}/)
        .map(p => p.replace(/\n/g, '<br>')) // 단락 내 한 줄 개행은 <br>로 처리
        .filter(p => p.trim())
        .map(p => `<div class="log-paragraph">${p}</div>`)
        .join('');
        
    return { title: titleLine, body: paragraphs };
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
    }, { threshold: 0.1 }); // 요소가 10% 보이면 애니메이션 시작

    document.querySelectorAll('.log-paragraph, .contrib-card').forEach(el => {
        observer.observe(el);
    });
}

/**
 * 레이드 로그 페이지의 메인 렌더링 함수
 */
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

        root.innerHTML = `
            <style>
                /* 전체적인 레이아웃과 색상 재정의 */
                .raidlog-container { max-width: 800px; margin: 0 auto; padding: 20px; font-family: 'Pretendard', sans-serif; }
                .raidlog-header { text-align: center; margin-bottom: 2.5rem; }
                .raidlog-title { font-size: 2rem; font-weight: 800; letter-spacing: -0.5px; margin: 0.5rem 0; }
                .raidlog-subtitle { font-size: 1rem; color: var(--muted, #94a3b8); }

                /* 기여도 카드 디자인 */
                .contribution-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 1rem; margin-top: 1.5rem; }
                @media (max-width: 640px) { .contribution-grid { grid-template-columns: 1fr; } }
                
                .contrib-card {
                    display: flex; align-items: center; gap: 1rem;
                    background: rgba(255, 255, 255, 0.03);
                    padding: 1rem; border-radius: 12px;
                    border: 1px solid rgba(255, 255, 255, 0.08);
                    transition: all 0.3s ease;
                    /* 스크롤 애니메이션 초기 상태 */
                    opacity: 0; transform: translateY(20px);
                }
                .contrib-card.is-visible { opacity: 1; transform: translateY(0); }
                .contrib-avatar { width: 48px; height: 48px; border-radius: 50%; object-fit: cover; flex-shrink: 0; border: 2px solid rgba(255,255,255,0.1); }
                .contrib-info { flex: 1; min-width: 0; }
                .contrib-name { font-weight: 700; }
                .contrib-meta { font-size: 0.8rem; color: var(--muted, #94a3b8); }
                .contrib-bar { height: 6px; background: rgba(0,0,0,0.2); border-radius: 3px; margin-top: 6px; overflow: hidden; }
                .contrib-bar-inner { height: 100%; background: linear-gradient(90deg, #3b82f6, #8b5cf6); }
                
                /* 로그 본문 디자인 */
                .log-body { margin-top: 2.5rem; border-top: 1px solid rgba(255, 255, 255, 0.1); padding-top: 2rem; }
                .log-paragraph {
                    margin-bottom: 1.5rem; line-height: 1.8;
                    /* 스크롤 애니메이션 초기 상태 */
                    opacity: 0; transform: translateY(20px);
                    transition: opacity 0.6s ease-out, transform 0.6s ease-out;
                }
                .log-paragraph.is-visible { opacity: 1; transform: translateY(0); }

                /* 리치 텍스트 스타일 */
                .dialogue { margin: 1em 0; padding: 0.8em 1.2em; border-radius: 8px; background: rgba(255,255,255,0.05); border-left: 3px solid #8b5cf6; }
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
                        const percentage = totalDamage > 0 ? (c.contribution / totalDamage) * 100 : 0;
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
        
        // 렌더링 후 스크롤 애니메이션 설정
        setupScrollAnimations();

    } catch (e) {
        console.error("Failed to render raid log:", e);
        root.innerHTML = `<section class="container narrow"><div class="kv-card error">${esc(e.message)}</div></section>`;
    }
}
