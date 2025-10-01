// /public/js/tabs/land_detail.js
import { func, auth } from '../api/firebase.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-functions.js';

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// URL에서 맵ID와 좌표를 파싱하는 함수
function parseLandInfo() {
  const m = (location.hash || '').match(/^#\/land\/([^/]+)\/(\d+)\/(\d+)$/);
  if (!m) return null;
  
  // gionkir_main.json 에서 plotId 정보를 가져오기 위해 tile 정보도 함께 파싱
  const tileInfoMatch = (location.hash || '').match(/tile=([^&]+)/);
  const tileInfo = tileInfoMatch ? JSON.parse(decodeURIComponent(tileInfoMatch[1])) : null;

  return { 
    mapId: m[1], 
    x: parseInt(m[2], 10), 
    y: parseInt(m[3], 10),
    tile: tileInfo
  };
}

// 마이크로 맵 범례 데이터를 캐시하여 중복 로딩 방지
let microLegendCache = null;
async function getMicroLegend() {
    if (microLegendCache) return microLegendCache;
    try {
        const response = await fetch('/assets/micro_legend.json');
        if (!response.ok) throw new Error('micro_legend.json not found');
        microLegendCache = await response.json();
        return microLegendCache;
    } catch (error) {
        console.error("Failed to load micro legend:", error);
        return { micro_tile_legend: {} };
    }
}

export async function showLandDetail() {
  const root = document.getElementById('view');
  const landInfo = parseLandInfo();

  if (!auth.currentUser || !landInfo) {
    root.innerHTML = `<section class="container narrow"><div class="kv-card">잘못된 토지 정보이거나 로그인이 필요합니다.</div></section>`;
    return;
  }

  root.innerHTML = `<section class="container narrow"><div class="spin-center"></div></section>`;
  
  try {
    const getLandDetail = httpsCallable(func, 'getLandDetail');
    // 서버 함수에 plotId도 함께 전달
    const result = await getLandDetail({ 
        mapId: landInfo.mapId, 
        x: landInfo.x, 
        y: landInfo.y,
        tileType: landInfo.tile?.type,
        plotId: landInfo.tile?.plotId 
    });
    const { data } = result;

    if (!data.ok) throw new Error(data.error || "토지 정보를 불러오지 못했습니다.");
    
    const microLegend = await getMicroLegend();
    const legend = microLegend.micro_tile_legend || {};
    
    // 10x10 그리드를 생성하고 각 타일에 맞는 색상과 툴팁을 적용
    const microGridHtml = data.microGrid.map((tileType, index) => {
        const tileInfo = legend[tileType] || { name: '알 수 없음', color: '#333' };
        const microX = index % 10;
        const microY = Math.floor(index / 10);
        const ownerName = data.owners?.[`${microY}_${microX}`] || null;
        
        let tileStyle = `background-color: ${tileInfo.color};`;
        if (ownerName) {
            tileStyle += 'box-shadow: inset 0 0 0 1px yellow;';
        }

        return `<div class="micro-tile" style="${tileStyle}" title="${tileInfo.name} (${microX}, ${microY})${ownerName ? ` | 소유자: ${esc(ownerName)}` : ''}"></div>`;
    }).join('');

    root.innerHTML = `
      <style>
        .micro-grid { display: grid; grid-template-columns: repeat(10, 1fr); border: 1px solid #555; image-rendering: pixelated; }
        .micro-tile { aspect-ratio: 1 / 1; }
        .micro-tile:hover { outline: 2px solid yellow; z-index: 1; position: relative; }
      </style>
      <section class="container narrow">
        <div class="card p12">
            <div class="row" style="justify-content:space-between">
                <h3 style="margin-top:0">토지 상세 정보 (${landInfo.x}, ${landInfo.y})</h3>
                <button class="btn ghost" onclick="history.back()">뒤로가기</button>
            </div>
            <div class="row">
                <div class="kv-card" style="flex:1;">
                    <div class="kv-label">유동 인구 (예상)</div>
                    <div>${data.floatingPopulation} 명/시간</div>
                </div>
                 <div class="kv-card" style="flex:1;">
                    <div class="kv-label">전체 소유자</div>
                    <div>${data.ownerName || '없음'}</div>
                </div>
            </div>
            <div class="micro-grid mt12">${microGridHtml}</div>
            <div class="text-dim" style="font-size:12px; margin-top:8px;">각 필지를 클릭하여 상세 정보를 확인하세요.</div>
        </div>
      </section>
    `;

  } catch (error) {
    console.error("토지 상세 정보 로딩 실패:", error);
    root.innerHTML = `<section class="container narrow"><div class="kv-card">오류: ${esc(error.message)}</div></section>`;
  }
}
