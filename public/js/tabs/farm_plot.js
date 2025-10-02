// /public/js/tabs/farm_plot.js (신규 파일)
import { auth, db, fx } from '../api/firebase.js';
import { isAdminCached } from '../api/admin.js';
import { showToast } from '../ui/toast.js';

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// URL에서 토지 정보 파싱: #/farm/{mapId}/{x}/{y}/{microX}/{microY}
function parseFarmPlotInfo() {
  const m = (location.hash || '').match(/^#\/farm\/([^/]+)\/(\d+)\/(\d+)\/(\d+)\/(\d+)/);
  if (!m) return null;
  return {
    mapId: m[1],
    x: parseInt(m[2], 10),
    y: parseInt(m[3], 10),
    microX: parseInt(m[4], 10),
    microY: parseInt(m[5], 10),
  };
}

export async function showFarmPlot() {
  const root = document.getElementById('view');
  const plotInfo = parseFarmPlotInfo();

  if (!auth.currentUser || !plotInfo) {
    root.innerHTML = `<section class="container narrow"><div class="kv-card">잘못된 접근입니다.</div></section>`;
    return;
  }
  
  if (!isAdminCached()) {
      root.innerHTML = `<section class="container narrow"><div class="kv-card">농장 관리는 현재 관리자만 사용할 수 있습니다.</div></section>`;
      return;
  }

  root.innerHTML = `
    <style>
      .farm-grid {
        display: grid;
        grid-template-columns: repeat(100, 1fr);
        border: 1px solid #555;
        background-color: #3e2e1c; /* 기본 흙 색상 */
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
            <h3 style="margin-top:0">농장 관리 (${plotInfo.x},${plotInfo.y}) - (${plotInfo.microX},${plotInfo.microY})</h3>
            <button class="btn ghost" onclick="history.back()">뒤로가기</button>
        </div>
        <div class="row mt12">
            <div class="kv-card" style="flex:1;">
                <div class="kv-label">담당 캐릭터</div>
                <div id="assigned-char">할당된 캐릭터 없음</div>
                <button class="btn small mt8" id="btn-assign-char">캐릭터 할당</button>
            </div>
            <div class="kv-card" style="flex:1;">
                <div class="kv-label">농장 관리</div>
                <button class="btn small mt8" id="btn-plant-seed">씨앗 심기 (관리자)</button>
            </div>
        </div>
        <div class="farm-grid mt12" id="farm-grid-container">
          </div>
      </div>
    </section>
  `;

  const gridContainer = root.querySelector('#farm-grid-container');
  // 성능을 위해 일단 10x10으로 표시 (추후 100x100으로 확장)
  for (let i = 0; i < 100; i++) {
    const tile = document.createElement('div');
    tile.className = 'farm-tile';
    tile.dataset.index = i;
    gridContainer.appendChild(tile);
  }

  // TODO: 캐릭터 할당 및 씨앗 심기 로직 추가
  root.querySelector('#btn-assign-char').onclick = () => showToast('캐릭터 할당 기능은 개발 중입니다.');
  root.querySelector('#btn-plant-seed').onclick = () => showToast('씨앗 심기 기능은 개발 중입니다.');
}
