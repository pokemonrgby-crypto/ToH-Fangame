// /public/js/tabs/land_management.js (기존 farm_plot.js에서 변경)
import { auth, db, fx } from '../api/firebase.js';
import { getFarmPlotDetail, plantSeedOnTile, assignCharacterToFarm, harvestTiles } from '../api/farm.js';
import { showToast } from '../ui/toast.js';

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// URL에서 토지 정보 파싱: #/land-management/{mapId}/{x}/{y}/{microX}/{microY}
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

export async function showLandManagement() {
  const root = document.getElementById('view');
  const plotInfo = parseLandPlotInfo();

  if (!auth.currentUser || !plotInfo) {
    root.innerHTML = `<section class="container narrow"><div class="kv-card">잘못된 접근입니다.</div></section>`;
    return;
  }

  // land_detail에서 전달받은 타일 정보 가져오기
  const tileParam = new URLSearchParams(window.location.hash.split('?')[1]).get('tile');
  const macroTileInfo = tileParam ? JSON.parse(decodeURIComponent(tileParam)) : null;
  const microTileParam = new URLSearchParams(window.location.hash.split('?')[1]).get('microTile');
  const microTileInfo = microTileParam ? JSON.parse(decodeURIComponent(microTileParam)) : { can_farm: false, can_build: false, color: '#3e2e1c' };

  root.innerHTML = `
    <style>
      .farm-grid {
        display: grid;
        grid-template-columns: repeat(32, 1fr); /* 32x32 그리드 */
        border: 1px solid #555;
        background-color: ${microTileInfo.color || '#3e2e1c'};
      }
      .farm-tile {
        aspect-ratio: 1 / 1;
        background-size: cover;
      }
      .farm-tile:hover {
        outline: 1px solid yellow;
        z-index: 1;
        position: relative;
      }
    </style>
    <section class="container narrow">
      <div class="card p12">
        <div class="row" style="justify-content:space-between">
            <h3 style="margin-top:0">토지 관리 (${plotInfo.x},${plotInfo.y}) - (${plotInfo.microX},${plotInfo.microY})</h3>
            <button class="btn ghost" onclick="history.back()">뒤로가기</button>
        </div>
        <div class="row mt12">
            <div class="kv-card" style="flex:1;">
                <div class="kv-label">담당 캐릭터</div>
                <div id="assigned-char">할당된 캐릭터 없음</div>
                <button class="btn small mt8" id="btn-assign-char">캐릭터 할당/변경</button>
            </div>
            <div class="kv-card" style="flex:1;">
                <div class="kv-label">관리 메뉴</div>
                <div class="row" style="gap:8px; margin-top:8px;">
                    <button class="btn small" id="btn-plant-seed" ${microTileInfo.can_farm ? '' : 'disabled title="농사 불가 토지"'}>씨앗 심기</button>
                    <button class="btn small" id="btn-build" ${microTileInfo.buildable ? '' : 'disabled title="건설 불가 토지"'}>건설하기</button>
                </div>
            </div>
        </div>
        <div class="farm-grid mt12" id="farm-grid-container"></div>
      </div>
    </section>
  `;

  const gridContainer = root.querySelector('#farm-grid-container');
  const COLS = 32, ROWS = 32, TILE_COUNT = COLS * ROWS;
  const selected = new Set();

  for (let i = 0; i < TILE_COUNT; i++) {
    const tile = document.createElement('div');
    tile.className = 'farm-tile';
    tile.dataset.index = i;
    gridContainer.appendChild(tile);
  }
  
  const style = document.createElement('style');
  style.textContent = `
    .farm-tile.selected { outline: 2px solid #4aa3ff; position: relative; }
    .farm-tile.marker::after {
      content: '';
      position: absolute; right: 2px; top: 2px; width: 6px; height: 6px; border-radius: 50%;
      background: var(--marker-color, #999);
    }
  `;
  document.head.appendChild(style);

  let dragging = false, startIdx = null;
  const xyFromIndex = (i)=>({ x: i % COLS, y: Math.floor(i / COLS) });

  gridContainer.addEventListener('mousedown', (e)=>{
    const t = e.target.closest('.farm-tile');
    if (!t) return;
    dragging = true;
    startIdx = Number(t.dataset.index);
    selected.clear();
    gridContainer.querySelectorAll('.farm-tile.selected').forEach(node => node.classList.remove('selected'));
    t.classList.add('selected');
    selected.add(startIdx);
  });
  gridContainer.addEventListener('mousemove', (e)=>{
    if (!dragging) return;
    const t = e.target.closest('.farm-tile');
    if (!t) return;
    const cur = Number(t.dataset.index);
    selected.clear();
    const a = xyFromIndex(startIdx), b = xyFromIndex(cur);
    const [minX, maxX] = [Math.min(a.x,b.x), Math.max(a.x,b.x)];
    const [minY, maxY] = [Math.min(a.y,b.y), Math.max(a.y,b.y)];
    gridContainer.querySelectorAll('.farm-tile.selected').forEach(node=>node.classList.remove('selected'));
    for (let y=minY; y<=maxY; y++){
      for (let x=minX; x<=maxX; x++){
        const idx = y*COLS + x;
        selected.add(idx);
        gridContainer.children[idx].classList.add('selected');
      }
    }
  });
  window.addEventListener('mouseup', ()=>{ dragging = false; startIdx = null; });

  (async ()=>{
    try{
      const detail = await getFarmPlotDetail({ mapId: plotInfo.mapId, x: plotInfo.x, y: plotInfo.y, microX: plotInfo.microX, microY: plotInfo.microY });
      const tiles = detail?.data?.tiles || {};
      for (const [k, v] of Object.entries(tiles)) {
        const idx = Number(k);
        const node = gridContainer.children[idx];
        if (!node) continue;
        node.classList.add('marker');
        const color = { normal:'#999', rare:'#4aa3ff', epic:'#a855f7', legendary:'#f59e0b', mythic:'#ef4444', aether:'#22d3ee' }[String(v.rarity||'normal')];
        node.style.setProperty('--marker-color', color || '#999');
      }
      if (detail?.data?.assigned_char_id) {
          const charSnap = await fx.getDoc(fx.doc(db, 'chars', detail.data.assigned_char_id));
          if(charSnap.exists()) {
              root.querySelector('#assigned-char').textContent = charSnap.data().name;
          }
      }
    }catch(e){ console.error(e); }
  })();
  
  root.querySelector('#btn-build').onclick = () => showToast('건설 기능은 현재 준비 중입니다.');

  root.querySelector('#btn-assign-char').onclick = async ()=>{
    const charId = prompt('할당할 캐릭터 ID를 입력하세요(없으면 비워두기):','');
    try{
      await assignCharacterToFarm({ mapId: plotInfo.mapId, x: plotInfo.x, y: plotInfo.y, microX: plotInfo.microX, microY: plotInfo.microY, charId: (charId||null) });
      showToast('캐릭터 배정이 완료되었어!');
      if (charId) {
          const charSnap = await fx.getDoc(fx.doc(db, 'chars', charId));
          if(charSnap.exists()) {
              root.querySelector('#assigned-char').textContent = charSnap.data().name;
          }
      } else {
          root.querySelector('#assigned-char').textContent = '할당된 캐릭터 없음';
      }
    }catch(e){ showToast(e.message||'배정 실패'); }
  };

  root.querySelector('#btn-plant-seed').onclick = async ()=>{
    if (selected.size===0) return showToast('먼저 심을 범위를 드래그로 선택해줘!');
    const seedItemId = prompt('인벤토리의 씨앗 “아이템 ID”를 입력하세요:','');
    const seedId     = prompt('씨앗의 “seedId”를 입력하세요(예: wheat_seed):','');
    if(!seedItemId || !seedId) return;
    try{
      await plantSeedOnTile({
        mapId: plotInfo.mapId, x: plotInfo.x, y: plotInfo.y, microX: plotInfo.microX, microY: plotInfo.microY,
        charId: null, seedItemId, seedId, tileIndices: Array.from(selected)
      });
      showToast(`선택한 ${selected.size}칸에 심었어!`);
      location.reload();
    }catch(e){ showToast(e.message||'심기 실패'); }
  };
}
