// /public/js/tabs/shop.js
import { showToast } from '../ui/toast.js';
import { showItemDetailModal } from '../ui/item.js';
import { rarityStyle, ensureItemCss, esc } from '../ui/utils.js';
import { ensureModalCss, confirmModal } from '../ui/modal.js';
import { func, auth } from '../api/firebase.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-functions.js';
import { isAdminCached } from '../api/admin.js';
import { buySeed } from '../api/farm.js';
import { getUserInventory } from '../api/user.js';

let seedsData = []; // 씨앗 데이터 캐시

async function loadSeedsData() {
    if (seedsData.length > 0) return seedsData;
    // 씨앗 데이터가 등급별로 분리되었으므로, 이제 각 파일을 모두 가져와야 합니다.
    // 여기서는 간단하게 기존 `seeds.json`을 그대로 사용하고, 
    // 백엔드에서는 분리된 파일을 읽도록 수정했으므로 클라이언트는 수정할 필요가 없습니다.
    try {
        const response = await fetch('/assets/seeds.json');
        if (!response.ok) throw new Error('seeds.json not found');
        seedsData = await response.json();
        return seedsData;
    } catch (error) {
        console.error("Failed to load seeds data:", error);
        return [];
    }
}

// [수정] 메인 렌더링 함수: 요청하신대로 UI 구조 변경
export async function renderShop(container) {
    const hash = location.hash || '';
    const isBuy = hash.includes('/buy');
    const isSell = hash.includes('/sell');
    const isFarm = hash.includes('/farm'); // 농사 탭 식별
    
    const subtabsHTML = `
        <div class="subtabs" style="margin-top: 12px; padding: 0 8px;">
            <a href="#/economy/shop/buy" class="sub ${isBuy || isFarm ? 'active' : ''}" style="text-decoration:none;">구매</a>
            <a href="#/economy/shop/sell" class="sub ${isSell ? 'active' : ''}" style="text-decoration:none;">판매</a>
            <a href="#/economy/shop/daily" class="sub" style="text-decoration:none; color: var(--muted);">일일상점(준비중)</a>
        </div>
    `;
    container.innerHTML = subtabsHTML + `<div id="shop-content" style="margin-top: 8px;"></div>`;

    const contentRoot = container.querySelector('#shop-content');
    
    if (isSell) {
        await renderShop_Sell(contentRoot);
    } else { // 기본적으로 '구매' 관련 탭들을 표시
        await renderShop_Buy(contentRoot, { isFarm });
    }
}

// [신규] 구매 탭 UI 렌더링 함수
async function renderShop_Buy(root, { isFarm }) {
    const buySubtabsHTML = `
        <div class="subtabs" style="padding: 0 8px; margin-bottom: 12px;">
            <a href="#/economy/shop/buy/general" class="sub" style="text-decoration:none; color: var(--muted);">일반</a>
            <a href="#/economy/shop/buy/farm" class="sub ${isFarm ? 'active' : ''}" style="text-decoration:none;">농사</a>
        </div>
        <div id="buy-content"></div>
    `;
    root.innerHTML = buySubtabsHTML;
    
    const buyContentRoot = root.querySelector('#buy-content');

    if (isFarm) {
        await renderShop_Farm(buyContentRoot);
    } else {
        // 기본 '구매' 탭 (현재 준비중)
        buyContentRoot.innerHTML = `<div class="kv-card text-dim">일반 아이템 구매는 준비 중입니다.</div>`;
    }
}

// 농사 탭 UI 렌더링 함수 (기존과 동일)
async function renderShop_Farm(root) {
  ensureItemCss();
  const seeds = await loadSeedsData();
  const isAdmin = isAdminCached();

  root.innerHTML = `
      <div class="kv-card" style="margin-bottom:12px;">
          <div style="font-weight:900;">씨앗 상점</div>
          <div class="text-dim" style="font-size:12px;">농사에 필요한 씨앗이나 묘목을 구매할 수 있습니다. (현재 관리자 전용)</div>
      </div>
      <div class="grid3" style="gap:12px;">
          ${seeds.map(seed => {
              const style = rarityStyle(seed.rarity);
              return `
                  <div class="kv-card item-card" style="padding:10px; border-left: 3px solid ${style.border}; background: ${style.bg};">
                      <div class="row" style="justify-content:space-between; align-items:flex-start;">
                          <div style="font-weight:700; color:${style.text};">${esc(seed.name)}</div>
                          <div class="chip">🪙 ${seed.price}</div>
                      </div>
                      <div class="text-dim" style="font-size:12px; margin-top:6px; min-height: 3em;">${esc(seed.description)}</div>
                      <div class="row" style="justify-content:flex-end; margin-top:8px;">
                          ${isAdmin ? `<button class="btn small btn-buy-seed" data-seed-id="${esc(seed.id)}">구매</button>` : ''}
                      </div>
                  </div>
              `;
          }).join('')}
      </div>
  `;

  if (isAdmin) {
      root.querySelectorAll('.btn-buy-seed').forEach(btn => {
          btn.onclick = async () => {
              const seedId = btn.dataset.seedId;
              const quantity = parseInt(prompt("구매할 수량을 입력하세요:", "1"), 10);
              if (!quantity || quantity <= 0) return;

              btn.disabled = true;
              btn.textContent = '구매중...';
              try {
                  await buySeed({ seedId, quantity });
                  showToast(`${seedId} 씨앗 ${quantity}개를 구매했습니다.`);
              } catch (e) {
                  showToast(`구매 실패: ${e.message}`);
              } finally {
                  btn.disabled = false;
                  btn.textContent = '구매';
              }
          };
      });
  }
}

