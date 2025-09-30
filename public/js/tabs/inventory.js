// /public/js/tabs/inventory.js (신규 파일)
import { db, auth, fx } from '../api/firebase.js';
import { showToast } from '../ui/toast.js';
import { getUserInventory, toggleItemLock } from '../api/user.js';
import { showItemDetailModal } from '../ui/item.js';
import { esc, rarityStyle, useBadgeHtml, ensureItemCss } from '../ui/utils.js';
import { viewWorldPick } from './adventure.js';

export async function showInventory(root) {
  const u = auth.currentUser;
  if (!u) {
    showToast('로그인이 필요합니다.');
    return;
  }

  let allItems = [];
  let unsub = null;

  // 실시간으로 인벤토리 변경 감지
  const userDocRef = fx.doc(db, 'users', u.uid);
  unsub = fx.onSnapshot(userDocRef, (doc) => {
    allItems = doc.exists() ? (doc.data().items_all || []) : [];
    renderInventory();
  });

  // 탭이 닫힐 때 구독 해제
  const view = root.closest('#view');
  if (view) {
    view.__cleanup = () => {
      if (unsub) unsub();
    };
  }
  
  ensureItemCss();

  root.innerHTML = `
    <section class="container narrow">
      <div class="book-card">
        <div class="bookmarks">
          <button class="bookmark ghost" id="btnToExplore">탐험</button>
          <button class="bookmark ghost" disabled>레이드(준비중)</button>
          <button class="bookmark active" disabled>가방</button>
        </div>
        <div class="bookview p12">
          <div class="kv-label">공유 보관함 (아이템 클릭: 상세정보, 🔒: 잠금/해제)</div>
          <div id="inventoryItems" class="grid4" style="gap:12px; max-height:60vh; overflow-y:auto; padding:8px 4px 4px 0;">
            </div>
        </div>
      </div>
    </section>
  `;

  const inventoryItemsBox = root.querySelector('#inventoryItems');
  
  function renderInventory() {
    inventoryItemsBox.innerHTML = ''; // Clear previous content
    if (allItems.length > 0) {
      allItems.forEach(item => {
        const style = rarityStyle(item.rarity);
        const isShiny = ['epic', 'legend', 'myth'].includes((item.rarity || '').toLowerCase());
        const isLocked = item.isLocked === true;

        const card = document.createElement('div');
        card.className = `kv-card item-card ${isShiny ? 'shine-effect' : ''}`;
        card.style.cssText = `
          padding: 8px;
          border: 1px solid ${style.border};
          background: ${style.bg};
          color: ${style.text};
          position: relative; /* 자물쇠 아이콘 위치 기준 */
        `;
        card.innerHTML = `
          <div class="item-content-wrapper" style="cursor: pointer;">
            <div class="row" style="align-items:center;gap:8px">
              <div style="font-weight:700;line-height:1.2">${esc(item.name)}</div>
              ${useBadgeHtml(item)}
            </div>
            <div style="font-size:12px;opacity:.85;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">
              ${esc(item.desc_soft || item.desc || item.description || '')}
            </div>
          </div>
          <button class="btn-lock" data-item-id="${item.id}" data-locked="${isLocked}" style="position: absolute; top: 4px; right: 4px; background: none; border: none; font-size: 18px; cursor: pointer; padding: 4px; line-height: 1;">
            ${isLocked ? '🔒' : '🔓'}
          </button>
        `;

        card.querySelector('.item-content-wrapper').addEventListener('click', () => showItemDetailModal(item));
        
        card.querySelector('.btn-lock').addEventListener('click', async (e) => {
          e.stopPropagation();
          const button = e.currentTarget;
          const itemId = button.dataset.itemId;
          const currentLockState = button.dataset.locked === 'true';
          
          button.disabled = true;
          try {
            await toggleItemLock(itemId, !currentLockState);
            showToast(`아이템을 ${!currentLockState ? '잠갔습니다.' : '해제했습니다.'}`);
          } catch (err) {
            showToast(`오류: ${err.message}`);
          } finally {
            button.disabled = false;
          }
        });

        inventoryItemsBox.appendChild(card);
      });
    } else {
      inventoryItemsBox.innerHTML = `<div class="kv-card text-dim" style="grid-column: 1 / -1;">보관함에 아이템이 없습니다.</div>`;
    }
  }
  
  root.querySelector('#btnToExplore').addEventListener('click', () => {
    if(unsub) unsub();
    viewWorldPick(root);
  });

  renderInventory();
}
