// /public/js/tabs/battlelog.js
import { db, auth, fx } from '../api/firebase.js';
import { createOrUpdateRelation, getRelationBetween, getBattleLog } from '../api/store.js';
import { showToast } from '../ui/toast.js';
import { prettyTime } from '../ui/utils.js';
/* ------------------------------
 * 유틸리티
 * ------------------------------ */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function parseLogId() {
  const m = location.hash.match(/^#\/battlelog\/([^/]+)$/);
  return m ? m[1] : null;
}

const rarityColors = {
  normal: '#c8d0dc', rare: '#cfe4ff', epic: '#e6dcff',
  legend: '#ffe9ad', myth: '#ffc9ce', aether: '#d6fff7'
};

/* ------------------------------
 * 리치 텍스트 렌더링 (신규)
 * ------------------------------ */
function renderRichLog(logText = '', party = []) {
    if (typeof logText !== 'string') logText = String(logText ?? '');

    let txt = logText.replace(/\r\n?/g, '\n');
    if (txt.includes('\\n')) txt = txt.replace(/\\n/g, '\n');

    const dialogues = [];
    // [대사:0]「대사」[/대사] 형식을 먼저 플레이스홀더로 분리
    txt = txt.replace(/\[대사:(\d)\]「([^」]*)」\[\/대사\]/g, (match, charIndex, line) => {
        dialogues.push({ charIndex: parseInt(charIndex, 10), line });
        return `__DIALOGUE_PLACEHOLDER_${dialogues.length - 1}__`;
    });

    // 나머지 텍스트 이스케이프 및 태그 변환
    let narrativeBody = esc(txt)
        .replace(/\[CUT\]/g, '<hr class="rich-cut">')
        .replace(/\[SFX:small\]([^\[]+?)\[\/SFX\]/g, '<span class="rich-sfx-small">$1</span>')
        .replace(/\[SFX:big\]([^\[]+?)\[\/SFX\]/g, '<strong class="rich-sfx-big">$1</strong>')
        .replace(/\[VFX\]([^\[]+?)\[\/VFX\]/g, '<span class="rich-vfx">$1</span>')
        .replace(/\[ITEM:(normal|rare|epic|legend|myth|aether)\]([^\[]+?)\[\/ITEM\]/g, (_m, r, n) => {
            const color = rarityColors[r.toLowerCase()] || '#fff';
            return `<strong class="item-highlight" style="color:${color}; text-shadow:0 0 6px ${color}80;">${n}</strong>`;
        });

    // 분리했던 대화 블록을 말풍선 HTML로 삽입
    dialogues.forEach((dialogue, index) => {
        const character = party[dialogue.charIndex];
        if (!character) return;
        
        const side = dialogue.charIndex === 0 ? 'left' : 'right';
        const bubbleHtml = `
          <div class="dialogue-bubble-wrap" data-side="${side}">
            <img src="${esc(character.thumb_url)}" class="dialogue-avatar" onerror="this.style.display='none'">
            <div class="dialogue-bubble">
              <div class="dialogue-name">${esc(character.name)}</div>
              <div class="dialogue-text">${esc(dialogue.line).replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')}</div>
            </div>
          </div>
        `;
        narrativeBody = narrativeBody.replace(`__DIALOGUE_PLACEHOLDER_${index}__`, bubbleHtml);
    });

    const paragraphs = narrativeBody.split(/\n{2,}/)
      .map(p => p.trim()).filter(p => p)
      .map(p => p.startsWith('<div class="dialogue-bubble-wrap"') ? p : `<div class="log-paragraph">${p.replace(/\n/g, '<br>')}</div>`)
      .join('');
          
      return paragraphs;
}

/**
 * 스크롤 애니메이션 설정
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

    document.querySelectorAll('.log-paragraph, .dialogue-bubble-wrap').forEach(el => {
        observer.observe(el);
    });
}

/* ------------------------------
 * 메인 렌더링
 * ------------------------------ */
export async function showBattleLog() {
    const root = document.getElementById('view');
    const logId = parseLogId();
    if (!logId) {
        root.innerHTML = `<section class="container narrow"><div class="kv-card">잘못된 로그 ID입니다.</div></section>`;
        return;
    }
    root.innerHTML = `<section class="container narrow"><div class="spin-center"></div></section>`;

    try {
        const log = await getBattleLog(logId);
        const attackerId = log.attacker_char.replace('chars/', '');
        const defenderId = log.defender_char.replace('chars/', '');

        const [attackerSnap, defenderSnap] = await Promise.all([
            fx.getDoc(fx.doc(db, 'chars', attackerId)),
            fx.getDoc(fx.doc(db, 'chars', defenderId))
        ]);

        const attacker = attackerSnap.exists() ? { id: attackerId, ...attackerSnap.data() } : { id: attackerId, ...log.attacker_snapshot };
        const defender = defenderSnap.exists() ? { id: defenderId, ...defenderSnap.data() } : { id: defenderId, ...log.defender_snapshot };
        
        const party = [attacker, defender]; // 대화 처리를 위한 파티 배열
        const body = renderRichLog(log.content, party);

        await render(root, log, attacker, defender, body);
        setupScrollAnimations();

    } catch (e) {
        console.error("배틀로그 로딩 실패:", e);
        root.innerHTML = `<section class="container narrow"><div class="kv-card error">${esc(e.message)}</div></section>`;
    }
}

async function render(root, log, attacker, defender, body) {
    const currentUserId = auth.currentUser?.uid;
    const isOwnerOfAttacker = currentUserId && attacker.owner_uid === currentUserId;
    const isParty = isOwnerOfAttacker || (currentUserId && defender.owner_uid === currentUserId);

    const winnerIsAttacker = log.winner === 0;
    const winnerIsDefender = log.winner === 1;

    const characterCard = (char, isWinner, isLoser, exp) => {
        let label = '';
        if (log.simulated) {
            label = '<span class="chip" style="background:#8b5cf6;color:white;font-weight:bold;">모의전</span>';
        } else if (isWinner) {
            label = '<span class="chip" style="background:#3b82f6;color:white;font-weight:bold;">승리</span>';
        } else if (isLoser) {
            label = '<span class="chip" style="background:#ef4444;color:white;font-weight:bold;">패배</span>';
        }
        
        return `
            <a href="#/char/${char.id}" class="battle-result-card">
                <img src="${esc(char.thumb_url || '')}" class="avatar">
                <div class="name">${esc(char.name)}</div>
                <div class="label">${label}</div>
                ${!log.simulated ? `<div class="exp">+${exp} EXP</div>` : ''}
            </a>
        `;
    };
    
    let topButtonHtml = isOwnerOfAttacker
        ? `<a href="#/battle" class="btn" style="text-decoration: none;">다시 배틀하기</a>`
        : '<button class="btn ghost" onclick="history.back()">이전으로 돌아가기</button>';
    
    root.innerHTML = `
        <style>
            /* 전체 레이아웃 */
            .battlelog-container { max-width: 800px; margin: 0 auto; padding: 20px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; }
            .battlelog-header { text-align: center; margin-bottom: 2rem; }
            .battlelog-title { font-size: 2rem; font-weight: 800; margin: 0.5rem 0; line-height: 1.2; }
            .battlelog-subtitle { font-size: 1rem; color: #94a3b8; }
            
            /* 캐릭터 카드 */
            .battle-results-grid { display: flex; justify-content: space-around; align-items: flex-start; margin: 24px 0; }
            .battle-result-card { text-decoration: none; color: inherit; display: flex; flex-direction: column; align-items: center; gap: 8px; }
            .battle-result-card .avatar { width: 120px; height: 120px; object-fit: cover; border-radius: 12px; border: 3px solid var(--border-color); transition: transform 0.2s; }
            .battle-result-card:hover .avatar { transform: scale(1.05); }
            .battle-result-card .name { font-weight: 800; font-size: 16px; }
            .battle-result-card .exp { font-size: 12px; font-weight: 700; color: #a3e635; background: rgba(163,230,53,.12); padding: 3px 8px; border-radius: 999px; }

            /* 로그 본문 & 애니메이션 */
            .log-body { margin-top: 3rem; border-top: 1px solid #2a2f36; padding-top: 2rem; }
            .log-paragraph, .dialogue-bubble-wrap { opacity: 0; transform: translateY(20px); transition: opacity 0.6s ease-out, transform 0.6s ease-out; }
            .log-paragraph.is-visible, .dialogue-bubble-wrap.is-visible { opacity: 1; transform: translateY(0); }
            .log-paragraph { margin-bottom: 1.5rem; line-height: 1.8; word-break: keep-all; }

            /* 말풍선 */
            .dialogue-bubble-wrap { display: flex; align-items: flex-start; gap: 10px; margin: 1.5rem 0; max-width: 85%; }
            .dialogue-bubble-wrap[data-side="right"] { margin-left: auto; flex-direction: row-reverse; }
            .dialogue-avatar { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; flex-shrink: 0; }
            .dialogue-bubble { background: #232a3b; padding: 12px 16px; border-radius: 18px; position: relative; max-width: min(560px, 90vw); }
            .dialogue-bubble-wrap[data-side="left"] .dialogue-bubble { border-top-left-radius: 6px; }
            .dialogue-bubble-wrap[data-side="right"] .dialogue-bubble { border-top-right-radius: 6px; background: #3b3a61; }
            .dialogue-name { font-weight: 700; font-size: 0.9rem; margin-bottom: 6px; color: #e5e7eb; }
            .dialogue-text { line-height: 1.7; word-break: keep-all; }
            
            /* 리치 텍스트 */
            .rich-cut { border: none; border-top: 1px dashed rgba(255,255,255,0.2); margin: 2em 0; }
            .rich-sfx-small { font-style: italic; color: #9aa4b2; }
            .rich-sfx-big { font-weight: 900; text-transform: uppercase; letter-spacing: 1px; }
            .rich-vfx { font-style: italic; color: #7dd3fc; text-shadow: 0 0 8px #7dd3fc80; }
        </style>

        <section class="container narrow battlelog-container">
            <header class="battlelog-header">
                <h1 class="battlelog-title">${esc(log.title)}</h1>
                <p class="battlelog-subtitle">${prettyTime(log.endedAt)}</p>
                ${topButtonHtml}
            </header>

            <div class="battle-results-grid">
                <div style="--border-color: ${winnerIsAttacker ? '#3b82f6' : winnerIsDefender ? '#ef4444' : '#273247'}">
                    ${characterCard(attacker, winnerIsAttacker, winnerIsDefender, log.exp_char0)}
                </div>
                <div style="font-size: 40px; font-weight: 900; color: #9aa5b1; align-self: center;">VS</div>
                <div style="--border-color: ${winnerIsDefender ? '#3b82f6' : winnerIsAttacker ? '#ef4444' : '#273247'}">
                    ${characterCard(defender, winnerIsDefender, winnerIsAttacker, log.exp_char1)}
                </div>
            </div>

            <div class="log-body">
                ${body}
            </div>
            
            <div style="display: flex; justify-content: center; margin-top: 24px;">
                ${!log.simulated && isParty ? `<button class="btn large ghost" id="btnRelate">관계 확인 중...</button>` : ''}
            </div>
        </section>
    `;

    const btnRelate = root.querySelector('#btnRelate');
    if (!btnRelate) return;

    const existingRelation = await getRelationBetween(attacker.id, defender.id);
    btnRelate.textContent = existingRelation ? '관계 업데이트하기' : 'AI로 관계 생성하기';
    btnRelate.disabled = false;

    btnRelate.onclick = async () => {
        btnRelate.disabled = true;
        btnRelate.textContent = 'AI가 관계를 분석하는 중...';
        try {
            await createOrUpdateRelation({
                aCharId: attacker.id,
                bCharId: defender.id,
                battleLogId: log.id
            });
            showToast('관계가 갱신되었습니다!');
            btnRelate.textContent = '관계가 갱신됨';
        } catch(e) {
            console.error('관계 생성/업데이트 실패:', e);
            showToast(`오류: ${e.message}`);
            btnRelate.disabled = false;
            btnRelate.textContent = existingRelation ? '업데이트 재시도' : '생성 재시도';
        }
    };
}

export default showBattleLog;
