// /public/js/tabs/land_detail.js
import { func } from '../api/firebase.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-functions.js';

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function parseLandId() {
  const m = (location.hash || '').match(/^#\/land\/([^/]+)\/(\d+)\/(\d+)$/);
  return m ? { mapId: m[1], x: parseInt(m[2], 10), y: parseInt(m[3], 10) } : null;
}

export async function showLandDetail() {
  const root = document.getElementById('view');
  const landInfo = parseLandId();

  if (!landInfo) {
    root.innerHTML = `<section class="container narrow"><div class="kv-card">잘못된 토지 정보입니다.</div></section>`;
    return;
  }

  root.innerHTML = `<section class="container narrow"><div class="spin-center"></div></section>`;
  
  try {
    const getLandDetail = httpsCallable(func, 'getLandDetail');
    const result = await getLandDetail({ mapId: landInfo.mapId, x: landInfo.x, y: landInfo.y });
    const { data } = result;

    if (!data.ok) throw new Error("토지 정보를 불러오지 못했습니다.");
    
    // TODO: micro_legend.json을 불러와서 색상 등 렌더링에 사용해야 함
    const microGridHtml = data.microGrid.map(tileType => 
        `<div class="micro-tile" style="background-color: #8AAA79;"></div>`
    ).join('');

    root.innerHTML = `
      <style>
        .micro-grid { display: grid; grid-template-columns: repeat(10, 1fr); border: 1px solid #555; }
        .micro-tile { aspect-ratio: 1 / 1; }
        .micro-tile:hover { outline: 1px solid yellow; }
      </style>
      <section class="container narrow">
        <div class="card p12">
            <div class="row" style="justify-content:space-between">
                <h3 style="margin-top:0">토지 상세 정보 (${landInfo.x}, ${landInfo.y})</h3>
                <button class="btn ghost" onclick="history.back()">뒤로가기</button>
            </div>
            <div class="row">
                <div class="kv-card" style="flex:1;">
                    <div class="kv-label">유동 인구</div>
                    <div>${data.floatingPopulation} 명/시간</div>
                </div>
                 <div class="kv-card" style="flex:1;">
                    <div class="kv-label">소유자</div>
                    <div>${data.ownerName || '없음'}</div>
                </div>
            </div>
            <div class="micro-grid mt12">${microGridHtml}</div>
        </div>
      </section>
    `;

  } catch (error) {
    console.error("토지 상세 정보 로딩 실패:", error);
    root.innerHTML = `<section class="container narrow"><div class="kv-card">오류: ${esc(error.message)}</div></section>`;
  }
}
