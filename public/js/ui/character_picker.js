// /public/js/ui/character_picker.js (신규 또는 교체)
import { ensureModalCss } from './modal.js';

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/**
 * 캐릭터 선택 모달을 엽니다.
 * @param {Array} characters - 선택 가능한 캐릭터 목록
 * @param {string} title - 모달 창의 제목
 * @returns {Promise<object|null|undefined>} 선택된 캐릭터 객체, null(해제), undefined(취소)
 */
export async function openCharacterPickerModal(characters, title = '캐릭터 선택') {
  ensureModalCss();
  return new Promise(resolve => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    
    let cardsHtml = characters.map(char => `
      <div class="kv-card" data-char-id="${char.id}" style="cursor:pointer; transition: background .2s;">
        <div class="row" style="gap:10px; pointer-events:none;">
          <img src="${esc(char.thumb_url || char.image_url || '')}" onerror="this.style.display='none'" style="width:56px; height:56px; border-radius:8px; object-fit:cover; background:#111;">
          <div>
            <div style="font-weight:bold;">${esc(char.name)}</div>
            <div class="text-dim" style="font-size:11px; margin-top:4px; line-height:1.4;">
              Lv.${char.level || 1} / Elo ${char.elo || 1000}
            </div>
          </div>
        </div>
      </div>`).join('');
    
    back.innerHTML = `
      <div class="modal-card" style="max-width: 700px;">
        <div class="row" style="justify-content:space-between; align-items:center; margin-bottom:12px;">
            <div style="font-weight:900; font-size:18px;">${esc(title)}</div>
            <button class="btn ghost" id="mClose">닫기</button>
        </div>
        <div class="grid2" style="gap:10px; max-height: 50vh; overflow-y:auto; padding: 4px;">
            ${cardsHtml || '<div class="text-dim">선택할 수 있는 캐릭터가 없습니다.</div>'}
        </div>
      </div>`;
    document.body.appendChild(back);

    const close = (char = undefined) => { back.remove(); resolve(char); };
    
    back.querySelector('#mClose').onclick = () => close();
    back.addEventListener('click', e => { if (e.target === back) close(); });
    
    back.querySelectorAll('[data-char-id]').forEach(card => {
      card.onclick = () => {
        const charId = card.dataset.charId;
        close(characters.find(c => c.id === charId));
      };
    });
  });
}
