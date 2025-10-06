// public/js/ui/modal.js
// [전체 교체]
function esc(s){ return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

/**
 * 모든 모달의 기본이 되는 CSS를 <head>에 주입합니다.
 * 한 번만 실행되도록 id로 중복을 체크합니다.
 */
export function ensureModalCss(){
  if (document.getElementById('toh-modal-css')) return;
  const st = document.createElement('style');
  st.id = 'toh-modal-css';
  st.textContent = `
    /* 모달 오버레이: 토스트보다 낮게 */
    .modal-back{
      position:fixed; inset:0; z-index:9990;
      display:flex; align-items:center; justify-content:center;
      background:rgba(0,0,0,.6); backdrop-filter:blur(4px);
    }
    .modal-back > .modal-card { /* .modal 클래스도 지원 */
      background:#0e1116; border:1px solid #273247; border-radius:14px;
      padding:16px; width:92vw; max-width:480px; max-height:90vh; overflow-y:auto;
    }
    .col{ display:flex; flex-direction:column; }
    .row{ display:flex; align-items:center; }
    .text-dim{ color: rgba(255,255,255,.6); }

    /* 토스트를 항상 모달 위로 띄우기 */
    #toast-root, .toast, .toast-container, .kv-toast {
      position: fixed; z-index: 11000 !important;
    }
  `;
  document.head.appendChild(st);
}

/**
 * 간단한 확인/취소 모달을 띄우고 Promise를 반환합니다.
 * @param {object} opts - {title, lines, okText, cancelText}
 * @returns {Promise<boolean>} - 확인(true), 취소(false)
 */
export function confirmModal(opts){
  ensureModalCss(); // [추가] CSS가 주입되었는지 확인
  return new Promise(res=>{
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `
      <div class="modal-card">
        <div style="font-weight:900; font-size:18px; margin-bottom:8px">${esc(opts.title||'확인')}</div>
        <div class="col" style="gap:6px; margin-bottom:10px; font-size:13px; color:rgba(255,255,255,.8);">
          ${(opts.lines||[]).map(t=>`<div>${esc(t)}</div>`).join('')}
        </div>
        <div class="row" style="justify-content:flex-end; gap:8px; margin-top:12px;">
          <button class="btn ghost" data-x>${esc(opts.cancelText||'취소')}</button>
          <button class="btn primary" data-ok>${esc(opts.okText||'확인')}</button>
        </div>
      </div>
    `;
    const close = (v)=>{ back.remove(); res(v); };
    back.addEventListener('click', e=>{ if(e.target===back) close(false); });
    back.querySelector('[data-x]').onclick = ()=> close(false);
    back.querySelector('[data-ok]').onclick = ()=> close(true);
    document.body.appendChild(back);
  });
}

/**
 * [교체] 텍스트 프롬프트를 입력받는 새로운 모달
 */
export function promptModal({ title, placeholder, hint, maxLen = 300, okText = '확인', cancelText = '취소' }) {
    ensureModalCss();
    return new Promise(resolve => {
        const back = document.createElement('div');
        back.className = 'modal-back';
        back.innerHTML = `
            <div class="modal-card" style="max-width: 560px;">
                <div style="font-weight:900; font-size:18px;">${esc(title)}</div>
                <div style="font-size:13px; color:rgba(255,255,255,.6); margin-top:4px;">${esc(hint)}</div>
                <textarea id="prompt-text" class="input" style="margin-top:12px; min-height:100px; resize:vertical;" maxlength="${maxLen}" placeholder="${esc(placeholder)}"></textarea>
                <div style="display:flex; justify-content:space-between; align-items:center; margin-top:8px;">
                    <div id="char-count" style="font-size:12px; color:rgba(255,255,255,.6);">0 / ${maxLen}</div>
                    <div class="row" style="gap: 8px;">
                        <button class="btn ghost" id="prompt-cancel">${esc(cancelText)}</button>
                        <button class="btn primary" id="prompt-ok">${esc(okText)}</button>
                    </div>
                </div>
            </div>
        `;

        const txt = back.querySelector('#prompt-text');
        const countEl = back.querySelector('#char-count');
        
        const updateCount = () => {
            countEl.textContent = `${txt.value.length} / ${maxLen}`;
        };
        txt.addEventListener('input', updateCount);

        const close = (val) => { back.remove(); resolve(val); };
        
        back.addEventListener('click', e => { if (e.target === back) close(null); });
        back.querySelector('#prompt-cancel').onclick = () => close(null);
        back.querySelector('#prompt-ok').onclick = () => {
            const value = txt.value.trim();
            if (!value) {
                alert('내용을 입력해주세요.');
                return;
            }
            close(value);
        };
        document.body.appendChild(back);
        txt.focus();
        updateCount();
    });
}
