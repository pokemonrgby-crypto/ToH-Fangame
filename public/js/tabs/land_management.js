// /public/js/tabs/land_management.js (전체 교체)
import { auth, db, fx } from '../api/firebase.js';
import { showToast } from '../ui/toast.js';
import { ensureModalCss, confirmModal, promptModal } from '../ui/modal.js';

// 신규: 필요한 함수들을 land.js와 farm.js에서 가져옵니다.
import { startConstruction, completeConstruction } from '../api/land.js'; 
import { createFarmland, plantInFarmland, harvestFromFarmland, assignCharacterToFacility } from '../api/farm.js';
import { getUserCharacters } from '../api/char.js';

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

// 화면을 다시 그리는 메인 함수
function render(root, plotInfo, plotData, characters) {
    const totalArea = plotData.totalArea || 10000;
    const usedArea = plotData.usedArea || 0;
    const availableArea = totalArea - usedArea;
    const facilities = plotData.facilities || [];

    const facilityCardsHtml = facilities.map(fac => {
        const assignedChar = characters.find(c => c.id === fac.assignedCharId);
        if (fac.type === 'building') {
            return `
                <div class="kv-card">
                    <div class="row" style="justify-content:space-between">
                        <b>${esc(fac.name)} (건물)</b>
                        <span>${fac.area}m² / ${fac.floors}층</span>
                    </div>
                    <div class="text-dim" style="font-size:12px;">용도: ${esc(fac.purpose)} | 등급: ${fac.grade}</div>
                    <div class="kv-card" style="margin-top:8px; padding:8px;">
                        담당: ${assignedChar ? esc(assignedChar.name) : '없음'}
                    </div>
                    <div class="row" style="justify-content:flex-end; gap:8px; margin-top:8px;">
                        <button class="btn small" data-facility-id="${fac.id}" data-action="assign-char">캐릭터 배치</button>
                        <button class="btn small" data-facility-id="${fac.id}" data-action="manage-building">관리</button>
                    </div>
                </div>
            `;
        }
        if (fac.type === 'farmland') {
             return `
                <div class="kv-card">
                    <div class="row" style="justify-content:space-between">
                        <b>${esc(fac.name)} (농지)</b>
                        <span>${fac.area}m²</span>
                    </div>
                     <div class="kv-card" style="margin-top:8px; padding:8px;">
                        담당: ${assignedChar ? `${esc(assignedChar.name)} (원예 Lv.${assignedChar.skills?.gardening?.level || 0})` : '없음'}
                    </div>
                    <div class="row" style="justify-content:flex-end; gap:8px; margin-top:8px;">
                        <button class="btn small" data-facility-id="${fac.id}" data-action="assign-char">캐릭터 배치</button>
                        <button class="btn small" data-facility-id="${fac.id}" data-action="manage-farm">농사 관리</button>
                    </div>
                </div>
            `;
        }
        return '';
    }).join('');

    root.innerHTML = `
        <section class="container narrow">
          <div class="card p12">
            <div class="row" style="justify-content:space-between">
                <h3 style="margin-top:0">토지 관리 (${plotInfo.x},${plotInfo.y}) - (${plotInfo.microX},${plotInfo.microY})</h3>
                <button class="btn ghost" onclick="history.back()">뒤로가기</button>
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
    attachEvents(root, plotInfo, availableArea, characters);
}

// 이벤트 핸들러 부착 함수
function attachEvents(root, plotInfo, availableArea, characters) {
    root.querySelector('#btn-new-building').onclick = async () => {
        // TODO: 건물 건설을 위한 상세 정보 입력 모달 구현
        showToast('건물 건설 기능은 준비 중입니다.');
    };
    root.querySelector('#btn-new-farmland').onclick = async () => {
        // TODO: 밭 경작을 위한 면적 입력 모달 구현
        showToast('밭 경작 기능은 준비 중입니다.');
    };

    root.querySelectorAll('[data-action="assign-char"]').forEach(btn => {
        btn.onclick = async () => {
            const facilityId = btn.dataset.facilityId;
            // TODO: 캐릭터 선택 모달 구현 및 캐릭터 할당 로직 연결
            showToast(`[${facilityId}]에 캐릭터를 배치하는 기능은 준비 중입니다.`);
        };
    });
}

// 메인 실행 함수
export async function showLandManagement() {
    const root = document.getElementById('view');
    const plotInfo = parseLandPlotInfo();

    if (!auth.currentUser || !plotInfo) {
        root.innerHTML = `<section class="container narrow"><div class="kv-card">잘못된 접근입니다.</div></section>`;
        return;
    }

    root.innerHTML = `<section class="container narrow"><div class="spin-center"></div></section>`;
    
    try {
        const plotDocId = `${plotInfo.mapId}_${plotInfo.x}_${plotInfo.y}_${plotInfo.microX}_${plotInfo.microY}`;
        const plotRef = fx.doc(db, 'land_plots', plotDocId);

        // 데이터 실시간 구독 설정
        fx.onSnapshot(plotRef, async (plotSnap) => {
            const plotData = plotSnap.exists() ? plotSnap.data() : { totalArea: 10000, usedArea: 0, facilities: [] };
            const characters = await getUserCharacters(); // 캐릭터 목록은 필요할 때마다 다시 가져옴
            render(root, plotInfo, plotData, characters);
        }, (error) => {
            console.error("토지 정보 실시간 수신 실패:", error);
            root.innerHTML = `<section class="container narrow"><div class="kv-card error">데이터를 불러오는 데 실패했습니다.</div></section>`;
        });

    } catch (error) {
        console.error("초기 데이터 로딩 실패:", error);
        root.innerHTML = `<section class="container narrow"><div class="kv-card error">오류: ${esc(error.message)}</div></section>`;
    }
}
