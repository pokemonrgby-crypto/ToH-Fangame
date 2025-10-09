// /public/js/tabs/land_management.js (전체 교체)
import { auth, db, fx } from '../api/firebase.js';
import { showToast } from '../ui/toast.js';
import { ensureModalCss, confirmModal, promptModal } from '../ui/modal.js';

// real_estate.js에서 startConstruction 함수를 가져옵니다.
import { assignCharacterToFacility, createFarmland, startConstruction } from '../api/real_estate.js';
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

// [NEW] 다단계 커스텀 건축 모달 UI
async function openCustomConstructionModal(characters, userItems, availableArea, materialsAsset) {
    ensureModalCss();
    return new Promise(resolve => {
        const back = document.createElement('div');
        back.className = 'modal-back';
        
        let state = {
            step: 1,
            design: {
                name: "나의 건물",
                totalArea: Math.min(100, availableArea),
                zones: [{ id: Date.now(), name: "구역 1", area: Math.min(100, availableArea), purpose: "주거" }],
                materials: { main: null, secondary: null, special: [] }
            },
            contractor: { type: 'character', id: null },
            allowMaterialBuyout: false,
        };

        const materialOptions = (filter = () => true) => Object.entries(materialsAsset)
            .filter(([id, data]) => filter(data))
            .map(([id, data]) => `<option value="${id}">${data.name}</option>`).join('');

        const render = () => {
            const { step, design } = state;
            let contentHtml = '';

            // 각 단계별 HTML 렌더링
            if (step === 1) { // 기본 정보
                contentHtml = `
                    <h3>Step 1: 기본 설계</h3>
                    <div class="col" style="gap: 4px;">
                        <label>건물 이름</label>
                        <input id="buildingName" class="input" value="${esc(design.name)}">
                    </div>
                    <div class="col" style="gap: 4px; margin-top: 12px;">
                        <label>총 면적 (최대: ${availableArea}m²)</label>
                        <input id="totalArea" class="input" type="number" value="${design.totalArea}" max="${availableArea}">
                    </div>
                `;
            } else if (step === 2) { // 구역 설정
                const zonesHtml = design.zones.map(z => `
                    <div class="row kv-card" style="gap:8px; padding: 8px;" data-zone-id="${z.id}">
                        <input class="input zone-name" value="${esc(z.name)}" placeholder="구역 이름">
                        <input class="input zone-area" type="number" value="${z.area}" style="width: 80px;">
                        <select class="input zone-purpose" style="flex:1;"><option>주거</option><option>상업</option><option>연구</option></select>
                        <button class="btn ghost small remove-zone">X</button>
                    </div>`).join('');
                const currentTotal = design.zones.reduce((sum, z) => sum + z.area, 0);
                contentHtml = `
                    <h3>Step 2: 구역 설정 (할당: ${currentTotal} / ${design.totalArea} m²)</h3>
                    <div class="col" style="gap: 8px;" id="zone-list">${zonesHtml}</div>
                    <button class="btn" id="add-zone" style="margin-top: 8px;">+ 구역 추가</button>
                `;
            } else if (step === 3) { // 재료 선택
                contentHtml = `
                    <h3>Step 3: 건축 재료 선택</h3>
                    <div class="col" style="gap: 4px;">
                        <label>주재료</label><select id="main-mat" class="input">${materialOptions()}</select>
                    </div>
                    <div class="col" style="gap: 4px; margin-top: 12px;">
                        <label>부재료</label><select id="sec-mat" class="input">${materialOptions()}</select>
                    </div>
                     <div class="col" style="gap: 4px; margin-top: 12px;">
                        <label>특별 재료 (다중 선택 가능)</label>
                        <select id="spec-mat" class="input" multiple style="min-height: 120px;">
                            ${materialOptions(m => m.aesthetic_modifier)}
                        </select>
                    </div>
                `;
            } else if (step === 4) { // 건축가 선택
                const charOptions = characters.map(c => `<option value="${c.id}">${c.name} (건설 Lv.${c.skills?.construction?.level || 1})</option>`).join('');
                contentHtml = `
                    <h3>Step 4: 노동력 할당</h3>
                    <div class="tabs" style="display:flex; gap: 8px; margin-bottom: 12px;">
                        <button class="btn tab ${state.contractor.type === 'character' ? 'active' : ''}" data-type="character">내 캐릭터</button>
                        <button class="btn tab ${state.contractor.type === 'npc' ? 'active' : ''}" data-type="npc">NPC 고용</button>
                    </div>
                    <div id="contractor-options"></div>
                `;
            } else if (step === 5) { // 최종 확인
                 // 이 단계에서 calculateCustomRequirements와 유사한 로직으로 예상 견적을 프론트에서 보여줌
                contentHtml = `<h3>Step 5: 최종 확인</h3><div id="summary">계산 중...</div>`;
            }

            back.innerHTML = `
                <div class="modal-card col" style="gap: 16px; min-width: 500px;">
                    ${contentHtml}
                    <div class="row" style="justify-content: space-between; margin-top: 16px;">
                        <button class="btn ghost" id="prev-step" ${step === 1 ? 'disabled' : ''}>이전</button>
                        <div>
                            <button class="btn ghost" id="cancel-build">취소</button>
                            <button class="btn primary" id="next-step">${step === 5 ? '건설 시작' : '다음'}</button>
                        </div>
                    </div>
                </div>
            `;
            attachModalEvents();
        };

        const updateStateAndRender = (newState) => {
            state = { ...state, ...newState };
            render();
        };
        
        const attachModalEvents = () => { /* 이벤트 핸들러 로직 */ };
        
        render(); // 초기 렌더링
    });
}


