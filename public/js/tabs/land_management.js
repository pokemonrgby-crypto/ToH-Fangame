// /public/js/tabs/land_management.js
import { auth, db, fx } from '../api/firebase.js';
import { showToast } from '../ui/toast.js';
import { ensureModalCss, confirmModal, promptModal } from '../ui/modal.js';

import { assignCharacterToFacility, createFarmland, startConstruction } from '../api/real_estate.js';
import { getUserCharacters } from '../api/char.js';

/* ------------------------------
 * 유틸리티
 * ------------------------------ */
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function parseLandPlotInfo() {
  const m = (location.hash || '').match(/^#\/land-management\/([^/]+)\/(\d+)\/(\d+)\/(\d+)\/(\d+)/);
  if (!m) return null;
  return {
    mapId: m[1],
    x: parseInt(m[2], 10),
    y: parseInt(m[3], 10),
    microX: parseInt(m[4], 10),
    microY: parseInt(m[5], 10),
  };
}

/* ------------------------------
 * 설계 마법사 (8단계)
 * ------------------------------ */
async function openCustomConstructionModal(characters, userItems, availableArea, materialsAsset, plotDocId) {
  ensureModalCss();
  return new Promise(resolve => {
    const back = document.createElement('div');
    back.className = 'modal-back';

    let state = {
      step: 1,
      // 기본 정보
      name: '',
      purpose: null,      // building type
      style: null,        // architectural style id
      // 규모/치수
      scale: 'small',     // small | medium | large | xlarge
      heightM: 5,         // 5~1000
      totalArea: 10,      // 총면적(m²)
      // 구역 분할
      zones: [],          // { name, purpose, areaM2 }
      // 자재
      materials: [],      // 선택된 자재 id[]
      totalCost: 0,
      // 시공사
      contractor: {       // { type:'self'|'player'|'company'|'npc', id?, level? }
        type: 'self',
        id: null,
        level: 1
      }
    };

    const closeModal = (val = null) => {
      try { document.body.removeChild(back); } catch {}
      resolve(val);
    };

    const render = () => {
      let contentHtml = '';

      switch (state.step) {
        case 1: // 이름
          contentHtml = `
            <h2>새 건물 설계 - 1단계: 이름</h2>
            <p>건물의 이름을 입력하세요.</p>
            <input type="text" id="building-name" value="${esc(state.name)}" placeholder="예: 대장간, 연금술사의 탑">
          `;
          break;

        case 2: // 유형
          contentHtml = `
            <h2>새 건물 설계 - 2단계: 유형</h2>
            <p>건물의 주된 유형을 선택하세요.</p>
            <div class="radio-grid">
              ${Object.entries(materialsAsset.purposes).map(([id, p]) => `
                <label>
                  <input type="radio" name="building-purpose" value="${id}" ${state.purpose === id ? 'checked' : ''}>
                  <div>
                    <span>${esc(p.name)}</span>
                    <small>${esc(p.description || '')}</small>
                  </div>
                </label>
              `).join('')}
            </div>
          `;
          break;

        case 3: // 양식
          contentHtml = `
            <h2>새 건물 설계 - 3단계: 건축 양식</h2>
            <p>건물의 건축 양식을 선택하세요.</p>
            <div class="radio-grid">
              ${Object.values(materialsAsset.styles).map(s => `
                <label>
                  <input type="radio" name="architectural-style" value="${s.id}" ${state.style === s.id ? 'checked' : ''}>
                  <div>
                    <span>${esc(s.name)}</span>
                    <small>${esc(s.description || '')}</small>
                  </div>
                </label>
              `).join('')}
            </div>
          `;
          break;

        case 4: // 규모/높이/총면적
          contentHtml = `
            <h2>새 건물 설계 - 4단계: 규모 · 높이 · 총면적</h2>
            <div class="grid2" style="gap:12px;">
              <div class="kv-card">
                <div class="kv-label">규모</div>
                <select id="building-scale">
                  <option value="small" ${state.scale==='small'?'selected':''}>소형 (≤ 500m²)</option>
                  <option value="medium" ${state.scale==='medium'?'selected':''}>중형 (≤ 2,000m²)</option>
                  <option value="large" ${state.scale==='large'?'selected':''}>대형 (≤ 5,000m²)</option>
                  <option value="xlarge" ${state.scale==='xlarge'?'selected':''}>초대형 (≤ 10,000m²)</option>
                </select>
              </div>
              <div class="kv-card">
                <div class="kv-label">높이 (5~1000 m)</div>
                <input type="number" id="building-height" min="5" max="1000" value="${state.heightM}">
              </div>
            </div>
            <div class="kv-card" style="margin-top:8px;">
              <div class="kv-label">총면적 (m²) — 남은 면적: ${availableArea.toLocaleString()}m²</div>
              <input type="number" id="building-totalarea" min="1" max="${availableArea}" value="${state.totalArea}">
              <small class="text-dim">규모는 가이드일 뿐, 실제 제약은 남은 면적입니다.</small>
            </div>
          `;
          break;

        case 5: { // 구역 분할
          const rows = (state.zones.length ? state.zones : [{ name:'본관', purpose: state.purpose || Object.keys(materialsAsset.purposes)[0], areaM2: state.totalArea }])
            .map((z, idx)=>`
              <tr data-idx="${idx}">
                <td><input type="text" class="z-name" value="${esc(z.name||'')}" placeholder="예: 매장, 작업실"></td>
                <td>
                  <select class="z-purpose">
                    ${Object.entries(materialsAsset.purposes).map(([id,p]) =>
                      `<option value="${id}" ${z.purpose===id?'selected':''}>${esc(p.name)}</option>`).join('')}
                  </select>
                </td>
                <td style="width:120px"><input type="number" class="z-area" min="1" value="${Number(z.areaM2||0)}"></td>
                <td style="width:40px"><button class="btn small ghost z-del">-</button></td>
              </tr>
            `).join('');
          const zonesSum = (state.zones.length?state.zones:[{areaM2:state.totalArea}]).reduce((a,b)=>a+Number(b.areaM2||0),0);
          contentHtml = `
            <h2>새 건물 설계 - 5단계: 구역 분할</h2>
            <p>총면적을 구역으로 나누세요. 합계는 총면적(${state.totalArea}m²)과 같아야 합니다.</p>
            <div class="kv-card">
              <table class="kv-table">
                <thead><tr><th>구역명</th><th>용도</th><th>면적(m²)</th><th></th></tr></thead>
                <tbody id="zones-tbody">${rows}</tbody>
              </table>
              <div class="row" style="gap:8px; margin-top:8px;">
                <button class="btn small" id="z-add">+ 구역 추가</button>
                <div class="text-dim">합계: <b id="zones-sum">${zonesSum}</b> / ${state.totalArea} m²</div>
              </div>
            </div>
          `;
          break;
        }

        case 6: { // 자재
          const materialEntries = Object.entries(materialsAsset.materials);
          contentHtml = `
            <h2>새 건물 설계 - 6단계: 주 자재</h2>
            <p>건설에 사용할 주요 자재를 선택하세요. (복수 선택 가능)</p>
            <div class="checkbox-grid">
              ${materialEntries.map(([id, m]) => {
                const userMaterial = userItems.find(i => i.id === id || i.itemId === id);
                const possessed = userMaterial ? (userMaterial.quantity || userMaterial.count || 0) : 0;
                const needsPurchase = possessed === 0;
                return `
                  <label>
                    <input type="checkbox" name="building-material" value="${id}" ${state.materials.includes(id) ? 'checked' : ''}>
                    <div>
                      <span>${esc(m.name)} (보유: ${possessed})</span>
                      <small>${esc(m.description || '')}</small>
                      ${needsPurchase ? `<small style="color:#f59e0b; font-weight:bold; margin-top:4px;">※ 보유량이 없어 구매가 필요합니다.</small>` : ''}
                    </div>
                  </label>
                `;
              }).join('')}
            </div>
          `;
          break;
        }

        case 7: // 시공사
          contentHtml = `
            <h2>새 건물 설계 - 7단계: 시공사 선택</h2>
            <div class="tabs row" style="gap:8px; margin-bottom:8px;">
              <button class="btn small ${state.contractor.type==='self'?'primary':''}" data-ct="self">개인(나)</button>
              <button class="btn small ${state.contractor.type==='player'?'primary':''}" data-ct="player">타인(플레이어)</button>
              <button class="btn small ${state.contractor.type==='company'?'primary':''}" data-ct="company">건설사</button>
              <button class="btn small ${state.contractor.type==='npc'?'primary':''}" data-ct="npc">NPC 팀</button>
            </div>
            <div id="contractor-pane" class="kv-card">
              ${state.contractor.type==='npc'
                ? `<div class="kv-label">NPC 팀 레벨</div>
                   <input type="range" id="npc-level" min="1" max="100" value="${state.contractor.level||1}">
                   <div>현재 레벨: <b id="npc-level-val">${state.contractor.level||1}</b></div>
                   <small class="text-dim">레벨이 높을수록 공사 시간이 단축돼.</small>`
                : state.contractor.type==='player'
                  ? `<div class="kv-label">플레이어 UID</div><input type="text" id="player-uid" value="${esc(state.contractor.id||'')}">`
                  : state.contractor.type==='company'
                    ? `<div class="kv-label">건설사 ID</div><input type="text" id="company-id" value="${esc(state.contractor.id||'')}">`
                    : `<div class="text-dim">내가 직접 맡아. 추가 정보는 없어.</div>`
              }
            </div>
          `;
          break;

        case 8: { // 최종 확인/비용 미리보기
          const selectedPurpose = materialsAsset.purposes[state.purpose];
          const selectedStyle = materialsAsset.styles[state.style];
          const selectedMaterialsInfo = state.materials.map(id => ({ id, ...materialsAsset.materials[id] }));

          let buyoutCost = 0;
          const DUMMY_REQUIRED_QTY_PER_AREA = 10; // 예시 수량
          const materialsSummary = [];

          selectedMaterialsInfo.forEach(material => {
            const requiredQty = state.totalArea * DUMMY_REQUIRED_QTY_PER_AREA;
            const userMaterial = userItems.find(i => i.id === material.id || i.itemId === material.id);
            const possessed = userMaterial ? (userMaterial.quantity || userMaterial.count || 0) : 0;
            const missingQty = Math.max(0, requiredQty - possessed);

            if (missingQty > 0) {
              const price = material.basePrice || 1;
              buyoutCost += missingQty * price * 2.5; // 긴급 구매 2.5배
            }
            materialsSummary.push(`<li>${esc(material.name)} ${requiredQty}개 (보유: ${possessed})${missingQty>0?` - <b style="color:#f59e0b;">${missingQty}개 구매</b>`:''}</li>`);
          });

          state.totalCost = Math.ceil(buyoutCost);
          const zonesSum8 = (state.zones||[]).reduce((a,b)=>a+Number(b.areaM2||0),0);

          contentHtml = `
            <h2>새 건물 설계 - 최종 확인</h2>
            <ul>
              <li><strong>이름:</strong> ${esc(state.name)}</li>
              <li><strong>유형:</strong> ${esc(selectedPurpose?.name || state.purpose)}</li>
              <li><strong>양식:</strong> ${esc(selectedStyle?.name || state.style)}</li>
              <li><strong>규모:</strong> ${esc(state.scale)}</li>
              <li><strong>높이:</strong> ${state.heightM} m</li>
              <li><strong>총면적:</strong> ${state.totalArea} m²</li>
              <li><strong>구역 합계:</strong> ${zonesSum8} m²</li>
            </ul>
            <div class="kv-card" style="margin-top:8px;">
              <div class="kv-label">필요 자재</div>
              <ul style="padding-left:20px; margin:0; font-size:13px;">${materialsSummary.join('')}</ul>
              <hr style="margin:12px 0; border-color:#2a2f36;">
              <div class="row" style="justify-content:space-between;">
                <span>자재 구매 비용:</span>
                <b style="color:#f59e0b;">🪙 ${state.totalCost.toLocaleString()} G</b>
              </div>
            </div>
          `;
          break;
        }
      }

      back.innerHTML = `
        <div class="modal-card col" style="gap: 16px; max-width: 760px; width: 92vw;">
          ${contentHtml}
          <div class="row" style="justify-content: space-between; margin-top: 16px;">
            <button class="btn ghost" id="prev-step" ${state.step === 1 ? 'disabled' : ''}>이전</button>
            <div>
              <button class="btn ghost" id="cancel-build">취소</button>
              <button class="btn primary" id="next-step">${state.step === 8 ? '건설 시작' : '다음'}</button>
            </div>
          </div>
        </div>
      `;
      attachModalEvents();
    };

    const attachModalEvents = () => {
      // 닫기
      const cancelBtn = back.querySelector('#cancel-build');
      if (cancelBtn) cancelBtn.addEventListener('click', () => closeModal(null));

      // 이전
      const prevStepBtn = back.querySelector('#prev-step');
      if (prevStepBtn) prevStepBtn.addEventListener('click', () => { if (state.step > 1) { state.step--; render(); } });

      // 다음/건설 시작
      const nextStepBtn = back.querySelector('#next-step');
      if (nextStepBtn) {
        nextStepBtn.addEventListener('click', async () => {
          switch (state.step) {
            case 1:
              if (!state.name.trim()) { showToast('건물 이름을 입력해줘.', 'error'); return; }
              break;

            case 2:
              if (!state.purpose) { showToast('건물 유형을 선택해줘.', 'error'); return; }
              break;

            case 3:
              if (!state.style) { showToast('건축 양식을 선택해줘.', 'error'); return; }
              break;

            case 4: {
              const ta = Number(back.querySelector('#building-totalarea')?.value || 0);
              const hm = Number(back.querySelector('#building-height')?.value || 0);
              const sc = String(back.querySelector('#building-scale')?.value || 'small');
              if (!Number.isFinite(ta) || ta<=0) { showToast('총면적을 올바르게 입력해줘.', 'error'); return; }
              if (ta > availableArea) { showToast(`남은 면적(${availableArea}m²)을 넘을 수 없어.`, 'error'); return; }
              if (!Number.isFinite(hm) || hm<5 || hm>1000) { showToast('높이는 5~1000m 사이로 입력해줘.', 'error'); return; }
              state.totalArea = ta;
              state.heightM = hm;
              state.scale = sc;
              if (!state.zones.length) state.zones = [{ name:'본관', purpose: state.purpose, areaM2: ta }];
              break;
            }

            case 5: {
              const sum = (state.zones||[]).reduce((a,b)=>a+Number(b.areaM2||0),0);
              if (sum !== Number(state.totalArea)) {
                showToast(`구역 면적 합계(${sum})가 총면적(${state.totalArea})과 같아야 해.`, 'error'); 
                return;
              }
              break;
            }

            case 6:
              if (state.materials.length === 0) { showToast('주 자재를 하나 이상 선택해줘.', 'error'); return; }
              break;

            case 7:
              if (state.contractor.type==='player' || state.contractor.type==='company') {
                if (!state.contractor.id || !String(state.contractor.id).trim()) { showToast('ID를 입력해줘.', 'error'); return; }
              }
              if (state.contractor.type==='npc') {
                const lv = Number(back.querySelector('#npc-level')?.value || state.contractor.level || 1);
                state.contractor.level = Math.max(1, Math.min(100, lv));
              }
              break;

            case 8: {
              // 최종 제출
              const payload = {
                plotId: plotDocId,
                design: {
                  name: state.name,
                  type: state.purpose,
                  style: state.style,
                  scale: state.scale,
                  heightM: Number(state.heightM||0),
                  totalArea: Number(state.totalArea||0),
                  zones: (state.zones||[]).map(z=>({
                    name: String(z.name||'').trim()||'구역',
                    purpose: z.purpose || state.purpose,
                    areaM2: Number(z.areaM2||0)
                  })),
                  materials: {
                    main: state.materials[0] || null,
                    secondary: state.materials[1] || null,
                    special: state.materials.slice(2)
                  }
                },
                contractor: { ...state.contractor },
                allowMaterialBuyout: true
              };

              try {
                const result = await startConstruction(payload);
                const ok = !!(result && (result.success || result.ok));
                if (ok) {
                  showToast('새로운 건물 건설을 시작했어!', 'success');
                  closeModal(result);
                } else {
                  showToast(result?.error || '건설 시작에 실패했어.', 'error');
                }
              } catch (err) {
                showToast(err?.message || '알 수 없는 오류로 건설에 실패했어.', 'error');
              }
              return;
            }
          }
          if (state.step < 8) { state.step++; render(); }
        });
      }

      // 단계별 입력 리스너
      switch (state.step) {
        case 1:
          back.querySelector('#building-name')
            ?.addEventListener('input', e => { state.name = e.target.value; });
          break;

        case 2:
          back.querySelectorAll('input[name="building-purpose"]')
            .forEach(r => r.addEventListener('change', e => { state.purpose = e.target.value; }));
          break;

        case 3:
          back.querySelectorAll('input[name="architectural-style"]')
            .forEach(r => r.addEventListener('change', e => { state.style = e.target.value; }));
          break;

        case 4:
          back.querySelector('#building-scale')
            ?.addEventListener('change', e => { state.scale = e.target.value; });
          back.querySelector('#building-height')
            ?.addEventListener('input', e => { state.heightM = Number(e.target.value||0); });
          back.querySelector('#building-totalarea')
            ?.addEventListener('input', e => { 
              const v = Math.max(1, Math.min(availableArea, Number(e.target.value||0)));
              state.totalArea = v;
              e.target.value = v;
            });
          break;

        case 5: {
          const tbody = back.querySelector('#zones-tbody');
          const recalc = () => {
            const rows = [...tbody.querySelectorAll('tr')];
            state.zones = rows.map(tr => ({
              name: tr.querySelector('.z-name')?.value || '',
              purpose: tr.querySelector('.z-purpose')?.value || state.purpose,
              areaM2: Number(tr.querySelector('.z-area')?.value || 0)
            }));
            const sum = state.zones.reduce((a,b)=>a+Number(b.areaM2||0),0);
            const sumEl = back.querySelector('#zones-sum');
            if (sumEl) sumEl.textContent = String(sum);
          };
          tbody?.addEventListener('input', recalc);
          tbody?.addEventListener('change', recalc);
          tbody?.addEventListener('click', e=>{
            const del = e.target.closest('.z-del');
            if (!del) return;
            const tr = del.closest('tr');
            tr?.remove();
            recalc();
          });
          back.querySelector('#z-add')?.addEventListener('click', ()=>{
            const tr = document.createElement('tr');
            tr.innerHTML = `
              <td><input type="text" class="z-name" placeholder="신규 구역"></td>
              <td>
                <select class="z-purpose">
                  ${Object.entries(materialsAsset.purposes).map(([id,p]) =>
                    `<option value="${id}">${esc(p.name)}</option>`).join('')}
                </select>
              </td>
              <td style="width:120px"><input type="number" class="z-area" min="1" value="1"></td>
              <td style="width:40px"><button class="btn small ghost z-del">-</button></td>
            `;
            tbody?.appendChild(tr);
            recalc();
          });
          // 초기 합계 계산
          recalc();
          break;
        }

        case 6:
          back.querySelectorAll('input[name="building-material"]').forEach(c =>
            c.addEventListener('change', e => {
              if (e.target.checked) {
                if (!state.materials.includes(e.target.value)) state.materials.push(e.target.value);
              } else {
                state.materials = state.materials.filter(m => m !== e.target.value);
              }
            }));
          break;

        case 7: {
          // 탭 전환
          back.querySelectorAll('[data-ct]').forEach(btn=>{
            btn.addEventListener('click', ()=>{
              state.contractor.type = btn.dataset.ct;
              // 정리
              if (state.contractor.type==='npc') { state.contractor.level = state.contractor.level||1; state.contractor.id = null; }
              else if (state.contractor.type==='self') { state.contractor.id = null; }
              render();
            });
          });
          // 각 타입별 입력
          const lvl = back.querySelector('#npc-level');
          if (lvl) {
            const lbl = back.querySelector('#npc-level-val');
            lvl.addEventListener('input', e=>{ state.contractor.level = Number(e.target.value||1); if(lbl) lbl.textContent = state.contractor.level; });
          }
          const puid = back.querySelector('#player-uid');
          if (puid) puid.addEventListener('input', e=>{ state.contractor.id = e.target.value; });
          const cid = back.querySelector('#company-id');
          if (cid) cid.addEventListener('input', e=>{ state.contractor.id = e.target.value; });
          break;
        }
      }
    };

    document.body.appendChild(back);
    render();
  });
}

/* ------------------------------
 * 캐릭터 선택 모달
 * ------------------------------ */
async function openCharacterPickerModal(characters) {
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
                원예 ${skills.gardening?.level||0} | 건설 ${skills.construction?.level||0} | ...
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

/* ------------------------------
 * 메인 렌더링
 * ------------------------------ */
function render(root, plotInfo, plotData, characters, plotDocId) {
  const totalArea = plotData.totalArea || 10000;
  const usedArea = plotData.usedArea || 0;
  const availableArea = Math.max(0, totalArea - usedArea);
  const facilities = Array.isArray(plotData.facilities) ? plotData.facilities : [];

  const facilityCardsHtml = facilities.map(fac => {
    const assignedChar = characters.find(c => c.id === fac.assignedCharId);
    const isBuilding = fac.type === 'building';
    const areaTxt = (fac.area || fac.totalArea || 'N/A');
    const heightTxt = (fac.height || fac.heightM || 'N/A');

    const cardContent = isBuilding ? `
      <div class="row" style="justify-content:space-between">
        <b>${esc(fac.name || '건물')} (건물)</b>
        <span>${areaTxt}m² / ${heightTxt}m</span>
      </div>
      <div class="text-dim" style="font-size:12px;">스타일: ${esc(fac.style || '-')} | 안전도: ${esc(fac.safetyLevel || '-')}</div>
      <div class="kv-card" style="margin-top:8px; padding:8px;">
        담당: ${assignedChar ? `${esc(assignedChar.name)} (건설 Lv.${assignedChar.skills?.construction?.level || 0})` : '없음'}
      </div>
    ` : `
      <div class="row" style="justify-content:space-between">
        <b>${esc(fac.name || '농지')} (농지)</b>
        <span>${areaTxt}m²</span>
      </div>
      <div class="kv-card" style="margin-top:8px; padding:8px;">
        담당: ${assignedChar ? `${esc(assignedChar.name)} (원예 Lv.${assignedChar.skills?.gardening?.level || 0})` : '없음'}
      </div>
    `;

    return `
      <div class="kv-card">
        ${cardContent}
        <div class="row" style="justify-content:flex-end; gap:8px; margin-top:8px;">
          <button class="btn small" data-facility-id="${fac.id}" data-action="assign-char">캐릭터 배치</button>
          <button class="btn small" data-facility-id="${fac.id}" data-action="manage-${fac.type}">관리</button>
        </div>
      </div>
    `;
  }).join('');

  root.innerHTML = `
    <section class="container narrow">
      <div class="card p12">
        <div class="row" style="justify-content:space-between">
          <h3 style="margin-top:0">토지 관리 (${plotInfo.x},${plotInfo.y}) - (${plotInfo.microX},${plotInfo.microY})</h3>
          <a href="#/worldmap" class="btn ghost">월드맵</a>
        </div>
        
        <div class="kv-card" style="margin-top:12px;">
          <div class="kv-label">토지 현황</div>
          <div>총 면적: ${totalArea.toLocaleString()}m²</div>
          <div>사용된 면적: ${usedArea.toLocaleString()}m²</div>
          <div style="font-weight:bold; color: #a3e635;">남은 면적: ${availableArea.toLocaleString()}m²</div>
        </div>

        <div class="row" style="gap:8px; margin-top:12px;">
          <button id="btn-new-building" class="btn primary">새 건물 건설</button>
          <button id="btn-new-farmland" class="btn">새 밭 경작</button>
        </div>

        <div id="facilities-list" class="col" style="gap:12px; margin-top:16px;">
          ${facilityCardsHtml || '<div class="text-dim kv-card">아직 건설된 시설이 없습니다.</div>'}
        </div>
      </div>
    </section>
  `;
  attachEvents(root, plotInfo, plotDocId, availableArea, characters);
}

/* ------------------------------
 * 이벤트 바인딩
 * ------------------------------ */
function attachEvents(root, plotInfo, plotDocId, availableArea, characters) {
  // 새 건물
  root.querySelector('#btn-new-building').onclick = async () => {
    const userDoc = await fx.getDoc(fx.doc(db, 'users', auth.currentUser.uid));
    const userData = userDoc.data() || {};
    const userItems = userData.items_all || [];

    let materials, purposes, stylesArray;
    try {
      [materials, purposes, stylesArray] = await Promise.all([
        fetch('/assets/building_materials.json').then(res => res.json()),
        fetch('/assets/building_purposes.json').then(res => res.json()),
        fetch('/assets/architectural_styles.json').then(res => res.json())
      ]);
    } catch (err) {
      console.error("Failed to fetch building assets:", err);
      showToast('건축 데이터를 불러오는 데 실패했어.', 'error');
      return;
    }
    if (!materials || !purposes || !stylesArray) { showToast('건축 데이터가 비어 있어.', 'error'); return; }

    const styles = stylesArray.reduce((acc, style) => { acc[style.id] = style; return acc; }, {});
    const materialsAsset = { materials, purposes, styles };

    await openCustomConstructionModal(characters, userItems, availableArea, materialsAsset, plotDocId);
  };

  // 새 밭
  root.querySelector('#btn-new-farmland').onclick = async () => {
    const name = await promptModal({ title: '새로운 농지의 이름을 입력하세요.', placeholder: '나의 텃밭' });
    if (!name) return;

    const areaStr = await promptModal({ title: `경작할 면적을 입력하세요 (최대: ${availableArea}m²)`, placeholder: `최대 ${availableArea}` });
    if (!areaStr) return;

    const area = parseInt(areaStr, 10);
    if (isNaN(area) || area <= 0 || area > availableArea) {
      showToast('올바른 면적을 입력해줘.', 'error');
      return;
    }

    try {
      await createFarmland({ plotId: plotDocId, name, area });
      showToast(`'${name}' 농지가 생성되었어.`, 'success');
    } catch (e) {
      showToast(`농지 생성 실패: ${e.message}`, 'error');
    }
  };

  // 캐릭터 배치
  root.querySelectorAll('[data-action="assign-char"]').forEach(btn => {
    btn.onclick = async () => {
      const facilityId = btn.dataset.facilityId;
      const selectedChar = await openCharacterPickerModal(characters);
      if (selectedChar === undefined) return; // 닫기
      try {
        await assignCharacterToFacility({ plotId: plotDocId, facilityId, charId: selectedChar ? selectedChar.id : null });
        showToast('캐릭터 배치가 완료되었어.', 'success');
      } catch (e) {
        showToast(`배치 실패: ${e.message}`, 'error');
      }
    };
  });

  // 관리 버튼 (스텁: 필요 시 모달로 확장)
  root.querySelectorAll('[data-action^="manage-"]').forEach(btn => {
    btn.onclick = async () => {
      showToast('관리 기능은 곧 추가될 예정이야. (inspect/repair/expand 등)', 'info');
    };
  });
}

/* ------------------------------
 * 엔트리
 * ------------------------------ */
export async function showLandManagement() {
  const root = document.getElementById('view');
  const plotInfo = parseLandPlotInfo();

  if (!auth.currentUser || !plotInfo) {
    root.innerHTML = `<section class="container narrow"><div class="kv-card">잘못된 접근이야.</div></section>`;
    return;
  }

  root.innerHTML = `<section class="container narrow"><div class="spin-center"></div></section>`;
  
  try {
    const plotDocId = `${plotInfo.mapId}_${plotInfo.x}_${plotInfo.y}_${plotInfo.microX}_${plotInfo.microY}`;
    const plotRef = fx.doc(db, 'land_plots', plotDocId);

    const unsub = fx.onSnapshot(plotRef, async (plotSnap) => {
      const plotData = plotSnap.exists() ? plotSnap.data() : { totalArea: 10000, usedArea: 0, facilities: [] };
      if (!root.characters) {
        root.characters = await getUserCharacters() || [];
      }
      render(root, plotInfo, plotData, root.characters, plotDocId);
    }, (error) => {
      console.error("토지 정보 실시간 수신 실패:", error);
      root.innerHTML = `<section class="container narrow"><div class="kv-card error">데이터를 불러오는 데 실패했어.</div></section>`;
    });
    
    root.closest('#view').__cleanup = () => {
      if (root.characters) delete root.characters;
      unsub();
    };

  } catch (error) {
    console.error("초기 데이터 로딩 실패:", error);
    root.innerHTML = `<section class="container narrow"><div class="kv-card error">오류: ${esc(error.message)}</div></section>`;
  }
}