// 아이템 판매 탭 UI 렌더링 함수 (기존과 동일)
async function renderShop_Sell(root) {
  ensureItemCss();

  const rarityOrder = ['aether', 'myth', 'legend', 'epic', 'rare', 'normal'];
  const rarityNames  = { aether:'에테르', myth:'신화', legend:'레전드', epic:'유니크', rare:'레어', normal:'일반' };

  const calculatePrice = (item) => {
    const prices = {
      consumable:     { normal:1,  rare:5,  epic:25, legend:50,  myth:100, aether:250 },
      non_consumable: { normal:2,  rare:10, epic:50, legend:100, myth:200, aether:500 }
    };
    const isConsumable = item.isConsumable || item.consumable;
    const tier = isConsumable ? prices.consumable : prices.non_consumable;
    const basePrice = tier[(item.rarity || 'normal').toLowerCase()] || 0;
    
    const aestheticBonus = Math.floor(0.02 * (item.properties?.aestheticValue || 0));

    return basePrice + aestheticBonus;
  };

  let inventory = [];
  let selectedIds = new Set();
  let searchTerm  = '';
  let isLoading   = false;

  const render = () => {
    if (isLoading) {
      root.innerHTML = `<div class="kv-card text-dim">인벤토리를 불러오는 중...</div>`;
      return;
    }
    if (!inventory.length) {
      root.innerHTML = `<div class="kv-card text-dim">판매할 아이템이 없습니다.</div>`;
      return;
    }

    const filtered = inventory.filter(it => String(it.name||'').toLowerCase().includes(searchTerm.toLowerCase()));

    const grouped = filtered.reduce((acc, it)=>{
      const r = (it.rarity||'normal').toLowerCase();
      (acc[r] ||= []).push(it);
      return acc;
    }, {});

    const totalPrice = Array.from(selectedIds).reduce((sum, id)=>{
      const it = inventory.find(x=>x.id===id);
      return sum + (it ? calculatePrice(it) : 0);
    }, 0);

    let html = `
      <div class="kv-card" style="margin-bottom:12px;">
        <input type="search" id="item-search" class="input" placeholder="아이템 이름 검색..." value="${esc(searchTerm)}">
        <div class="row" style="margin-top:8px; justify-content:space-around; flex-wrap:wrap;">
          ${rarityOrder.map(r=>`<button class="btn ghost small btn-bulk-sell" data-rarity="${r}">${rarityNames[r]} 일괄선택</button>`).join('')}
        </div>
      </div>

      <div id="sell-item-list" class="col" style="gap:12px;">
    `;

    for (const r of rarityOrder) {
      const list = grouped[r];
      if (!list || !list.length) continue;
      const style = rarityStyle(r);
      html += `
        <div>
          <div class="kv-label" style="color:${style.text}; border-bottom:1px solid ${style.border}; padding-bottom:4px; margin-bottom:8px;">
            ${rarityNames[r]} 등급
          </div>
          <div class="grid3" style="gap:8px;">
            ${list.map(item=>{
              const isAether   = (String(item.rarity||'').toLowerCase()==='aether');
              const isSelected = selectedIds.has(item.id);
              const isLocked = item.isLocked === true;
              const leftBorder = isAether ? '' : `border-left:3px solid ${isSelected ? '#4aa3ff' : style.border};`;
              return `
                <button class="kv-card item-card item-sell-card ${isSelected?'selected':''} ${isAether?'rarity-aether':''}"
                        data-item-id="${item.id}"
                        style="${leftBorder} text-align:left; padding:8px; ${isLocked ? 'opacity: 0.6; cursor: not-allowed;' : ''}"
                        ${isLocked ? 'disabled' : ''}>
                  <div style="font-weight:700; color:${style.text};">${esc(item.name)} ${isLocked ? '🔒' : ''}</div>
                  <div class="text-dim" style="font-size:12px;">판매가: 🪙 ${calculatePrice(item)}</div>
                </button>
              `;
            }).join('')}
          </div>
        </div>
      `;
    }

    html += `</div>
      <div id="sell-footer"
           style="position:sticky; bottom:80px; margin-top:16px; padding:12px; background:rgba(12,15,20,.8); backdrop-filter:blur(8px); border:1px solid #2a2f36; border-radius:14px;">
        <button class="btn primary large" id="btn-sell-confirm" style="width:100%;" ${selectedIds.size===0?'disabled':''}>
          ${selectedIds.size>0 ? `${selectedIds.size}개 아이템 판매 (총 🪙 ${totalPrice})` : '판매할 아이템 선택'}
        </button>
      </div>
      <style>
        .item-sell-card.selected { outline:2px solid #4aa3ff; transform:translateY(-2px); }
      </style>
    `;

    root.innerHTML = html;
    attachEvents();
  };

  const attachEvents = () => {
    root.querySelector('#item-search')?.addEventListener('input', (e)=>{
      searchTerm = e.target.value;
      render();
    });

    root.querySelectorAll('.item-sell-card').forEach(card=>{
      card.addEventListener('click', ()=>{
        if (card.disabled) {
          showToast('잠긴 아이템은 판매할 수 없습니다.');
          return;
        }
        const id = card.getAttribute('data-item-id');
        if (!id) return;
        if (selectedIds.has(id)) selectedIds.delete(id);
        else selectedIds.add(id);
        render();
      });
    });

    root.querySelectorAll('.btn-bulk-sell').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const r = btn.getAttribute('data-rarity');
        const targets = (inventory||[]).filter(it => 
          !it.isLocked &&
          (String(it.rarity||'normal').toLowerCase()===r) &&
          String(it.name||'').toLowerCase().includes(searchTerm.toLowerCase())
        );
        const allSelected = targets.every(it=>selectedIds.has(it.id));
        if (allSelected) targets.forEach(it=>selectedIds.delete(it.id));
        else targets.forEach(it=>selectedIds.add(it.id));
        render();
      });
    });

    root.querySelector('#btn-sell-confirm')?.addEventListener('click', showSellConfirmation);
  };

  const showSellConfirmation = () => {
    ensureModalCss();
    if (selectedIds.size===0) return;

    const itemsToSell = Array.from(selectedIds).map(id=>inventory.find(i=>i.id===id)).filter(Boolean);
    const totalPrice  = itemsToSell.reduce((s,it)=>s+calculatePrice(it),0);

    const back = document.createElement('div');
    back.className = 'modal-back';
    back.style.zIndex = '10001';
    back.innerHTML = `
      <div class="modal-card" style="max-width:480px; display:flex; flex-direction:column; gap:12px;">
        <div style="font-weight:900; font-size:18px; text-align:center; padding-bottom:8px; border-bottom:1px solid #2a2f36;">
          아이템 판매 확인
        </div>
        <div class="col" style="gap:4px;">
          <div class="text-dim" style="font-size:13px; margin-bottom:4px;">판매할 아이템:</div>
          <div class="item-list-box" style="max-height:200px; overflow-y:auto; background:#0e1116; border:1px solid #273247; border-radius:8px; padding:10px;">
            ${itemsToSell.map(it=>`<div style="padding:2px 0;">- ${esc(it.name)}</div>`).join('')}
          </div>
        </div>
        <div style="text-align:center; margin-top:8px;">
          <p>위 ${itemsToSell.length}개의 아이템을 총 <b style="color:#f3c34f; font-size:1.1em;">🪙 ${totalPrice}</b> 골드에 판매하시겠습니까?</p>
          <p class="text-dim" style="font-size:12px;">이 작업은 되돌릴 수 없습니다.</p>
        </div>
        <div class="row" style="margin-top:8px; justify-content:flex-end; gap:8px;">
          <button class="btn ghost" id="btn-cancel-sell">취소</button>
          <button class="btn primary" id="btn-confirm-sell">판매 확인</button>
        </div>
      </div>
    `;
    document.body.appendChild(back);

    const close = ()=> back.remove();
    back.addEventListener('click', e=>{ if(e.target===back) close(); });
    back.querySelector('#btn-cancel-sell')?.addEventListener('click', close);
    back.querySelector('#btn-confirm-sell')?.addEventListener('click', async ()=>{
      close();
      await executeSell();
    });
  };

  const executeSell = async () => {
    isLoading = true; render();
    try {
      const sellItemsFn = httpsCallable(func, 'sellItems');
      const res = await sellItemsFn({ itemIds: Array.from(selectedIds) });
      if (!res?.data?.ok && typeof res?.data?.goldEarned!=='number') {
        throw new Error('서버 판매 처리 실패');
      }
      showToast(`🪙 ${res.data.goldEarned} 골드를 얻었습니다!`);
      selectedIds.clear();
      await loadInventory();
    } catch (e) {
      console.error(e);
      showToast(`판매 실패: ${e.message}`);
    } finally {
      isLoading = false; render();
    }
  };

  const loadInventory = async () => {
    isLoading = true; render();
    try {
      inventory = await getUserInventory();
    } catch { inventory = []; }
    isLoading = false; render();
  };

  loadInventory();
}
