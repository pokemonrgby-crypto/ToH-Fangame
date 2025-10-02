// /public/js/ui/item.js

// [수정] import 문: seedCreatorModal을 promptModal로 교체합니다.
import { esc, rarityStyle, useBadgeHtml } from './utils.js';
import { ensureModalCss, promptModal } from './modal.js';
import { showToast } from './toast.js';
import { appraiseItem, usePromptItem } from '../api/user.js';

let allItemsCache = null;
async function getAllItemsData() {
    if (allItemsCache) return allItemsCache;
    try {
        const response = await fetch('/assets/items.json');
        if (!response.ok) throw new Error('items.json not found');
        allItemsCache = await response.json();
        return allItemsCache;
    } catch (error) {
        console.error("Failed to load items.json:", error);
        return {};
    }
}

async function getSeedInfoHtml(it) {
    if (it.type !== 'seed' || !it.seedInfo) return '';
    const allItems = await getAllItemsData();
    const info = it.seedInfo;
    const growthTime = info.growthTimeMinutes || 0;
    const hours = Math.floor(growthTime / 60);
    const minutes = growthTime % 60;
    const timeText = hours > 0 ? `${hours}시간 ${minutes}분` : `${minutes}분`;

    const harvestItems = Array.isArray(info.harvest)
        ? info.harvest.map(h => {
            const itemInfo = allItems[h.itemId] || { name: h.itemId };
            const probText = h.probability < 1.0 ? ` (${h.probability * 100}%)` : '';
            return `<li>${esc(itemInfo.name || h.itemId)} (${h.min}~${h.max}개)${probText}</li>`;
        }).join('')
        : '<li>알 수 없음</li>';
    
    const mutationProb = (it.mutation?.probability || 0) * 100;
    const aestheticValue = it.properties?.aestheticValue || 0;

    return `
        <hr style="margin:12px 0; border-color:#273247;">
        <div class="kv-label">씨앗 정보</div>
        <div style="display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 13px; margin-top: 8px;">
            <b>성장 시간</b> <div>${timeText}</div>
            <b>다년생</b> <div>${info.isPerennial ? '✔ 예' : '❌ 아니오'}</div>
            <b>배치 가능</b> <div>${it.placeable ? '✔ 예' : '❌ 아니오'}</div>
            ${aestheticValue > 0 ? `<b>미관 점수</b> <div>${aestheticValue.toLocaleString()}</div>` : ''}
            <b>돌연변이 확률</b> <div>${mutationProb > 0 ? `${mutationProb.toFixed(1)}%` : '없음'}</div>
            <b style="grid-column: 1 / -1; margin-top: 6px;">예상 수확물</b>
            <ul style="grid-column: 1 / -1; margin: 0; padding-left: 20px; list-style-type: '- ';">${harvestItems}</ul>
        </div>
    `;
}

export async function showItemDetailModal(item, context = {}) {
    ensureModalCss();
    if (document.querySelector('.modal-back[data-kind="item-detail"]')) return;
    const { equippedIds, onUpdate } = context;
    const isEquipped = Array.isArray(equippedIds) && equippedIds.includes(item.id);
    const style = rarityStyle(item.rarity);
    const getItemDesc = (it) => (it?.description || it?.desc_long || it?.desc_soft || it?.desc || '').replace(/\n/g, '<br>');

    // (getEffectsHtml, getPropertiesHtml 함수는 변경 없음)
    const getEffectsHtml = (it) => { /* ... */ return ''; };
    const getPropertiesHtml = (it) => { /* ... */ return ''; };

    const back = document.createElement('div');
    back.className = 'modal-back';
    back.dataset.kind = 'item-detail';
    back.style.zIndex = '9000';

    const seedHtml = await getSeedInfoHtml(item);

    back.innerHTML = `
    <div class="modal-card">
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
        <div>${getItemDesc(item) || '상세 설명이 없습니다.'}</div>
        ${item.effects ? getEffectsHtml(item) : ''}
        ${getPropertiesHtml(item)}
        ${seedHtml} 
      </div>
      <div id="itemActions" style="display:flex; justify-content:flex-end; gap:8px; margin-top:12px;"></div>
    </div>
  `;

    const closeModal = () => back.remove();
    back.addEventListener('click', e => { if (e.target === back) closeModal(); });
    back.querySelector('#mCloseDetail').onclick = closeModal;

    const actionsContainer = back.querySelector('#itemActions');
    
    // [핵심 수정] 'isPromptUse' 아이템 사용 시 promptModal 호출
    if (item.isPromptUse === true) {
        const btnUse = document.createElement('button');
        btnUse.className = 'btn primary';
        btnUse.textContent = '✨ 사용하기';
        btnUse.onclick = async () => {
            // 새로 만든 promptModal을 호출합니다.
            const userPrompt = await promptModal({
                title: '커스텀 씨앗 생성',
                hint: 'AI가 당신의 아이디어를 기반으로 새로운 씨앗을 창조합니다.',
                placeholder: '예: 밤하늘의 별똥별을 닮은, 먹으면 행운을 가져다주는 과일나무 씨앗',
                okText: '생성 요청'
            });

            if (userPrompt === null) return; // 사용자가 취소

            btnUse.disabled = true;
            btnUse.textContent = '생성 중...';
            try {
                // 서버에 텍스트 프롬프트를 전달합니다.
                const result = await usePromptItem(item.id, userPrompt);
                if (result.ok) {
                    showToast(`'${result.newItem.name}' 아이템을 획득했습니다!`);
                    closeModal();
                    if (typeof onUpdate === 'function') {
                        onUpdate(); // 인벤토리 UI 새로고침 콜백
                    }
                }
            } catch (err) {
                showToast(`아이템 사용 실패: ${err.message}`);
                btnUse.disabled = false;
                btnUse.textContent = '✨ 사용하기';
            }
        };
        actionsContainer.appendChild(btnUse);
    }
    
    const canAppraise = !item.properties?.appraised;
    if (canAppraise) {
        const btnAppraise = document.createElement('button');
        btnAppraise.className = 'btn primary';
        btnAppraise.textContent = '🔍 감정하기';
        btnAppraise.onclick = async () => {
            btnAppraise.disabled = true;
            btnAppraise.textContent = '감정 중...';
            try {
                const result = await appraiseItem(item.id);
                if (result.ok) {
                    showToast('아이템 감정이 완료되었습니다!');
                    closeModal(); 
                    if (typeof onUpdate === 'function') {
                        onUpdate();
                    }
                } else { throw new Error('서버에서 감정을 거부했습니다.'); }
            } catch (err) {
                showToast(`감정 실패: ${err.message}`);
                btnAppraise.disabled = false;
                btnAppraise.textContent = '🔍 감정하기';
            }
        };
        actionsContainer.appendChild(btnAppraise);
    }

    if (typeof onUpdate === 'function' && Array.isArray(equippedIds)) {
      if (isEquipped) {
        const btnUnequip = document.createElement('button');
        btnUnequip.className = 'btn';
        btnUnequip.textContent = '장착 해제';
        btnUnequip.onclick = () => {
          onUpdate(equippedIds.filter(id => id !== item.id));
          closeModal();
        };
        actionsContainer.appendChild(btnUnequip);
      } else if (equippedIds.length < 3) {
        const btnEquip = document.createElement('button');
        btnEquip.className = 'btn primary';
        btnEquip.textContent = '장착하기';
        btnEquip.onclick = () => {
          onUpdate([...equippedIds, item.id]);
          closeModal();
        };
        actionsContainer.appendChild(btnEquip);
      }
    }
    document.body.appendChild(back);
}
