// /public/js/tabs/market.js (FULL REWRITE)
// 요구사항: 등급 정렬 기본, 길드/플라자와 왕복 느낌의 탭, 모바일 하단 액션바,
// 등록/구매/입찰/정산 전 확인 모달, 서버 응답은 ID 중심(이름/등급만) 소비

import { db, fx, auth, func } from '../api/firebase.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-functions.js';
import { showToast } from '../ui/toast.js';

// ---------- util ----------
const call = (name) => httpsCallable(func, name);
const esc  = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cssEsc = (s) => (window.CSS?.escape ? CSS.escape(String(s ?? '')) : String(s ?? '').replace(/[^\w-]/g, '_'));

const RARITY_ORDER = ['aether','myth','legend','epic','rare','normal']; // 앞일수록 상위
const RARITY_LABEL = { aether:'에테르', myth:'신화', legend:'레전드', epic:'유니크', rare:'레어', normal:'일반' };

// KST 간단 포맷
function prettyTime(ts){
  const ms = ts?.toMillis ? ts.toMillis() : (ts?.seconds ? ts.seconds * 1000 : Date.now());
  const d = new Date(ms + 9*3600000);
  const y = d.getUTCFullYear(), m = String(d.getUTCMonth()+1).padStart(2,'0'), dd = String(d.getUTCDate()).padStart(2,'0');
  const hh = String(d.getUTCHours()).padStart(2,'0'), mm = String(d.getUTCMinutes()).padStart(2,'0');
  return `${y}-${m}-${dd} ${hh}:${mm} (KST)`;
}

function ensureStyles(){
  if (document.getElementById('market2-style')) return;
  const st = document.createElement('style');
  st.id = 'market2-style';
  st.textContent = `
  .market2{ --bd:rgba(255,255,255,.08); --muted:rgba(255,255,255,.6); }
  .market2 .wrap{ max-width:1080px; margin:10px auto; padding:0 10px; }
  .market2 .bookmarks{ position:sticky; top:56px; z-index:20; display:flex; gap:8px;
    background:rgba(16,16,20,.6); backdrop-filter:blur(6px); padding:8px 10px; border-bottom:1px solid var(--bd);}
  .market2 .bookmark{ padding:8px 12px; border-radius:10px; border:1px solid transparent; color:#d8ddff; text-decoration:none;}
  .market2 .bookmark.active{ border-color:var(--bd); background:rgba(255,255,255,.06); }
  .market2 .kv-card{ background:rgba(255,255,255,.03); border:1px solid var(--bd); border-radius:12px; padding:12px; }
  .market2 .kv-label{ font-weight:800; margin-bottom:6px; }
  .market2 .grid{ display:grid; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); gap:10px; }
  .market2 .row{ display:flex; align-items:center; gap:8px; }
  .market2 .col{ display:flex; flex-direction:column; gap:6px; }
  .market2 .chip{ padding:4px 8px; border:1px solid var(--bd); border-radius:999px; background:rgba(255,255,255,.06); }
  .market2 .input{ height:34px; padding:0 10px; border-radius:8px; border:1px solid var(--bd); background:rgba(255,255,255,.06); color:#fff; }
  .market2 .btn{ height:34px; padding:0 12px; border-radius:8px; border:1px solid var(--bd); background:rgba(115,130,255,.18); color:#fff; cursor:pointer; }
  .market2 .btn.ghost{ background:transparent; }
  .market2 .btn.primary{ background:rgba(100,160,255,.35); }
  .market2 .empty{ padding:24px; text-align:center; color:var(--muted); border:1px dashed var(--bd); border-radius:12px; }
  /* 하단 액션바(모바일 우선) */
  .market2 .actionbar{ position:sticky; bottom:0; z-index:15; padding:10px; background:rgba(12,15,20,.9); backdrop-filter:blur(8px); border-top:1px solid var(--bd); display:flex; gap:8px; }
  .market2 .actionbar .btn{ flex:1; }
  /* 모달 */
  .market2 .modal-back{ position:fixed; inset:0; z-index:9990; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,.6); backdrop-filter:blur(4px); }
  .market2 .modal{ background:#0e1116; border:1px solid #273247; border-radius:14px; padding:14px; width:92vw; max-width:480px; }
  .market2 .item-name{ font-weight:900; }
  `;
  document.head.appendChild(st);
}

