// /public/js/ui/item.js
import { esc, rarityStyle, useBadgeHtml } from './utils.js';
import { ensureModalCss, promptModal } from './modal.js'; // promptModal 추가
import { showToast } from './toast.js';
import { appraiseItem, usePromptItem } from '../api/user.js'; // usePromptItem 추가

// [신규] 게임 내 모든 아이템의 정보를 불러와 캐시하는 함수
// 수확물 ID를 한글 이름으로 바꾸기 위해 필요합니다.
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


/**
 * [신규] 씨앗 아이템일 경우, 농사 관련 정보를 표시하는 HTML을 생성하는 함수입니다.
 * @param {object} it - 아이템 객체
 * @returns {Promise<string>} 씨앗 정보가 담긴 HTML 문자열 Promise
 */
async function getSeedInfoHtml(it) {
    // 아이템 타입이 'seed'가 아니거나, seedInfo 객체가 없으면 아무것도 표시하지 않습니다.
    if (it.type !== 'seed' || !it.seedInfo) return '';

    const allItems = await getAllItemsData();
    const info = it.seedInfo;
    const growthTime = info.growthTimeMinutes || 0;
    const hours = Math.floor(growthTime / 60);
    const minutes = growthTime % 60;
    const timeText = hours > 0 ? `${hours}시간 ${minutes}분` : `${minutes}분`;

    // 수확물 정보를 표시합니다. items.json을 참조하여 아이템 ID를 한글 이름으로 보여줍니다.
    const harvestItems = Array.isArray(info.harvest)
        ? info.harvest.map(h => {
            const itemInfo = allItems[h.itemId] || { name: h.itemId };
            const probText = h.probability < 1.0 ? ` (${h.probability * 100}%)` : '';
            return `<li>${esc(itemInfo.name)} (${h.min}~${h.max}개)${probText}</li>`;
        }).join('')
        : '<li>알 수 없음</li>';
    
    const mutationProb = (it.mutation?.probability || 0) * 100;
    const aestheticValue = it.properties?.aestheticValue || 0;

    // 최종적으로 표시될 HTML 구조입니다.
    return `
        <hr style="margin:12px 0; border-color:#273247;">
        <div class="kv-label">씨앗 정보</div>
        <div style="display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; align-items: start; font-size: 13px; margin-top: 8px;">
            <b style="color: #9aa4b2;">성장 시간</b>
            <div>${timeText}</div>

            <b style="color: #9aa4b2;">다년생</b>
            <div>${info.isPerennial ? '✔ 예' : '❌ 아니오'}</div>

            <b style="color: #9aa4b2;">배치 가능</b>
            <div>${it.placeable ? '✔ 예' : '❌ 아니오'}</div>
            
            ${aestheticValue > 0 ? `
            <b style="color: #9aa4b2;">미관 점수</b>
            <div>${aestheticValue.toLocaleString()}</div>
            ` : ''}

            <b style="color: #9aa4b2;">돌연변이 확률</b>
            <div>${mutationProb > 0 ? `${mutationProb.toFixed(1)}% (신비한 씨앗 획득 가능)`: '없음'}</div>

            <b style="color: #9aa4b2; grid-column: 1 / -1; margin-top: 6px;">예상 수확물</b>
            <div style="grid-column: 1 / -1; padding-left: 16px;">
                <ul style="margin: 0; padding: 0; list-style-type: '- '; color: #c8d0dc;">
                    ${harvestItems}
                </ul>
            </div>
        </div>
    `;
}


/**
 * 아이템 상세 정보 모달을 표시합니다.
 */
