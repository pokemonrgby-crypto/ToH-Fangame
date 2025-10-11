// /public/js/tabs/encounterlog.js
import { auth, db, fx } from '../api/firebase.js';
import { getEncounterLog, createOrUpdateRelation, getEncounterComments, addEncounterComment } from '../api/store.js';
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

function renderRichLog(logText = '', party = []) {
    if (typeof logText !== 'string') logText = String(logText ?? '');

    let txt = logText.replace(/\r\n?/g, '\n');
    if (txt.includes('\\n')) txt = txt.replace(/\\n/g, '\n');

    const dialogues = [];
    txt = txt.replace(/\[대사:(\d)\]([\s\S]*?)\[\/대사\]/g, (match, charIndex, line) => {
        dialogues.push({ charIndex: parseInt(charIndex, 10), line });
        return `__DIALOGUE_PLACEHOLDER_${dialogues.length - 1}__`;
    });

    let narrativeBody = esc(txt)
        .replace(/\[내면\]([\s\S]*?)\[\/내면\]/g, '<div class="rich-thought">$1</div>')
        .replace(/\[ITEM:(normal|rare|epic|legend|myth|aether)\]([\s\S]*?)\[\/ITEM\]/g, (_m, r, n) => {
            const color = rarityColors[r.toLowerCase()] || '#fff';
            return `<strong class="item-highlight" style="color:${color}; text-shadow:0 0 6px ${color}80;">${n}</strong>`;
        });

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
        const [log, comments] = await Promise.all([
            getEncounterLog(logId),
            getEncounterComments(logId)
        ]);

        const charAId = log.a_char.replace('chars/', '');
        const charBId = log.b_char.replace('chars/', '');

        const [charASnap, charBSnap] = await Promise.all([
            fx.getDoc(fx.doc(db, 'chars', charAId)),
            fx.getDoc(fx.doc(db, 'chars', charBId))
        ]);

        const charA = charASnap.exists() ? { id: charAId, ...charASnap.data() } : { id: charAId, ...log.a_snapshot };
        const charB = charBSnap.exists() ? { id: charBId, ...charBSnap.data() } : { id: charBId, ...log.b_snapshot };

        await render(root, log, charA, charB, logId, comments);
        setupScrollAnimations();

    } catch (e) {
        console.error("Failed to load encounter log:", e);
        root.innerHTML = `<section class="container narrow"><div class="kv-card error">${esc(e.message)}</div></section>`;
    }
}

