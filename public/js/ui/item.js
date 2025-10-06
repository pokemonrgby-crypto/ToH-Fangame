// /public/js/ui/item.js
import { db, fx } from '../api/firebase.js';
import { esc, rarityStyle, useBadgeHtml } from './utils.js';
import { ensureModalCss, promptModal } from './modal.js';
import { showToast } from './toast.js';
import { appraiseItem, usePromptItem } from '../api/user.js';
/** rarity 표준화: 'Aether', 'α', 'Omega', 'Ω', 'mythic', 'unique' 등 표기 혼합 방지 */


function normalizeRarity(r) {
  const s = String(r || '').trim().toLowerCase();
  // 한글/동의어 매핑
  if (s === '오메가' || s === 'ω' || s === 'omega') return 'omega';
  if (s === '알파'  || s === 'α' || s === 'alpha') return 'alpha';
  if (s === '에테르' || s === 'aether') return 'aether';
  if (s === '신화' || s === 'mythic' || s === 'myth') return 'myth';
  if (s === '전설' || s === '레전드' || s === 'legend') return 'legend';
  if (s === '영웅' || s === '에픽' || s === 'epic') return 'epic';
  if (s === '희귀' || s === '레어' || s === 'rare') return 'rare';
  if (s === '일반' || s === '커먼' || s === 'common') return 'common';
  return s || 'common';
}
function rarityClass(r) { return `rarity-${normalizeRarity(r)}`; }


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

// ▼▼▼ [수정된 부분] ▼▼▼
const itemDataCache = new Map();
async function getItemDisplayData(itemId) {
    if (itemDataCache.has(itemId)) return itemDataCache.get(itemId);

    // 1. Check static items first
    const allStaticItems = await getAllItemsData();
    if (allStaticItems[itemId]) {
        itemDataCache.set(itemId, allStaticItems[itemId]);
        return allStaticItems[itemId];
    }
    
    // 2. Fallback to Firestore custom_items
    try {
        const docRef = fx.doc(db, 'custom_items', itemId);
        const docSnap = await fx.getDoc(docRef);
        if (docSnap.exists()) {
            const data = docSnap.data();
            itemDataCache.set(itemId, data);
            return data;
        }
    } catch (e) {
        console.error(`Failed to fetch custom item ${itemId}`, e);
    }

    // 3. If not found anywhere, return a placeholder
    const placeholder = { name: itemId };
    itemDataCache.set(itemId, placeholder);
    return placeholder;
}


async function getSeedInfoHtml(it) {
    if (it.type !== 'seed' || !it.seedInfo) return '';

    const info = it.seedInfo;
    const growthTime = info.growthTimeMinutes || 0;
    const hours = Math.floor(growthTime / 60);
    const minutes = growthTime % 60;
    const timeText = hours > 0 ? `${hours}시간 ${minutes}분` : `${minutes}분`;

    const harvestItemsPromises = Array.isArray(info.harvest)
        ? info.harvest.map(async (h) => {
            if (!h.itemId) return '';
            const itemInfo = await getItemDisplayData(h.itemId);
            const probText = h.probability < 1.0 ? ` (${(h.probability * 100).toFixed(0)}%)` : '';
            return `<li>${esc(itemInfo.name || h.itemId)} (${h.min}~${h.max}개)${probText}</li>`;
        })
        : [Promise.resolve('<li>알 수 없음</li>')];
    
    const harvestItems = (await Promise.all(harvestItemsPromises)).join('');
    
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
// ▲▲▲ [수정된 부분] ▲▲▲

export async function showItemDetailModal(item, context = {}) {
    ensureModalCss();
    if (document.querySelector('.modal-back[data-kind="item-detail"]')) return;
    const { equippedIds, onUpdate } = context;
    const isEquipped = Array.isArray(equippedIds) && equippedIds.includes(item.id);
    // 표시용 데이터(이름/설명 등) 비어 있으면 카탈로그/커스텀에서 보강
    try {
      const fromCatalog = await getItemDisplayData(item.id);
      item = { ...fromCatalog, ...item }; // item 우선, 빈 칸만 채움
    } catch (_) { /* no-op */ }

    const style = rarityStyle(item.rarity);
    const getItemDesc = (it) => (it?.description || it?.desc_long || it?.desc_soft || it?.desc || '').replace(/\n/g, '<br>');

    // [수정] 생략되었던 함수 본문 전체를 복구합니다.
    const getEffectsHtml = (it) => {
        const eff = it?.effects;
        if (!eff) return '';
        if (Array.isArray(eff)) return `<ul style="margin:6px 0 0 16px; padding:0;">${eff.map(x=>`<li>${esc(String(x||''))}</li>`).join('')}</ul>`;
        if (typeof eff === 'object') return `<ul style="margin:6px 0 0 16px; padding:0;">${Object.entries(eff).map(([k,v])=>`<li><b>${esc(k)}</b>: ${esc(String(v??''))}</li>`).join('')}</ul>`;
        return `<div>${esc(String(eff))}</div>`;
    };
    const getPropertiesHtml = (it) => {
        const props = it?.properties;
        if (!props || !props.appraised || it.type === 'seed') return '';
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
                    html += `<b style="grid-column: 1 / -1; margin-top: 6px; color: #9aa4b2;">${esc(translatedKey)}</b>`;
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

    const seedHtml = await getSeedInfoHtml(item);

    back.innerHTML = `
    <div class="modal-card">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px;">
        <div>
          <div class="row" style="align-items:center;gap:8px;flex-wrap:wrap">
            <div style="font-weight:900; font-size:18px;">${esc(item.name)}</div>
            <span class="chip ${rarityClass(item.rarity)}"
                  style="background:${style.border}; color:${style.bg}; font-weight:900; border:1px solid currentColor; text-shadow:0 0 6px rgba(255,255,255,.18);">
              ${esc(style.label)}
            </span>

            ${useBadgeHtml(item)}
          </div>
        </div>
        <button class="btn ghost" id="mCloseDetail">닫기</button>
      </div>
      <div class="kv-card ${rarityClass(item.rarity)}" style="padding:12px;">
        <div>${getItemDesc(item) || '상세 설명이 없습니다.'}</div>
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
  // ▼ [추가] 외부에서 버튼 주입(맥락별 액션)
if (Array.isArray(context.actions)) {
  context.actions.forEach(({ label, className = 'btn', onClick, closeOnClick = true }) => {
    const b = document.createElement('button');
    b.className = className.includes('btn') ? className : `btn ${className}`;
    b.textContent = label;
    b.onclick = async () => {
      try { await onClick?.(item, context); }
      finally { if (closeOnClick) closeModal(); }
    };
    actionsContainer.appendChild(b);
  });
}

    
    if (item.isPromptUse === true) {
        const btnUse = document.createElement('button');
        btnUse.className = 'btn primary';
        btnUse.textContent = '✨ 사용하기';
        btnUse.onclick = async () => {
            const userPrompt = await promptModal({
                title: '커스텀 씨앗 생성',
                hint: 'AI가 당신의 아이디어를 기반으로 새로운 씨앗을 창조합니다.',
                placeholder: '예: 밤하늘의 별똥별을 닮은, 먹으면 행운을 가져다주는 과일나무 씨앗',
                okText: '생성 요청'
            });

            if (userPrompt === null) return;

            btnUse.disabled = true;
            btnUse.textContent = '생성 중...';
            try {
                const result = await usePromptItem(item.id, userPrompt);
                if (result.ok) {
                    showToast(`'${result.newItem.name}' 아이템을 획득했습니다!`);
                    closeModal();
                    if (typeof onUpdate === 'function') {
                        onUpdate();
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
