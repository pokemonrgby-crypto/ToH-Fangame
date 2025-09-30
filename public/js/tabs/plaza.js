// /public/js/tabs/plaza.js
import { db, fx, auth, func } from '../api/firebase.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-functions.js';
import { showToast } from '../ui/toast.js';
import { fetchMyChars, uploadGuildBadgeSquare, createGuild } from '../api/store.js';

function esc(s){ return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function ensureModalCss(){
  if (document.getElementById('toh-modal-css')) return;
  const st = document.createElement('style');
  st.id = 'toh-modal-css';
  st.textContent = `
    .modal-back{position:fixed; inset:0; z-index:9990;display:flex; align-items:center; justify-content:center;background:rgba(0,0,0,.6); backdrop-filter:blur(4px);}
    .modal-card{background:#0e1116; border:1px solid #273247; border-radius:14px;padding:16px; width:92vw; max-width:720px; max-height:90vh; overflow-y:auto;}
    #toast-root, .toast, .toast-container, .kv-toast {position: fixed; z-index: 11000 !important;}
  `;
  document.head.appendChild(st);
}

async function openCharPicker(onSelectCallback){
  ensureModalCss();
  const u = auth.currentUser;
  if(!u){ showToast('로그인이 필요해'); return; }

  let items = await fetchMyChars(u.uid).catch(()=>[]);
  if (!Array.isArray(items)) items = [];
  items.sort((a,b)=> (b.updatedAt||0) - (a.updatedAt||0));

  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `
    <div class="modal-card" style="max-width:720px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <div style="font-weight:900;font-size:18px;">활동할 캐릭터 선택</div>
        <button class="btn ghost" id="mClose">닫기</button>
      </div>
      <div class="grid3" style="gap:10px;">
        ${items.length ? items.map(c => `
          <button class="kv-card" data-cid="${c.id}" style="text-align:left;display:flex;gap:10px;align-items:center;cursor:pointer;">
            <img src="${c.image_url || c.thumb_url || ''}" onerror="this.style.display='none'"
                 style="width:56px;height:56px;border-radius:10px;object-fit:cover;background:#111">
            <div>
              <div style="font-weight:700">${esc(c.name || '(이름 없음)')}</div>
              <div class="text-dim" style="font-size:12px">${esc(c.world_id || '')}</div>
            </div>
          </button>
        `).join('') : `<div class="kv-card text-dim">캐릭터가 없습니다. 먼저 생성해주세요.</div>`}
      </div>
    </div>
  `;

  const close = ()=> back.remove();
  back.addEventListener('click', e=>{ if(e.target===back) close(); });
  back.querySelector('#mClose')?.addEventListener('click', close);
  back.querySelectorAll('[data-cid]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const cid = btn.getAttribute('data-cid');
      if(!cid) return;
      sessionStorage.setItem('toh.activeChar', cid);
      close();
      onSelectCallback();
    });
  });
  document.body.appendChild(back);
}

async function loadActiveChar(){
  const cid = sessionStorage.getItem('toh.activeChar');
  if(!cid) return null;
  const snap = await fx.getDoc(fx.doc(db, 'chars', cid));
  return snap.exists() ? { id: cid, ...snap.data() } : null;
}

