// /public/js/tabs/land_detail.js
import { func, auth, db, fx } from '../api/firebase.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-functions.js';
import { isAdminCached, ensureAdmin } from '../api/admin.js';
import { buyMicroPlot, sellMicroPlot } from '../api/land.js';
import { showToast } from '../ui/toast.js';
import { ensureModalCss, confirmModal } from '../ui/modal.js';

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

function calculateLandPrice(tileType, microTileType, legend, floatingPopulation) {
    const basePrice = { s: 500, l: 700, M: 2000, m: 3000, f: 1200, n: 1000, b: 1500, d: 800, r: 2500, R: 5000 }[tileType] || 1000;
    const microInfo = legend.micro_tile_legend[microTileType] || {};
    const microMultiplier = microInfo.buildable ? 1.2 : 0.8;
    const populationBonus = Math.floor(basePrice * (floatingPopulation / 100)); // 유동인구 1명당 1% 가격 보너스
    return Math.floor(basePrice * microMultiplier) + populationBonus;
}


async function showMicroPlotModal({ microX, microY, tileInfo, ownerData, landInfo, isAdmin, floatingPopulation }) {
  ensureModalCss();
  const legend = await getMicroLegend();
  const price = calculateLandPrice(landInfo.tile.type, tileInfo.type, legend, floatingPopulation);
  const isOwner = ownerData?.owner_uid === auth.currentUser.uid;
  const macroTileInfo = landInfo.tile;

  // 최종 건설/농사 가능 여부 판단
  const canBuild = (macroTileInfo.buildable !== false) && (tileInfo.buildable !== false);
  const canFarm = (macroTileInfo.can_farm === true) && (tileInfo.can_farm !== false);

  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `
    <div class="modal-card" style="max-width: 420px;">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px;">
        <div>
          <div style="font-weight:900; font-size:18px;">${esc(tileInfo.name)}</div>
          <div class="text-dim" style="font-size:12px;">(${landInfo.x}, ${landInfo.y}) 구역 내 (${microX}, ${microY})</div>
        </div>
        <button class="btn ghost" id="mClose">닫기</button>
      </div>
      
      <div class="kv-card" style="padding:12px;">
        <div class="row" style="justify-content:space-between;"><span>소유자</span> <b>${ownerData ? esc(ownerData.ownerName) : '없음'}</b></div>
        <div class="row" style="justify-content:space-between; margin-top:8px;"><span>예상 가격</span> <b>🪙 ${price.toLocaleString()}</b></div>
        ${ownerData ? `<div class="row" style="justify-content:space-between; margin-top:8px;"><span>판매 시 환급액 (80%)</span> <b>🪙 ${Math.floor(price * 0.8).toLocaleString()}</b></div>` : ''}
        <hr style="margin:12px 0; border-color: #273247;">
        <div class="row" style="justify-content:space-between;"><span>건설 가능</span> <b>${canBuild ? '✔ 가능' : '❌ 불가능'}</b></div>
        <div class="row" style="justify-content:space-between; margin-top:8px;"><span>농사 가능</span> <b>${canFarm ? '✔ 가능' : '❌ 불가능'}</b></div>
        <div class="row" style="justify-content:space-between; margin-top:8px;"><span>유동 인구</span> <b>~${floatingPopulation} 명/시간</b></div>
      </div>
      
      <div id="modal-actions" style="margin-top:16px; display:flex; justify-content:flex-end; gap:8px;"></div>
    </div>
  `;

  const closeModal = () => back.remove();
  back.addEventListener('click', (e) => { if (e.target === back) closeModal(); });
  back.querySelector('#mClose').onclick = closeModal;

  if (isAdmin) {
    const actionsContainer = back.querySelector('#modal-actions');
    if (ownerData) {
      if (isOwner) {
        // [수정] 토지 관리 버튼 로직 변경
        const manageBtn = document.createElement('button');
        manageBtn.className = 'btn';
        manageBtn.textContent = '토지 관리';
        manageBtn.onclick = () => {
          if (canFarm) {
            location.hash = `#/farm/${landInfo.mapId}/${landInfo.x}/${landInfo.y}/${microX}/${microY}`;
            closeModal();
          } else {
            showToast('농사가 불가능한 토지입니다. (추후 다른 관리 기능 추가 예정)');
          }
        };
        actionsContainer.appendChild(manageBtn);

        const sellBtn = document.createElement('button');
        sellBtn.className = 'btn danger';
        sellBtn.textContent = '판매하기';
        sellBtn.onclick = async () => {
          if (await confirmModal({ title: '토지 판매 확인', lines: [`이 토지를 🪙 ${Math.floor(price * 0.8).toLocaleString()}에 판매하시겠습니까?`] })) {
            try {
              await sellMicroPlot({ mapId: landInfo.mapId, x: landInfo.x, y: landInfo.y, microX, microY });
              showToast('토지를 판매했습니다.');
              closeModal();
              showLandDetail();
            } catch (e) { showToast(`판매 실패: ${e.message}`); }
          }
        };
        actionsContainer.appendChild(sellBtn);
      }
    } else {
      const buyBtn = document.createElement('button');
      buyBtn.className = 'btn primary';
      buyBtn.textContent = '구매하기';
      buyBtn.onclick = async () => {
        if (await confirmModal({ title: '토지 구매 확인', lines: [`이 토지를 🪙 ${price.toLocaleString()}에 구매하시겠습니까?`] })) {
          try {
            await buyMicroPlot({ mapId: landInfo.mapId, x: landInfo.x, y: landInfo.y, microX, microY, tileType: landInfo.tile.type, microTileType: tileInfo.type });
            showToast('토지를 구매했습니다.');
            closeModal();
            showLandDetail();
          } catch (e) { showToast(`구매 실패: ${e.message}`); }
        }
      };
      actionsContainer.appendChild(buyBtn);
    }
  }
  
  document.body.appendChild(back);
}

