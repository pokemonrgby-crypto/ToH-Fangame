// /public/js/ui/modal.js (전체 교체)

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
    .modal-card, .modal{ /* .modal 클래스도 지원 */
      background:#0e1116; border:1px solid #273247; border-radius:14px;
      padding:16px; width:92vw; max-width:480px; max-height:90vh; overflow-y:auto;
    }
    .col{ display:flex; flex-direction:column; }
    .row{ display:flex; align-items:center; }
    .btn{ height:34px; padding:0 12px; border-radius:8px; border:1px solid rgba(255,255,255,.08); background:rgba(115,130,255,.18); color:#fff; cursor:pointer; }
    .btn.ghost{ background:transparent; }
    .btn.primary{ background:rgba(100,160,255,.35); }
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
 * [신규] 텍스트 입력을 받는 프롬프트 모달을 띄우고 Promise를 반환합니다.
 * @param {object} opts - {title, placeholder, hint, maxLen, okText, cancelText}
 * @returns {Promise<string|null>} - 확인(입력값), 취소(null)
 */
export function seedCreatorModal(opts = {}) {
    ensureModalCss();
    const { baseItem } = opts;
    if (!baseItem) return Promise.resolve(null);

    const rarity = baseItem.rarity || 'normal';
    const rules = {
        normal: { growthTime: [10, 60], aestheticValue: [10, 50] },
        rare:   { growthTime: [60, 300], aestheticValue: [20, 150] },
        epic:   { growthTime: [300, 1440], aestheticValue: [30, 400] },
        legend: { growthTime: [720, 1440], aestheticValue: [40, 1000] },
        myth:   { growthTime: [1080, 1440], aestheticValue: [100, 2500] },
        aether: { growthTime: [1440, 1440], aestheticValue: [250, 5000] }
    }[rarity] || { growthTime: [10, 60], aestheticValue: [10, 50] };

    return new Promise(resolve => {
        const back = document.createElement('div');
        back.className = 'modal-back';
        back.innerHTML = `
        <div class="modal-card" style="max-width: 640px;">
            <div style="font-weight:900; font-size:18px; margin-bottom:12px">커스텀 씨앗 생성 (${rarity})</div>
            
            <div class="col" style="gap: 12px;">
                <input id="seed-name" class="input" placeholder="새로운 씨앗 이름 (최대 50자)" maxlength="50">
                <textarea id="seed-desc" class="input" placeholder="씨앗에 대한 설명 (최대 500자)" maxlength="500" rows="3"></textarea>
                
                <div class="grid2" style="gap: 12px;">
                    <div>
                        <label class="kv-label">성장 시간(분)</label>
                        <input id="seed-growth" class="input" type="number" min="${rules.growthTime[0]}" max="${rules.growthTime[1]}" value="${rules.growthTime[0]}">
                        <div class="text-dim" style="font-size:12px;">(추천: ${rules.growthTime[0]} ~ ${rules.growthTime[1]})</div>
                    </div>
                    <div>
                        <label class="kv-label">미관 점수</label>
                        <input id="seed-aesthetic" class="input" type="number" min="${rules.aestheticValue[0]}" max="${rules.aestheticValue[1]}" value="${rules.aestheticValue[0]}">
                        <div class="text-dim" style="font-size:12px;">(추천: ${rules.aestheticValue[0]} ~ ${rules.aestheticValue[1]})</div>
                    </div>
                </div>

                <div>
                    <div class="kv-label">수확물 (최대 3개, 확정 1개 필수)</div>
                    <div id="harvest-rows" class="col" style="gap: 8px;"></div>
                    <button id="btn-add-harvest" class="btn small" style="margin-top: 8px;">+ 수확물 추가</button>
                </div>
            </div>

            <div class="row" style="justify-content:flex-end; gap:8px; margin-top:16px;">
                <button class="btn ghost" id="modal-cancel">취소</button>
                <button class="btn primary" id="modal-ok">생성</button>
            </div>
        </div>
        `;

        const harvestRows = back.querySelector('#harvest-rows');
        const btnAddHarvest = back.querySelector('#btn-add-harvest');

        const addHarvestRow = (isGuaranteed = false) => {
            if (harvestRows.children.length >= 3) {
                btnAddHarvest.style.display = 'none';
                return;
            }
            const row = document.createElement('div');
            row.className = 'row harvest-row';
            row.style.gap = '8px';
            row.innerHTML = `
                <input class="input harvest-id" list="item-datalist" placeholder="아이템 ID">
                <input class="input harvest-min" type="number" value="1" min="1" max="5" style="width: 60px;" ${isGuaranteed ? '' : 'disabled'}>
                <input class="input harvest-max" type="number" value="1" min="1" max="5" style="width: 60px;">
                <input class="input harvest-prob" type="number" value="${isGuaranteed ? '1.0' : '0.1'}" min="0" max="1" step="0.01" style="width: 80px;" ${isGuaranteed ? 'disabled' : ''}>
                <button class="btn danger small btn-remove-harvest" style="${isGuaranteed ? 'display:none;' : ''}">X</button>
            `;
            harvestRows.appendChild(row);
            if (harvestRows.children.length >= 3) btnAddHarvest.style.display = 'none';
        };

        btnAddHarvest.onclick = () => addHarvestRow(false);
        harvestRows.addEventListener('click', e => {
            if (e.target.classList.contains('btn-remove-harvest')) {
                e.target.parentElement.remove();
                btnAddHarvest.style.display = 'block';
            }
        });

        const close = (val) => { back.remove(); resolve(val); };
        back.addEventListener('click', e => { if (e.target === back) close(null); });
        back.querySelector('#modal-cancel').onclick = () => close(null);
        back.querySelector('#modal-ok').onclick = () => {
            try {
                const harvest = Array.from(harvestRows.children).map(row => {
                    return {
                        itemId: row.querySelector('.harvest-id').value,
                        min: parseInt(row.querySelector('.harvest-min').value),
                        max: parseInt(row.querySelector('.harvest-max').value),
                        probability: parseFloat(row.querySelector('.harvest-prob').value)
                    };
                });

                const data = {
                    name: back.querySelector('#seed-name').value,
                    description: back.querySelector('#seed-desc').value,
                    growthTimeMinutes: parseInt(back.querySelector('#seed-growth').value),
                    aestheticValue: parseInt(back.querySelector('#seed-aesthetic').value),
                    harvest: harvest
                };
                
                // 간단한 유효성 검사
                if (!data.name || !data.description || !data.growthTimeMinutes || !data.aestheticValue || data.harvest.length === 0) {
                    throw new Error('모든 필드를 채워주세요.');
                }

                close(data);
            } catch (e) {
                showToast(`입력 오류: ${e.message}`);
            }
        };

        addHarvestRow(true); // 확정 드랍 행 1개 추가
        document.body.appendChild(back);
        
        // Datalist for item search
        fetch('/assets/items.json').then(r => r.json()).then(items => {
            const datalist = document.createElement('datalist');
            datalist.id = 'item-datalist';
            datalist.innerHTML = Object.entries(items).map(([id, item]) => `<option value="${id}">${item.name} (${item.rarity})</option>`).join('');
            back.appendChild(datalist);
        });
    });
}
