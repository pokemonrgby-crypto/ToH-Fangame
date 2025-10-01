// /public/js/tabs/economy.js
import { db, auth, fx } from '../api/firebase.js';
import { renderShop } from './shop.js';
import { renderStocks } from './stockmarket.js';
import { renderMyStocks } from './mystocks.js';
import { showWorldMap } from './worldmap.js'; // ◀◀ 월드맵 함수 임포트

function esc(s){ return String(s ?? '').replace(/[&<>"']/g, c=>({'&':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function subNav(current='#/economy/shop', coins = 0){
  // '부동산' 탭 활성화
  return `
  <div class="bookmarks" style="display:flex; gap:8px; flex-wrap:wrap; margin:8px 0 12px; align-items:center;">
    <a class="bookmark ${current.includes('/shop')?'active':''}" href="#/economy/shop"  style="text-decoration:none;">상점</a>
    <a class="bookmark ${current.includes('/stock')?'active':''}" href="#/economy/stock" style="text-decoration:none;">주식</a>
    <a class="bookmark ${current.includes('/mystocks')?'active':''}" href="#/economy/mystocks" style="text-decoration:none;">내 주식</a>
    <a class="bookmark ${current.includes('/estate')?'active':''}" href="#/economy/estate" style="text-decoration:none;">부동산</a>
    <div class="chip" style="margin-left: auto;">🪙 <b>${coins.toLocaleString()}</b></div>
  </div>`;
}

export default async function showEconomy(){
  const view = document.getElementById('view');
  if (!view) return;

  if (view.__cleanup) {
    try { view.__cleanup(); } catch (e) { console.error('Cleanup failed', e); }
    delete view.__cleanup;
  }
  
  const hash = location.hash || '#/economy/shop';
  const isShop = hash.startsWith('#/economy/shop');
  const isStock = hash.startsWith('#/economy/stock');
  const isMyStocks = hash.startsWith('#/economy/mystocks');
  const isEstate = hash.startsWith('#/economy/estate'); // ◀◀ 부동산 탭 확인

  let userCoins = 0;
  const uid = auth.currentUser?.uid;
  if (uid) {
      try {
          const userSnap = await fx.getDoc(fx.doc(db, 'users', uid));
          if (userSnap.exists()) {
              userCoins = userSnap.data().coins || 0;
          }
      } catch (e) { console.warn("코인 정보 로딩 실패", e); }
  }

  view.innerHTML = `
    <div class="kv-card" style="padding:12px;margin-bottom:8px;">
      <div style="font-weight:900;font-size:20px;">경제 허브</div>
      <div style="color:var(--muted);font-size:12px;">상점 / 주식 / 부동산</div>
    </div>
    ${subNav(hash, userCoins)}
    <div id="eco-body"></div>
  `;

  const body = view.querySelector('#eco-body');

  // ◀◀ 부동산 탭 라우팅 로직 추가
  if (isStock) {
    await renderStocks(body);
  } else if (isShop) {
    await renderShop(body);
  } else if (isMyStocks) {
    await renderMyStocks(body);
  } else if (isEstate) {
    // 부동산 탭이 활성화되면 showWorldMap 함수를 호출합니다.
    await showWorldMap();
    // showWorldMap은 #view 전체를 다시 그리므로, 여기서는 추가 작업이 필요 없습니다.
    // 만약 body 내에만 그리고 싶다면 showWorldMap(body) 형태로 수정이 필요합니다.
  } else {
    body.innerHTML = `<div class="kv-card text-dim">준비 중인 콘텐츠입니다.</div>`;
  }
}
