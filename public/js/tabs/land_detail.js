// /public/js/tabs/land_detail.js
import { func, auth } from '../api/firebase.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-functions.js';
import { isAdminCached, ensureAdmin } from '../api/admin.js';
import { buyMicroPlot, sellMicroPlot } from '../api/land.js';
import { showToast } from '../ui/toast.js';

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function parseLandInfo() {
  const m = (location.hash || '').match(/^#\/land\/([^/]+)\/(\d+)\/(\d+)/);
  if (!m) return null;
  
  const tileInfoMatch = (location.hash || '').match(/tile=([^&]+)/);
  const tileInfo = tileInfoMatch ? JSON.parse(decodeURIComponent(tileInfoMatch[1])) : null;

  return {
    mapId: m[1],
    x: parseInt(m[2], 10),
    y: parseInt(m[3], 10),
    tile: tileInfo
  };
}

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
  
  // [신규] 관리자 여부 확인
  const isAdmin = await ensureAdmin().catch(() => false);

  root.innerHTML = `<section class="container narrow"><div class="spin-center"></div></section>`;
  
  try {
    const getLandDetail = httpsCallable(func, 'getLandDetail');
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
    
    const microGridHtml = data.microGrid.map((microTileType, index) => {
        const tileInfo = legend[microTileType] || { name: '알 수 없음', color: '#333' };
        const microX = index % 10;
        const microY = Math.floor(index / 10);
        const ownerData = data.owners?.[`${microY}_${microX}`] || null;
        const ownerName = ownerData?.ownerName || null;
        
        let tileStyle = `background-color: ${tileInfo.color};`;
        if (ownerName) {
            tileStyle += `box-shadow: inset 0 0 0 2px ${ownerData.owner_uid === auth.currentUser.uid ? '#4ade80' : '#FFD700'};`;
        }
        
        // [신규] 관리자용 버튼 추가
        let adminButtons = '';
        if (isAdmin) {
          if (ownerData) {
            if (ownerData.owner_uid === auth.currentUser.uid) {
              adminButtons = `<button class="btn danger small btn-sell" style="margin-top:8px;" data-mx="${microX}" data-my="${microY}">판매</button>`;
            }
          } else {
             adminButtons = `<button class="btn primary small btn-buy" style="margin-top:8px;" data-mx="${microX}" data-my="${microY}" data-mtype="${microTileType}">구매</button>`;
          }
        }
        
        return `<div class="micro-tile" title="${tileInfo.name} (${microX}, ${microY})">
                    <div class="micro-tile-inner" style="${tileStyle}"></div>
                    <div class="micro-tile-info">
                        <div>${tileInfo.name}</div>
                        <div class="text-dim" style="font-size:11px">${ownerName ? `소유: ${esc(ownerName)}` : '공유지'}</div>
                        ${adminButtons}
                    </div>
                </div>`;
    }).join('');

    root.innerHTML = `
      <style>
        .micro-grid { display: grid; grid-template-columns: repeat(10, 1fr); border: 1px solid #555; image-rendering: pixelated; }
        .micro-tile { aspect-ratio: 1 / 1; position: relative; }
        .micro-tile-inner { position: absolute; inset: 0; }
        .micro-tile:hover .micro-tile-info { display: flex; }
        .micro-tile-info { display: none; position: absolute; inset: 0; background: rgba(0,0,0,0.7); color: white; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 4px; font-size: 12px; }
      </style>
      <section class="container narrow">
        <div class="card p12">
            <div class="row" style="justify-content:space-between">
                <h3 style="margin-top:0">토지 상세 정보 (${landInfo.x}, ${landInfo.y})</h3>
                <button class="btn ghost" onclick="history.back()">뒤로가기</button>
            </div>
            <div class="micro-grid mt12">${microGridHtml}</div>
            <div class="text-dim" style="font-size:12px; margin-top:8px;">각 필지에 마우스를 올려 상세 정보를 확인하세요.</div>
        </div>
      </section>
    `;
    
    if(isAdmin) {
        root.querySelectorAll('.btn-buy').forEach(btn => {
            btn.onclick = async () => {
                const microX = parseInt(btn.dataset.mx, 10);
                const microY = parseInt(btn.dataset.my, 10);
                const microTileType = btn.dataset.mtype;
                
                try {
                    await buyMicroPlot({ mapId: landInfo.mapId, x: landInfo.x, y: landInfo.y, microX, microY, tileType: landInfo.tile.type, microTileType });
                    showToast('토지를 구매했습니다.');
                    showLandDetail(); // 새로고침
                } catch (e) {
                    showToast(`구매 실패: ${e.message}`);
                }
            };
        });
        root.querySelectorAll('.btn-sell').forEach(btn => {
            btn.onclick = async () => {
                const microX = parseInt(btn.dataset.mx, 10);
                const microY = parseInt(btn.dataset.my, 10);
                try {
                    await sellMicroPlot({ mapId: landInfo.mapId, x: landInfo.x, y: landInfo.y, microX, microY });
                    showToast('토지를 판매했습니다.');
                    showLandDetail(); // 새로고침
                } catch (e) {
                    showToast(`판매 실패: ${e.message}`);
                }
            };
        });
    }

  } catch (error) {
    console.error("토지 상세 정보 로딩 실패:", error);
    root.innerHTML = `<section class="container narrow"><div class="kv-card">오류: ${esc(error.message)}</div></section>`;
  }
}
