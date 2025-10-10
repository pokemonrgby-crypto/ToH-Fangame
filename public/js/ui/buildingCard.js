// /public/js/ui/buildingCard.js

import {
    getFirestore, collection, doc, onSnapshot, getDocs, query, where, getDoc, setDoc, updateDoc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
    getFunctions, httpsCallable,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import {
    showToast
} from './toast.js';
import {
    openModal,
    closeModal
} from './modal.js';
import {
    renderResourceCosts,
    esc,
    formatNumber
} from '../ui/utils.js';

/**
 * 건물 정보 카드를 렌더링하고 DOM 요소를 반환합니다.
 * @param {object} building - 건물 데이터 객체
 * @param {Array<object>} characters - 모든 캐릭터 데이터 배열
 * @param {string} plotDocId - 부지 문서 ID
 * @returns {HTMLElement} - 렌더링된 카드 HTML 요소
 */
export function renderBuildingCard(building, characters, plotDocId) {
    const assignedChar = characters.find(c => building.assignedCharIds && building.assignedCharIds.includes(c.id));
    const areaTxt = formatNumber(building.design.totalAreaM2 || 0);

    const card = document.createElement('div');
    card.className = 'kv-card';
    card.dataset.facilityId = building.id; // 시설 ID 추가

    card.innerHTML = `
      <div class="row" style="justify-content:space-between">
        <b>${esc(building.design.name || '이름 없는 건물')} (건물)</b>
        <span>${areaTxt}m² / ${building.design.floors}층</span>
      </div>
      <div class="text-dim" style="font-size:12px; margin-top: 4px;">
        <span>스타일: ${esc(building.design.style.name || '-')}</span> | 
        <span>용도: ${esc(building.design.purpose.name || '-')}</span> |
        <span>안전도: ${esc(building.safetyLevel || '평가되지 않음')}</span>
      </div>
      <div class="kv-card" style="margin-top:8px; padding:8px;">
        관리자: ${assignedChar ? `${esc(assignedChar.name)} (건설 Lv.${assignedChar.skills?.construction?.level || 0})` : '없음'}
      </div>
      <div class="row" style="justify-content:flex-end; gap:8px; margin-top:8px;">
        <button class="btn small" data-action="assign-manager">관리자 배정</button>
        <button class="btn small" data-action="manage-building">관리</button>
      </div>
    `;

    // 이벤트 리스너 연결
    card.querySelector('[data-action="assign-manager"]').addEventListener('click', (e) => {
        e.stopPropagation();
        openAssignManagerModal(building, characters, plotDocId);
    });

    card.querySelector('[data-action="manage-building"]').addEventListener('click', (e) => {
        e.stopPropagation();
        // TODO: 건물 관리 모달 열기 로직 구현
        showToast(`'${building.design.name}' 건물 관리 기능은 아직 준비 중입니다.`);
    });

    return card;
}


/**
 * 관리자 배정 모달을 엽니다.
 * @param {object} building - 대상 건물 객체
 * @param {Array<object>} characters - 캐릭터 목록
 * @param {string} plotDocId - 부지 ID
 */
function openAssignManagerModal(building, characters, plotDocId) {
    const assignableChars = characters.filter(c => c.skills?.construction); // 건설 스킬이 있는 캐릭터만
    if (assignableChars.length === 0) {
        showToast('배정할 수 있는 건설 스킬을 가진 캐릭터가 없습니다.', 'error');
        return;
    }

    const options = assignableChars.map(c => {
        const isAssigned = building.assignedCharIds && building.assignedCharIds.includes(c.id);
        return `<option value="${c.id}" ${isAssigned ? 'selected' : ''}>${c.name} (건설 Lv.${c.skills.construction.level})</option>`;
    }).join('');

    const modalContent = `
        <h2>'${esc(building.design.name)}' 관리자 배정</h2>
        <p>이 건물에 관리자로 배정할 캐릭터를 선택하세요.</p>
        <select id="manager-select" class="input-select" style="width:100%;">
            <option value="">-- 없음 --</option>
            ${options}
        </select>
        <div class="row" style="justify-content:flex-end; margin-top:16px;">
            <button id="confirm-assign" class="btn">배정</button>
        </div>
    `;

    openModal(modalContent, () => {
        document.getElementById('confirm-assign').addEventListener('click', async () => {
            const selectedCharId = document.getElementById('manager-select').value;
            const functions = getFunctions();
            const assignFacilityManager = httpsCallable(functions, 'assignFacilityManager');

            try {
                showToast('관리자 배정 중...', 'info');
                await assignFacilityManager({
                    plotId: plotDocId,
                    facilityId: building.id,
                    charId: selectedCharId || null, // ID가 없으면 null
                });
                showToast('관리자가 성공적으로 배정되었습니다.', 'success');
                closeModal();
            } catch (error) {
                console.error("관리자 배정 실패:", error);
                showToast(`오류: ${error.message}`, 'error');
            }
        });
    });
}
