// /public/js/tabs/encounterlog.js
import { auth, db, fx } from '../api/firebase.js';
import { getEncounterLog, createOrUpdateRelation } from '../api/store.js';
import { showToast } from '../ui/toast.js';
import { prettyTime } from '../ui/utils.js';

function parseLogId() {
    const h = location.hash || '';
    const m = h.match(/^#\/encounter-log\/([^/]+)$/);
    return m ? m[1] : null;
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const rarityColors = {
    normal: '#c8d0dc', rare: '#cfe4ff', epic: '#e6dcff',
    legend: '#ffe9ad', myth: '#ffc9ce', aether: '#d6fff7'
};

/**
 * 리치 텍스트 렌더링 (battlelog.js 스타일)
 */
function renderRichLog(logText = '', party = []) {
    if (typeof logText !== 'string') logText = String(logText ?? '');

    let txt = logText.replace(/\r\n?/g, '\n');
    if (txt.includes('\\n')) txt = txt.replace(/\\n/g, '\n');

    const dialogues = [];
    // [대사:0]「대사」[/대사] 또는 [대사:0]"대사"[/대사] 형식을 먼저 플레이스홀더로 분리
    // [수정] 프롬프트 변경에 따라 [대화] 태그를 [대사:인덱스] 태그로 처리하도록 변경
    txt = txt.replace(/\[대사:(\d)\]([\s\S]*?)\[\/대사\]/g, (match, charIndex, line) => {
        dialogues.push({ charIndex: parseInt(charIndex, 10), line });
        return `__DIALOGUE_PLACEHOLDER_${dialogues.length - 1}__`;
    });

    // 나머지 텍스트 이스케이프 및 태그 변환
    let narrativeBody = esc(txt)
        .replace(/\[내면\]([\s\S]*?)\[\/내면\]/g, '<div class="rich-thought">$1</div>')
        .replace(/\[ITEM:(normal|rare|epic|legend|myth|aether)\]([\s\S]*?)\[\/ITEM\]/g, (_m, r, n) => {
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


export async function showEncounterLog() {
    const root = document.getElementById('view');
    const logId = parseLogId();

    if (!logId) {
        root.innerHTML = `<section class="container narrow"><p>잘못된 경로입니다.</p></section>`;
        return;
    }

    root.innerHTML = `<section class="container narrow"><div class="spin-center" style="margin-top: 40px;"></div></section>`;

    try {
        const log = await getEncounterLog(logId);

        const charAId = log.a_char.replace('chars/', '');
        const charBId = log.b_char.replace('chars/', '');

        const [charASnap, charBSnap] = await Promise.all([
            fx.getDoc(fx.doc(db, 'chars', charAId)),
            fx.getDoc(fx.doc(db, 'chars', charBId))
        ]);

        const charA = charASnap.exists() ? { id: charAId, ...charASnap.data() } : { id: charAId, ...log.a_snapshot };
        const charB = charBSnap.exists() ? { id: charBId, ...charBSnap.data() } : { id: charBId, ...log.b_snapshot };

        await render(root, log, charA, charB, logId);
        setupScrollAnimations();

    } catch (e) {
        console.error("Failed to load encounter log:", e);
        root.innerHTML = `<section class="container narrow"><div class="kv-card error">${esc(e.message)}</div></section>`;
    }
}

async function render(root, log, charA, charB, logId) {
  const currentUserId = auth.currentUser?.uid;
  const isParty = currentUserId && (charA.owner_uid === currentUserId || charB.owner_uid === currentUserId);
  const expA = Number(log.exp_a ?? log.exp_char_a ?? 0) | 0;
  const expB = Number(log.exp_b ?? log.exp_char_b ?? 0) | 0;

  const body = renderRichLog(log.content, [charA, charB]); // 렌더링 함수에 party 전달

  const characterCard = (char, exp) => `
    <a href="#/char/${char.id}" class="elog-card">
      ${char.thumb_url ? `<img src="${esc(char.thumb_url)}" class="elog-avatar" alt="">` : `<div class="elog-avatar ph"></div>`}
      <div class="elog-name">${esc(char.name)}</div>
      <div class="elog-exp">+${exp} EXP</div>
    </a>`;

  // 141번째 줄의 `\` 제거됨
  root.innerHTML = `
    <style>
      .elog-wrap{display:flex;flex-direction:column;gap:18px}
      .elog-topbar{position:sticky;top:0;z-index:10;backdrop-filter:blur(8px);background:rgba(8,12,18,.6);border-bottom:1px solid #1e2835}
      .elog-topbar .inner{display:flex;align-items:center;justify-content:space-between;padding:10px 8px}
      .elog-actions{display:flex;gap:8px}
      .elog-grid{display:grid;grid-template-columns:1fr minmax(0,72ch) 1fr;gap:18px}
      .elog-cc{display:flex;justify-content:center}
      .elog-card{text-decoration:none;color:inherit;display:flex;flex-direction:column;align-items:center;gap:6px}
      .elog-avatar{width:96px;height:96px;object-fit:cover;border-radius:50%;border:3px solid #273247;box-shadow:0 4px 12px rgba(0,0,0,.3)}
      .elog-avatar.ph{background:linear-gradient(90deg,#14202e,#0b1018)}
      .elog-name{font-weight:800;font-size:15px;margin-top:2px}
      .elog-exp{font-size:12px;font-weight:700;color:#a3e635;background:rgba(163,230,53,.12);padding:3px 8px;border-radius:999px}
      .elog-body{line-height:1.8;font-size:15px}
      .elog-title{font-size:22px;font-weight:900;text-align:center;margin:8px 0 14px}
      .elog-article{background:#0c1117;border:1px solid #273247;border-radius:14px;padding:16px}
      .rich-thought{margin:16px 0;padding:12px;border-left:3px solid #7a9bff;background:rgba(122,155,255,.08);border-radius:8px; font-style: italic; color: #d1d5db;}
      
      /* 말풍선 스타일 (battlelog.js에서 가져옴) */
      .log-paragraph, .dialogue-bubble-wrap { opacity: 0; transform: translateY(20px); transition: opacity 0.6s ease-out, transform 0.6s ease-out; }
      .log-paragraph.is-visible, .dialogue-bubble-wrap.is-visible { opacity: 1; transform: translateY(0); }
      .log-paragraph { margin-bottom: 1.5rem; line-height: 1.8; word-break: keep-all; }
      .dialogue-bubble-wrap { display: flex; align-items: flex-start; gap: 10px; margin: 1.5rem 0; max-width: 85%; }
      .dialogue-bubble-wrap[data-side="right"] { margin-left: auto; flex-direction: row-reverse; }
      .dialogue-avatar { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; flex-shrink: 0; }
      .dialogue-bubble { background: #232a3b; padding: 12px 16px; border-radius: 18px; position: relative; max-width: min(560px, 90vw); }
      .dialogue-bubble-wrap[data-side="left"] .dialogue-bubble { border-top-left-radius: 6px; }
      .dialogue-bubble-wrap[data-side="right"] .dialogue-bubble { border-top-right-radius: 6px; background: #3b3a61; }
      .dialogue-name { font-weight: 700; font-size: 0.9rem; margin-bottom: 6px; color: #e5e7eb; }
      .dialogue-text { line-height: 1.7; word-break: keep-all; }

      @media (max-width:860px){ .elog-grid{grid-template-columns:1fr;gap:12px} .elog-cc{order:-1} }
    </style>

    <section class="container narrow elog-wrap">
      <div class="elog-topbar">
        <div class="inner">
          <button class="btn ghost" onclick="history.back()">← 돌아가기</button>
          <div class="elog-actions">
            <button class="btn ghost" id="btnShare">공유</button>
            <button class="btn" id="btnRematch">다시 조우</button>
          </div>
        </div>
      </div>

      <div class="elog-grid">
        <div class="elog-cc">${characterCard(charA, expA)}</div>

        <div class="elog-article">
          <h1 class="elog-title">${esc(log.title)}</h1>
          <div class="elog-body">${body}</div>
        </div>

        <div class="elog-cc">${characterCard(charB, expB)}</div>
      </div>

      <div style="display:flex;justify-content:center;margin:10px 0 0">
        ${isParty ? `<button class="btn large ghost" id="btnRelate">AI로 관계 분석/업데이트</button>` : ''}
      </div>
    </section>
  `;

  const btnShare = root.querySelector('#btnShare');
  if (btnShare) {
    if (navigator?.share) {
        btnShare.onclick = () => navigator.share({ title: esc(log.title), text: '조우 로그', url: location.href }).catch(()=>{});
    } else {
        btnShare.onclick = async ()=>{
            try { 
                await navigator.clipboard.writeText(location.href); 
                showToast('로그 링크가 복사되었습니다.');
            } catch(_) {
                showToast('링크 복사에 실패했습니다.');
            }
        };
    }
  }

  const btnRematch = root.querySelector('#btnRematch');
  if (btnRematch) {
    btnRematch.onclick = ()=>{
      sessionStorage.setItem('toh.match.intent', JSON.stringify({ mode:'encounter', charId: charA.id, ts: Date.now() }));
      location.hash = \`#/encounter\`;
    };
  }

  const btnRelate = root.querySelector('#btnRelate');
  if (btnRelate) {
    btnRelate.onclick = async ()=>{
      btnRelate.disabled = true; btnRelate.textContent = 'AI 분석 중…';
      try{
        const result = await createOrUpdateRelation({ aCharId: charA.id, bCharId: charB.id, encounterLogId: logId });
        showToast('관계가 갱신되었습니다!');
        btnRelate.textContent = '관계 갱신 완료';
      }catch(e){
        showToast('오류: '+(e?.message||'실패'));
        btnRelate.disabled = false; btnRelate.textContent = '분석/업데이트 재시도';
      }
    };
  }
}

export default showEncounterLog;
