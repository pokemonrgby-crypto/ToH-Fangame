// /public/js/tabs/land_management.js (기존 farm_plot.js 대체)
import { auth, db, fx } from '../api/firebase.js';
import { getFarmPlotDetail, plantSeedOnTile, assignCharacterToFarm, harvestTiles } from '../api/farm.js';
import { getUserInventory } from '../api/user.js';
import { showToast } from '../ui/toast.js';
import { ensureModalCss, confirmModal } from '../ui/modal.js';

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// URL에서 토지 정보 파싱
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

// 남은 시간을 hh:mm:ss 형식으로 변환
function formatRemainingTime(ms) {
    if (ms <= 0) return "수확 가능!";
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}


export async function showLandManagement() {
    const root = document.getElementById('view');
    const plotInfo = parseLandPlotInfo();

    if (!auth.currentUser || !plotInfo) {
        root.innerHTML = `<section class="container narrow"><div class="kv-card">잘못된 접근입니다.</div></section>`;
        return;
    }

    const tileParam = new URLSearchParams(window.location.hash.split('?')[1]).get('tile');
    const microTileParam = new URLSearchParams(window.location.hash.split('?')[1]).get('microTile');
    const microTileInfo = microTileParam ? JSON.parse(decodeURIComponent(microTileParam)) : { can_farm: false, buildable: false, color: '#3e2e1c' };

    root.innerHTML = `
        <style>
          .farm-grid { display: grid; grid-template-columns: repeat(32, 1fr); border: 1px solid #555; background-color: ${microTileInfo.color || '#3e2e1c'}; }
          .farm-tile { aspect-ratio: 1 / 1; background-size: cover; border: 1px solid rgba(0,0,0,0.1); }
          .farm-tile:hover { outline: 1px solid yellow; z-index: 1; position: relative; }
          .farm-tile.selected { box-shadow: inset 0 0 0 2px #4aa3ff; }
          .farm-tile.planted { background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="2" fill="%23a3e635"/></svg>'); background-size: 40%; background-repeat: no-repeat; background-position: center; }
          .farm-tile.ready { background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M5 1 L7 4 L9 4 L6 7 L6 9 L4 9 L4 7 L1 4 L3 4 Z" fill="%23f59e0b"/></svg>'); background-size: 70%; }
        </style>
        <section class="container narrow">
          <div class="card p12">
            <div class="row" style="justify-content:space-between">
                <h3 style="margin-top:0">토지 관리 (${plotInfo.x},${plotInfo.y}) - (${plotInfo.microX},${plotInfo.microY})</h3>
                <button class="btn ghost" onclick="history.back()">뒤로가기</button>
            </div>
            <div id="management-panel" class="row mt12"></div>
            <div class="farm-grid mt12" id="farm-grid-container"></div>
          </div>
        </section>
    `;

    const gridContainer = root.querySelector('#farm-grid-container');
    const COLS = 32, ROWS = 32, TILE_COUNT = COLS * ROWS;

    for (let i = 0; i < TILE_COUNT; i++) {
        gridContainer.appendChild(document.createElement('div'));
    }

    const state = {
        plotData: {},
        assignedCharId: null,
        mode: 'view', // 'view', 'planting'
        selectedSeed: null,
        selectedTiles: new Set(),
        isDragging: false,
        dragStart: null,
    };

    const render = () => {
        // Render Management Panel
        const managementPanel = root.querySelector('#management-panel');
        managementPanel.innerHTML = `
            <div class="kv-card" style="flex:1;">
                <div class="kv-label">담당 캐릭터</div>
                <div id="assigned-char" style="min-height: 20px;">${state.assignedCharId ? '로딩 중...' : '할당된 캐릭터 없음'}</div>
                <button class="btn small mt8" id="btn-assign-char">캐릭터 할당/변경</button>
            </div>
            <div class="kv-card" style="flex:1;">
                <div class="kv-label">관리 메뉴</div>
                <div class="row" style="gap:8px; margin-top:8px;">
                    <button class="btn small" id="btn-plant-seed" ${microTileInfo.can_farm ? '' : 'disabled title="농사 불가 토지"'}>씨앗 심기</button>
                    <button class="btn small" id="btn-harvest-all" ${microTileInfo.can_farm ? '' : 'disabled title="농사 불가 토지"'}>전체 수확</button>
                    <button class="btn small" id="btn-build" ${microTileInfo.buildable ? '' : 'disabled title="건설 불가 토지"'}>건설하기</button>
                </div>
            </div>
        `;
        
        // Render Grid
        const now = Date.now();
        gridContainer.innerHTML = '';
        for (let i = 0; i < TILE_COUNT; i++) {
            const tile = document.createElement('div');
            tile.className = 'farm-tile';
            tile.dataset.index = i;
            const tileData = state.plotData.tiles?.[i];
            if (tileData) {
                if ((tileData.readyAt || 0) <= now) {
                    tile.classList.add('ready');
                } else {
                    tile.classList.add('planted');
                }
            }
            if (state.selectedTiles.has(i)) {
                tile.classList.add('selected');
            }
            gridContainer.appendChild(tile);
        }
        attachGridEvents();
        attachButtonEvents();
    };

    const attachGridEvents = () => {
        let singleClickTimer = null;
        gridContainer.addEventListener('mousedown', (e) => {
            const tile = e.target.closest('.farm-tile');
            if (!tile) return;
            
            clearTimeout(singleClickTimer);
            state.isDragging = false;
            
            singleClickTimer = setTimeout(() => {
                if (!state.isDragging) { // 드래그가 시작되지 않았을 때만 단일 클릭으로 처리
                    handleTileClick(Number(tile.dataset.index));
                }
            }, 200);

            if (state.mode === 'planting') {
                state.isDragging = true;
                state.dragStart = Number(tile.dataset.index);
                state.selectedTiles.clear();
                updateSelectionUI();
                toggleTileSelection(state.dragStart);
            }
        });

        gridContainer.addEventListener('mousemove', (e) => {
            if (state.mode !== 'planting' || !state.isDragging) return;
            state.isDragging = true; // mousemove가 한 번이라도 발생하면 드래그로 간주

            const tile = e.target.closest('.farm-tile');
            if (!tile) return;

            const currentIdx = Number(tile.dataset.index);
            state.selectedTiles.clear();

            const startPos = { x: state.dragStart % COLS, y: Math.floor(state.dragStart / COLS) };
            const currentPos = { x: currentIdx % COLS, y: Math.floor(currentIdx / COLS) };
            const minX = Math.min(startPos.x, currentPos.x);
            const maxX = Math.max(startPos.x, currentPos.x);
            const minY = Math.min(startPos.y, currentPos.y);
            const maxY = Math.max(startPos.y, currentPos.y);

            for (let y = minY; y <= maxY; y++) {
                for (let x = minX; x <= maxX; x++) {
                    state.selectedTiles.add(y * COLS + x);
                }
            }
            updateSelectionUI();
        });

        const endDrag = () => {
            state.isDragging = false;
            state.dragStart = null;
        };
        gridContainer.addEventListener('mouseup', endDrag);
        gridContainer.addEventListener('mouseleave', endDrag);
    };

    const handleTileClick = async (index) => {
        const tileData = state.plotData.tiles?.[index];
        if (!tileData) {
            showToast(`(${index % COLS}, ${Math.floor(index/COLS)}) 비어있는 타일입니다.`);
            return;
        }

        if (tileData.readyAt <= Date.now()) {
            if (await confirmModal({title: "수확 확인", lines: ["이 타일의 작물을 수확하시겠습니까?"]})) {
                executeHarvest([index]);
            }
        } else {
            const remaining = tileData.readyAt - Date.now();
            showToast(`남은 시간: ${formatRemainingTime(remaining)}`);
        }
    };

    const toggleTileSelection = (index) => {
        if (state.selectedTiles.has(index)) {
            state.selectedTiles.delete(index);
        } else {
            state.selectedTiles.add(index);
        }
        updateSelectionUI();
    };
    
    const updateSelectionUI = () => {
        gridContainer.querySelectorAll('.farm-tile').forEach(tile => {
            tile.classList.toggle('selected', state.selectedTiles.has(Number(tile.dataset.index)));
        });
    };

    const attachButtonEvents = () => {
        root.querySelector('#btn-assign-char').onclick = handleAssignCharacter;
        root.querySelector('#btn-build').onclick = () => showToast('건설 기능은 현재 준비 중입니다.');
        root.querySelector('#btn-plant-seed').onclick = startPlantingMode;
        root.querySelector('#btn-harvest-all').onclick = handleHarvestAll;
    };

    const handleAssignCharacter = async () => {
        const charId = prompt('할당할 캐릭터 ID를 입력하세요 (비우면 할당 해제):', state.assignedCharId || '');
        if (charId === null) return; // 취소
        try {
            await assignCharacterToFarm({ ...plotInfo, charId: charId.trim() || null });
            showToast('캐릭터 할당이 완료되었습니다.');
            loadPlotData();
        } catch(e) { showToast(e.message || '배정 실패'); }
    };
    
    const startPlantingMode = async () => {
        if (!state.assignedCharId) {
            showToast('씨앗을 심으려면 먼저 담당 캐릭터를 할당해야 합니다.');
            return;
        }
        
        const seed = await openSeedPickerModal();
        if (!seed) return;

        state.mode = 'planting';
        state.selectedSeed = seed;
        
        const managementPanel = root.querySelector('#management-panel');
        managementPanel.innerHTML = `
            <div class="kv-card" style="flex:1;">
                <div class="kv-label">씨앗 심는 중: ${esc(seed.name)}</div>
                <div class="text-dim" style="font-size:12px;">보유: ${seed.uses}개. 심을 영역을 드래그하세요.</div>
                <div class="row" style="gap:8px; margin-top:8px;">
                    <button class="btn primary" id="btn-confirm-plant">심기 확인</button>
                    <button class="btn ghost" id="btn-cancel-plant">취소</button>
                </div>
            </div>
        `;
        
        managementPanel.querySelector('#btn-confirm-plant').onclick = executePlanting;
        managementPanel.querySelector('#btn-cancel-plant').onclick = () => {
            state.mode = 'view';
            state.selectedSeed = null;
            state.selectedTiles.clear();
            render();
        };
    };

    const executePlanting = async () => {
        if (state.selectedTiles.size === 0) {
            showToast('심을 타일을 1개 이상 선택해주세요.');
            return;
        }
        if (state.selectedTiles.size > state.selectedSeed.uses) {
            showToast(`씨앗이 부족합니다. (필요: ${state.selectedTiles.size}, 보유: ${state.selectedSeed.uses})`);
            return;
        }
        
        const btn = root.querySelector('#btn-confirm-plant');
        btn.disabled = true;
        btn.textContent = '처리 중...';

        try {
            // 정렬하여 좌측 상단부터 심도록 보장
            const sortedTiles = Array.from(state.selectedTiles).sort((a,b) => a - b);
            
            await plantSeedOnTile({
                ...plotInfo,
                charId: state.assignedCharId,
                seedItemId: state.selectedSeed.id,
                seedId: state.selectedSeed.seedInfo.id,
                tileIndices: sortedTiles
            });
            showToast(`${state.selectedTiles.size}개의 씨앗을 심었습니다.`);
            state.mode = 'view';
            state.selectedSeed = null;
            state.selectedTiles.clear();
            loadPlotData();
        } catch (e) {
            showToast(`심기 실패: ${e.message}`);
            btn.disabled = false;
            btn.textContent = '심기 확인';
        }
    };
    
    const handleHarvestAll = async () => {
        const now = Date.now();
        const readyTiles = Object.entries(state.plotData.tiles || {})
            .filter(([_, tileData]) => (tileData.readyAt || 0) <= now)
            .map(([index, _]) => Number(index));

        if (readyTiles.length === 0) {
            showToast('수확할 작물이 없습니다.');
            return;
        }
        if (await confirmModal({title: "전체 수확 확인", lines: [`수확 가능한 ${readyTiles.length}개의 작물을 모두 수확하시겠습니까?`]})) {
            executeHarvest(readyTiles);
        }
    };

    const executeHarvest = async (tileIndices) => {
        const btn = root.querySelector('#btn-harvest-all');
        if(btn) btn.disabled = true;
        showToast(`${tileIndices.length}개 작물 수확 중...`);
        try {
            await harvestTiles({ ...plotInfo, tileIndices });
            showToast('수확을 완료했습니다!');
            loadPlotData();
        } catch(e) {
            showToast(`수확 실패: ${e.message}`);
        } finally {
            if(btn) btn.disabled = false;
        }
    };

    const openSeedPickerModal = async () => {
        ensureModalCss();
        const inventory = await getUserInventory();
        const seeds = inventory.filter(item => item.type === 'seed' && (item.uses || 0) > 0);

        return new Promise(resolve => {
            const back = document.createElement('div');
            back.className = 'modal-back';
            back.innerHTML = `
              <div class="modal-card" style="max-width: 600px;">
                <div style="font-weight:900; margin-bottom:12px;">심을 씨앗 선택</div>
                <div class="grid3" style="gap:10px; max-height: 40vh; overflow-y:auto;">
                    ${seeds.length > 0 ? seeds.map(seed => {
                        return `<button class="kv-card" data-seed-id="${seed.id}" style="text-align:left; cursor:pointer;">
                                    <div>${esc(seed.name)}</div>
                                    <div class="text-dim" style="font-size:12px;">보유: ${seed.uses}개</div>
                                </button>`
                    }).join('') : '<div class="text-dim">사용 가능한 씨앗이 없습니다.</div>'}
                </div>
                <button class="btn ghost" id="mClose" style="margin-top:12px; align-self:flex-end;">취소</button>
              </div>`;
            document.body.appendChild(back);
            
            const close = (seed = null) => { back.remove(); resolve(seed); };
            back.addEventListener('click', e => { if (e.target === back) close(); });
            back.querySelector('#mClose').onclick = () => close();
            back.querySelectorAll('[data-seed-id]').forEach(btn => {
                btn.onclick = () => {
                    const seed = seeds.find(s => s.id === btn.dataset.seedId);
                    close(seed);
                };
            });
        });
    };

    const loadPlotData = async () => {
        try {
            const detail = await getFarmPlotDetail(plotInfo);
            state.plotData = detail?.data || {};
            state.assignedCharId = state.plotData.assigned_char_id || null;
            render();
            if (state.assignedCharId) {
                const charSnap = await fx.getDoc(fx.doc(db, 'chars', state.assignedCharId));
                if (charSnap.exists()) {
                    root.querySelector('#assigned-char').textContent = charSnap.data().name;
                }
            }
        } catch (e) {
            console.error(e);
            root.innerHTML = `<section class="container narrow"><div class="kv-card">농장 정보를 불러오지 못했습니다: ${e.message}</div></section>`;
        }
    };
    
    loadPlotData();
}
