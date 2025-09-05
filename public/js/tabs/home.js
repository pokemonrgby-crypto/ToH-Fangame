// /public/js/tabs/home.js  (목록 렌더 부분만 교체)
// myChars 를 세로 카드로 렌더하고, 클릭 시 #/char/:id 로 이동.

import { App, fetchMyChars } from '../api/store.js';
import { auth } from '../api/firebase.js';

export async function showHome(){
  const root = document.getElementById('view');
  const u = auth.currentUser;
  if(!u){ root.innerHTML = `<section class="container narrow"><p>로그인하면 캐릭터를 볼 수 있어.</p></section>`; return; }

  const list = await fetchMyChars(u.uid);
  root.innerHTML = `
    <section class="container narrow">
      ${list.map(c=>`
        <div class="card row clickable" data-id="${c.id}">
          <div class="thumb sq"></div>
          <div class="col">
            <div class="title">${c.name}</div>
            <div class="chips"><span class="chip">${c.world_id}</span></div>
            <div class="row gap8 mt6">
              <span class="pill">주간 ${c.likes_weekly||0}</span>
              <span class="pill">누적 ${c.likes_total||0}</span>
              <span class="pill">Elo ${c.elo||1000}</span>
            </div>
          </div>
        </div>
      `).join('')}
      <div class="card center mt16">
        <button id="btnNew" class="btn primary">새 캐릭터 만들기</button>
      </div>
    </section>
  `;
  root.querySelectorAll('.clickable').forEach(el=>{
    el.onclick = ()=> location.hash = `#/char/${el.dataset.id}`;
  });
  root.querySelector('#btnNew').onclick = ()=> location.hash = '#/create';
}
