// public/js/tabs/market.js (모바일 UI 및 버그 수정 최종본)

import { db, fx, auth, func } from '../api/firebase.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-functions.js';
import { showToast } from '../ui/toast.js';
import { ensureModalCss, confirmModal } from '../ui/modal.js';
import { showItemDetailModal } from '../ui/item.js';
import { rarityStyle, useBadgeHtml } from '../ui/utils.js';

// ---------- util ----------
const call = (name) => httpsCallable(func, name);
const esc  = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cssEsc = (s) => (window.CSS?.escape ? CSS.escape(String(s ?? '')) : String(s ?? '').replace(/[^\w-]/g, '_'));

const RARITY_ORDER = ['aether','myth','legend','epic','rare','normal'];

function prettyTime(ts){
  function fmt(ms){
    if (!ms) return '-';
    const d = new Date(ms);
    const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), dd = String(d.getDate()).padStart(2,'0');
    const hh = String(d.getHours()).padStart(2,'0'), mm = String(d.getMinutes()).padStart(2,'0');
    return `${y}-${m}-${dd} ${hh}:${mm}`;
  }
  if (!ts) return '-';
  if (typeof ts === 'number') return fmt(ts);
  if (typeof ts === 'string') return fmt(Number(ts)); // 혹시 문자열 타임스탬프면 숫자로
  if (typeof ts?.toMillis === 'function') return fmt(ts.toMillis());
  const sec = (ts?._seconds ?? ts?.seconds);
  const nano = (ts?._nanoseconds ?? ts?.nanoseconds ?? 0);
  if (sec != null) return fmt(sec * 1000 + Math.floor(nano/1e6));
  return '-';
}