async function render(root, log, charA, charB, logId, comments) {
  const currentUserId = auth.currentUser?.uid;
  const isParty = currentUserId && (charA.owner_uid === currentUserId || charB.owner_uid === currentUserId);
  const hasAlreadyCommented = comments.some(c => c.uid === currentUserId);
  const canComment = currentUserId && !hasAlreadyCommented;

  const expA = Number(log.exp_a ?? log.exp_char_a ?? 0) | 0;
  const expB = Number(log.exp_b ?? log.exp_char_b ?? 0) | 0;

  const body = renderRichLog(log.content, [charA, charB]);

  const characterCard = (char, exp) => `
    <a href="#/char/${char.id}" class="elog-card">
      ${char.thumb_url ? `<img src="${esc(char.thumb_url)}" class="elog-avatar" alt="">` : `<div class="elog-avatar ph"></div>`}
      <div class="elog-name">${esc(char.name)}</div>
      <div class="elog-exp">+${exp} EXP</div>
    </a>`;
    
  const renderComment = (comment) => `
    <div class="comment-item">
        ${comment.photoURL ? `<img src="${esc(comment.photoURL)}" class="comment-avatar" alt="${esc(comment.displayName)}의 아바타">` : `<div class="comment-avatar" style="background:#334155;"></div>`}
        <div class="comment-body">
            <div class="comment-header">
                <span class="comment-author">${esc(comment.displayName)}</span>
                <span class="comment-rating">${'★'.repeat(comment.rating)}${'☆'.repeat(5 - comment.rating)}</span>
            </div>
            <p class="comment-text">${esc(comment.text).replace(/\n/g, '<br>')}</p>
            <div class="comment-meta">${prettyTime(comment.createdAt?.toDate ? comment.createdAt.toDate() : comment.createdAt)}</div>
        </div>
    </div>
  `;

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

      .elog-comments-wrap { margin-top: 24px; border-top: 1px solid #273247; padding-top: 24px; }
      .elog-comments-wrap h2 { font-size: 1.25rem; margin-bottom: 1rem; }
      .comment-form { display: flex; flex-direction: column; gap: 12px; margin-bottom: 24px; background: #141a23; padding: 16px; border-radius: 8px; }
      .comment-form textarea { width: 100%; min-height: 80px; }
      .star-rating { display: flex; flex-direction: row-reverse; justify-content: flex-end; align-items: center; margin-bottom: 8px; }
      .star-rating input[type="radio"] { display: none; }
      .star-rating label { font-size: 2rem; color: #4b5563; cursor: pointer; transition: color 0.2s ease-in-out; padding: 0 2px; }
      .star-rating input[type="radio"]:checked ~ label,
      .star-rating:not(:checked) > label:hover,
      .star-rating:not(:checked) > label:hover ~ label { color: #ffc700; }
      .comments-list { display: flex; flex-direction: column; gap: 16px; }
      .comment-item { display: flex; gap: 12px; background: #0c1117; padding: 12px; border-radius: 8px; border: 1px solid #273247; }
      .comment-avatar { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; flex-shrink: 0; }
      .comment-body { flex: 1; }
      .comment-header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 6px; }
      .comment-author { font-weight: bold; }
      .comment-rating { font-size: 1.1em; color: #ffc700; line-height: 1; }
      .comment-text { font-size: 0.95em; line-height: 1.6; white-space: pre-wrap; word-break: break-all; }
      .comment-meta { font-size: 0.8rem; color: #6b7280; margin-top: 8px; }

      @media (max-width:860px){ .elog-grid{grid-template-columns:1fr;gap:12px} .elog-cc{order:-1} }
    </style>

    <section class="container narrow elog-wrap">
      <div class="elog-topbar">
        <div class="inner">
          <button class="btn ghost" onclick="history.back()">← 돌아가기</button>
          <div class="elog-actions">
            <button class="btn ghost" id="btnShare">공유</button>
            ${isParty ? `<button class="btn" id="btnRematch">다시 조우</button>` : ''}
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

      <div class="elog-comments-wrap">
        <h2>댓글 및 평가 (${comments.length})</h2>
        ${canComment ? `
        <form id="comment-form" class="comment-form">
            <p style="margin:0;font-weight:500;">이 조우에 대한 감상을 남겨주세요.</p>
            <div class="star-rating">
                <input type="radio" id="5-stars" name="rating" value="5" required/><label for="5-stars" class="star" title="5점">&#9733;</label>
                <input type="radio" id="4-stars" name="rating" value="4" /><label for="4-stars" class="star" title="4점">&#9733;</label>
                <input type="radio" id="3-stars" name="rating" value="3" /><label for="3-stars" class="star" title="3점">&#9733;</label>
                <input type="radio" id="2-stars" name="rating" value="2" /><label for="2-stars" class="star" title="2점">&#9733;</label>
                <input type="radio" id="1-star" name="rating" value="1" /><label for="1-star" class="star" title="1점">&#9733;</label>
            </div>
            <textarea id="comment-text" class="form-control" placeholder="댓글을 입력하세요..." required minlength="10"></textarea>
            <button type="submit" class="btn">댓글 등록</button>
        </form>
        ` : (currentUserId ? `<div class="kv-card info">이미 댓글을 작성했습니다.</div>` : `<div class="kv-card info">댓글을 작성하려면 <a href="#/me">로그인</a>이 필요합니다.</div>`)}
        
        <div id="comments-list" class="comments-list">
            ${comments.length > 0 ? comments.map(renderComment).join('') : '<p>아직 댓글이 없습니다.</p>'}
        </div>
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
      location.hash = `#/encounter`;
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

  const commentForm = root.querySelector('#comment-form');
  if (commentForm) {
      commentForm.onsubmit = async (e) => {
          e.preventDefault();
          const btn = commentForm.querySelector('button[type="submit"]');
          btn.disabled = true;
          btn.textContent = '등록 중...';

          const text = root.querySelector('#comment-text').value;
          const rating = new FormData(commentForm).get('rating');

          if (!rating) {
              showToast('별점을 선택해주세요.', 'error');
              btn.disabled = false;
              btn.textContent = '댓글 등록';
              return;
          }

          try {
              const newComment = await addEncounterComment(logId, { text, rating });
              showToast('댓글이 성공적으로 등록되었습니다.');
              
              const commentsList = root.querySelector('#comments-list');
              const newCommentHtml = renderComment(newComment);
              if (comments.length === 0) {
                  commentsList.innerHTML = newCommentHtml;
              } else {
                  commentsList.insertAdjacentHTML('afterbegin', newCommentHtml);
              }
              commentForm.remove(); 
              root.querySelector('.elog-comments-wrap h2').textContent = `댓글 및 평가 (${comments.length + 1})`;
              root.querySelector('.elog-comments-wrap').insertAdjacentHTML('afterbegin', '<div class="kv-card info">댓글을 작성했습니다.</div>');

          } catch (err) {
              console.error("Comment submission failed:", err);
              showToast(err.message || '댓글 등록에 실패했습니다.', 'error');
              btn.disabled = false;
              btn.textContent = '댓글 등록';
          }
      };
  }
}

export default showEncounterLog;
