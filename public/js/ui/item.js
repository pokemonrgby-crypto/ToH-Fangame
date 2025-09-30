// /public/js/ui/item.js
import { esc, rarityStyle, useBadgeHtml } from './utils.js';
import { ensureModalCss } from './modal.js';

/**
 * 아이템 상세 정보 모달을 표시합니다.
 * @param {object} item - 아이템 객체
 * @param {object} context - { equippedIds: string[], onUpdate: function(string[]) }
 */
export function showItemDetailModal(item, context = {}) {
    ensureModalCss();
    if (document.querySelector('.modal-back[data-kind="item-detail"]')) return;
    const { equippedIds = [], onUpdate = null } = context;
    const isEquipped = equippedIds.includes(item.id);

    const style = rarityStyle(item.rarity);
    const getItemDesc = (it) => (it?.description || it?.desc_long || it?.desc_soft || it?.desc || '').replace(/\n/g, '<br>');
    const getEffectsHtml = (it) => {
        const eff = it?.effects;
        if (!eff) return '';
        if (Array.isArray(eff)) return `<ul style="margin:6px 0 0 16px; padding:0;">${eff.map(x=>`<li>${esc(String(x||''))}</li>`).join('')}</ul>`;
        if (typeof eff === 'object') return `<ul style="margin:6px 0 0 16px; padding:0;">${Object.entries(eff).map(([k,v])=>`<li><b>${esc(k)}</b>: ${esc(String(v??''))}</li>`).join('')}</ul>`;
        return `<div>${esc(String(eff))}</div>`;
    };

    const back = document.createElement('div');
    back.className = 'modal-back';
    back.dataset.kind = 'item-detail';
    back.style.zIndex = '10001';

    back.innerHTML = `
    <div class="modal-card" style="background:#0e1116;border:1px solid #273247;border-radius:14px;padding:14px;max-width:720px;width:92vw;">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px;">
        <div>
          <div class="row" style="align-items:center;gap:8px;flex-wrap:wrap">
            <div style="font-weight:900; font-size:18px;">${esc(item.name)}</div>
            <span class="chip" style="background:${style.border}; color:${style.bg}; font-weight:800;">${esc(style.label)}</span>
            ${useBadgeHtml(item)}
          </div>
        </div>
        <button class="btn ghost" id="mCloseDetail">닫기</button>
      </div>
      <div class="kv-card ${(item.rarity||'').toLowerCase()==='aether' ? 'rarity-aether' : ''}" style="padding:12px;">
        <div style="font-size:14px; line-height:1.6;">${getItemDesc(item) || '상세 설명이 없습니다.'}</div>
        ${item.effects ? `<hr style="margin:12px 0; border-color:#273247;"><div class="kv-label">효과</div><div style="font-size:13px;">${getEffectsHtml(item)}</div>` : ''}
      </div>
      <div id="itemActions" style="display:flex; justify-content:flex-end; gap:8px; margin-top:12px;"></div>
    </div>
  `;
    const closeModal = () => back.remove();
    back.addEventListener('click', e => { if (e.target === back) closeModal(); });
    back.querySelector('#mCloseDetail').onclick = closeModal;

    const actionsContainer = back.querySelector('#itemActions');

    if (typeof onUpdate === 'function') {
      if (isEquipped) {
        const btnUnequip = document.createElement('button');
        btnUnequip.className = 'btn';
        btnUnequip.textContent = '장착 해제';
        btnUnequip.onclick = () => {
          const newEquipped = equippedIds.filter(id => id !== item.id);
          onUpdate(newEquipped);
          closeModal();
        };
        actionsContainer.appendChild(btnUnequip);
      } else if (equippedIds.length < 3) {
        const btnEquip = document.createElement('button');
        btnEquip.className = 'btn primary';
        btnEquip.textContent = '장착하기';
        btnEquip.onclick = () => {
          const newEquipped = [...equippedIds, item.id];
          onUpdate(newEquipped);
          closeModal();
        };
        actionsContainer.appendChild(btnEquip);
      }
    }
    document.body.appendChild(back);
}
