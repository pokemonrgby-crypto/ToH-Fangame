// /public/js/tabs/land_management.js (기존 파일 전체 교체)
import { auth, db, fx } from '../api/firebase.js';
import { getFarmPlotDetail, plantSeedOnTile, assignCharacterToFarm, harvestTiles, cancelPlanting } from '../api/farm.js';
import { getUserInventory } from '../api/user.js';
import { getUserCharacters } from '../api/char.js';
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

// [추가] 등급별 파종 시간 (밀리초 단위)
const RARITY_PLANT_TIMES = {
  normal:   5 * 60 * 1000,
  rare:    10 * 60 * 1000,
  epic:    20 * 60 * 1000,
  legendary: 40 * 60 * 1000,
  mythic:  80 * 60 * 1000,
  aether: 160 * 60 * 1000,
};



export async function showLandManagement() {
    const root = document.getElementById('view');
    const plotInfo = parseLandPlotInfo();

    if (!auth.currentUser || !plotInfo) {
        root.innerHTML = `<section class="container narrow"><div class="kv-card">잘못된 접근입니다.</div></section>`;
        return;
    }

    const microTileParam = new URLSearchParams(window.location.hash.split('?')[1]).get('microTile');
    const microTileInfo = microTileParam ? JSON.parse(decodeURIComponent(microTileParam)) : { can_farm: false, buildable: false, color: '#3e2e1c' };

    root.innerHTML = `
        <style>
          .farm-grid { display: grid; grid-template-columns: repeat(32, 1fr); border: 1px solid #555; background-color: ${microTileInfo.color || '#3e2e1c'}; }
          .farm-tile { aspect-ratio: 1 / 1; background-size: cover; border: 1px solid rgba(0,0,0,0.1); transition: transform 0.1s ease-out, box-shadow 0.1s ease-out; }
          .farm-tile:hover { outline: 1px solid yellow; z-index: 1; position: relative; }
          .farm-tile.selected { box-shadow: inset 0 0 0 2px #4aa3ff; }
          .farm-tile.planted { background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="2" fill="%23a3e635"/></svg>'); background-size: 40%; background-repeat: no-repeat; background-position: center; }
          .farm-tile.ready { background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M5 1 L7 4 L9 4 L6 7 L6 9 L4 9 L4 7 L1 4 L3 4 Z" fill="%23f59e0b"/></svg>'); background-size: 70%; }
          .mgmt-btn { padding: 4px 8px !important; font-size: 12px !important; }
          .farm-tile { position: relative; }
          .farm-tile .tile-progress {
            position: absolute;
            left: 2px; right: 2px; bottom: 2px;
            height: 4px; background: rgba(255,255,255,0.2);
            overflow: hidden; border-radius: 2px;
          }
          .farm-tile .tile-progress .inner {
            height: 100%;
            width: 0%;
            background: rgba(255,255,255,0.85);
            transition: width 0.2s linear;
          }

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
        assignedChar: null,
        mode: 'view', // 'view', 'planting', 'working'
        selectedSeed: null,
        selectedTiles: new Set(),
        isDragging: false,
        dragStart: null,
    };

  // [추가] 실시간 구독: 서버 plot 문서를 onSnapshot으로 듣기
    let __unsubPlot = null;
    function subscribePlotRealtime(plotInfo) {
      const plotDocId = `${plotInfo.mapId}_${plotInfo.x}_${plotInfo.y}_${plotInfo.microX}_${plotInfo.microY}`;
      if (__unsubPlot) { __unsubPlot(); __unsubPlot = null; }
      const ref = fx.doc(db, 'farm_plots', plotDocId);
      __unsubPlot = fx.onSnapshot(ref, (snap) => {
        if (!snap.exists()) return;
        const d = snap.data() || {};
        state.plotData = d; // 서버 값을 진실로 동기화
        render();
      });
    }

  
    const render = () => {
        const managementPanel = root.querySelector('#management-panel');
        const charInfoHtml = state.assignedChar
            ? `<b>${esc(state.assignedChar.name)}</b> <span class="text-dim">(원예 ${state.assignedChar.skills.gardening})</span>`
            : '할당된 캐릭터 없음';

        managementPanel.innerHTML = `
            <div class="kv-card" style="flex:1;">
                <div class="kv-label">담당 캐릭터</div>
                <div id="assigned-char" style="min-height: 20px;">${charInfoHtml}</div>
                <button class="btn small mt8 mgmt-btn" id="btn-assign-char">캐릭터 할당/변경</button>
            </div>
            <div class="kv-card" style="flex:1;">
                <div class="kv-label">관리 메뉴</div>
                <div class="row" style="gap:8px; margin-top:8px;">
                    <button class="btn small mgmt-btn" id="btn-plant-seed" ${microTileInfo.can_farm ? '' : 'disabled title="농사 불가 토지"'}>씨앗 심기</button>
                    <button class="btn small mgmt-btn" id="btn-harvest-all" ${microTileInfo.can_farm ? '' : 'disabled title="농사 불가 토지"'}>전체 수확</button>
                    <button class="btn small mgmt-btn" id="btn-build" ${microTileInfo.buildable ? '' : 'disabled title="건설 불가 토지"'}>건설</button>
                </div>
            </div>
        `;
        
        const now = Date.now();
        gridContainer.innerHTML = '';
        for (let i = 0; i < TILE_COUNT; i++) {
            const tile = document.createElement('div');
            tile.className = 'farm-tile';
            tile.dataset.index = i;
            const tileData = state.plotData.tiles?.[i];
            if (tileData) {
              const rAt  = Number(tileData.readyAt || 0);
              const pEnd = Number(tileData.plantingEndsAt || 0);
              const pAt  = Number(tileData.plantedAt || 0);

              if (rAt <= now) {
                tile.classList.add('ready');
             } else if (pEnd > now) {
                tile.classList.add('planted'); // 심는 중
              } else {
                tile.classList.add('planted'); // 자라는 중
              }

              // 진행바 DOM
              const bar = document.createElement('div');
              bar.className = 'tile-progress';
              const inner = document.createElement('div');
              inner.className = 'inner';
              bar.appendChild(inner);
              tile.appendChild(bar);

              // 진행률 계산 (1단계: 심는 중 / 2단계: 자라는 중)
              let pct = 0;
              if (pEnd > now) {
                const denom = Math.max(1, pEnd - pAt);
                pct = Math.floor(((now - pAt) * 100) / denom);
              } else if (rAt > now) {
                const denom = Math.max(1, rAt - pAt);
                pct = Math.floor(((now - pAt) * 100) / denom);
              } else {
                pct = 100;
              }
              inner.style.width = Math.max(0, Math.min(100, pct)) + '%';
            }

            if (state.selectedTiles.has(i)) {
                tile.classList.add('selected');
            }
            gridContainer.appendChild(tile);
        }
        attachGridEvents();
        attachButtonEvents();
    };

    const handleTileClick = async (index) => {
        const tileData = state.plotData.tiles?.[index];
        if (!tileData) {
          showToast(`(${index % COLS}, ${Math.floor(index/COLS)}) 비어있는 타일입니다.`);
          return;
        }

        const now = Date.now();
        const rAt  = Number(tileData.readyAt || 0);
        const pEnd = Number(tileData.plantingEndsAt || 0);

        if (rAt <= now) {
          if (await confirmModal({title: "수확 확인", lines: ["이 타일의 작물을 수확하시겠습니까?"]})) {
            executeHarvest([index]);
          }
          return;
        }

        if (pEnd > now) {
          const ok = await confirmModal({
            title: "작업 중",
            lines: ["이 타일은 현재 심는 중입니다.", "작업을 취소하시겠습니까? (씨앗은 돌아오지 않습니다)"]
          });
          if (ok) {
            try {
              await cancelPlanting({ ...plotInfo, tileIndex: index });
              showToast("작업을 취소했습니다.");
            } catch (e) {
              showToast(e.message || "취소 실패");
            }
          }
          return;
        }

        // 자라는 중: 남은 시간 안내
        const remain = rAt - now;
        showToast(`남은 시간: ${formatRemainingTime(remain)}`);
    };

    const attachGridEvents = () => {
      if (gridContainer.__bound) return;
      gridContainer.__bound = true;

        let singleClickTimer = null;
        gridContainer.addEventListener('mousedown', (e) => {
            const tile = e.target.closest('.farm-tile');
            if (!tile) return;
            
            clearTimeout(singleClickTimer);
            state.isDragging = false;
            
            singleClickTimer = setTimeout(() => {
                if (!state.isDragging) {
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
            state.isDragging = true;

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
        const isWorking = state.mode === 'working';
        root.querySelectorAll('#management-panel button').forEach(btn => {
            if (isWorking) btn.disabled = true;
        });

        if (!isWorking) {
            root.querySelector('#btn-assign-char').onclick = handleAssignCharacter;
            root.querySelector('#btn-build').onclick = () => showToast('건설 기능은 현재 준비 중입니다.');
            root.querySelector('#btn-plant-seed').onclick = startPlantingMode;
            root.querySelector('#btn-harvest-all').onclick = handleHarvestAll;
        }
    };

    const handleAssignCharacter = async () => {
        const selectedChar = await openCharacterPickerModal();
        if (selectedChar === undefined) return;
        
        const charId = selectedChar ? selectedChar.id : null;
        try {
            await assignCharacterToFarm({ ...plotInfo, charId });
            showToast('캐릭터 할당이 완료되었습니다.');
            state.assignedChar = selectedChar;
            render();
        } catch(e) { showToast(e.message || '배정 실패'); }
    };
    
    const startPlantingMode = async () => {
        if (!state.assignedChar) {
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
                    <button class="btn primary mgmt-btn" id="btn-confirm-plant">심기 확인</button>
                    <button class="btn ghost mgmt-btn" id="btn-cancel-plant">취소</button>
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

      state.mode = 'working';
      const managementPanel = root.querySelector('#management-panel');
      const plantBtn = managementPanel.querySelector('#btn-confirm-plant');
      const cancelBtn = managementPanel.querySelector('#btn-cancel-plant');
      if (plantBtn) plantBtn.disabled = true;
      if (cancelBtn) cancelBtn.disabled = true;

      const sortedTiles = Array.from(state.selectedTiles).sort((a,b) => a - b);

      try {
        await plantSeedOnTile({
          ...plotInfo,
          charId: state.assignedChar.id,
          seedItemId: state.selectedSeed.id,
          seedId: state.selectedSeed.seedInfo.id,
          tileIndices: sortedTiles
        });
        showToast(`${sortedTiles.length}개 타일에 심기 예약 완료!`);
      } catch (e) {
        showToast(`심기 실패: ${e.message}`);
      } finally {
        state.mode = 'view';
        state.selectedSeed = null;
        state.selectedTiles.clear();
        render(); // 실시간 구독이 이후 상태를 가져옴
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
            const result = await harvestTiles({ ...plotInfo, tileIndices });
            
            // [수정] 즉시 UI 업데이트
            tileIndices.forEach(index => {
                delete state.plotData.tiles[index];
                const tileNode = gridContainer.children[index];
                if (tileNode) {
                    tileNode.classList.remove('ready', 'planted');
                }
            });
            render(); // Re-render to clear buttons if needed
            
            // [추가] 수확 결과 모달 표시
            if (result.data.ok && result.data.rewards?.length > 0) {
                showHarvestResultModal(result.data.rewards);
            } else {
                showToast('수확을 완료했습니다!');
            }
        } catch(e) {
            showToast(`수확 실패: ${e.message}`);
            loadPlotData(); // 실패 시 서버 데이터로 복구
        } finally {
            if(btn) btn.disabled = false;
        }
    };

    const showHarvestResultModal = (rewards) => {
        ensureModalCss();
        const back = document.createElement('div');
        back.className = 'modal-back';
        
        const rewardsHtml = rewards.map(item => `
            <div class="kv-card">
                <b>${esc(item.name)}</b> x ${item.count}
                <div class="text-dim" style="font-size:12px;">${esc(item.description)}</div>
            </div>
        `).join('');

        back.innerHTML = `
            <div class="modal-card" style="max-width: 400px;">
                <div style="font-weight:900; font-size: 18px; margin-bottom:12px;">수확 결과</div>
                <div style="display:flex; flex-direction:column; gap:8px; max-height: 40vh; overflow-y:auto;">
                    ${rewardsHtml}
                </div>
                <button class="btn primary" id="mClose" style="margin-top:16px; width:100%;">확인</button>
            </div>
        `;
        document.body.appendChild(back);
        const close = () => back.remove();
        back.querySelector('#mClose').onclick = close;
        back.addEventListener('click', e => { if (e.target === back) close(); });
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
                    ${seeds.length > 0 ? seeds.map(seed => `
                        <button class="kv-card" data-seed-id="${seed.id}" style="text-align:left; cursor:pointer;">
                            <div>${esc(seed.name)}</div>
                            <div class="text-dim" style="font-size:12px;">보유: ${seed.uses}개</div>
                        </button>
                    `).join('') : '<div class="text-dim">사용 가능한 씨앗이 없습니다.</div>'}
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

    const openCharacterPickerModal = async () => {
        ensureModalCss();
        const characters = await getUserCharacters();
        
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
                                    원예 ${skills.gardening||0} | 건설 ${skills.construction||0} | 예술 ${skills.art||0} | 제작 ${skills.crafting||0} | 연구 ${skills.research||0}<br>
                                    화술 ${skills.speech||0} | 채굴 ${skills.mining||0} | 조리 ${skills.cooking||0} | 가공 ${skills.processing||0}
                                </div>
                            </div>
                        </div>
                    </div>`;
            }).join('');

            cardsHtml += `<button class="kv-card" data-char-id="null" style="cursor:pointer; text-align:center;">
                            <div class="text-dim">🚫 담당자 할당 해제</div>
                          </button>`;

            back.innerHTML = `
                <div class="modal-card" style="max-width: 700px;">
                    <div style="font-weight:900; margin-bottom:12px;">담당 캐릭터 선택</div>
                    <div class="grid2" style="gap:10px; max-height: 50vh; overflow-y:auto;">${cardsHtml}</div>
                    <button class="btn ghost" id="mClose" style="margin-top:16px; align-self:flex-end;">닫기</button>
                </div>`;
            document.body.appendChild(back);

            const close = (char = undefined) => { back.remove(); resolve(char); };
            
            back.querySelector('#mClose').onclick = () => close();
            back.addEventListener('click', e => { if(e.target === back) close() });

            back.querySelectorAll('[data-char-id]').forEach(card => {
                card.onclick = () => {
                    const charId = card.dataset.charId;
                    if (charId === 'null') {
                        close(null);
                    } else {
                        const char = characters.find(c => c.id === charId);
                        close(char);
                    }
                };
            });
        });
    };

    const loadPlotData = async () => {
        try {
            const detail = await getFarmPlotDetail(plotInfo);
            state.plotData = detail?.data || {};
            const charId = state.plotData.assigned_char_id || null;

            if (charId) {
                const charSnap = await fx.getDoc(fx.doc(db, 'chars', charId));
                if (charSnap.exists()) {
                    const data = charSnap.data();
                    state.assignedChar = {
                        id: charSnap.id,
                        name: data.name,
                        skills: data.skills || { gardening: 0, art: 0, construction: 0, speech: 0, mining: 0, cooking: 0, processing: 0, crafting: 0, research: 0 }
                    };
                } else {
                     state.assignedChar = null;
                }
            } else {
                state.assignedChar = null;
            }
            render();
        } catch (e) {
            console.error(e);
            root.innerHTML = `<section class="container narrow"><div class="kv-card">농장 정보를 불러오지 못했습니다: ${e.message}</div></section>`;
        }
    };
    subscribePlotRealtime(plotInfo);

    loadPlotData();
}
