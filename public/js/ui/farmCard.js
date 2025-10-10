// /public/js/ui/farmCard.js
import {
    esc,
    formatNumber
} from '../ui/utils.js';
import {
    showToast
} from './toast.js';

/**
 * 경작지 정보 카드를 렌더링하고 DOM 요소를 반환합니다.
 * @param {object} farm - 경작지 데이터 객체
 * @param {Array<object>} characters - 모든 캐릭터 데이터 배열
 * @param {string} plotDocId - 부지 문서 ID
 * @returns {HTMLElement} - 렌더링된 카드 HTML 요소
 */
export function renderFarmCard(farm, characters, plotDocId) {
    const card = document.createElement('div');
    card.className = 'kv-card';
    card.dataset.facilityId = farm.id;

    const areaTxt = formatNumber(farm.areaM2 || 0);
    const assignedChar = characters.find(c => farm.assignedCharIds && farm.assignedCharIds.includes(c.id));

    // TODO: 현재 경작 중인 작물 정보 표시
    const cropInfo = farm.currentCrop ? `경작 중: ${farm.currentCrop.name}` : '휴경 중';

    card.innerHTML = `
      <div class="row" style="justify-content:space-between">
        <b>${esc(farm.name || '이름 없는 경작지')} (경작지)</b>
        <span>${areaTxt}m²</span>
      </div>
      <div class="text-dim" style="font-size:12px; margin-top: 4px;">
        <span>토질: ${farm.soilQuality || '보통'}</span>
      </div>
      <div class="kv-card" style="margin-top:8px; padding:8px;">
        <span>${cropInfo}</span>
        <br>
        <span>담당자: ${assignedChar ? `${esc(assignedChar.name)} (농사 Lv.${assignedChar.skills?.farming?.level || 0})` : '없음'}</span>
      </div>
      <div class="row" style="justify-content:flex-end; gap:8px; margin-top:8px;">
        <button class="btn small" data-action="assign-farmer">담당자 배정</button>
        <button class="btn small" data-action="manage-farm">경작 관리</button>
      </div>
    `;

    // 이벤트 리스너 연결
    card.querySelector('[data-action="assign-farmer"]').addEventListener('click', (e) => {
        e.stopPropagation();
        showToast('담당자 배정 기능은 준비 중입니다.');
    });

    card.querySelector('[data-action="manage-farm"]').addEventListener('click', (e) => {
        e.stopPropagation();
        showToast('경작 관리 기능은 준비 중입니다.');
    });


    return card;
}
