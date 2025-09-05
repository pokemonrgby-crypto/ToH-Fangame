// /public/js/tabs/create.js
import { fetchWorlds, createCharMinimal, App } from '../api/store.js';
import { showToast } from '../ui/toast.js';

export async function showCreate(){
  const root = document.getElementById('view');
  const worlds = await fetchWorlds();
  const worldList = (worlds?.worlds||[]);

  root.innerHTML = `
  <section class="container narrow">
    <h2>새 캐릭터 만들기</h2>
    <div class="card p16">
      <label class="lbl">세계관</label>
      <div class="chips" id="wchips">
        ${worldList.map(w=>`<button class="chip" data-w="${w.id}">${w.name}</button>`).join('')}
      </div>

      <label class="lbl">이름 (≤20자)</label>
      <input id="cname" maxlength="20" class="input" placeholder="이름" />

      <label class="lbl">설명 (≤500자)</label>
      <textarea id="cinfo" maxlength="500" class="textarea" rows="6" placeholder="캐릭터 소개/설정"></textarea>

      <button id="saveBtn" class="btn primary mt16">저장</button>
    </div>
  </section>
  `;

  let world_id = worldList[0]?.id || 'gionkir';
  const chips = root.querySelectorAll('#wchips .chip');
  chips.forEach(b=>{
    if(b.dataset.w === world_id) b.classList.add('active');
    b.onclick = ()=>{
      chips.forEach(x=>x.classList.remove('active'));
      b.classList.add('active');
      world_id = b.dataset.w;
    };
  });

  root.querySelector('#saveBtn').onclick = async ()=>{
    const name = root.querySelector('#cname').value.trim();
    const info = root.querySelector('#cinfo').value.trim();
    if(!name) return showToast('이름을 입력해줘');
    try{
      const id = await createCharMinimal({ world_id, name, input_info: info });
      location.hash = `#/char/${id}`;
    }catch(e){ showToast('생성 실패: '+e.message); }
  };
}