export default async function showPlaza() {
  const root = document.getElementById('view');
  root.innerHTML = `<section class="container narrow"><div class="spin-center" style="margin-top:40px;"></div></section>`;
  
  const c = await loadActiveChar();

  let myGuildId = null, myGuild = null;
    if (c?.id) {
        const cs = await fx.getDoc(fx.doc(db, 'chars', c.id));
        const cd = cs.exists() ? cs.data() : {};
        myGuildId = cd?.guildId || null;
        if (myGuildId) {
            const gs = await fx.getDoc(fx.doc(db, 'guilds', myGuildId));
            myGuild = gs.exists() ? ({ id: gs.id, ...gs.data() }) : null;
        }
    }

    let guilds = [];
    try {
        const qs = await fx.getDocs(fx.query(fx.collection(db, 'guilds'), fx.where('settings.isPublic', '==', true), fx.limit(50)));
        guilds = qs.docs.map(d => ({ id: d.id, ...d.data() }));
        guilds.sort((a, b) => (b.weekly_points || 0) - (a.weekly_points || 0) || (b.member_count || 0) - (a.member_count || 0) || (b.updatedAt || 0) - (a.updatedAt || 0));
    } catch (e) { console.error('guild list load failed', e); guilds = []; }

    const guildCard = (g) => `
      <a class="kv-card link guild-card" href="#/guild/${g.id}" style="text-decoration:none; color:inherit;">
        <div class="row" style="gap:12px;align-items:center">
          <img src="${esc(g.badge_url||'')}" onerror="this.style.display='none'" alt="" style="width:44px;height:44px;border-radius:10px;object-fit:cover;border:1px solid #273247;">
          <div>
            <div style="font-weight:900">${esc(g.name||'(이름없음)')}</div>
            <div class="text-dim" style="font-size:12px">멤버 ${g.member_count||1}명 · 레벨 ${g.level||1}</div>
          </div>
        </div>
      </a>
    `;

    const wrap = document.createElement('section');
    wrap.className = 'container narrow';
    wrap.innerHTML = `
      <div class="book-card">
        <div class="bookmarks">
            <a href="#/economy" class="bookmark">🏛️ 경제</a>
            <a href="#/plaza" class="bookmark active">🏰 길드</a>
            <a href="#/market" class="bookmark">↔️ 거래소</a>
        </div>
        <div class="bookview p12">
          <div class="kv-card" style="margin-bottom:12px;">
            <div class="row" style="justify-content:space-between;align-items:center">
              <div style="font-weight:900">길드</div>
              <button id="btn-open-create" class="btn" ${myGuildId?'disabled title="이미 길드 소속입니다."':''}>길드 만들기</button>
            </div>
          </div>
          <div class="kv-card" style="margin-bottom:12px;">
            <div id="btnPickChar" style="cursor:pointer; padding: 4px 0;">
              ${c ? `활동 캐릭터: <b>${esc(c.name||c.id)}</b> <span class="text-dim">(변경)</span>` : '활동할 캐릭터를 선택해주세요.'}
            </div>
          </div>
          ${myGuild ? `
            <div class="kv-card" id="my-guild-card" style="margin-bottom:12px;">
                <div class="kv-label">내 길드</div>
                <a href="#/guild/${myGuild.id}" style="text-decoration:none; color:inherit;">
                    <div class="row" style="gap:12px;align-items:center; margin-top:8px;">
                        <img src="${esc(myGuild.badge_url||'')}" onerror="this.style.display='none'" alt="" style="width:48px;height:48px;border-radius:8px;object-fit:cover;border:1px solid #273247;">
                        <div>
                            <div style="font-weight:900">${esc(myGuild.name||'(이름없음)')}</div>
                            <div class="text-dim" style="font-size:12px">멤버 ${myGuild.member_count||1}명 · 레벨 ${myGuild.level||1}</div>
                        </div>
                    </div>
                </a>
            </div>`:''}
          <div class="kv-card">
            <div style="font-weight:900; margin-bottom:8px">공개 길드</div>
            <div class="col" style="gap:8px;">
                ${guilds.length ? guilds.map(guildCard).join('') : `<div class="text-dim">아직 공개된 길드가 없습니다.</div>`}
            </div>
          </div>
        </div>
      </div>
    `;

    root.innerHTML = '';
    root.appendChild(wrap);

    wrap.querySelector('#btnPickChar')?.addEventListener('click', () => {
        openCharPicker(showPlaza);
    });
    
    wrap.querySelector('#btn-open-create')?.addEventListener('click', () => {
        if (myGuildId) {
            showToast('이미 길드에 소속되어 있습니다.');
            return;
        }
        if (!c) {
            showToast('길드를 생성하려면 먼저 활동할 캐릭터를 선택해야 합니다.');
            openCharPicker(showPlaza);
            return;
        }

        // 길드 생성 모달을 띄우는 로직 (예시)
        const guildName = prompt('생성할 길드의 이름을 입력하세요 (2~20자):');
        if (guildName && guildName.trim().length >= 2 && guildName.trim().length <= 20) {
            const btn = wrap.querySelector('#btn-open-create');
            btn.disabled = true;
            btn.textContent = '생성 중...';

            createGuild({ charId: c.id, name: guildName.trim() })
                .then(result => {
                    showToast(`'${guildName}' 길드가 성공적으로 생성되었습니다!`);
                    // 성공 후 광장 페이지를 새로고침하여 내 길드 정보를 표시
                    showPlaza();
                })
                .catch(e => {
                    showToast(`길드 생성 실패: ${e.message}`);
                    btn.disabled = false;
                    btn.textContent = '길드 만들기';
                });
        } else if (guildName !== null) { // 사용자가 취소를 누르지 않았을 경우
            showToast('길드 이름은 2자 이상 20자 이하로 입력해주세요.');
        }
    });
}
