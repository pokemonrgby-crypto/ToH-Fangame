// /public/js/tabs/worldmap.js
// 기존 파일 전체를 아래 코드로 교체하세요.

import { getMapData } from '../api/world.js';
import { fetchWorlds } from '../api/store.js';
import { auth, db, fx } from '../api/firebase.js';

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// 월드맵 UI를 그리는 메인 함수
async function renderMap(container, mapId) {
    // 1. 정적 맵 데이터(지형, 범례 등)를 JSON 파일에서 불러옵니다.
    const mapData = await getMapData(mapId);
    if (!mapData) {
        container.innerHTML = '맵 데이터를 불러오지 못했습니다.';
        return;
    }

    // 2. 동적 데이터(소유자 정보)를 Firestore에서 실시간으로 가져옵니다.
    const owners = new Map();
    const ownershipQuery = fx.query(fx.collection(db, 'land_ownership'), fx.where('mapId', '==', mapId));
    
    // onSnapshot을 사용해 소유권 변경을 실시간으로 감지합니다.
    fx.onSnapshot(ownershipQuery, (snapshot) => {
        snapshot.docs.forEach(doc => {
            const data = doc.data();
            const tileIndex = data.y * mapData.width + data.x;
            owners.set(tileIndex, data.ownerName || data.owner_uid); // ownerName 필드를 우선 사용
        });
        
        // 소유자 정보가 업데이트되면 맵을 다시 그립니다.
        drawTiles(container, mapData, owners);
    }, (error) => {
        console.error("소유자 정보 실시간 수신 실패:", error);
    });
}

// 타일을 실제로 화면에 그리는 함수 (분리)
function drawTiles(container, mapData, owners) {
    container.style.gridTemplateColumns = `repeat(${mapData.width}, 32px)`;
    container.innerHTML = ''; // 이전 맵 지우기

    const mapInfo = document.getElementById('map-info');

    for (let y = 0; y < mapData.height; y++) {
        for (let x = 0; x < mapData.width; x++) {
            const index = y * mapData.width + x;
            const tileType = mapData.tiles[index];
            const tileInfo = mapData.legend[tileType];
            const ownerName = owners.get(index) || null; // Map에서 소유자 정보 조회
            if (!tileInfo) continue;

            const tileEl = document.createElement('div');
            tileEl.className = 'map-tile';
            tileEl.style.backgroundColor = tileInfo.color;
            tileEl.title = `${tileInfo.name} (${x}, ${y})`;
            
            // 소유자가 있으면 테두리로 표시
            if (ownerName) {
                tileEl.style.boxShadow = 'inset 0 0 0 2px #FFD700';
            }

            tileEl.addEventListener('click', () => {
                let detailsHtml = `
                    <li><strong>농사 가능:</strong> ${tileInfo.can_farm ? '✔' : '❌'}</li>
                    <li><strong>이동 속도:</strong> ${tileInfo.movement_speed_modifier * 100}%</li>
                `;
                if (tileInfo.obtainable_items && tileInfo.obtainable_items.length > 0) {
                    detailsHtml += `<li><strong>획득 가능:</strong> ${tileInfo.obtainable_items.join(', ')}</li>`;
                }
                if (tileInfo.season_bonus) {
                    const bonuses = Object.entries(tileInfo.season_bonus).map(([s, d]) => `${s}: ${d}`).join(', ');
                    detailsHtml += `<li><strong>계절 효과:</strong> ${bonuses}</li>`;
                }

                mapInfo.style.display = 'block';
                mapInfo.innerHTML = `
                    <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                        <div>
                            <div style="font-weight: bold; font-size: 16px;">${esc(tileInfo.name)}</div>
                            <div class="text-dim" style="font-size: 12px;">좌표: (${x}, ${y})</div>
                        </div>
                        <div class="chip" style="font-size:12px;">소유자: ${ownerName ? esc(ownerName) : '없음'}</div>
                    </div>
                    <div style="margin-top: 8px; font-size:14px;">${esc(tileInfo.desc)}</div>
                    <hr style="border-color: #333; margin: 12px 0;">
                    <ul style="margin:0; padding-left: 20px; font-size: 13px; color: #ccc; line-height: 1.6;">
                        ${detailsHtml}
                    </ul>
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
    
    const worldsData = await fetchWorlds();
    const availableWorlds = worldsData?.worlds || [];
    const mapWorlds = availableWorlds.filter(w => ['gionkir', 'ahnoria'].includes(w.id));

    root.innerHTML = `
        <style>
          .world-map-grid { display: grid; border: 1px solid #333; overflow: auto; max-width: 100%; }
          .map-tile { width: 32px; height: 32px; font-size: 0; cursor: pointer; position: relative; }
          .map-tile:hover { outline: 2px solid yellow; z-index: 1; }
          .map-info-card {
            position: fixed;
            bottom: 88px;
            left: 50%;
            transform: translateX(-50%);
            width: 95vw;
            max-width: 420px;
            z-index: 10;
            background: rgba(30, 35, 45, 0.9);
            backdrop-filter: blur(8px);
          }
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
    
    root.querySelectorAll('[data-map-id]').forEach(btn => {
        btn.addEventListener('click', () => {
            const mapId = btn.dataset.mapId;
            mapContainer.innerHTML = '<div class="spin-center"></div>';
            document.getElementById('map-info').style.display = 'none';
            renderMap(mapContainer, mapId);
        });
    });

    if (mapWorlds.length > 0) {
        renderMap(mapContainer, `${mapWorlds[0].id}_main`);
    } else {
        mapContainer.innerHTML = '표시할 맵이 없습니다.';
    }
}
