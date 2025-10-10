// /public/js/tabs/land_management.js (전체 교체)

import { auth, db, fx } from '../api/firebase.js';
import { showToast } from '../ui/toast.js';
import { promptModal } from '../ui/modal.js';
import { assignCharacterToFacility, createFarmland } from '../api/real_estate.js';
import { getUserCharacters } from '../api/char.js';

// 분리된 UI 모듈 import
import { openCustomConstructionModal } from '../ui/construction_wizard.js';
import { openCharacterPickerModal } from '../ui/character_picker.js';


/* ------------------------------
 * 유틸리티
 * ------------------------------ */
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function parseLandPlotInfo() {
  const m = (location.hash || '').match(/^#\/land-management\/([^/]+)\/(\d+)\/(\d+)\/(\d+)\/(\d+)/);
  if (!m) return null;
  return {
    mapId: m[1],
    x: parseInt(m[2], 10),
    y: parseInt(m[3], 10),
    microX: parseInt(m[4], 10),
    microY: parseInt(m[5], 10),
  };
}


/* ------------------------------
 * 메인 렌더링
 * ------------------------------ */
function render(root, plotInfo, plotData, characters, plotDocId) {
  const totalArea = plotData.totalArea || 10000;
  const usedArea = plotData.usedArea || 0;
  const availableArea = Math.max(0, totalArea - usedArea);
  const facilities = Array.isArray(plotData.facilities) ? plotData.facilities : [];

  const facilityCardsHtml = facilities.map(fac => {
    const assignedChar = characters.find(c => c.id === fac.assignedCharId);
    const isBuilding = fac.type === 'building';
    const areaTxt = (fac.area || fac.totalArea || 'N/A');
    const heightTxt = (fac.height || fac.heightM || 'N/A');

    const cardContent = isBuilding ? `
      <div class="row" style="justify-content:space-between">
        <b>${esc(fac.name || '건물')} (건물)</b>
        <span>${areaTxt}m² / ${heightTxt}m</span>
      </div>
      <div class="text-dim" style="font-size:12px;">스타일: ${esc(fac.style || '-')} | 안전도: ${esc(fac.safetyLevel || '-')}</div>
      <div class="kv-card" style="margin-top:8px; padding:8px;">
        담당: ${assignedChar ? `${esc(assignedChar.name)} (건설 Lv.${assignedChar.skills?.construction?.level || 0})` : '없음'}
      </div>
    ` : `
      <div class="row" style="justify-content:space-between">
        <b>${esc(fac.name || '농지')} (농지)</b>
        <span>${areaTxt}m²</span>
      </div>
      <div class="kv-card" style="margin-top:8px; padding:8px;">
        담당: ${assignedChar ? `${esc(assignedChar.name)} (원예 Lv.${assignedChar.skills?.gardening?.level || 0})` : '없음'}
      </div>
    `;

    return `
      <div class="kv-card">
        ${cardContent}
        <div class="row" style="justify-content:flex-end; gap:8px; margin-top:8px;">
          <button class="btn small" data-facility-id="${fac.id}" data-action="assign-char">캐릭터 배치</button>
          <button class="btn small" data-facility-id="${fac.id}" data-action="manage-${fac.type}">관리</button>
        </div>
      </div>
    `;
  }).join('');

  root.innerHTML = `
    <section class="container narrow">
      <div class="card p12">
        <div class="row" style="justify-content:space-between">
          <h3 style="margin-top:0">토지 관리 (${plotInfo.x},${plotInfo.y}) - (${plotInfo.microX},${plotInfo.microY})</h3>
          <a href="#/worldmap" class="btn ghost">월드맵</a>
        </div>
       
        <div class="kv-card" style="margin-top:12px;">
          <div class="kv-label">토지 현황</div>
          <div>총 면적: ${totalArea.toLocaleString()}m²</div>
          <div>사용된 면적: ${usedArea.toLocaleString()}m²</div>
          <div style="font-weight:bold; color: #a3e635;">남은 면적: ${availableArea.toLocaleString()}m²</div>
        </div>

        <div class="row" style="gap:8px; margin-top:12px;">
          <button id="btn-new-building" class="btn primary">새 건물 건설</button>
          <button id="btn-new-farmland" class="btn">새 밭 경작</button>
        </div>

        <div id="facilities-list" class="col" style="gap:12px; margin-top:16px;">
          ${facilityCardsHtml || '<div class="text-dim kv-card">아직 건설된 시설이 없습니다.</div>'}
        </div>
      </div>
    </section>
  `;
  attachEvents(root, plotInfo, plotDocId, availableArea, characters);
}

/* ------------------------------
 * 이벤트 바인딩
 * ------------------------------ */
function attachEvents(root, plotInfo, plotDocId, availableArea, characters) {
  // 새 건물
  root.querySelector('#btn-new-building').onclick = async () => {
    const userDoc = await fx.getDoc(fx.doc(db, 'users', auth.currentUser.uid));
    const userData = userDoc.data() || {};
    const userItems = userData.items_all || [];

    let materials, purposes, stylesArray, rooms;
    try {
      [materials, purposes, stylesArray, rooms] = await Promise.all([
        fetch('/assets/building_materials.json').then(res => res.json()),
        fetch('/assets/building_purposes.json').then(res => res.json()),
        fetch('/assets/architectural_styles.json').then(res => res.json()),
        fetch('/assets/rooms.json').then(res => res.json()).catch(()=> ({})) // 없으면 빈 객체
      ]);
    } catch (err) {
      console.error("Failed to fetch building assets:", err);
      showToast('건축 데이터를 불러오는 데 실패했어.', 'error');
      return;
    }
    if (!materials || !purposes || !stylesArray) { showToast('건축 데이터가 비어 있어.', 'error'); return; }

    const styles = stylesArray.reduce((acc, style) => { acc[style.id] = style; return acc; }, {});
    const assets = { materials, purposes, styles, rooms };

    // 분리된 모듈 호출
    await openCustomConstructionModal(characters, userItems, availableArea, assets, plotDocId);
  };

  // 새 밭
  root.querySelector('#btn-new-farmland').onclick = async () => {
    const name = await promptModal({ title: '새로운 농지의 이름을 입력하세요.', placeholder: '나의 텃밭' });
    if (!name) return;

    const areaStr = await promptModal({ title: `경작할 면적을 입력하세요 (최대: ${availableArea}m²)`, placeholder: `최대 ${availableArea}` });
    if (!areaStr) return;

    const area = parseInt(areaStr, 10);
    if (isNaN(area) || area <= 0 || area > availableArea) {
      showToast('올바른 면적을 입력해줘.', 'error');
      return;
    }

    try {
      await createFarmland({ plotId: plotDocId, name, area });
      showToast(`'${name}' 농지가 생성되었어.`, 'success');
    } catch (e) {
      showToast(`농지 생성 실패: ${e.message}`, 'error');
    }
  };

  // 캐릭터 배치(시설)
  root.querySelectorAll('[data-action="assign-char"]').forEach(btn => {
    btn.onclick = async () => {
      const facilityId = btn.dataset.facilityId;
      // 분리된 모듈 호출
      const selectedChar = await openCharacterPickerModal(characters);
      if (selectedChar === undefined) return; // 닫기
      try {
        await assignCharacterToFacility({ plotId: plotDocId, facilityId, charId: selectedChar ? selectedChar.id : null });
        showToast('캐릭터 배치가 완료되었어.', 'success');
      } catch (e) {
        showToast(`배치 실패: ${e.message}`, 'error');
      }
    };
  });

  // 관리 버튼 (스텁)
  root.querySelectorAll('[data-action^="manage-"]').forEach(btn => {
    btn.onclick = async () => {
      showToast('관리 기능은 곧 추가될 예정이야. (inspect/repair/expand 등)', 'info');
    };
  });
}

/* ------------------------------
 * 엔트리
 * ------------------------------ */
export async function showLandManagement() {
  const root = document.getElementById('view');
  const plotInfo = parseLandPlotInfo();

  if (!auth.currentUser || !plotInfo) {
    root.innerHTML = `<section class="container narrow"><div class="kv-card">잘못된 접근이야.</div></section>`;
    return;
  }

  root.innerHTML = `<section class="container narrow"><div class="spin-center"></div></section>`;
 
  try {
    const plotDocId = `${plotInfo.mapId}_${plotInfo.x}_${plotInfo.y}_${plotInfo.microX}_${plotInfo.microY}`;
    const plotRef = fx.doc(db, 'land_plots', plotDocId);

    const unsub = fx.onSnapshot(plotRef, async (plotSnap) => {
      const plotData = plotSnap.exists() ? plotSnap.data() : { totalArea: 10000, usedArea: 0, facilities: [] };
      if (!root.characters) {
        root.characters = await getUserCharacters() || [];
      }
      render(root, plotInfo, plotData, root.characters, plotDocId);
    }, (error) => {
      console.error("토지 정보 실시간 수신 실패:", error);
      root.innerHTML = `<section class="container narrow"><div class="kv-card error">데이터를 불러오는 데 실패했어.</div></section>`;
    });
   
    root.closest('#view').__cleanup = () => {
      if (root.characters) delete root.characters;
      unsub();
    };

  } catch (error) {
    console.error("초기 데이터 로딩 실패:", error);
    root.innerHTML = `<section class="container narrow"><div class="kv-card error">오류: ${esc(error.message)}</div></section>`;
  }
}
