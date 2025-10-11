// /public/js/tabs/encounterlog.js
import { auth, db, fx, func } from '../api/firebase.js';
import { getEncounterLog, getEncounterComments, fetchMyChars } from '../api/store.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-functions.js';
import { showToast } from '../ui/toast.js';
import { prettyTime } from '../ui/utils.js';
// ✨ 1단계에서 만든 캐릭터 선택 모달을 가져옵니다.
import { openCharacterPickerModal } from '../ui/character_picker.js';

const call = (name) => httpsCallable(func, name);

// ✨ 댓글 작성을 위해 유저가 선택한 캐릭터를 저장할 변수를 만듭니다.
let selectedCharForComment = null;

// (여기부터 showEncounterLog 함수 전까지는 기존 코드와 동일합니다)
function parseLogId(){const h=location.hash||'';const m=h.match(/^#\/encounter-log\/([^/]+)$/);return m?m[1]:null}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
const rarityColors={normal:'#c8d0dc',rare:'#cfe4ff',epic:'#e6dcff',legend:'#ffe9ad',myth:'#ffc9ce',aether:'#d6fff7'};
function renderRichLog(logText='',party=[]){if(typeof logText!=='string')logText=String(logText??'');let txt=logText.replace(/\r\n?/g,'\n').replace(/\\n/g,'\n');const dialogues=[];txt=txt.replace(/\[대사:(\d)\]([\s\S]*?)\[\/대사\]/g,(match,charIndex,line)=>{dialogues.push({charIndex:parseInt(charIndex,10),line});return `__DIALOGUE_PLACEHOLDER_${dialogues.length-1}__`});let narrativeBody=esc(txt).replace(/\[내면\]([\s\S]*?)\[\/내면\]/g,'<div class="rich-thought">$1</div>').replace(/\[ITEM:(normal|rare|epic|legend|myth|aether)\]([\s\S]*?)\[\/ITEM\]/g,(_m,r,n)=>{const color=rarityColors[r.toLowerCase()]||'#fff';return `<strong class="item-highlight" style="color:${color};text-shadow:0 0 6px ${color}80;">${n}</strong>`});dialogues.forEach((dialogue,index)=>{const character=party[dialogue.charIndex];if(!character)return;const side=dialogue.charIndex===0?'left':'right';const bubbleHtml=`
<div class="dialogue-bubble-wrap" data-side="${side}"><img src="${esc(character.thumb_url)}" class="dialogue-avatar" onerror="this.style.display='none'"><div class="dialogue-bubble"><div class="dialogue-name">${esc(character.name)}</div><div class="dialogue-text">${esc(dialogue.line).replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>')}</div></div></div>`;narrativeBody=narrativeBody.replace(`__DIALOGUE_PLACEHOLDER_${index}__`,bubbleHtml)});return narrativeBody.split(/\n{2,}/).map(p=>p.trim()).filter(p=>p).map(p=>p.startsWith('<div class="dialogue-bubble-wrap"')?p:`<div class="log-paragraph">${p.replace(/\n/g,'<br>')}</div>`).join('')}
function setupScrollAnimations(){const observer=new IntersectionObserver((entries)=>{entries.forEach(entry=>{if(entry.isIntersecting){entry.target.classList.add('is-visible');observer.unobserve(entry.target)}})},{threshold:0.1});document.querySelectorAll('.log-paragraph, .dialogue-bubble-wrap').forEach(el=>observer.observe(el))}


export async function showEncounterLog() {
    const root = document.getElementById('view');
    const logId = parseLogId();
    if (!logId) {
        root.innerHTML = `<section class="container narrow"><p>잘못된 경로입니다.</p></section>`;
        return;
    }
    root.innerHTML = `<section class="container narrow"><div class="spin-center" style="margin-top: 40px;"></div></section>`;
    try {
        // ✨ 페이지에 들어올 때마다 선택된 캐릭터를 초기화합니다.
        selectedCharForComment = null; 

        const [log, comments] = await Promise.all([ getEncounterLog(logId), getEncounterComments(logId) ]);
        const [charASnap, charBSnap] = await Promise.all([ fx.getDoc(fx.doc(db, log.a_char)), fx.getDoc(fx.doc(db, log.b_char)) ]);
        const charA = charASnap.exists() ? { id: charASnap.id, ...charASnap.data() } : { id: log.a_char.split('/')[1], ...log.a_snapshot };
        const charB = charBSnap.exists() ? { id: charBSnap.id, ...charBSnap.data() } : { id: log.b_char.split('/')[1], ...log.b_snapshot };
        const myChars = auth.currentUser ? await fetchMyChars(auth.currentUser.uid) : [];
        
        await render(root, log, charA, charB, logId, comments, myChars);
        setupScrollAnimations();
    } catch (e) {
        console.error("Failed to load encounter log:", e);
        root.innerHTML = `<section class="container narrow"><div class="kv-card error">${esc(e.message)}</div></section>`;
    }
}

async function render(root, log, charA, charB, logId, comments, myChars) {
    const currentUserId = auth.currentUser?.uid;
    const isParty = currentUserId && (charA.owner_uid === currentUserId || charB.owner_uid === currentUserId);
    const body = renderRichLog(log.content, [charA, charB]);
    const characterCard = (char, exp) => `<a href="#/char/${char.id}" class="elog-card"><img src="${esc(char.thumb_url)}" class="elog-avatar" alt=""><div class="elog-name">${esc(char.name)}</div><div class="elog-exp">+${(exp||0)} EXP</div></a>`;

    root.innerHTML = `
    <style>
      /* ✨ 세련된 별점 UI를 위한 스타일 */
      .star-rating-enhanced { display: flex; flex-direction: row-reverse; justify-content: center; font-size: 2rem; }
      .star-rating-enhanced input { display: none; }
      .star-rating-enhanced label { color: #4b5563; cursor: pointer; transition: color 0.2s ease-out, transform 0.1s ease; padding: 0 2px; }
      .star-rating-enhanced label:hover { transform: scale(1.1); }
      .star-rating-enhanced input:checked ~ label,
      .star-rating-enhanced:not(:checked) > label:hover,
      .star-rating-enhanced:not(:checked) > label:hover ~ label { color: #ffc700; text-shadow: 0 0 8px #ffc70090; }
      .star-rating-enhanced > input:checked + label:hover,
      .star-rating-enhanced > input:checked ~ label:hover,
      .star-rating-enhanced > input:checked ~ label:hover ~ label,
      .star-rating-enhanced > label:hover ~ input:checked ~ label { color: #ffed85; }

      /* ✨ 캐릭터 선택 버튼 스타일 */
      #comment-char-picker { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; padding: 10px; border: 1px solid #273247; border-radius: 8px; background: #0f172a; cursor: pointer; transition: background .2s; }
      #comment-char-picker:hover { background: #1e293b; }
      #comment-char-picker img { width: 36px; height: 36px; border-radius: 50%; object-fit: cover; }
      #comment-char-picker .placeholder { color: #6b7280; }
      
      /* (기존 스타일은 그대로 유지) */
      .elog-wrap{display:flex;flex-direction:column;gap:18px} .elog-topbar{position:sticky;top:0;z-index:10;backdrop-filter:blur(8px);background:rgba(8,12,18,.6);border-bottom:1px solid #1e2835} .elog-topbar .inner{display:flex;align-items:center;justify-content:space-between;padding:10px 8px} .elog-actions{display:flex;gap:8px} .elog-grid{display:grid;grid-template-columns:1fr minmax(0,72ch) 1fr;gap:18px} .elog-cc{display:flex;justify-content:center} .elog-card{text-decoration:none;color:inherit;display:flex;flex-direction:column;align-items:center;gap:6px} .elog-avatar{width:96px;height:96px;object-fit:cover;border-radius:50%;border:3px solid #273247;box-shadow:0 4px 12px rgba(0,0,0,.3)} .elog-name{font-weight:800;font-size:15px;margin-top:2px} .elog-exp{font-size:12px;font-weight:700;color:#a3e635;background:rgba(163,230,53,.12);padding:3px 8px;border-radius:999px} .elog-body{line-height:1.8;font-size:15px} .elog-title{font-size:22px;font-weight:900;text-align:center;margin:8px 0 14px} .elog-article{background:#0c1117;border:1px solid #273247;border-radius:14px;padding:16px} .rich-thought{margin:16px 0;padding:12px;border-left:3px solid #7a9bff;background:rgba(122,155,255,.08);border-radius:8px; font-style: italic; color: #d1d5db;} .log-paragraph, .dialogue-bubble-wrap { opacity: 0; transform: translateY(20px); transition: opacity 0.6s ease-out, transform 0.6s ease-out; } .log-paragraph.is-visible, .dialogue-bubble-wrap.is-visible { opacity: 1; transform: translateY(0); } .log-paragraph { margin-bottom: 1.5rem; line-height: 1.8; word-break: keep-all; } .dialogue-bubble-wrap { display: flex; align-items: flex-start; gap: 10px; margin: 1.5rem 0; max-width: 85%; } .dialogue-bubble-wrap[data-side="right"] { margin-left: auto; flex-direction: row-reverse; } .dialogue-avatar { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; flex-shrink: 0; } .dialogue-bubble { background: #232a3b; padding: 12px 16px; border-radius: 18px; position: relative; max-width: min(560px, 90vw); } .dialogue-bubble-wrap[data-side="left"] .dialogue-bubble { border-top-left-radius: 6px; } .dialogue-bubble-wrap[data-side="right"] .dialogue-bubble { border-top-right-radius: 6px; background: #3b3a61; } .dialogue-name { font-weight: 700; font-size: 0.9rem; margin-bottom: 6px; color: #e5e7eb; } .dialogue-text { line-height: 1.7; word-break: keep-all; } .elog-comments-wrap { margin-top: 24px; border-top: 1px solid #273247; padding-top: 24px; } .elog-comments-wrap h2 { font-size: 1.25rem; margin-bottom: 1rem; } .comment-form { display: flex; flex-direction: column; gap: 12px; margin-bottom: 24px; background: #141a23; padding: 16px; border-radius: 8px; } .comments-list { display: flex; flex-direction: column; gap: 16px; } .comment-item { display: flex; gap: 12px; background: #0c1117; padding: 12px; border-radius: 8px; border: 1px solid #273247; } .comment-avatar { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; flex-shrink: 0; } .comment-body { flex: 1; } .comment-header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 6px; } .comment-author { font-weight: bold; } .comment-text { font-size: 0.95em; line-height: 1.6; white-space: pre-wrap; word-break: break-all; } .comment-meta { font-size: 0.8rem; color: #6b7280; margin-top: 8px; display: flex; align-items: center; } @media (max-width:860px){ .elog-grid{grid-template-columns:1fr;gap:12px} .elog-cc{order:-1} }
    </style>
    <section class="container narrow elog-wrap">
      <div class="elog-topbar"><div class="inner"><button class="btn ghost" onclick="history.back()">← 돌아가기</button><div class="elog-actions"><button class="btn ghost" id="btnShare">공유</button>${isParty ? `<button class="btn" id="btnRematch">다시 조우</button>` : ''}</div></div></div><div class="elog-grid"><div class="elog-cc">${characterCard(charA, log.exp_a)}</div><div class="elog-article"><h1 class="elog-title">${esc(log.title)}</h1><div class="elog-body">${body}</div></div><div class="elog-cc">${characterCard(charB, log.exp_b)}</div></div><div style="display:flex;justify-content:center;margin:10px 0 0">${isParty ? `<button class="btn large ghost" id="btnRelate">AI로 관계 분석/업데이트</button>` : ''}</div>
      
      <div class="elog-comments-wrap">
        <h2>댓글 및 평가 (${comments.length})</h2>
        <div id="rating-area" class="kv-card" style="margin-bottom: 1rem;">
          <p style="margin:0; font-weight:500;">이 조우의 캐릭터들에게 별점을 매겨주세요. (각 1회)</p>
          <div class="row" style="justify-content: space-around; margin-top: 1rem; align-items: flex-start;">
            ${renderRatingControl(charA, 'a')}
            ${renderRatingControl(charB, 'b')}
          </div>
        </div>
        
        <form id="comment-form" class="comment-form" style="${!currentUserId ? 'display:none;' : ''}">
          <p style="margin:0;font-weight:500;">내 캐릭터로 댓글 남기기</p>
          
          <button type="button" id="comment-char-picker">
            <span class="placeholder">-- 댓글을 작성할 내 캐릭터 선택 --</span>
          </button>

          <textarea id="comment-text" class="form-control" placeholder="캐릭터의 입장에서 댓글을 작성하면 AI가 서사를 반영하여 변환합니다..." required minlength="5"></textarea>
          <button type="submit" class="btn">AI로 변환하여 댓글 등록</button>
        </form>

        <div id="comments-list" class="comments-list">
          ${comments.length > 0 ? comments.map(c => renderComment(c)).join('') : '<p>아직 댓글이 없습니다.</p>'}
        </div>
      </div>
    </section>
    `;

    document.getElementById('btnShare')?.addEventListener('click', () => navigator.clipboard.writeText(location.href).then(()=>showToast('주소가 복사되었습니다!')));
    document.getElementById('btnRematch')?.addEventListener('click', () => location.hash = `#/encounter?cid=${charA.id}&oid=${charB.id}`);
    document.getElementById('btnRelate')?.addEventListener('click', () => location.hash = `#/char/${charA.id}/relate?target=${charB.id}`);

    attachAllActionEvents(logId, myChars);
}

// ✨ 개선된 별점 UI를 렌더링하는 함수입니다.
function renderRatingControl(char, side) {
    return `
      <div class="col" style="align-items: center; gap: 12px; flex: 1;">
        <img src="${esc(char.thumb_url)}" class="elog-avatar" style="width: 64px; height: 64px;">
        <b>${esc(char.name)}</b>
        <div class="star-rating-enhanced" data-char-id="${char.id}">
          ${[5, 4.5, 4, 3.5, 3, 2.5, 2, 1.5, 1, 0.5].map(val => {
              const id = `star-${side}-${val}`;
              // 각 라벨은 온전한 별표(★) 하나를 내용으로 가집니다.
              return `<input type="radio" id="${id}" name="rating-${side}" value="${val}"><label for="${id}" title="${val}점">★</label>`;
          }).join('')}
        </div>
      </div>
    `;
}

// 댓글 카드 렌더링 함수 (기존과 동일)
function renderComment(comment) {
    return `<div class="comment-item" data-comment-id="${comment.id}"><img src="${esc(comment.photoURL||'')}" class="comment-avatar" onerror="this.style.background='#334155';this.src='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';"><div class="comment-body"><div class="comment-header"><span class="comment-author">${esc(comment.displayName)}</span></div><p class="comment-text">${esc(comment.text).replace(/\n/g,'<br>')}</p><div class="comment-meta">${prettyTime(comment.createdAt?.toDate?comment.createdAt.toDate():new Date())}<button class="btn xs ghost btn-report" style="margin-left:auto;">신고</button></div></div></div>`;
}

// ✨ 모든 이벤트 리스너를 한 곳에서 관리하도록 통합했습니다.
function attachAllActionEvents(logId, myChars) {
    // 별점 이벤트
    document.querySelectorAll('.star-rating-enhanced input').forEach(radio => {
        radio.addEventListener('change', async (e) => {
            if (!auth.currentUser) return showToast('로그인이 필요합니다.', 'error');
            const rating = parseFloat(e.target.value);
            const charId = e.target.closest('.star-rating-enhanced').dataset.charId;
            const btnContainer = e.target.closest('.star-rating-enhanced');
            btnContainer.style.pointerEvents = 'none';
            try {
                await call('rateEncounter')({ logId, targetCharId: charId, rating });
                showToast(`${rating}점을 주었습니다!`, 'success');
            } catch (err) {
                showToast(`평가 실패: ${err.message}`, 'error');
                btnContainer.style.pointerEvents = 'auto';
            }
        });
    });

    // ✨ 캐릭터 선택 버튼(모달 열기) 이벤트
    const pickerBtn = document.getElementById('comment-char-picker');
    if (pickerBtn) {
        pickerBtn.onclick = async () => {
            const selected = await openCharacterPickerModal(myChars, '댓글을 작성할 캐릭터 선택');
            if (selected) { // 캐릭터를 선택하면
                selectedCharForComment = selected;
                pickerBtn.innerHTML = `<img src="${esc(selected.thumb_url||'')}"><span>${esc(selected.name)}</span>`;
            }
        };
    }

    // 댓글 폼 제출 이벤트
    const commentForm = document.getElementById('comment-form');
    if (commentForm) {
        commentForm.onsubmit = async (e) => {
            e.preventDefault();
            const btn = commentForm.querySelector('button[type="submit"]');
            const rawComment = document.getElementById('comment-text').value;

            // ✨ select 대신 변수에 저장된 캐릭터 정보로 유효성 검사
            if (!selectedCharForComment) {
                showToast('댓글을 작성할 캐릭터를 선택해주세요.', 'error'); return;
            }
            if (rawComment.length < 5) {
                showToast('댓글은 5자 이상 입력해주세요.', 'error'); return;
            }

            btn.disabled = true;
            btn.textContent = 'AI 변환 중...';
            try {
                const res = await call('commentOnEncounter')({ logId, actingCharId: selectedCharForComment.id, rawComment });
                if (res.data.ok) {
                    showToast('댓글이 등록되었습니다.');
                    const list = document.getElementById('comments-list');
                    if (list.innerHTML.includes('아직 댓글이 없습니다.')) list.innerHTML = '';
                    list.insertAdjacentHTML('afterbegin', renderComment(res.data.comment));
                    commentForm.reset();
                    // 댓글 작성 후 선택된 캐릭터 초기화
                    selectedCharForComment = null; 
                    pickerBtn.innerHTML = `<span class="placeholder">-- 댓글을 작성할 내 캐릭터 선택 --</span>`;
                }
            } catch (err) {
                showToast(`댓글 등록 실패: ${err.message}`, 'error');
            } finally {
                btn.disabled = false;
                btn.textContent = 'AI로 변환하여 댓글 등록';
            }
        };
    }

    // 신고 이벤트
    document.getElementById('comments-list').addEventListener('click', async (e) => {
        if (e.target.classList.contains('btn-report')) {
            if (!auth.currentUser) return showToast('로그인이 필요합니다.', 'error');
            const commentItem = e.target.closest('.comment-item');
            const commentId = commentItem.dataset.commentId;
            const reason = prompt("신고 사유를 입력해주세요. (예: 정치적, 성적, '그 캐릭터' 등)");
            if (reason) {
                e.target.disabled = true;
                try {
                    await call('reportEncounterComment')({ logId, commentId, reason });
                    showToast('신고가 접수되었습니다.');
                    e.target.textContent = '신고됨';
                } catch (err) {
                    showToast(`신고 실패: ${err.message}`, 'error');
                    e.target.disabled = false;
                }
            }
        }
    });
}

export default showEncounterLog;
