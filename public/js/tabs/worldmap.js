// /public/js/tabs/worldmap.js
import { getMapData } from '../api/world.js';
import { fetchWorlds } from '../api/store.js'; // worlds.json 로더 import
import { auth } from '../api/firebase.js';

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// 월드맵 UI를 그리는 메인 함수
async function renderMap(container, mapId) {
    const mapData = await getMapData(mapId);
    if (!mapData) {
        container.innerHTML = '맵 데이터를 불러오지 못했습니다.';
        return;
    }

    container.style.gridTemplateColumns = `repeat(${mapData.width}, 32px)`;
    container.innerHTML = ''; // 이전 맵 지우기

    const mapInfo = document.getElementById('map-info');

    for (let y = 0; y < mapData.height; y++) {
        for (let x = 0; x < mapData.width; x++) {
            const tileType = mapData.tiles[y * mapData.width + x];
            const tileInfo = mapData.legend[tileType];
            if (!tileInfo) continue; // 정의되지 않은 타일은 건너뛰기

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

            container.appendChild(tileEl);
        }
    }
}


export async function showWorldMap() {
    const root = document.getElementById('view');
    if (!auth.currentUser) {
        root.innerHTML = `<section class="container narrow"><div class="kv-card">로그인이 필요합니다.</div></section>`;
        return;
    }
    
    // worlds.json에서 월드 목록을 가져옵니다.
    const worldsData = await fetchWorlds();
    const availableWorlds = worldsData?.worlds || [];
    
    // 부동산(맵)이 존재하는 월드만 필터링 (예시: gionkir, ahnoria)
    const mapWorlds = availableWorlds.filter(w => ['gionkir', 'ahnoria'].includes(w.id));

    root.innerHTML = `
        <style>
          .world-map-grid { display: grid; border: 1px solid #333; overflow: auto; max-width: 100%; }
          .map-tile { width: 32px; height: 32px; font-size: 0; cursor: pointer; }
          .map-tile:hover { outline: 2px solid yellow; z-index: 1; }
          .map-info-card { position: sticky; bottom: 80px; left: 50%; transform: translateX(-50%); width: 90%; max-width: 400px; z-index: 10; }
        </style>
        <section class="container narrow">
          <div class="card p12">
            <h3 style="margin-top:0">부동산 정보</h3>
            
            <div class="row" style="gap:8px; margin-bottom:12px;">
                <div class="kv-label">지역 선택:</div>
                ${mapWorlds.map(w => `<button class="btn ghost small" data-map-id="${w.id}_main">${esc(w.name)}</button>`).join('')}
            </div>

            <div id="map-container" class="world-map-grid"></div>
          </div>
          <div id="map-info" class="card p12 mt12 map-info-card" style="display:none;"></div>
        </section>
    `;

    const mapContainer = document.getElementById('map-container');
    
    // 지역 선택 버튼에 이벤트 리스너 추가
    root.querySelectorAll('[data-map-id]').forEach(btn => {
        btn.addEventListener('click', () => {
            const mapId = btn.dataset.mapId;
            mapContainer.innerHTML = '<div class="spin-center"></div>'; // 로딩 표시
            document.getElementById('map-info').style.display = 'none'; // 정보창 숨기기
            renderMap(mapContainer, mapId);
        });
    });

    // 기본으로 첫 번째 맵을 로딩합니다.
    if (mapWorlds.length > 0) {
        renderMap(mapContainer, `${mapWorlds[0].id}_main`);
    } else {
        mapContainer.innerHTML = '표시할 맵이 없습니다.';
    }
}