export async function showItemDetailModal(item, context = {}) { // [수정] async 함수로 변경
    ensureModalCss();
    if (document.querySelector('.modal-back[data-kind="item-detail"]')) return;
    const { equippedIds, onUpdate } = context; // [수정] equippedIds가 undefined일 수 있음
    const isEquipped = Array.isArray(equippedIds) && equippedIds.includes(item.id);

    const style = rarityStyle(item.rarity);
    const getItemDesc = (it) => (it?.description || it?.desc_long || it?.desc_soft || it?.desc || '').replace(/\n/g, '<br>');
    
    // getEffectsHtml, getPropertiesHtml 함수는 이전에 제공된 코드와 동일하게 유지됩니다.
    const getEffectsHtml = (it) => {
        const eff = it?.effects;
        if (!eff) return '';
        if (Array.isArray(eff)) return `<ul style="margin:6px 0 0 16px; padding:0;">${eff.map(x=>`<li>${esc(String(x||''))}</li>`).join('')}</ul>`;
        if (typeof eff === 'object') return `<ul style="margin:6px 0 0 16px; padding:0;">${Object.entries(eff).map(([k,v])=>`<li><b>${esc(k)}</b>: ${esc(String(v??''))}</li>`).join('')}</ul>`;
        return `<div>${esc(String(eff))}</div>`;
    };
    const getPropertiesHtml = (it) => {
        const props = it?.properties;
        if (!props || !props.appraised || it.type === 'seed') return ''; // 씨앗 아이템은 별도 처리하므로 여기서 제외
        const keyTranslations = { category: '분류', subCategory: '세부 분류', equipable: '장착 가능', placeable: '배치 가능', aestheticValue: '미관 점수', effects: '특수 효과' };
        const valueTranslations = { "equipment": "장비", "consumable": "소모품", "material": "재료", "furniture": "가구", "decoration": "장식", "etc": "기타", "gardening": "농사", "weapon": "무기", "armor": "방어구", "shield": "방패", "clothing": "의상", "boots": "신발", "gloves": "장갑", "accessory": "장신구", "potion": "물약", "food": "음식", "scroll": "주문서", "bomb": "폭탄", "tome": "마도서", "ore": "광석", "herb": "약초", "leather": "가죽", "cloth": "옷감", "gem": "보석", "monsterPart": "마물 부속", "essence": "정수", "chair": "의자", "table": "탁자", "bed": "침대", "storage": "보관함", "painting": "그림", "sculpture": "조각상", "rug": "융단", "lighting": "조명", "plant": "화분/식물", "key": "열쇠", "quest": "퀘스트", "collectible": "수집품", "junk": "잡동사니" };
        const propertyOrder = ['category', 'subCategory', 'equipable', 'placeable', 'aestheticValue', 'effects'];
        let html = '<hr style="margin:12px 0; border-color:#273247;"><div class="kv-label">감정된 속성</div>';
        const availableProps = propertyOrder.filter(key => props.hasOwnProperty(key));
        if (availableProps.length > 0) {
            html += `<div style="display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; align-items: start; font-size: 13px; margin-top: 8px;">`;
            for (const key of availableProps) {
                const value = props[key];
                const translatedKey = keyTranslations[key] || key;
                if (key === 'effects' && Array.isArray(value)) {
                    html += `<b style="grid-column: 1 / -1; margin-top: 6px;">${esc(translatedKey)}</b>`;
                    if (value.length > 0) {
                        html += `<div style="grid-column: 1 / -1; padding-left: 16px;"><ul style="margin: 0; padding: 0; list-style-type: '- '; color: #c8d0dc;">`;
                        value.forEach(effect => { html += `<li style="margin-bottom: 4px;">${esc(effect.description || JSON.stringify(effect))}</li>`; });
                        html += `</ul></div>`;
                    }
                } else {
                    let displayValue = (typeof value === 'boolean') ? (value ? '✔ 예' : '❌ 아니오') : (key === 'category' || key === 'subCategory') ? (valueTranslations[value] || value) : String(value ?? '');
                    html += `<b style="color: #9aa4b2;">${esc(translatedKey)}</b><div>${esc(displayValue)}</div>`;
                }
            }
            html += `</div>`;
        } else {
            html += `<div style="font-size:13px; margin-top: 8px;">특별한 속성이 발견되지 않았습니다.</div>`;
        }
        return html;
    };

    const back = document.createElement('div');
    back.className = 'modal-back';
    back.dataset.kind = 'item-detail';
    back.style.zIndex = '9000';

    // [수정] 위에서 만든 getSeedInfoHtml 함수를 여기서 호출합니다.
    const seedHtml = await getSeedInfoHtml(item);

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
    if (item.isPromptUse === true && typeof onUpdate === 'function') {
        const btnUse = document.createElement('button');
        btnUse.className = 'btn primary';
        btnUse.textContent = '✨ 사용하기';
        btnUse.onclick = async () => {
            const userPrompt = await promptModal({
                title: `${item.name} 사용`,
                hint: '아이템을 어떻게 변형할지, 혹은 어떤 씨앗으로 변이시킬지 자유롭게 작성해주세요.',
                placeholder: '예) 푸른색 보석이 박힌 날렵한 단검, 밤하늘을 담은 듯한 신비로운 씨앗...',
                maxLen: 300
            });

            if (userPrompt === null) return; // 사용자가 취소

            btnUse.disabled = true;
            btnUse.textContent = '생성 중...';
            try {
                const result = await usePromptItem(item.id, userPrompt);
                if (result.ok) {
                    showToast(`'${result.newItem.name}' 아이템을 획득했습니다!`);
                    closeModal();
                    // onUpdate 콜백이 있으면 인벤토리 UI를 새로고침하도록 호출
                    if (typeof context.onUpdate === 'function') {
                        context.onUpdate();
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
                    // onUpdate 콜백이 있으면 인벤토리 UI를 새로고침하도록 호출
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

    // ▼▼▼ [핵심 수정] ▼▼▼
    // onUpdate 함수와 equippedIds 배열이 모두 존재할 때만 장착/해제 버튼을 표시합니다.
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
    // ▲▲▲ [핵심 수정] ▲▲▲
    document.body.appendChild(back);
}