function render(root, plotInfo, plotData, characters, plotDocId) {
    const totalArea = plotData.totalArea || 10000;
    const usedArea = plotData.usedArea || 0;
    const availableArea = totalArea - usedArea;
    const facilities = plotData.facilities || [];

    const facilityCardsHtml = facilities.map(fac => {
        const assignedChar = characters.find(c => c.id === fac.assignedCharId);
        const cardContent = fac.type === 'building' ? `
            <div class="row" style="justify-content:space-between">
                <b>${esc(fac.name)} (건물)</b>
                <span>${fac.area || 'N/A'}m² / ${fac.height || 'N/A'}m</span>
            </div>
            <div class="text-dim" style="font-size:12px;">스타일: ${esc(fac.style)} | 안전도: ${esc(fac.safetyLevel)}</div>
            <div class="kv-card" style="margin-top:8px; padding:8px;">
                담당: ${assignedChar ? `${esc(assignedChar.name)} (건설 Lv.${assignedChar.skills?.construction?.level || 0})` : '없음'}
            </div>
        ` : `
            <div class="row" style="justify-content:space-between">
                <b>${esc(fac.name)} (농지)</b>
                <span>${fac.area}m²</span>
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

async function openCharacterPickerModal(characters) {
    ensureModalCss();
    return new Promise(resolve => {
        const back = document.createElement('div');
        back.className = 'modal-back';
        let cardsHtml = characters.map(char => {
            const skills = char.skills || {};
            return `
                <div class="kv-card" data-char-id="${char.id}" style="cursor:pointer;">
                    <div class="row" style="gap:10px">
                        <img src="${char.thumb_url || char.image_url || ''}" onerror="this.style.display='none'" style="width:60px; height:60px; border-radius:4px; object-fit:cover;">
                        <div>
                            <div style="font-weight:bold;">${esc(char.name)}</div>
                            <div class="text-dim" style="font-size:11px; margin-top:4px; line-height: 1.4;">
                                원예 ${skills.gardening?.level||0} | 건설 ${skills.construction?.level||0} | ...
                            </div>
                        </div>
                    </div>
                </div>`;
        }).join('');
        cardsHtml += `<button class="kv-card" data-char-id="null" style="cursor:pointer; text-align:center;"><div class="text-dim">🚫 담당자 할당 해제</div></button>`;
        back.innerHTML = `
            <div class="modal-card" style="max-width: 700px;">
                <div style="font-weight:900; margin-bottom:12px;">담당 캐릭터 선택</div>
                <div class="grid2" style="gap:10px; max-height: 50vh; overflow-y:auto;">${cardsHtml}</div>
                <button class="btn ghost" id="mClose" style="margin-top:16px; align-self:flex-end;">닫기</button>
            </div>`;
        document.body.appendChild(back);
        const close = (char = undefined) => { back.remove(); resolve(char); };
        back.querySelector('#mClose').onclick = () => close();
        back.addEventListener('click', e => { if (e.target === back) close(); });
        back.querySelectorAll('[data-char-id]').forEach(card => {
            card.onclick = () => {
                const charId = card.dataset.charId;
                close(charId === 'null' ? null : characters.find(c => c.id === charId));
            };
        });
    });
}

function attachEvents(root, plotInfo, plotDocId, availableArea, characters) {
    root.querySelector('#btn-new-building').onclick = async () => {
        const userData = (await fx.getDoc(fx.doc(db, 'users', auth.currentUser.uid))).data();
        const userItems = userData.items_all || [];
        const materialsAsset = await fetch('/assets/building_materials.json').then(res => res.json());

        const result = await openCustomConstructionModal(characters, userItems, availableArea, materialsAsset);
        if (!result) return;
        
        try {
            const apiResult = await startConstruction({ plotId: plotDocId, ...result });
            showToast(apiResult.message || '건설을 시작합니다.');
        } catch (e) {
            console.error(e);
            showToast(`건설 시작 실패: ${e.message}`, 'error');
        }
    };
    
    root.querySelector('#btn-new-farmland').onclick = async () => {
        const name = await promptModal({ title: '새로운 농지의 이름을 입력하세요.', placeholder: '나의 텃밭' });
        if (!name) return;

        const areaStr = await promptModal({ title: `경작할 면적을 입력하세요 (최대: ${availableArea}m²)`, placeholder: `최대 ${availableArea}` });
        if (!areaStr) return;

        const area = parseInt(areaStr, 10);
        if (isNaN(area) || area <= 0 || area > availableArea) {
            showToast('올바른 면적을 입력해주세요.');
            return;
        }

        try {
            await createFarmland({ plotId: plotDocId, name, area });
            showToast(`'${name}' 농지가 생성되었습니다.`);
        } catch (e) {
            showToast(`농지 생성 실패: ${e.message}`);
        }
    };

    root.querySelectorAll('[data-action="assign-char"]').forEach(btn => {
        btn.onclick = async () => {
            const facilityId = btn.dataset.facilityId;
            const selectedChar = await openCharacterPickerModal(characters);
            if (selectedChar === undefined) return;
            
            try {
                await assignCharacterToFacility({ plotId: plotDocId, facilityId, charId: selectedChar ? selectedChar.id : null });
                showToast('캐릭터 배치가 완료되었습니다.');
            } catch (e) {
                showToast(`배치 실패: ${e.message}`);
            }
        };
    });
}

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

        const unsub = fx.onSnapshot(plotRef, async (plotSnap) => {
            const plotData = plotSnap.exists() ? plotSnap.data() : { totalArea: 10000, usedArea: 0, facilities: [] };
            // 캐릭터 목록은 자주 바뀌지 않으므로 최초 한 번만 불러오거나, 필요 시 다시 불러오도록 최적화 가능
            if (!root.characters) {
                const { characters } = await getUserCharacters();
                root.characters = characters || [];
            }
            render(root, plotInfo, plotData, root.characters, plotDocId);
        }, (error) => {
            console.error("토지 정보 실시간 수신 실패:", error);
            root.innerHTML = `<section class="container narrow"><div class="kv-card error">데이터를 불러오는 데 실패했습니다.</div></section>`;
        });
        
        root.closest('#view').__cleanup = () => {
             if (root.characters) delete root.characters;
             unsub();
        }

    } catch (error) {
        console.error("초기 데이터 로딩 실패:", error);
        root.innerHTML = `<section class="container narrow"><div class="kv-card error">오류: ${esc(error.message)}</div></section>`;
    }
}