export async function showLandDetail() {
  const root = document.getElementById('view');
  const landInfo = parseLandInfo();

  if (!auth.currentUser || !landInfo) {
    root.innerHTML = `<section class="container narrow"><div class="kv-card">잘못된 토지 정보이거나 로그인이 필요합니다.</div></section>`;
    return;
  }
  
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
        
        let tileStyle = `background-color: ${tileInfo.color}; cursor: pointer;`;
        if (ownerData) {
            tileStyle += `box-shadow: inset 0 0 0 2px ${ownerData.owner_uid === auth.currentUser.uid ? '#4ade80' : '#FFD700'};`;
        }

        return `<div class="micro-tile" style="${tileStyle}" data-mx="${microX}" data-my="${microY}" data-mtype="${microTileType}" title="${tileInfo.name} (${microX}, ${microY})"></div>`;
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
            <div class="micro-grid mt12">${microGridHtml}</div>
            <div class="text-dim" style="font-size:12px; margin-top:8px;">각 필지를 클릭하여 상세 정보를 확인하고 거래할 수 있습니다.</div>
        </div>
      </section>
    `;

    root.querySelectorAll('.micro-tile').forEach(tileEl => {
      tileEl.addEventListener('click', () => {
        const microX = parseInt(tileEl.dataset.mx, 10);
        const microY = parseInt(tileEl.dataset.my, 10);
        const microTileType = tileEl.dataset.mtype;
        const tileInfo = { type: microTileType, ...(legend[microTileType] || {}) };
        const ownerData = data.owners?.[`${microY}_${microX}`] || null;
        
        showMicroPlotModal({ microX, microY, tileInfo, ownerData, landInfo, isAdmin, floatingPopulation: data.floatingPopulation });
      });
    });

  } catch (error) {
    console.error("토지 상세 정보 로딩 실패:", error);
    root.innerHTML = `<section class="container narrow"><div class="kv-card">오류: ${esc(error.message)}</div></section>`;
  }
}