function subpath(){
  const h = location.hash || '';
  const m = h.match(/^#\/market(?:\/([^/]+))?/); // trade | auction | special
  return m?.[1] ? m[1] : 'trade';
}

// 인벤토리 로드
async function loadInventory(){
  const uid = auth.currentUser?.uid; if (!uid) return [];
  const s = await fx.getDoc(fx.doc(db, 'users', uid));
  const d = s.exists() ? s.data() : {};
  return Array.isArray(d.items_all) ? d.items_all : [];
}

// 공개 목록(서버 최소 정보만)
async function fetchTrades(){
  const { data } = await call('tradeListPublic')({});
  return Array.isArray(data?.rows) ? data.rows : [];
}
async function fetchAuctions(kind){ // 'normal' | 'special' | null
  const { data } = await call('auctionListPublic')({ kind });
  return Array.isArray(data?.rows) ? data.rows : [];
}

function header(tab){
  return `
    <div class="bookmarks">
      <a href="#/plaza/shop"   class="bookmark">🛒 상점</a>
      <a href="#/market/trade"   class="bookmark ${tab==='trade'?'active':''}">↔️ 일반거래</a>
      <a href="#/market/auction" class="bookmark ${tab==='auction'?'active':''}">🏷️ 일반 경매</a>
      <a href="#/market/special" class="bookmark ${tab==='special'?'active':''}">🎭 특수 경매</a>
      <a href="#/plaza/guilds" class="bookmark">🏰 길드</a>
    </div>
  `;
}

// 등급 → 최신순 기본
function sortByRarityThen(a, b){
  const ra = RARITY_ORDER.indexOf(String(a.item_rarity||'normal').toLowerCase());
  const rb = RARITY_ORDER.indexOf(String(b.item_rarity||'normal').toLowerCase());
  if (ra !== rb) return ra - rb;
  const ta = (a.createdAt?.seconds||0), tb = (b.createdAt?.seconds||0);
  return tb - ta;
}

// ---------- 확인 모달 ----------
function confirmModal(opts){
  // opts: {title, lines:[...], okText, cancelText}
  return new Promise(res=>{
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `
      <div class="modal market2">
        <div style="font-weight:900; font-size:18px; margin-bottom:8px">${esc(opts.title||'확인')}</div>
        <div class="col" style="gap:6px; margin-bottom:10px">
          ${(opts.lines||[]).map(t=>`<div class="text-dim" style="font-size:13px">${esc(t)}</div>`).join('')}
        </div>
        <div class="row" style="justify-content:flex-end">
          <button class="btn ghost" data-x>${esc(opts.cancelText||'취소')}</button>
          <button class="btn primary" data-ok>${esc(opts.okText||'확인')}</button>
        </div>
      </div>
    `;
    const close = (v)=>{ back.remove(); res(v); };
    back.addEventListener('click', e=>{ if(e.target===back) close(false); });
    back.querySelector('[data-x]').onclick = ()=> close(false);
    back.querySelector('[data-ok]').onclick = ()=> close(true);
    document.body.appendChild(back);
  });
}

// ===================================================
// ===============  TAB: 일반거래  ====================
async function viewTrade(root){
  let mode = 'list'; // 'list' | 'sell'
  let inv  = await loadInventory();
  let rows = await fetchTrades();
  rows.sort(sortByRarityThen);

  function rarityChip(r){ return `<span class="chip">${RARITY_LABEL[(r||'normal').toLowerCase()]||'일반'}</span>`; }

  function listHTML(){
    if (!rows.length) return `<div class="kv-card empty" style="margin-top:8px">아직 등록된 물건이 없어.</div>`;
    return `
      <div class="kv-card" style="margin-top:8px">
        <div class="grid">
          ${rows.map(L=>`
            <div class="kv-card">
              <div class="row" style="justify-content:space-between; align-items:flex-start">
                <div>
                  <div class="item-name">${esc(L.item_name || ('아이템 #' + (L.item_id||'')))}</div>
                  <div class="text-dim" style="font-size:12px; margin-top:2px">
                    ${rarityChip(L.item_rarity)}
                  </div>
                </div>
                <div class="chip">🪙 <b>${Number(L.price||0)}</b></div>
              </div>
              <div class="row" style="margin-top:8px; justify-content:flex-end; gap:6px">
                <button class="btn" data-buy="${esc(L.id)}">구매</button>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  function sellHTML(){
    return `
      <div class="kv-card" style="margin-top:8px">
        <div class="kv-label">내 인벤토리에서 판매 등록 <span class="text-dim" style="font-size:12px">(일반거래는 하루 5회 제한)</span></div>
        <div class="grid">
          ${inv.length ? inv.map(it=>`
            <div class="kv-card">
              <div class="item-name">${esc(it.name||'(이름없음)')}</div>
              <div class="text-dim" style="font-size:12px">${esc(it.rarity||'normal')}</div>
              <div class="row" style="gap:6px; margin-top:8px">
                <input class="input" type="number" min="1" step="1" placeholder="가격" style="width:120px" data-price-for="${esc(it.id)}">
                <button class="btn" data-sell="${esc(it.id)}">등록</button>
              </div>
            </div>
          `).join('') : `<div class="empty">인벤토리가 비어 있어.</div>`}
        </div>
      </div>
    `;
  }

  function render(){
    root.innerHTML = `
      ${header('trade')}
      <div class="wrap">
        <div class="kv-card"><div style="font-weight:900">일반거래</div></div>

        <div class="kv-card">
          <div class="row" style="justify-content:space-between; flex-wrap:wrap">
            <div class="row" style="gap:6px">
              <button class="btn ${mode==='list'?'primary':''}" data-go="list">구매</button>
              <button class="btn ${mode==='sell'?'primary':''}" data-go="sell">등록</button>
            </div>
            <div class="row" style="gap:6px">
              <select id="sort" class="input">
                <option value="rarity">정렬: 등급순</option>
                <option value="new">정렬: 최신순</option>
                <option value="p_asc">정렬: 가격↑</option>
                <option value="p_desc">정렬: 가격↓</option>
              </select>
            </div>
          </div>
        </div>

        ${mode==='list' ? listHTML() : sellHTML()}

        <div class="actionbar">
          <button class="btn ${mode==='list'?'primary':''}" data-go="list">구매 보기</button>
          <button class="btn ${mode==='sell'?'primary':''}" data-go="sell">등록하기</button>
        </div>
      </div>
    `;

    // 탭 전환
    root.querySelectorAll('[data-go]').forEach(b=>{
      b.onclick = ()=>{ mode = b.getAttribute('data-go'); render(); };
    });

    // 정렬
    const sel = root.querySelector('#sort');
    if (sel){
      sel.onchange = ()=>{
        const v = sel.value;
        if (v==='rarity') rows.sort(sortByRarityThen);
        if (v==='new') rows.sort((a,b)=> (b.createdAt?.seconds||0)-(a.createdAt?.seconds||0));
        if (v==='p_asc') rows.sort((a,b)=> Number(a.price||0)-Number(b.price||0));
        if (v==='p_desc') rows.sort((a,b)=> Number(b.price||0)-Number(a.price||0));
        render();
      };
    }

    // 구매
    root.querySelectorAll('[data-buy]').forEach(btn=>{
      btn.onclick = async ()=>{
        const id = btn.getAttribute('data-buy');
        const card = btn.closest('.kv-card');
        const name = card?.querySelector('.item-name')?.textContent || '아이템';
        const ok = await confirmModal({
          title: '구매 확인',
          lines: [`${name}을(를) 구매할까요?`, `구매 후 취소할 수 없어요.`],
          okText: '구매', cancelText: '취소'
        });
        if (!ok) return;
        try{
          const r = await call('tradeBuy')({ listingId: id });
          if (r.data?.ok){ showToast('구매 완료!'); rows = await fetchTrades(); rows.sort(sortByRarityThen); render(); }
          else showToast('구매 실패');
        }catch(e){ showToast(`구매 실패: ${e.message}`); }
      };
    });

    // 등록
    root.querySelectorAll('[data-sell]').forEach(btn=>{
      btn.onclick = async ()=>{
        const id = btn.getAttribute('data-sell');
        const price = Number(root.querySelector(`[data-price-for="${cssEsc(id)}"]`)?.value || 0);
        if (!price) return showToast('가격을 입력해줘');
        const item = inv.find(x => String(x.id)===String(id));
        const ok = await confirmModal({
          title: '등록 확인',
          lines: [
            `${item?.name || '아이템'}을(를) ${price}골드에 등록할까요?`,
            `일반거래는 하루 5회까지만 등록 가능해.`,
          ],
          okText: '등록', cancelText: '취소'
        });
        if (!ok) return;
        try{
          const r = await call('tradeCreateListing')({ itemId:id, price });
          if (r.data?.ok){ showToast('등록 완료!'); inv = await loadInventory(); rows = await fetchTrades(); rows.sort(sortByRarityThen); mode='list'; render(); }
          else showToast('등록 실패');
        }catch(e){ showToast(`등록 실패: ${e.message}`); }
      };
    });
  }

  render();
}

// ===================================================
// ==============  TAB: 일반 경매  ====================
async function viewAuction(root){
  let mode = 'list'; // 'list' | 'sell'
  let inv = await loadInventory();
  let rows = await fetchAuctions('normal');
  rows.sort(sortByRarityThen);

  function rarityChip(r){ return `<span class="chip">${RARITY_LABEL[(r||'normal').toLowerCase()]||'일반'}</span>`; }

  function listHTML(){
    if(!rows.length) return `<div class="kv-card empty" style="margin-top:8px">진행 중 경매가 아직 없어.</div>`;
    return `
      <div class="kv-card" style="margin-top:8px">
        <div class="grid">
          ${rows.map(A=>{
            const top = A.topBid?.amount ? `현재가 ${A.topBid.amount}` : `시작가 ${A.minBid}`;
            return `
              <div class="kv-card">
                <div class="row" style="justify-content:space-between; align-items:flex-start">
                  <div>
                    <div class="item-name">${esc(A.item_name || ('아이템 #' + (A.item_id||'')))}</div>
                    <div class="text-dim" style="font-size:12px; margin-top:2px">${rarityChip(A.item_rarity)}</div>
                    <div class="text-dim" style="font-size:12px; margin-top:2px">마감: ${prettyTime(A.endsAt)}</div>
                  </div>
                  <div class="chip">🪙 <b>${top}</b></div>
                </div>
                <div class="row" style="margin-top:8px; gap:6px; justify-content:flex-end">
                  <input class="input" type="number" min="1" step="1" placeholder="입찰가" style="width:120px" data-bid-for="${esc(A.id)}">
                  <button class="btn" data-bid="${esc(A.id)}">입찰</button>
                  <button class="btn ghost" data-settle="${esc(A.id)}">정산</button>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  function sellHTML(){
    return `
      <div class="kv-card" style="margin-top:8px">
        <div class="kv-label">내 인벤토리에서 경매 등록 <span class="text-dim" style="font-size:12px">(최소 30분, 등록 후 취소 불가)</span></div>
        <div class="grid">
          ${inv.length ? inv.map(it=>`
            <div class="kv-card">
              <div class="item-name">${esc(it.name||'(이름없음)')}</div>
              <div class="text-dim" style="font-size:12px">${esc(it.rarity||'normal')}</div>
              <div class="row" style="gap:6px; margin-top:8px; flex-wrap:wrap">
                <input class="input" type="number" min="1" step="1" placeholder="시작가" style="width:110px" data-sbid-for="${esc(it.id)}">
                <input class="input" type="number" min="30" step="5" placeholder="분(최소30)" style="width:120px" data-mins-for="${esc(it.id)}">
                <button class="btn" data-aucl="${esc(it.id)}">등록</button>
              </div>
            </div>
          `).join('') : `<div class="empty">인벤토리가 비어 있어.</div>`}
        </div>
      </div>
    `;
  }

  function render(){
    root.innerHTML = `
      ${header('auction')}
      <div class="wrap">
        <div class="kv-card"><div style="font-weight:900">일반 경매</div></div>

        <div class="kv-card">
          <div class="row" style="justify-content:space-between; flex-wrap:wrap">
            <div class="row" style="gap:6px">
              <button class="btn ${mode==='list'?'primary':''}" data-go="list">입찰</button>
              <button class="btn ${mode==='sell'?'primary':''}" data-go="sell">등록</button>
            </div>
            <div class="row" style="gap:6px">
              <select id="sortA" class="input">
                <option value="rarity">정렬: 등급순</option>
                <option value="new">정렬: 최신순</option>
              </select>
            </div>
          </div>
        </div>

        ${mode==='list' ? listHTML() : sellHTML()}

        <div class="actionbar">
          <button class="btn ${mode==='list'?'primary':''}" data-go="list">입찰 보기</button>
          <button class="btn ${mode==='sell'?'primary':''}" data-go="sell">경매 등록</button>
        </div>
      </div>
    `;

    // 전환
    root.querySelectorAll('[data-go]').forEach(b=>{
      b.onclick = ()=>{ mode = b.getAttribute('data-go'); render(); };
    });

    // 정렬
    const sel = root.querySelector('#sortA');
    if (sel){
      sel.onchange = ()=>{
        const v = sel.value;
        if (v==='rarity') rows.sort(sortByRarityThen);
        if (v==='new') rows.sort((a,b)=> (b.createdAt?.seconds||0)-(a.createdAt?.seconds||0));
        render();
      };
    }

    // 입찰
    root.querySelectorAll('[data-bid]').forEach(btn=>{
      btn.onclick = async ()=>{
        const id = btn.getAttribute('data-bid');
        const amt = Number(root.querySelector(`[data-bid-for="${cssEsc(id)}"]`)?.value || 0);
        if (!amt) return showToast('입찰가를 입력해줘');
        const ok = await confirmModal({
          title: '입찰 확인',
          lines: ['입찰가는 즉시 보증금으로 홀드돼.', '상회 입찰이 나오면 자동 환불돼.'],
          okText: '입찰', cancelText: '취소'
        });
        if (!ok) return;
        try{
          const r = await call('auctionBid')({ auctionId:id, amount:amt });
          if (r.data?.ok){ showToast('입찰 완료!'); rows = await fetchAuctions('normal'); rows.sort(sortByRarityThen); render(); }
          else showToast('입찰 실패');
        }catch(e){ showToast(`입찰 실패: ${e.message}`); }
      };
    });

    // 정산
    root.querySelectorAll('[data-settle]').forEach(btn=>{
      btn.onclick = async ()=>{
        const ok = await confirmModal({
          title: '정산',
          lines: ['마감된 경매를 정산할게?', '낙찰자는 보증금이 확정 차감되고 아이템이 지급돼.'],
          okText: '정산', cancelText: '닫기'
        });
        if (!ok) return;
        try{
          const r = await call('auctionSettle')({ auctionId: btn.getAttribute('data-settle') });
          if (r.data?.ok){ showToast('정산 완료/또는 아직 마감 전'); rows = await fetchAuctions('normal'); rows.sort(sortByRarityThen); render(); }
          else showToast('정산 실패');
        }catch(e){ showToast(`정산 실패: ${e.message}`); }
      };
    });

    // 등록
    root.querySelectorAll('[data-aucl]').forEach(btn=>{
      btn.onclick = async ()=>{
        const id = btn.getAttribute('data-aucl');
        const sb = Number(root.querySelector(`[data-sbid-for="${cssEsc(id)}"]`)?.value||0);
        const mins = Number(root.querySelector(`[data-mins-for="${cssEsc(id)}"]`)?.value||0) || 30;
        if (!sb) return showToast('시작가를 입력해줘');
        const item = inv.find(x => String(x.id)===String(id));
        const ok = await confirmModal({
          title: '경매 등록',
          lines: [
            `${item?.name || '아이템'}을(를) 시작가 ${sb}골드, ${mins}분 경매로 등록할까?`,
            '등록 후 취소할 수 없어.',
          ],
          okText: '등록', cancelText: '취소'
        });
        if (!ok) return;
        try{
          const r = await call('auctionCreate')({ itemId:id, minBid:sb, minutes:mins, kind:'normal' });
          if (r.data?.ok){ showToast('경매 등록 완료!'); inv = await loadInventory(); rows = await fetchAuctions('normal'); rows.sort(sortByRarityThen); mode='list'; render(); }
          else showToast('등록 실패');
        }catch(e){ showToast(`등록 실패: ${e.message}`); }
      };
    });
  }

  render();
}

// ===================================================
// ==============  TAB: 특수 경매  ====================
async function viewSpecial(root){
  let mode = 'list'; // 'list' | 'sell'
  let inv = await loadInventory();
  let rows = await fetchAuctions('special');

  function listHTML(){
    if(!rows.length) return `<div class="kv-card empty" style="margin-top:8px">진행 중 특수 경매가 아직 없어.</div>`;
    return `
      <div class="kv-card" style="margin-top:8px">
        <div class="grid">
          ${rows.map(A=>{
            const top = A.topBid?.amount ? `현재가 ${A.topBid.amount}` : `시작가 ${A.minBid}`;
            return `
              <div class="kv-card">
                <div class="row" style="justify-content:space-between; align-items:flex-start">
                  <div>
                    <div class="item-name">비공개 물품 #${esc(A.item_id||'')}</div>
                    <div class="text-dim" style="font-size:12px; margin-top:2px">${esc(A.description || '서술 없음')}</div>
                    <div class="text-dim" style="font-size:12px; margin-top:2px">마감: ${prettyTime(A.endsAt)}</div>
                  </div>
                  <div class="chip">🪙 <b>${top}</b></div>
                </div>
                <div class="row" style="margin-top:8px; gap:6px; justify-content:flex-end">
                  <input class="input" type="number" min="1" step="1" placeholder="입찰가" style="width:120px" data-bid-sp-for="${esc(A.id)}">
                  <button class="btn" data-bid-sp="${esc(A.id)}">입찰</button>
                  <button class="btn ghost" data-settle-sp="${esc(A.id)}">정산</button>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  function sellHTML(){
    return `
      <div class="kv-card" style="margin-top:8px">
        <div class="kv-label">내 인벤토리에서 특수 경매 등록 <span class="text-dim" style="font-size:12px">(등급/수치 비공개, 서술만 노출)</span></div>
        <div class="grid">
          ${inv.length ? inv.map(it=>`
            <div class="kv-card">
              <div class="item-name">${esc(it.name||'(이름없음)')}</div>
              <div class="row" style="gap:6px; margin-top:8px; flex-wrap:wrap">
                <input class="input" type="number" min="1" step="1" placeholder="시작가" style="width:110px" data-sbid-sp-for="${esc(it.id)}">
                <input class="input" type="number" min="30" step="5" placeholder="분(최소30)" style="width:120px" data-mins-sp-for="${esc(it.id)}">
                <button class="btn" data-aucl-sp="${esc(it.id)}">등록</button>
              </div>
              <div class="text-dim" style="font-size:12px; margin-top:4px">구매자에게는 서술만 보여.</div>
            </div>
          `).join('') : `<div class="empty">인벤토리가 비어 있어.</div>`}
        </div>
      </div>
    `;
  }

  function render(){
    root.innerHTML = `
      ${header('special')}
      <div class="wrap">
        <div class="kv-card"><div style="font-weight:900">특수 경매</div></div>

        <div class="kv-card">
          <div class="row" style="justify-content:space-between; flex-wrap:wrap">
            <div class="row" style="gap:6px">
              <button class="btn ${mode==='list'?'primary':''}" data-go="list">입찰</button>
              <button class="btn ${mode==='sell'?'primary':''}" data-go="sell">등록</button>
            </div>
          </div>
        </div>

        ${mode==='list' ? listHTML() : sellHTML()}

        <div class="actionbar">
          <button class="btn ${mode==='list'?'primary':''}" data-go="list">입찰 보기</button>
          <button class="btn ${mode==='sell'?'primary':''}" data-go="sell">특수 등록</button>
        </div>
      </div>
    `;

    // 전환
    root.querySelectorAll('[data-go]').forEach(b=>{
      b.onclick = ()=>{ mode = b.getAttribute('data-go'); render(); };
    });

    // 입찰
    root.querySelectorAll('[data-bid-sp]').forEach(btn=>{
      btn.onclick = async ()=>{
        const id = btn.getAttribute('data-bid-sp');
        const amt = Number(root.querySelector(`[data-bid-sp-for="${cssEsc(id)}"]`)?.value || 0);
        if (!amt) return showToast('입찰가를 입력해줘');
        const ok = await confirmModal({
          title: '입찰 확인',
          lines: ['입찰가는 즉시 보증금으로 홀드돼.', '상회 입찰이 나오면 자동 환불돼.'],
          okText: '입찰', cancelText: '취소'
        });
        if (!ok) return;
        try{
          const r = await call('auctionBid')({ auctionId:id, amount:amt });
          if (r.data?.ok){ showToast('입찰 완료!'); rows = await fetchAuctions('special'); render(); }
          else showToast('입찰 실패');
        }catch(e){ showToast(`입찰 실패: ${e.message}`); }
      };
    });

    // 정산
    root.querySelectorAll('[data-settle-sp]').forEach(btn=>{
      btn.onclick = async ()=>{
        const ok = await confirmModal({
          title: '정산',
          lines: ['마감된 경매를 정산할게?', '낙찰자는 보증금이 확정 차감되고 아이템이 지급돼.'],
          okText: '정산', cancelText: '닫기'
        });
        if (!ok) return;
        try{
          const r = await call('auctionSettle')({ auctionId: btn.getAttribute('data-settle-sp') });
          if (r.data?.ok){ showToast('정산 완료/또는 아직 마감 전'); rows = await fetchAuctions('special'); render(); }
          else showToast('정산 실패');
        }catch(e){ showToast(`정산 실패: ${e.message}`); }
      };
    });

    // 등록
    root.querySelectorAll('[data-aucl-sp]').forEach(btn=>{
      btn.onclick = async ()=>{
        const id = btn.getAttribute('data-aucl-sp');
        const sb = Number(root.querySelector(`[data-sbid-sp-for="${cssEsc(id)}"]`)?.value||0);
        const mins = Number(root.querySelector(`[data-mins-sp-for="${cssEsc(id)}"]`)?.value||0) || 30;
        if (!sb) return showToast('시작가를 입력해줘');
        const item = inv.find(x => String(x.id)===String(id));
        const ok = await confirmModal({
          title: '특수 경매 등록',
          lines: [
            `${item?.name || '아이템'}을(를) 시작가 ${sb}골드, ${mins}분 특수 경매로 등록할까?`,
            '등록 후 취소할 수 없어.',
          ],
          okText: '등록', cancelText: '취소'
        });
        if (!ok) return;
        try{
          const r = await call('auctionCreate')({ itemId:id, minBid:sb, minutes:mins, kind:'special' });
          if (r.data?.ok){ showToast('특수 경매 등록 완료!'); inv = await loadInventory(); rows = await fetchAuctions('special'); mode='list'; render(); }
          else showToast('등록 실패');
        }catch(e){ showToast(`등록 실패: ${e.message}`); }
      };
    });
  }

  render();
}

// ===================================================
// ==================  ENTRY  ========================
export async function showMarket(){
  ensureStyles();

  // 루트 보장
  let root =
    document.querySelector('[data-view="root"]') ||
    document.getElementById('view-root') ||
    document.getElementById('root');

  if (!root) {
    root = document.createElement('div');
    root.setAttribute('data-view', 'root');
    document.body.appendChild(root);
  }

  const tab = subpath();

  root.innerHTML = `
    <div class="market2">
      <div class="wrap">
        <div class="kv-card"><div style="font-weight:900">거래소</div></div>
      </div>
      <div class="wrap"><div id="market-root"></div></div>
    </div>
  `;

  const slot = root.querySelector('#market-root');
  if (tab === 'auction') return viewAuction(slot);
  if (tab === 'special') return viewSpecial(slot);
  return viewTrade(slot);
}

export default showMarket;
