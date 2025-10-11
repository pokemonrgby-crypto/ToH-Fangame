// /public/js/ui/modal.js

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
    /* 모달 오버레이: 기본 z-index를 9990으로 설정 */
    .modal-back{
      position:fixed; inset:0; z-index:9990;
      display:flex; align-items:center; justify-content:center;
      background:rgba(0,0,0,.6); backdrop-filter:blur(4px);
    }
    .modal-back > .modal-card {
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
 * [추가] 비어있는 모달 창을 생성하고, card와 modal element를 반환합니다.
 * item.js 등에서 상세 모달을 만들 때 사용합니다.
 * @param {object} options - { zIndex }
 * @returns {{modal: HTMLElement, card: HTMLElement}}
 */
export function createModal(options = {}) {
    ensureModalCss();
    const back = document.createElement('div');
    back.className = 'modal-back';
    
    // zIndex 옵션이 있으면 적용하고, 없으면 현재 열린 모달 개수에 따라 동적으로 계산
    back.style.zIndex = options.zIndex || (9990 + document.querySelectorAll('.modal-back').length);

    const card = document.createElement('div');
    card.className = 'modal-card';
    back.appendChild(card);

    // 배경 클릭 시 닫기
    const close = () => back.remove();
    back.addEventListener('click', e => {
        if (e.target === back) close();
    });

    document.body.appendChild(back);
    // card element를 반환하여 내용을 채울 수 있도록 하고, modal(back) element는 z-index 계산 등에 사용
    return { modal: back, card };
}

/**
 * [추가] 내용을 받아 모달을 열고, 모달의 card 엘리먼트를 반환합니다.
 * story.js 등에서 사용하기 위한 간편 함수입니다.
 * @param {string} content - 모달 카드에 들어갈 HTML 내용
 * @returns {HTMLElement} 생성된 모달의 card 엘리먼트
 */
export function showModal(content) {
    const { card } = createModal();
    card.innerHTML = content;
    return card;
}


/**
 * [추가된 함수] 다른 파일에서 import하여 사용할 수 있도록 openModal 함수를 추가합니다.
 * 이 함수는 모달을 열고 내용을 채운 후 콜백을 실행합니다.
 * @param {string} content - 모달 카드에 들어갈 HTML 내용
 * @param {function} onOpen - 모달이 열린 후 실행할 콜백 함수
 */
export function openModal(content, onOpen) {
    const { modal, card } = createModal();
    card.innerHTML = content;

    // 닫기 버튼에 이벤트 리스너 추가 (모달 내부에 id="close-modal" 버튼이 있다고 가정)
    const closeButton = card.querySelector('#close-modal');
    if (closeButton) {
        closeButton.onclick = () => modal.remove();
    }

    if (typeof onOpen === 'function') {
        onOpen(modal, card);
    }
}


/**
 * [추가] 모달 내부의 버튼 등에서 모달을 닫을 때 사용합니다.
 * @param {HTMLElement} elementInsideModal - 모달 내부의 아무 엘리먼트
 */
export function closeModal(elementInsideModal) {
    elementInsideModal.closest('.modal-back')?.remove();
}


/**
 * 간단한 확인/취소 모달을 띄우고 Promise를 반환합니다.
 * @param {object} opts - {title, lines, okText, cancelText, zIndex}
 * @returns {Promise<boolean>} - 확인(true), 취소(false)
 */
export function confirmModal(opts){
  return new Promise(res=>{
    // zIndex를 옵션으로 받아 createModal에 전달합니다.
    const { modal, card } = createModal({ zIndex: opts.zIndex });
    
    card.innerHTML = `
      <div style="font-weight:900; font-size:18px; margin-bottom:8px">${esc(opts.title||'확인')}</div>
      <div class="col" style="gap:6px; margin-bottom:10px; font-size:13px; color:rgba(255,255,255,.8);">
        ${(opts.lines||[]).map(t=>`<div>${esc(t)}</div>`).join('')}
      </div>
      <div class="row" style="justify-content:flex-end; gap:8px; margin-top:12px;">
        <button class="btn ghost" data-x>${esc(opts.cancelText||'취소')}</button>
        <button class="btn primary" data-ok>${esc(opts.okText||'확인')}</button>
      </div>
    `;
    const close = (v)=>{ modal.remove(); res(v); };
    card.querySelector('[data-x]').onclick = ()=> close(false);
    card.querySelector('[data-ok]').onclick = ()=> close(true);
  });
}
window.closeModal = closeModal;

/**
 * 텍스트 프롬프트를 입력받는 새로운 모달
 * @param {object} opts - { title, placeholder, hint, maxLen, okText, cancelText, zIndex }
 */
export function promptModal({ title, placeholder, hint, maxLen = 300, okText = '확인', cancelText = '취소', zIndex }) {
    return new Promise(resolve => {
        const { modal, card } = createModal({ zIndex });
        
        card.style.maxWidth = '560px';
        card.innerHTML = `
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
        `;

        const txt = card.querySelector('#prompt-text');
        const countEl = card.querySelector('#char-count');
        
        const updateCount = () => {
            countEl.textContent = `${txt.value.length} / ${maxLen}`;
        };
        txt.addEventListener('input', updateCount);

        const close = (val) => { modal.remove(); resolve(val); };
        
        card.querySelector('#prompt-cancel').onclick = () => close(null);
        card.querySelector('#prompt-ok').onclick = () => {
            const value = txt.value.trim();
            if (!value) {
                // alert() 대신 confirmModal과 비슷한 알림 모달을 사용하는 것이 더 일관적일 수 있습니다.
                // 여기서는 일단 alert를 유지합니다.
                alert('내용을 입력해주세요.');
                return;
            }
            close(value);
        };
        txt.focus();
        updateCount();
    });
}
