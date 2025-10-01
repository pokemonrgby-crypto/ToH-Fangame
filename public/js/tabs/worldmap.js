// /public/js/tabs/worldmap.js
import { getMapData } from '../api/world.js';
import { auth } from '../api/firebase.js';

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

export async function showWorldMap() {
  const root = document.getElementById('view');
  if (!auth.currentUser) {
    root.innerHTML = `<section class="container narrow"><div class="kv-card">로그인이 필요합니다.</div></section>`;
    return;
  }

  root.innerHTML = `
    <style>
      .world-map-grid {
        display: grid;
        border: 1px solid #333;
        overflow: auto;
        max-width: 100%;
      }
      .map-tile {
        width: 32px;
        height: 32px;
        font-size: 0; /* Hide character content */
        cursor: pointer;
      }
      .map-tile:hover {
        outline: 2px solid yellow;
        z-index: 1;
      }
      .map-info-card {
        position: sticky;
        bottom: 80px;
        left: 50%;
        transform: translateX(-50%);
        width: 90%;
        max-width: 400px;
        z-index: 10;
      }
    </style>
    <section class="container narrow">
      <div class="card p12">
        <h3 style="margin-top:0">월드맵</h3>
        <div id="map-container" class="world-map-grid"></div>
      </div>
      <div id="map-info" class="card p12 mt12 map-info-card" style="display:none;"></div>
    </section>
  `;

  const mapContainer = document.getElementById('map-container');
  const mapInfo = document.getElementById('map-info');

  const mapData = await getMapData();
  if (!mapData) {
    mapContainer.innerHTML = '맵 데이터를 불러오지 못했습니다.';
    return;
  }

  mapContainer.style.gridTemplateColumns = `repeat(${mapData.width}, 32px)`;

  for (let y = 0; y < mapData.height; y++) {
    for (let x = 0; x < mapData.width; x++) {
      const tileType = mapData.tiles[y * mapData.width + x];
      const tileInfo = mapData.legend[tileType];
      const tileEl = document.createElement('div');
      tileEl.className = 'map-tile';
      tileEl.style.backgroundColor = tileInfo.color;
      tileEl.title = `${tileInfo.name} (${x}, ${y})`;
      tileEl.dataset.x = x;
      tileEl.dataset.y = y;
      tileEl.dataset.type = tileType;

      tileEl.addEventListener('click', () => {
        const type = tileEl.dataset.type;
        const legend = mapData.legend[type];
        mapInfo.style.display = 'block';
        mapInfo.innerHTML = `
          <div style="font-weight: bold; font-size: 16px;">${esc(legend.name)}</div>
          <div class="text-dim" style="font-size: 12px;">좌표: (${tileEl.dataset.x}, ${tileEl.dataset.y})</div>
          <div style="margin-top: 8px;">${esc(legend.desc)}</div>
        `;
      });

      mapContainer.appendChild(tileEl);
    }
  }
}