function subpath(){
  const h = location.hash || '';
  const m = h.match(/^#\/market(?:\/([^/]+))?/);
  return m?.[1] ? m[1] : 'trade';
}

async function loadUserData(){
  const uid = auth.currentUser?.uid; if (!uid) return { inv: [], coins: 0 };
  const s = await fx.getDoc(fx.doc(db, 'users', uid));
  if (!s.exists()) return { inv: [], coins: 0 };
  const data = s.data();
  return {
    inv: data.items_all || [],
    coins: data.coins || 0
  };
}

async function fetchTrades(){
  const { data } = await call('tradeListPublic')({});
  return Array.isArray(data?.rows) ? data.rows : [];
}
async function fetchAuctions(kind){
  const { data } = await call('auctionListPublic')({ kind });
  return Array.isArray(data?.rows) ? data.rows : [];
}

function header(tab, coins = 0){
  // 모바일 화면 최적화를 위해 상점, 길드 탭 제거
  return `<div class="bookmarks">
    <a href="#/market/trade"   class="bookmark ${tab==='trade'?'active':''}">↔️ 일반거래</a>
    <a href="#/market/auction" class="bookmark ${tab==='auction'?'active':''}">🏷️ 일반 경매</a>
    <a href="#/market/special" class="bookmark ${tab==='special'?'active':''}">🎭 특수 경매</a>
    <a href="#/market/my" class="bookmark ${tab==='my'?'active':''}">📊 경매정보</a>
    <div class="chip" style="margin-left: auto;">🪙 <b>${coins}</b></div>
  </div>`;
}

async function showTradeDetailModal(listing, onPurchase) {
  ensureModalCss();
  const uid = auth.currentUser?.uid;
  let item = null, price = 0, seller_uid = '';
  try {
    const { data } = await call('tradeGetListingDetail')({ listingId: listing.id });
    if (!data.ok) throw new Error('상세 정보 로딩 실패');
    item = data.item; price = data.price; seller_uid = data.seller_uid;
  } catch(e) { showToast(`오류: ${e.message}`); return; }
  
  const style = rarityStyle(item.rarity);
  const isMyItem = uid === seller_uid;

  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `
    <div class="modal-card" style="max-width: 520px;">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px;">
        <div class="item-name" style="font-size:18px; font-weight: 800; color:${style.text}">${esc(item.name)}</div>
        <button class="btn ghost" id="mClose">닫기</button>
      </div>
      <div class="kv-card" style="border-left: 3px solid ${style.border}; background:${style.bg};">
        <p>${(item.description || item.desc_long || item.desc_soft || item.desc || '상세 설명 없음').replace(/\n/g, '<br>')}</p>
      </div>
      <div class="row" style="margin-top: 12px; justify-content: flex-end;">
        ${isMyItem ? '<div class="text-dim">내 아이템</div>' : `<button class="btn primary" id="btn-buy">🪙 ${price}에 구매</button>`}
      </div>
    </div>
  `;
  const closeModal = () => back.remove();
  back.addEventListener('click', e => { if (e.target === back) closeModal(); });
  back.querySelector('#mClose').onclick = closeModal;

  if (!isMyItem) {
    back.querySelector('#btn-buy').onclick = async () => {
      if (!await confirmModal({ title: '구매 확인', lines: [`${item.name}을(를) 🪙${price} 골드에 구매합니다.`] })) return;
      try {
        await call('tradeBuy')({ listingId: listing.id });
        showToast('구매 성공!'); onPurchase(); closeModal();
      } catch (e) { showToast(`구매 실패: ${e.message}`); }
    };
  }
  document.body.appendChild(back);
}


async function showAuctionDetailModal(auctionId) {
  ensureModalCss();
  let data;
  try {
    const res = await call('auctionGetDetail')({ auctionId });
    data = res.data;
    if (!data?.ok) throw new Error('상세 정보 로딩 실패');
  } catch (e) {
    showToast(`오류: ${e.message}`);
    return;
  }

  if (data.kind === 'special') {
    showToast('특수 경매는 정보가 비공개야.');
    return;
  }

  const item = data.item || {};
  const style = rarityStyle(item.rarity);
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `
    <div class="modal-card" style="max-width: 520px;">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px;">
        <div class="item-name" style="font-size:18px; font-weight: 800; color:${style.text}">${esc(item.name || '이름 없음')}</div>
        <button class="btn ghost" id="mClose">닫기</button>
      </div>
      <div class="kv-card" style="border-left: 3px solid ${style.border}; background:${style.bg};">
        <p>${(item.description || item.desc_long || item.desc_soft || item.desc || '상세 설명 없음').replace(/\n/g, '<br>')}</p>
      </div>
    </div>
  `;
  const closeModal = () => back.remove();
  back.addEventListener('click', e => { if (e.target === back) closeModal(); });
  back.querySelector('#mClose').onclick = closeModal;
  document.body.appendChild(back);
}


// ===================================================
// TAB: 일반거래
// ===================================================
async function viewTrade(root, inv, coins){
  let mode = 'list';
  let sortKey = 'rarity';
  let rows = await fetchTrades();
  const handleRefresh = async () => { 
    const data = await loadUserData();
    inv = data.inv;
    coins = data.coins;
    rows = await fetchTrades(); 
    render(); 
  };

  function render(){
    const sortedRows = [...rows];
    if (sortKey==='rarity') sortedRows.sort((a,b) => RARITY_ORDER.indexOf(a.item_rarity) - RARITY_ORDER.indexOf(b.item_rarity) || (b.createdAt?._seconds||0)-(a.createdAt?._seconds||0));
    if (sortKey==='new') sortedRows.sort((a,b)=> (b.createdAt?._seconds||0)-(a.createdAt?._seconds||0));
    if (sortKey==='p_asc') sortedRows.sort((a,b)=> Number(a.price||0)-Number(b.price||0));
    if (sortKey==='p_desc') sortedRows.sort((a,b)=> Number(b.price||0)-Number(a.price||0));

    const listHTML = sortedRows.length ? `<div class="grid">${sortedRows.map(L => {
      const style = rarityStyle(L.item_rarity);
      return `
        <div class="card" style="border-left: 3px solid ${style.border}; background: ${style.bg};">
          <div class="row" style="justify-content:space-between; align-items:flex-start">
            <div class="item-name title" style="color:${style.text}">${esc(L.item_name)}</div>
            ${useBadgeHtml(L)}
          </div>
          <div class="row" style="margin-top:8px; justify-content:space-between; gap:6px">
            <button class="btn" data-detail='${JSON.stringify(L)}'>상세보기</button>
            <div class="chip">🪙 <b>${Number(L.price||0)}</b></div>
          </div>
        </div>
      `;
    }).join('')}</div>` : `<div class="empty card">아직 등록된 물건이 없어.</div>`;

    const sellHTML = inv.length ? `<div class="grid">${inv.map(it => {
      const style = rarityStyle(it.rarity);
      return `
        <div class="card" style="border-left: 3px solid ${style.border}; background: ${style.bg};">
          <div class="item-name title" style="color:${style.text}">${esc(it.name)}</div>
          <div class="row" style="gap:6px; margin-top:8px">
            <input class="input" type="number" min="1" step="1" placeholder="가격" style="width:100px; flex:1;" data-price-for="${esc(it.id)}">
            <button class="btn" data-sell-detail='${JSON.stringify(it)}'>정보</button>
            <button class="btn primary" data-sell="${esc(it.id)}">등록</button>
          </div>
        </div>
      `;
    }).join('')}</div>` : `<div class="empty card">인벤토리가 비어 있어.</div>`;

    root.innerHTML = `
      ${header('trade', coins)}
      <div class="bookview">
        <div class="card">
          <div class="row" style="justify-content:space-between; flex-wrap:wrap">
            <div class="row" style="gap:6px">
              <button class="btn ${mode==='list'?'primary':''}" data-go="list">구매</button>
              <button class="btn ${mode==='sell'?'primary':''}" data-go="sell">등록</button>
            </div>
            <div class="row" style="gap:6px">
              <select id="sort" class="input" style="width: auto;">
                <option value="rarity">정렬: 등급순</option> <option value="new">정렬: 최신순</option>
                <option value="p_asc">정렬: 가격↑</option> <option value="p_desc">정렬: 가격↓</option>
              </select>
            </div>
          </div>
        </div>
        <div style="margin-top:12px">
          ${mode==='list' ? listHTML : `<div class="kv-label">내 인벤토리에서 판매 등록 <span class="text-dim">(일일 5회, 기준가±50%)</span></div>${sellHTML}`}
        </div>
      </div>
    `;
    root.querySelector('#sort').value = sortKey;
    root.querySelectorAll('[data-go]').forEach(b => b.onclick = () => { mode = b.dataset.go; render(); });
    root.querySelector('#sort')?.addEventListener('change', e => { sortKey = e.target.value; render(); });
    root.querySelectorAll('[data-detail]').forEach(btn => btn.onclick = () => showTradeDetailModal(JSON.parse(btn.dataset.detail), handleRefresh));
    root.querySelectorAll('[data-sell-detail]').forEach(btn => btn.onclick = () => showItemModalForListing(JSON.parse(btn.dataset.sellDetail)));
    root.querySelectorAll('[data-sell]').forEach(btn => btn.onclick = async () => {
      const id = btn.dataset.sell;
      const price = Number(root.querySelector(`[data-price-for="${cssEsc(id)}"]`)?.value || 0);
      if (!price || price <= 0) return showToast('가격을 입력해줘');
      const item = inv.find(x => x.id === id);
      if (!await confirmModal({title: '등록 확인', lines: [`${item?.name}을(를) ${price}골드에 등록합니다.`]})) return;
      try {
        await call('tradeCreateListing')({ itemId:id, price });
        showToast('등록 완료!'); await handleRefresh(); mode = 'list'; render();
      } catch(e) { showToast(`등록 실패: ${e.message}`); }
    });
  }
  render();
}
// /public/js/tabs/market.js (이어서)

async function viewAuction(root, inv, coins){
  let mode = 'list';
  let sortKey = 'rarity';
  let rows = await fetchAuctions('normal');
  const handleRefresh = async () => { 
    const data = await loadUserData();
    inv = data.inv;
    coins = data.coins;
    rows = await fetchAuctions('normal'); 
    render(); 
    
  }

  function render(){
    const sortedRows = [...rows];
    if (sortKey === 'rarity') sortedRows.sort((a,b) => RARITY_ORDER.indexOf(a.item_rarity) - RARITY_ORDER.indexOf(b.item_rarity) || (b.createdAt?._seconds||0)-(a.createdAt?._seconds||0));
    if (sortKey === 'new') sortedRows.sort((a,b)=> (b.createdAt?._seconds||0)-(a.createdAt?._seconds||0));

    const listHTML = sortedRows.length ? `<div class="grid">${sortedRows.map(A=>{
      const top = A.topBid?.amount ? `현재가 ${A.topBid.amount}` : `시작가 ${A.minBid}`;
      const style = rarityStyle(A.item_rarity);
      const minNext = Math.max(A.minBid||1, (A.topBid?.amount||0)+1);
      return `
        <div class="card" style="border-left: 3px solid ${style.border}; background: ${style.bg};">
          <div class="row" style="justify-content:space-between; align-items:flex-start">
            <div class="item-name title" style="color:${style.text}">${esc(A.item_name)}</div>
            ${useBadgeHtml(A)}
          </div>
          <div class="text-dim" style="font-size:12px; margin-top:2px">마감: ${prettyTime(A.endsAt)}</div>
          <div class="row" style="gap:6px; align-items:center;">
  <div class="chip">🪙 <b>${top}</b></div>
  ${ (auth.currentUser?.uid && A.topBid?.uid===auth.currentUser.uid) ? '<span class="chip success">입찰중</span>' : '' }
</div>

          <div class="row" style="margin-top:8px; gap:6px;">
            <button class="btn" data-au-detail="${esc(A.id)}">상세보기</button>
            <input class="input" type="number" min="${minNext}" step="1" placeholder="${minNext} 이상" style="flex:1;" data-bid-for="${esc(A.id)}">
            <button class="btn primary" data-bid="${esc(A.id)}">입찰</button>
          </div>
        </div>
      `;
    }).join('')}</div>` : `<div class="empty card">진행 중 경매가 아직 없어.</div>`;

    const sellHTML = inv.length ? `<div class="grid">${inv.map(it=>{
      const style = rarityStyle(it.rarity);
      return `
      <div class="card" style="border-left: 3px solid ${style.border}; background: ${style.bg};">
        <div class="item-name title" style="color:${style.text}">${esc(it.name)}</div>
        <div class="row" style="gap:6px; margin-top:8px; flex-wrap:wrap">
          <input class="input" type="number" min="1" step="1" placeholder="시작가" style="width:100px; flex:1;" data-sbid-for="${esc(it.id)}">
          <input class="input" type="number" min="30" step="5" placeholder="분" style="width:80px; flex:1;" data-mins-for="${esc(it.id)}">
        </div>
        <div class="row" style="gap:6px; margin-top:8px;">
          <button class="btn" data-sell-detail='${JSON.stringify(it)}'>정보</button>
          <button class="btn primary" data-aucl="${esc(it.id)}" style="flex:1;">등록</button>
        </div>
      </div>
      `}).join('')}</div>` : `<div class="empty card">인벤토리가 비어 있어.</div>`;
    
    root.innerHTML = `
      ${header('auction', coins)}
      <div class="bookview">
        <div class="card">
          <div class="row" style="justify-content:space-between; flex-wrap:wrap">
            <div class="row" style="gap:6px"> <button class="btn ${mode==='list'?'primary':''}" data-go="list">입찰</button> <button class="btn ${mode==='sell'?'primary':''}" data-go="sell">등록</button> </div>
            <select id="sortA" class="input" style="width:auto;"> <option value="rarity">정렬: 등급순</option> <option value="new">정렬: 최신순</option> </select>
          </div>
        </div>
        <div style="margin-top:12px"> ${mode==='list' ? listHTML : `<div class="kv-label">내 인벤토리에서 경매 등록 <span class="text-dim">(최소 30분, 취소 불가)</span></div>${sellHTML}`} </div>
      </div>
    `;
    root.querySelector('#sortA').value = sortKey;
    root.querySelectorAll('[data-go]').forEach(b=>b.onclick=()=>{mode=b.dataset.go; render();});
    root.querySelector('#sortA')?.addEventListener('change', e => { sortKey = e.target.value; render(); });
    root.querySelectorAll('[data-sell-detail]').forEach(btn => btn.onclick = () => showItemModalForListing(JSON.parse(btn.dataset.sellDetail)));
    root.querySelectorAll('[data-bid]').forEach(btn => {
  btn.onclick = async () => {
    const id  = btn.dataset.bid;
    const amt = Number(root.querySelector(`[data-bid-for="${cssEsc(id)}"]`)?.value || 0);
    if (!amt) return showToast('입찰가를 입력해줘');

    // 현재 카드 데이터에서 최소 허용가 재계산
    const A = (rows||[]).find(r => String(r.id) === String(id)) || {};
    const minNext = Math.max((A.minBid||1), (A.topBid?.amount||0) + 1);
    if (amt < minNext) return showToast(`최소 ${minNext} 이상으로 입찰해줘`);

    if (!await confirmModal({ title: '입찰 확인', lines: ['입찰가는 즉시 보증금으로 홀드됩니다.'] })) return;
    try {
      await call('auctionBid')({ auctionId:id, amount:amt });
      showToast('입찰 완료!'); handleRefresh();
    } catch (e) {
      showToast(`입찰 실패: ${e.message}`);
    }
  };
});

    root.querySelectorAll('[data-aucl]').forEach(btn=>{ btn.onclick = async ()=>{
        const id = btn.dataset.aucl;
        const sb = Number(root.querySelector(`[data-sbid-for="${cssEsc(id)}"]`)?.value||0);
        const mins = Number(root.querySelector(`[data-mins-for="${cssEsc(id)}"]`)?.value||0) || 30;
        if (!sb) return showToast('시작가를 입력해줘');
        if (!await confirmModal({ title: '경매 등록', lines: [`시작가 ${sb}골드, ${mins}분 경매로 등록합니다.`, '등록 후 취소할 수 없습니다.']})) return;
        try{ await call('auctionCreate')({ itemId:id, minBid:sb, minutes:mins, kind:'normal' }); showToast('경매 등록 완료!'); await handleRefresh(); mode='list'; render(); }
        catch(e){ showToast(`등록 실패: ${e.message}`); }
    }});

    root.querySelectorAll('[data-au-detail]').forEach(btn=>{
      btn.onclick = () => showAuctionDetailModal(btn.dataset.auDetail);
    });

  }
  render();
}

async function viewSpecial(root, inv, coins){
  let mode = 'list';
  let rows = await fetchAuctions('special');
  rows.sort((a,b)=> (b.createdAt?._seconds||0)-(a.createdAt?._seconds||0));
  const handleRefresh = async () => {
    const data = await loadUserData();
    inv = data.inv;
    coins = data.coins;
    rows = await fetchAuctions('special'); 
    render(); 
  }
  function render(){
    const listHTML = rows.length ? `<div class="grid">${rows.map(A=>{
      const top = A.topBid?.amount ? `현재가 ${A.topBid.amount}` : `시작가 ${A.minBid}`;
      const minNext = Math.max(A.minBid||1, (A.topBid?.amount||0)+1);
      return `
        <div class="card special-card">
          <div class="item-name title">비공개 물품 #${esc(A.id.slice(-6))}</div>
          <div class="text-dim" style="font-size:12px; margin-top:2px; min-height: 2.4em;">${esc(A.description || '서술 없음')}</div>
          <div class="text-dim" style="font-size:12px; margin-top:2px">마감: ${prettyTime(A.endsAt)}</div>
          <div class="chip" style="align-self: flex-start;">🪙 <b>${top}</b></div>
          <div class="row" style="margin-top:8px; gap:6px;">
            <input class="input" type="number" min="${minNext}" step="1" placeholder="${minNext} 이상" style="flex:1;" data-bid-sp-for="${esc(A.id)}">
            <button class="btn primary" data-bid-sp="${esc(A.id)}">입찰</button>
          </div>
        </div>
      `;
    }).join('')}</div>` : `<div class="empty card">진행 중 특수 경매가 아직 없어.</div>`;
    const sellHTML = inv.length ? `<div class="grid">${inv.map(it=>{
      const style = rarityStyle(it.rarity);
      return `
      <div class="card" style="border-left: 3px solid ${style.border}; background: ${style.bg};">
        <div class="item-name title" style="color:${style.text}">${esc(it.name)}</div>
        <div class="row" style="gap:6px; margin-top:8px; flex-wrap:wrap">
          <input class="input" type="number" min="1" step="1" placeholder="시작가" style="width:100px; flex:1;" data-sbid-sp-for="${esc(it.id)}">
          <input class="input" type="number" min="30" step="5" placeholder="분" style="width:80px; flex:1;" data-mins-sp-for="${esc(it.id)}">
        </div>
        <div class="row" style="gap:6px; margin-top:8px;">
          <button class="btn" data-sell-detail='${JSON.stringify(it)}'>정보</button>
          <button class="btn primary" data-aucl-sp="${esc(it.id)}" style="flex:1;">등록</button>
        </div>
        <div class="text-dim" style="font-size:12px; margin-top:4px">※ 구매자에겐 등급/수치가 비공개됩니다.</div>
      </div>
      `}).join('')}</div>` : `<div class="empty card">인벤토리가 비어 있어.</div>`;

    root.innerHTML = `
      ${header('special', coins)}
      <div class="bookview">
        <div class="card"><button class="btn ${mode==='list'?'primary':''}" data-go="list">입찰</button> <button class="btn ${mode==='sell'?'primary':''}" data-go="sell">등록</button></div>
        <div style="margin-top:12px">${mode==='list' ? listHTML : `<div class="kv-label">내 인벤토리에서 특수 경매 등록</div>${sellHTML}`}</div>
      </div>
    `;
    root.querySelectorAll('[data-go]').forEach(b => b.onclick = () => { mode = b.dataset.go; render(); });
    root.querySelectorAll('[data-sell-detail]').forEach(btn => btn.onclick = () => showItemModalForListing(JSON.parse(btn.dataset.sellDetail)));
    root.querySelectorAll('[data-bid-sp]').forEach(btn => {
  btn.onclick = async () => {
    const id  = btn.dataset.bidSp;
    const amt = Number(root.querySelector(`[data-bid-sp-for="${cssEsc(id)}"]`)?.value || 0);
    if (!amt) return showToast('입찰가를 입력해줘');

    const A = (rows||[]).find(r => String(r.id) === String(id)) || {};
    const minNext = Math.max((A.minBid||1), (A.topBid?.amount||0) + 1);
    if (amt < minNext) return showToast(`최소 ${minNext} 이상으로 입찰해줘`);

    if (!await confirmModal({ title: '입찰 확인', lines: ['입찰가는 즉시 보증금으로 홀드됩니다.'] })) return;
    try {
      await call('auctionBid')({ auctionId:id, amount:amt });
      showToast('입찰 완료!'); handleRefresh();
    } catch (e) {
      showToast(`입찰 실패: ${e.message}`);
    }
  };
});

    root.querySelectorAll('[data-aucl-sp]').forEach(btn=>{ btn.onclick = async ()=>{
        const id = btn.dataset.auclSp;
        const sb = Number(root.querySelector(`[data-sbid-sp-for="${cssEsc(id)}"]`)?.value||0);
        const mins = Number(root.querySelector(`[data-mins-sp-for="${cssEsc(id)}"]`)?.value||0) || 30;
        if (!sb) return showToast('시작가를 입력해줘');
        if (!await confirmModal({ title: '특수 경매 등록', lines: [`시작가 ${sb}골드, ${mins}분 특수 경매로 등록합니다.`]})) return;
        try{ await call('auctionCreate')({ itemId:id, minBid:sb, minutes:mins, kind:'special' }); showToast('특수 경매 등록 완료!'); await handleRefresh(); mode='list'; render(); }
        catch(e){ showToast(`등록 실패: ${e.message}`); }
    }});
  }
  render();
}

// ANCHOR: viewMyListings 함수 수정
async function viewMyListings(root, coins){
  let sub = 'bids';
  let myBids = [], myTrades = [], myAuctions = [];

  async function refresh(){
    try {
      const [bidsRes, tradesRes, auctionsRes] = await Promise.all([
        call('auctionListMyBids')({}),
        call('tradeListMyListings')({}),
        call('auctionListMyListings')({})
      ]);
      myBids = Array.isArray(bidsRes?.data?.rows) ? bidsRes.data.rows : [];
      myTrades = Array.isArray(tradesRes?.data?.rows) ? tradesRes.data.rows.map(r => ({...r, type: 'trade'})) : [];
      myAuctions = Array.isArray(auctionsRes?.data?.rows) ? auctionsRes.data.rows.map(r => ({...r, type: 'auction'})) : [];
    } catch(e) {
      console.error(e);
      root.innerHTML = `${header('my', coins)}<div class="bookview"><div class="empty card error" style="margin-top:12px;">정보를 불러오지 못했어.</div></div>`;
      return;
    }
    render();
  }

  function bidsHTML(){
    const uid = auth.currentUser?.uid;
    // 1. 마감되지 않은(active) 경매만 필터링
    const activeBids = myBids.filter(row => row.status === 'active');
    
    // 2. 경매 ID별로 최신 입찰만 남기기 (중복 제거)
    const latestBids = Array.from(new Map(activeBids.map(item => [item.id, item])).values());

    if (latestBids.length === 0) return `<div class="empty card">입찰한 경매가 아직 없어.</div>`;
    
        return `<div class="grid">` + latestBids.map(row=>{
      const iAmTop = (uid && row.topBid?.uid === uid);
      const topTxt = row.topBid?.amount ? `현재가 ${row.topBid.amount}` : `시작가 ${row.minBid}`;
      const isSpecial = row.kind === 'special';
      const name = isSpecial ? `비공개 물품 #${row.id.slice(-6)}` : (row.item_name || '(이름없음)');
      const style = row.item_rarity ? rarityStyle(row.item_rarity) : { border:'#555', bg:'', text:'' };
      const borderStyle = isSpecial ? '' : `border-left:3px solid ${style.border};`;

      return `
        <div class="card ${isSpecial ? 'special-card' : ''}" style="${borderStyle}">
          <div class="item-name title" style="color:${style.text}">${esc(name)}</div>
          <div class="text-dim" style="font-size:12px;">마감: ${prettyTime(row.endsAt)}</div>
          <div class="row" style="gap:6px; align-items:center; margin-top:4px;">
            <div class="chip">🪙 ${topTxt}</div>
            ${iAmTop ? '<span class="chip success">입찰중</span>' : ''}
          </div>
          <div class="row" style="margin-top:8px; gap:6px;">
            <div class="chip ghost">내 최근 입찰: <b>${row.myAmount}</b></div>
            <input class="input" type="number"
       min="${Math.max((row.topBid?.amount||0)+1, row.minBid)}"
       step="1"
       placeholder="${Math.max((row.topBid?.amount||0)+1, row.minBid)} 이상"
       style="flex:1;"
       data-rebid-for="${esc(row.id)}">

            <button class="btn primary" data-rebid="${esc(row.id)}">올려서 입찰</button>
          </div>
        </div>`;
    }).join('') + `</div>`;
  }
  
  function listingsHTML(){
    const allItems = [...myTrades, ...myAuctions].sort((a,b)=> (b.createdAt?._seconds||0)-(a.createdAt?._seconds||0));
    if (!allItems.length) return `<div class="empty card">등록한 물품이 없습니다.</div>`;
    return `<div class="grid">` + allItems.map(item=>{
      if (item.type === 'trade'){
        const style = rarityStyle(item.item_rarity);
        const statusText = { active:'판매중', sold:'판매완료', cancelled:'취소됨' }[item.status] || item.status;
        return `
          <div class="card" style="border-left:3px solid ${style.border};">
            <div class="item-name title" style="color:${style.text}">${esc(item.item_name)}</div>
            <div class="text-dim" style="font-size:12px;">일반거래 · ${statusText}</div>
            <div class="row" style="margin-top:8px; justify-content:space-between">
              <div class="chip">🪙 ${item.price}</div>
              ${item.status==='active' ? `<button class="btn danger" data-cancel-my="${esc(item.id)}">판매취소</button>` : ''}
            </div>
          </div>`;
      } else {
        const top = item.topBid?.amount ? `현재가 ${item.topBid.amount}` : `시작가 ${item.minBid}`;
        const isEnded = (item.endsAt?._seconds * 1000 || 0) <= Date.now();
        return `
          <div class="card ${item.kind==='special'?'special-card':''}">
            <div class="item-name title">${esc(item.item_name || `비공개 물품 #${item.id.slice(-6)}`)}</div>
            <div class="text-dim" style="font-size:12px;">${item.kind==='special'?'특수경매':'일반경매'} · ${item.status}</div>
            <div class="text-dim" style="font-size:12px;">마감: ${prettyTime(item.endsAt)}</div>
            <div class="row" style="margin-top:8px; justify-content:space-between">
              <div class="chip">🪙 ${top}</div>
              ${item.status==='active' && isEnded ? `<button class="btn primary" data-settle-my="${esc(item.id)}">정산</button>` : ''}
            </div>
          </div>`;
      }
    }).join('') + `</div>`;
  }

  function render(){
    root.innerHTML = `
      ${header('my', coins)}
      <div class="bookview">
        <div class="card">
          <div class="row" style="gap:6px;">
            <button class="btn ${sub==='bids'?'primary':''}" data-sub="bids">내 입찰정보</button>
            <button class="btn ${sub==='list'?'primary':''}" data-sub="list">내 등록물품</button>
          </div>
        </div>
        <div style="margin-top:12px;">
          ${sub==='bids' ? bidsHTML() : listingsHTML()}
        </div>
      </div>
    `;

    root.querySelectorAll('[data-sub]').forEach(b=> b.onclick=()=>{ sub=b.dataset.sub; render(); });

    root.querySelectorAll('[data-rebid]').forEach(btn => btn.onclick = async ()=>{
      const id = btn.dataset.rebid;
      const amt = Number(root.querySelector(`[data-rebid-for="${cssEsc(id)}"]`)?.value||0);
      if (!amt) return showToast('재입찰 금액을 입력해줘');
      if (!await confirmModal({ title:'재입찰 확인', lines:['입찰가는 즉시 보증금으로 홀드됩니다.']})) return;
      try{ await call('auctionBid')({ auctionId:id, amount:amt }); showToast('입찰 올리기 완료!'); refresh(); }
      catch(e){ showToast(`실패: ${e.message}`); }
    });

    root.querySelectorAll('[data-cancel-my]').forEach(btn => btn.onclick = async ()=>{
      if (!await confirmModal({title:'판매 취소', lines:['등록을 취소하고 아이템을 돌려받겠습니까?']})) return;
      try { await call('tradeCancelListing')({ listingId: btn.dataset.cancelMy }); showToast('판매를 취소했습니다.'); refresh(); }
      catch (e) { showToast(`취소 실패: ${e.message}`); }
    });
    root.querySelectorAll('[data-settle-my]').forEach(btn => btn.onclick = async ()=>{
      if (!await confirmModal({ title:'정산', lines:['마감된 경매를 정산합니다.']})) return;
      try { await call('auctionSettle')({ auctionId: btn.dataset.settleMy }); showToast('정산 완료!'); refresh(); }
      catch (e) { showToast(`정산 실패: ${e.message}`); }
    });
  }
  refresh();
}
// ANCHOR_END

export default async function showMarket(){
  ensureModalCss();
  const root = document.getElementById('view');
  if (!root) return;
  const tab = subpath();
  root.innerHTML = `<section class="container narrow" id="market-root"><div class="spin-center" style="margin-top:40px;"></div></section>`;
  const marketRoot = root.querySelector('#market-root');

  const { inv, coins } = await loadUserData();

  if (tab === 'auction') return viewAuction(marketRoot, inv, coins);
  if (tab === 'special') return viewSpecial(marketRoot, inv, coins);
  if (tab === 'my') return viewMyListings(marketRoot, coins);
  return viewTrade(marketRoot, inv, coins);
}
