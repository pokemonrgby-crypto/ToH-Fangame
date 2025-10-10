// /public/js/ui/character_picker.js (새 파일)

import { ensureModalCss } from './modal.js';

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/**
 * 캐릭터 선택 모달을 엽니다.
 * @param {Array} characters - 선택 가능한 캐릭터 목록
 * @returns {Promise<object|null|undefined>} 선택된 캐릭터 객체, null(해제), undefined(취소)
 */
export async function openCharacterPickerModal(characters) {
  ensureModalCss();
  return new Promise(resolve => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    let cardsHtml = characters.map(char => {
      const skills = char.skills || {};
      return `
        <div class="kv-card" data-char-id="${char.id}" style="cursor:pointer;">
          <div class="row" style="gap:10px">
            <img src="${char.thumb_url || char.image_url || ''}" onerror="this.style.display='none'" style="width:60px; height:60px; border-radius:4px; object-fit:cover;">
            <div>
              <div style="font-weight:bold;">${esc(char.name)}</div>
              <div class="text-dim" style="font-size:11px; margin-top:4px; line-height: 1.4;">
                원예 ${skills.gardening?.level||0} | 건설 ${skills.construction?.level||0} | 미술 ${skills.art?.level||0}
              </div>
            </div>
          </div>
        </div>`;
    }).join('');
    cardsHtml += `<button class="kv-card" data-char-id="null" style="cursor:pointer; text-align:center;"><div class="text-dim">🚫 담당자 할당 해제</div></button>`;

    back.innerHTML = `
      <div class="modal-card" style="max-width: 700px;">
        <div style="font-weight:900; margin-bottom:12px;">담당 캐릭터 선택</div>
        <div class="grid2" style="gap:10px; max-height: 50vh; overflow-y:auto;">${cardsHtml}</div>
        <button class="btn ghost" id="mClose" style="margin-top:16px; align-self:flex-end;">닫기</button>
      </div>`;
    document.body.appendChild(back);

    const close = (char = undefined) => { back.remove(); resolve(char); };
    back.querySelector('#mClose').onclick = () => close();
    back.addEventListener('click', e => { if (e.target === back) close(); });
    back.querySelectorAll('[data-char-id]').forEach(card => {
      card.onclick = () => {
        const charId = card.dataset.charId;
        close(charId === 'null' ? null : characters.find(c => c.id === charId));
      };
    });
  });
}
