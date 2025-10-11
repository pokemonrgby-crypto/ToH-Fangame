// /public/js/ui/construction_wizard.js

import { showToast } from './toast.js';
import { ensureModalCss } from './modal.js';
import { startConstruction } from '../api/real_estate.js';

// 유틸리티 함수
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/**
 * 새 건물 설계를 위한 8단계 모달을 엽니다.
 * @param {Array} characters - 현재 유저의 캐릭터 목록
 * @param {Array} userItems - 유저가 보유한 아이템 목록 (materials)
 * @param {number} availableArea - 건설 가능한 남은 토지 면적 (m²)
 * @param {object} assets - 건축 관련 데이터 (materials, purposes, styles, rooms)
 * @param {string} plotDocId - 현재 토지의 문서 ID
 * @returns {Promise<object|null>} 건설 시작 결과 또는 null(취소)
 */
export async function openCustomConstructionModal(characters, userItems, availableArea, assets, plotDocId) {
  ensureModalCss();
  return new Promise(resolve => {
    const back = document.createElement('div');
    back.className = 'modal-back';

    const roomListForType = (type) => {
      const rooms = assets.rooms || {};
      const entries = Object.entries(rooms);
      return entries.filter(([rid, r]) => !Array.isArray(r.forTypes) || r.forTypes.length === 0 || r.forTypes.includes(type));
    };

    let state = {
      step: 1,
      name: '',
      purpose: null,
      style: null,
      floors: 1,
      heightM: 5,
      baseAreaM2: 10,
      replicateLayout: false,
      zones: [],
      primaryMaterials: [],
      secondaryMaterials: [],
      totalCost: 0,
      contractorType: 'characters',
      contractorId: null,
      npcTeam: [{ level: 1, count: 1 }],
      selectedCharIds: []
    };

    const closeModal = (val = null) => {
      try { document.body.removeChild(back); } catch {}
      resolve(val);
    };

    const render = () => {
      let contentHtml = '';

      const step1 = () => `
        <h2>새 건물 설계 - 1단계: 이름</h2>
        <p>건물의 이름을 입력해줘.</p>
        <input type="text" id="building-name" value="${esc(state.name)}" placeholder="예: 대장간, 연금술사의 탑">
      `;

      const step2 = () => `
        <h2>새 건물 설계 - 2단계: 유형</h2>
        <p>건물의 주된 유형을 선택해줘.</p>
        <div class="radio-grid">
          ${Object.entries(assets.purposes).map(([id, p]) => `
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

      const step3 = () => `
        <h2>새 건물 설계 - 3단계: 건축 양식</h2>
        <p>건물의 건축 양식을 선택해줘.</p>
        <div class="radio-grid">
          ${Object.values(assets.styles).map(s => `
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

      const step4 = () => `
        <h2>새 건물 설계 - 4단계: 층수 · 높이 · 한 층의 면적</h2>
        <div class="grid2" style="gap:12px;">
            <div class="kv-card">
                <div class="kv-label">층수 (1~200)</div>
                <input type="number" id="building-floors" min="1" max="200" value="${state.floors}">
            </div>
            <div class="kv-card">
                <div class="kv-label">높이 (5~1000 m)</div>
                <input type="number" id="building-height" min="5" max="1000" value="${state.heightM}">
            </div>
        </div>
        <div class="kv-card" style="margin-top:8px;">
            <div class="kv-label">한 층의 면적 (m²) — 남은 면적: ${availableArea.toLocaleString()}m²</div>
            <input type="number" id="building-basearea" min="1" max="${availableArea}" value="${state.baseAreaM2}">
        </div>
      `;

      const step5 = () => {
        const rows = (state.zones.length
          ? state.zones
          : [{ name:'본관', purpose: state.purpose || Object.keys(assets.purposes)[0], roomId:'', areaM2: state.baseAreaM2 }]);

        const roomOptions = roomListForType(state.purpose);

        const tr = (z, idx) => `
          <tr data-idx="${idx}">
            <td><input type="text" class="z-name" value="${esc(z.name||'')}" placeholder="예: 주방, 안방, 창고"></td>
            <td>
              <select class="z-purpose">
                ${Object.entries(assets.purposes).map(([id,p]) =>
                  `<option value="${id}" ${z.purpose===id?'selected':''}>${esc(p.name)}</option>`).join('')}
              </select>
            </td>
            <td>
              <select class="z-room">
                <option value="">(방 지정 안 함)</option>
                ${roomOptions.map(([rid, r]) =>
                  `<option value="${rid}" ${z.roomId===rid?'selected':''}>${esc(r.label)}</option>`).join('')}
              </select>
            </td>
            <td style="width:120px"><input type="number" class="z-area" min="1" value="${Number(z.areaM2||0)}"></td>
            <td style="width:40px"><button class="btn small ghost z-del">-</button></td>
          </tr>
        `;

        const zonesSum = rows.reduce((a,b)=>a+Number(b.areaM2||0),0);

        return `
          <h2>새 건물 설계 - 5단계: 구역 분할</h2>
          <p>한 층의 면적을 구역으로 나눠줘. 합계는 한 층의 면적(${state.baseAreaM2}m²)과 같아야 해.</p>
          <div class="kv-card">
            <table class="kv-table">
              <thead><tr><th>구역명</th><th>용도</th><th>방</th><th>면적(m²)</th><th></th></tr></thead>
              <tbody id="zones-tbody">${rows.map(tr).join('')}</tbody>
            </table>
            <div class="row" style="gap:8px; margin-top:8px;">
              <button class="btn small" id="z-add">+ 구역 추가</button>
              <div class="text-dim">합계: <b id="zones-sum">${zonesSum}</b> / ${state.baseAreaM2} m²</div>
            </div>
          </div>
          <div class="row" style="margin-top: 12px;">
            <input type="checkbox" id="replicate-layout" ${state.replicateLayout ? 'checked' : ''}>
            <label for="replicate-layout">1층의 구역 구성을 모든 층에 동일하게 적용</label>
          </div>
        `;
      };

      const step6 = () => {
        const materialEntries = Object.entries(assets.materials);
        const mainMaterials = materialEntries.filter(([id, m]) => m.type === 'main');
        const subMaterials = materialEntries.filter(([id, m]) => m.type === 'sub');

        const materialCheckbox = (id, m, isMain) => {
            const userMaterial = userItems.find(i => i.id === id || i.itemId === id);
            const possessed = userMaterial ? (userMaterial.quantity || userMaterial.count || 0) : 0;
            const needsPurchase = possessed === 0;
            return `
              <label>
                <input type="checkbox" name="building-material-${isMain ? 'main' : 'sub'}" value="${id}" ${ (isMain ? state.primaryMaterials : state.secondaryMaterials).includes(id) ? 'checked' : ''}>
                <div>
                  <span>${esc(m.name)} (보유: ${possessed})</span>
                  <small>${esc(m.description || '')}</small>
                  ${needsPurchase ? `<small style="color:#f59e0b; font-weight:bold; margin-top:4px;">※ 보유량이 없어 구매가 필요해.</small>` : ''}
                </div>
              </label>
            `;
        };

        return `
          <h2>새 건물 설계 - 6단계: 자재 선택</h2>
          <div class="kv-card" style="margin-bottom: 12px;">
            <p style="margin-top:0"><b>주 자재 (최대 4개 선택)</b></p>
            <div class="checkbox-grid">
              ${mainMaterials.map(([id, m]) => materialCheckbox(id, m, true)).join('')}
            </div>
          </div>
          <div class="kv-card">
            <p style="margin-top:0"><b>부자재 (선택)</b></p>
            <div class="checkbox-grid">
              ${subMaterials.map(([id, m]) => materialCheckbox(id, m, false)).join('')}
            </div>
          </div>
        `;
      };

      const step7 = () => {
        const tabBtn = (key, label) => `<button class="btn small ${state.contractorType===key?'primary':''}" data-ct="${key}">${label}</button>`;
        const npcRows = state.npcTeam.map((m, i) => `
          <tr data-n="${i}">
            <td style="width:130px"><input type="number" class="npc-lv" min="1" max="100" value="${m.level}"></td>
            <td style="width:130px"><input type="number" class="npc-cnt" min="1" max="50" value="${m.count}"></td>
            <td style="width:40px"><button class="btn small ghost npc-del">-</button></td>
          </tr>
        `).join('');

        const charsList = (characters||[]).map(ch => `
          <label class="row" style="gap:8px; align-items:center;">
            <input type="checkbox" class="ct-char" value="${ch.id}" ${state.selectedCharIds.includes(ch.id)?'checked':''}>
            <div class="row" style="gap:8px; align-items:center;">
              <img src="${ch.thumb_url || ch.image_url || ''}" onerror="this.style.display='none'" style="width:28px;height:28px;border-radius:4px;object-fit:cover;">
              <span>${esc(ch.name)}</span>
              <small class="text-dim">건설 ${ch.skills?.construction?.level||0} · 미술 ${ch.skills?.art?.level||0}</small>
            </div>
          </label>
        `).join('');

        const pane =
          state.contractorType==='npc_team' ? `
            <div class="kv-label">NPC 팀 구성 (레벨, 인원수)</div>
            <table class="kv-table">
              <thead><tr><th>레벨</th><th>명수</th><th></th></tr></thead>
              <tbody id="npc-tbody">${npcRows || ''}</tbody>
            </table>
            <button class="btn small" id="npc-add" style="margin-top:8px;">+ 인원 추가</button>
            <small class="text-dim" style="display:block; margin-top:6px;">레벨·인원에 따라 비용이 지수적으로 증가해.</small>
          `
          : state.contractorType==='characters' ? `
            <div class="kv-label">참여할 내 캐릭터 선택</div>
            <div class="col" style="gap:8px; max-height:240px; overflow:auto;">${charsList || '<div class="text-dim">선택할 수 있는 캐릭터가 없어.</div>'}</div>
            <small class="text-dim" style="display:block; margin-top:6px;">캐릭터는 동시에 하나의 작업만 수행할 수 있어.</small>
          `
          : state.contractorType==='player' ? `
            <div class="kv-label">타인 캐릭터 UID</div>
            <input type="text" id="player-uid" value="${esc(state.contractorId||'')}">
            <small class="text-dim" style="display:block; margin-top:6px;">타인 캐릭터 고용은 퀘스트를 통해 진행됩니다. 여기서는 건설을 위탁할 캐릭터의 UID를 입력하세요.</small>
          `
          : state.contractorType==='company' ? `
            <div class="kv-label">건설사 ID</div>
            <input type="text" id="company-id" value="${esc(state.contractorId||'')}">
          `
          : `<div class="text-dim">알 수 없는 시공사 유형입니다.</div>`;

        return `
          <h2>새 건물 설계 - 7단계: 시공사/인원 선택</h2>
          <div class="tabs row" style="gap:8px; margin-bottom:8px;">
            ${tabBtn('characters','내 캐릭터')}
            ${tabBtn('player','타인 캐릭터')}
            ${tabBtn('company','건설사')}
            ${tabBtn('npc_team','NPC 팀')}
          </div>
          <div id="contractor-pane" class="kv-card">${pane}</div>
        `;
      };
      
      const step8 = () => {
        const selectedPurpose = assets.purposes[state.purpose];
        const selectedStyle = assets.styles[state.style];
        const selectedMaterialsInfo = [...state.primaryMaterials, ...state.secondaryMaterials].map(id => ({ id, ...assets.materials[id] }));

        let buyoutCost = 0;
        const DUMMY_REQUIRED_QTY_PER_AREA = 10;
        const materialsSummary = [];
        const totalArea = state.baseAreaM2 * state.floors;

        selectedMaterialsInfo.forEach(material => {
          const requiredQty = totalArea * DUMMY_REQUIRED_QTY_PER_AREA;
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
        const zonesSum = (state.zones||[]).reduce((a,b)=>a+Number(b.areaM2||0),0);

        return `
          <h2>새 건물 설계 - 최종 확인</h2>
          <ul>
            <li><strong>이름:</strong> ${esc(state.name)}</li>
            <li><strong>유형:</strong> ${esc(selectedPurpose?.name || state.purpose)}</li>
            <li><strong>양식:</strong> ${esc(selectedStyle?.name || state.style)}</li>
            <li><strong>층수:</strong> ${state.floors} 층</li>
            <li><strong>높이:</strong> ${state.heightM} m</li>
            <li><strong>한 층 면적:</strong> ${state.baseAreaM2} m² (총 ${totalArea} m²)</li>
            <li><strong>구역 합계:</strong> ${zonesSum} m²</li>
          </ul>
          <div class="kv-card" style="margin-top:8px;">
            <div class="kv-label">필요 자재</div>
            <ul style="padding-left:20px; margin:0; font-size:13px;">${materialsSummary.join('')}</ul>
            <hr style="margin:12px 0; border-color:#2a2f36;">
            <div class="row" style="justify-content:space-between;">
              <span>자재 구매 비용(예상):</span>
              <b style="color:#f59e0b;">🪙 ${state.totalCost.toLocaleString()} G</b>
            </div>
          </div>
        `;
      };

      switch (state.step) {
        case 1: contentHtml = step1(); break;
        case 2: contentHtml = step2(); break;
        case 3: contentHtml = step3(); break;
        case 4: contentHtml = step4(); break;
        case 5: contentHtml = step5(); break;
        case 6: contentHtml = step6(); break;
        case 7: contentHtml = step7(); break;
        case 8: contentHtml = step8(); break;
      }

      back.innerHTML = `
        <div class="modal-card col" style="gap: 16px; max-width: 820px; width: 92vw;">
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
      back.querySelector('#cancel-build')?.addEventListener('click', () => closeModal(null));
      back.querySelector('#prev-step')?.addEventListener('click', () => { if (state.step > 1) { state.step--; render(); } });

      back.querySelector('#next-step')?.addEventListener('click', async () => {
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
            const ba = Number(back.querySelector('#building-basearea')?.value || 0);
            const hm = Number(back.querySelector('#building-height')?.value || 0);
            const fl = Number(back.querySelector('#building-floors')?.value || 0);
            if (!Number.isFinite(ba) || ba<=0) { showToast('한 층의 면적을 올바르게 입력해줘.', 'error'); return; }
            if (ba > availableArea) { showToast(`남은 면적(${availableArea}m²)을 넘을 수 없어.`, 'error'); return; }
            if (!Number.isFinite(hm) || hm<5 || hm>1000) { showToast('높이는 5~1000m 사이로 입력해줘.', 'error'); return; }
            if (!Number.isFinite(fl) || fl<1 || fl>200) { showToast('층수는 1~200층 사이로 입력해줘.', 'error'); return; }
            state.baseAreaM2 = ba;
            state.heightM = hm;
            state.floors = fl;
            if (!state.zones.length) state.zones = [{ name:'본관', purpose: state.purpose, roomId:'', areaM2: ba }];
            break;
          }
          case 5: {
            const sum = (state.zones||[]).reduce((a,b)=>a+Number(b.areaM2||0),0);
            if (sum !== Number(state.baseAreaM2)) {
              showToast(`구역 면적 합계(${sum})가 한 층의 면적(${state.baseAreaM2})과 같아야 해.`, 'error'); 
              return;
            }
            break;
          }
          case 6:
            if (state.primaryMaterials.length === 0) { showToast('주 자재를 하나 이상 선택해줘.', 'error'); return; }
            if (state.primaryMaterials.length > 4) { showToast('주 자재는 최대 4개까지만 선택할 수 있어.', 'error'); return; }
            break;
          case 7:
            if (state.contractorType==='player' || state.contractorType==='company') {
              if (!state.contractorId || !String(state.contractorId).trim()) { showToast('ID를 입력해줘.', 'error'); return; }
            }
            if (state.contractorType==='npc_team') {
              const valid = Array.isArray(state.npcTeam) && state.npcTeam.length > 0 && state.npcTeam.every(m => Number(m.level)>=1 && Number(m.count)>=1);
              if (!valid) { showToast('NPC 팀의 레벨/명수를 올바르게 입력해줘.', 'error'); return; }
            }
            if (state.contractorType==='characters') {
              if (!state.selectedCharIds.length) { showToast('참여할 캐릭터를 선택해줘.', 'error'); return; }
            }
            break;
          case 8: {
            let contractor;
            if (state.contractorType === 'npc_team') {
              contractor = { type: 'npc_team', npcTeam: state.npcTeam.map(m => ({ level: Number(m.level), count: Number(m.count) })) };
            } else if (state.contractorType === 'characters') {
              contractor = { type: 'characters', charIds: state.selectedCharIds.slice(0, 8) };
            } else if (state.contractorType === 'player' || state.contractorType === 'company') {
              contractor = { type: state.contractorType, id: state.contractorId || null };
            } else {
              contractor = { type: 'self' };
            }

            const payload = {
              plotId: plotDocId,
              design: {
                name: state.name,
                type: state.purpose,
                style: state.style,
                floors: Number(state.floors || 1),
                heightM: Number(state.heightM || 0),
                baseAreaM2: Number(state.baseAreaM2 || 0),
                totalAreaM2: Number(state.baseAreaM2 || 0) * Number(state.floors || 1),
                replicateLayout: state.replicateLayout,
                zones: (state.zones||[]).map(z=>({
                  name: String(z.name||'').trim()||'구역',
                  purpose: z.purpose || state.purpose,
                  roomId: z.roomId || '',
                  areaM2: Number(z.areaM2||0)
                })),
                materials: {
                  primary: state.primaryMaterials,
                  secondary: state.secondaryMaterials
                }
              },
              contractor,
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

      if (state.step === 1) {
        back.querySelector('#building-name')?.addEventListener('input', e => { state.name = e.target.value; });
      }
      if (state.step === 2) {
        back.querySelectorAll('input[name="building-purpose"]').forEach(r => r.addEventListener('change', e => { state.purpose = e.target.value; state.zones = state.zones.map(z => ({ ...z, roomId: '' })); }));
      }
      if (state.step === 3) {
        back.querySelectorAll('input[name="architectural-style"]').forEach(r => r.addEventListener('change', e => { state.style = e.target.value; }));
      }
      if (state.step === 4) {
        back.querySelector('#building-floors')?.addEventListener('input', e => { state.floors = Number(e.target.value||0); });
        back.querySelector('#building-height')?.addEventListener('input', e => { state.heightM = Number(e.target.value||0); });
        back.querySelector('#building-basearea')?.addEventListener('input', e => {
          const v = Math.max(1, Math.min(availableArea, Number(e.target.value||0)));
          state.baseAreaM2 = v; e.target.value = v;
        });
      }
      if (state.step === 5) {
        const tbody = back.querySelector('#zones-tbody');
        const recalc = () => {
          const rows = [...tbody.querySelectorAll('tr')];
          state.zones = rows.map(tr => ({ name: tr.querySelector('.z-name')?.value || '', purpose: tr.querySelector('.z-purpose')?.value || state.purpose, roomId: tr.querySelector('.z-room')?.value || '', areaM2: Number(tr.querySelector('.z-area')?.value || 0) }));
          const sum = state.zones.reduce((a,b)=>a+Number(b.areaM2||0),0);
          const sumEl = back.querySelector('#zones-sum');
          if (sumEl) sumEl.textContent = String(sum);
        };
        tbody?.addEventListener('input', recalc);
        tbody?.addEventListener('change', recalc);
        tbody?.addEventListener('click', e=>{ if (e.target.closest('.z-del')) { e.target.closest('tr')?.remove(); recalc(); } });
        back.querySelector('#z-add')?.addEventListener('click', ()=>{
          const roomOptions = roomListForType(state.purpose);
          const tr = document.createElement('tr');
          tr.innerHTML = `<td><input type="text" class="z-name" placeholder="신규 구역"></td><td><select class="z-purpose">${Object.entries(assets.purposes).map(([id,p]) => `<option value="${id}">${esc(p.name)}</option>`).join('')}</select></td><td><select class="z-room"><option value="">(방 지정 안 함)</option>${roomOptions.map(([rid, r]) => `<option value="${rid}">${esc(r.label)}</option>`).join('')}</select></td><td style="width:120px"><input type="number" class="z-area" min="1" value="1"></td><td style="width:40px"><button class="btn small ghost z-del">-</button></td>`;
          tbody?.appendChild(tr); recalc();
        });
        back.querySelector('#replicate-layout')?.addEventListener('change', e => { state.replicateLayout = e.target.checked; });
        recalc();
      }
      if (state.step === 6) {
        back.querySelectorAll('input[name="building-material-main"]').forEach(c => c.addEventListener('change', e => {
          if (e.target.checked) {
            if (state.primaryMaterials.length >= 4) { e.target.checked = false; showToast('주 자재는 최대 4개까지만 선택할 수 있습니다.', 'error'); return; }
            if (!state.primaryMaterials.includes(e.target.value)) state.primaryMaterials.push(e.target.value);
          } else { state.primaryMaterials = state.primaryMaterials.filter(m => m !== e.target.value); }
        }));
        back.querySelectorAll('input[name="building-material-sub"]').forEach(c => c.addEventListener('change', e => {
          if (e.target.checked) { if (!state.secondaryMaterials.includes(e.target.value)) state.secondaryMaterials.push(e.target.value); } 
          else { state.secondaryMaterials = state.secondaryMaterials.filter(m => m !== e.target.value); }
        }));
      }
      if (state.step === 7) {
        back.querySelectorAll('[data-ct]').forEach(btn=>{ btn.addEventListener('click', ()=>{ state.contractorType = btn.dataset.ct; if (state.contractorType==='npc_team' && (!state.npcTeam || !state.npcTeam.length)) state.npcTeam = [{level:1,count:1}]; if (state.contractorType!=='player' && state.contractorType!=='company') state.contractorId = null; render(); }); });
        const tbody = back.querySelector('#npc-tbody');
        if (tbody) {
          const sync = () => { state.npcTeam = [...tbody.querySelectorAll('tr')].map(tr => ({ level: Number(tr.querySelector('.npc-lv')?.value || 1), count: Number(tr.querySelector('.npc-cnt')?.value || 1) })).filter(m => m.level>=1 && m.count>=1); };
          tbody.addEventListener('input', sync); tbody.addEventListener('change', sync);
          tbody.addEventListener('click', e => { if (e.target.closest('.npc-del')) { e.target.closest('tr')?.remove(); sync(); }});
          back.querySelector('#npc-add')?.addEventListener('click', ()=>{ const tr = document.createElement('tr'); tr.innerHTML = `<td style="width:130px"><input type="number" class="npc-lv" min="1" max="100" value="1"></td><td style="width:130px"><input type="number" class="npc-cnt" min="1" max="50" value="1"></td><td style="width:40px"><button class="btn small ghost npc-del">-</button></td>`; tbody.appendChild(tr); sync(); });
        }
        back.querySelectorAll('.ct-char')?.forEach(cb=>{ cb.addEventListener('change', ()=>{ const id = cb.value; if (cb.checked) { if (!state.selectedCharIds.includes(id)) state.selectedCharIds.push(id); } else { state.selectedCharIds = state.selectedCharIds.filter(x => x !== id); } }); });
        back.querySelector('#player-uid')?.addEventListener('input', e=>{ state.contractorId = e.target.value; });
        back.querySelector('#company-id')?.addEventListener('input', e=>{ state.contractorId = e.target.value; });
      }
    };

    document.body.appendChild(back);
    render();
  });
}
