// /public/js/tabs/land_management.js

import { auth } from '../api/firebase.js';

function parseId(){
  const h = location.hash || '';
  // 예시: #/land-management/{plotId} 형태의 URL을 파싱
  const m = h.match(/^#\/land-management\/([^/]+)/);
  return m ? m[1] : null;
}

export async function showLandManagement() {
  const root = document.getElementById('view');
  if (!auth.currentUser) {
    root.innerHTML = `<section class="container narrow"><div class="kv-card">로그인이 필요합니다.</div></section>`;
    return;
  }

  const plotId = parseId();

  if (!plotId) {
      root.innerHTML = `
      <section class="container narrow">
        <div class="kv-card">
            <h3>내 토지 목록 (예시)</h3>
            <p>이곳에 소유한 토지 목록을 표시하고, 클릭하면 해당 토지의 관리 페이지로 이동하도록 구현할 수 있습니다.</p>
            <a href="#/worldmap" class="btn">월드맵에서 토지 선택하기</a>
        </div>
      </section>`;
      return;
  }
  
  // 특정 토지를 관리하는 UI
  root.innerHTML = `
    <section class="container narrow">
        <div class="kv-card">
            <h3>토지 관리: ${plotId}</h3>
            <p>이곳에 선택된 토지(${plotId})를 관리하는 상세 UI를 구현할 수 있습니다.</p>
             <a href="#/land-management" class="btn ghost">목록으로 돌아가기</a>
        </div>
    </section>
  `;
}
