// /public/js/tabs/char_progress_narrative.js
function parseCharId() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  return params.get('id');
}

export default function showProgressNarrativePage() {
  const root = document.getElementById('view');
  const charId = parseCharId();
  root.innerHTML = `
    <section class="container narrow">
      <div class="card p16">
        <div style="display:flex; justify-content:space-between;">
            <h3 style="margin-top:0">서사 진행</h3>
            <a href="#/char/${charId || ''}" class="btn ghost">캐릭터로 돌아가기</a>
        </div>
        <div class="kv-card text-dim">
          서사 진행 기능은 현재 준비 중입니다.
        </div>
      </div>
    </section>
  `;
}
