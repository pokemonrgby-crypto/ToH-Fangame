// /public/js/tabs/land_management.js (전체 교체)
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
async function openCustomConstructionModal(characters, userItems, availableArea, assets, plotDocId) {
  ensureModalCss();
  return new Promise(resolve => {
    const back = document.createElement('div');
    back.className = 'modal-back';

    // 방 카탈로그 헬퍼
    const roomListForType = (type) => {
      const rooms = assets.rooms || {};
      const entries = Object.entries(rooms);
      return entries.filter(([rid, r]) => !Array.isArray(r.forTypes) || r.forTypes.length === 0 || r.forTypes.includes(type));
    };

    let state = {
      step: 1,
      // 기본 정보
      name: '',
      purpose: null,      // building type (= server design.type)
      style: null,        // architectural style id
      // 층수/면적
      floors: 1,
      baseAreaM2: 10,
      totalAreaM2: 10,
      // 구역 분할
      zones: [],          // { name, purpose, roomId?, areaM2, items? }
      // 자재
      primaryMaterials: [],
      secondaryMaterials: [],
      totalCost: 0,
      // 시공사(서버 규격에 맞춤)
      contractorType: 'self',       // 'self' = 모집(퀘스트), 'player'|'company'|'npc_team'|'characters'
      contractorId: null,           // player/company일 때 사용
      npcTeam: [{ level: 1, count: 1 }], // npc_team 구성
      selectedCharIds: []           // characters 구성
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
        <h2>새 건물 설계 - 4단계: 층수 · 한 층 면적</h2>
        <div class="grid2" style="gap:12px;">
          <div class="kv-card">
            <div class="kv-label">층수 (기본 1~2층, 지식 보유 시 3층↑ 가능)</div>
            <input type="number" id="floors" min="1" value="${state.floors || 1}">
          </div>
          <div class="kv-card">
            <div class="kv-label">한 층 면적 (m²)</div>
            <input type="number" id="baseAreaM2" min="1" value="${state.baseAreaM2 || 10}">
          </div>
        </div>
        <div class="kv-card" style="margin-top:8px;">
            <div class="kv-label">부지 점유 면적 (1층 면적) — 남은 면적: ${availableArea.toLocaleString()}m²</div>
            <div><b id="baseAreaM2View">${(state.baseAreaM2||10).toLocaleString()}</b> m²</div>
        </div>
        <div class="kv-card" style="margin-top:8px;">
          <div class="kv-label">건물 총면적 (비용/자재 계산용)</div>
          <div><b id="totalAreaM2View">${((state.floors||1) * (state.baseAreaM2||10)).toLocaleString()}</b> m²</div>
        </div>
      `;

      const step5 = () => {
        const rows = (state.zones.length
          ? state.zones
          : [{ name:'본관', purpose: state.purpose || Object.keys(assets.purposes)[0], roomId:'', areaM2: state.totalAreaM2 }]);

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
          <p>총면적을 구역으로 나눠줘. 합계는 건물 총면적(${state.totalAreaM2}m²)과 같아야 해.</p>
          <div class="kv-card">
            <table class="kv-table">
              <thead><tr><th>구역명</th><th>용도</th><th>방</th><th>면적(m²)</th><th></th></tr></thead>
              <tbody id="zones-tbody">${rows.map(tr).join('')}</tbody>
            </table>
            <div class="row" style="gap:8px; margin-top:8px;">
              <button class="btn small" id="z-add">+ 구역 추가</button>
              <div class="text-dim">합계: <b id="zones-sum">${zonesSum}</b> / ${state.totalAreaM2} m²</div>
            </div>
          </div>
        `;
      };

      const step6 = () => {
        const entries = Object.entries(assets.materials);
        const isPrimary = id => (state.primaryMaterials || []).includes(id);
        const isSecondary = id => (state.secondaryMaterials || []).includes(id);

        const matCard = ([id, m]) => {
          const userMaterial = userItems.find(i => i.id === id || i.itemId === id);
          const have = userMaterial ? (userMaterial.quantity || userMaterial.count || 0) : 0;
          return `
            <label class="mat-tile" data-id="${id}">
              <div class="row" style="justify-content:space-between;">
                <b>${esc(m.name)}</b><small class="text-dim">보유 ${have}</small>
              </div>
              <small class="text-dim">${esc(m.description || '')}</small>
              <div class="row" style="gap:6px; margin-top:6px;">
                <button class="btn tiny ghost btn-primary ${isPrimary(id)?'active':''}" data-p="${id}">주재료</button>
                <button class="btn tiny ghost btn-secondary ${isSecondary(id)?'active':''}" data-s="${id}">부재료</button>
              </div>
            </label>`;
        };

        return `
          <h2>새 건물 설계 - 6단계: 자재 선택</h2>
          <p>주재료(최대 4개)는 안정성·등급 확률에, 부재료는 미관 점수에만 영향을 줘.</p>
          <div class="grid2" style="gap:8px;">${entries.map(matCard).join('')}</div>
          <small class="text-dim">주재료는 5개째를 누르면 가장 먼저 선택된 게 자동 해제돼.</small>
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
            <div class="kv-label">NPC 팀 구성</div>
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
            <div class="kv-label">플레이어 UID</div>
            <input type="text" id="player-uid" value="${esc(state.contractorId||'')}">
          `
          : state.contractorType==='company' ? `
            <div class="kv-label">건설사 ID</div>
            <input type="text" id="company-id" value="${esc(state.contractorId||'')}">
          `
          : `<div class="text-dim">모집 공고를 게시해서 인원을 모을게. 추가 정보는 없어.</div>`;

        return `
          <h2>새 건물 설계 - 7단계: 시공사/인원 선택</h2>
          <div class="tabs row" style="gap:8px; margin-bottom:8px;">
            ${tabBtn('self','모집(퀘스트)')}
            ${tabBtn('player','타인(플레이어)')}
            ${tabBtn('company','건설사')}
            ${tabBtn('npc_team','NPC 팀')}
            ${tabBtn('characters','내 캐릭터')}
          </div>
          <div id="contractor-pane" class="kv-card">${pane}</div>
        `;
      };

      const step8 = () => {
        const selectedPurpose = assets.purposes[state.purpose];
        const selectedStyle = assets.styles[state.style];

        const matsPrimary = (state.primaryMaterials||[]).map(id => assets.materials[id]?.name || id);
        const matsSecondary = (state.secondaryMaterials||[]).map(id => assets.materials[id]?.name || id);

        const zonesSum = (state.zones||[]).reduce((a,b)=>a+Number(b.areaM2||0),0);

        return `
          <h2>새 건물 설계 - 최종 확인</h2>
          <ul>
            <li><strong>이름:</strong> ${esc(state.name)}</li>
            <li><strong>유형:</strong> ${esc(selectedPurpose?.name || state.purpose)}</li>
            <li><strong>양식:</strong> ${esc(selectedStyle?.name || state.style)}</li>
            <li><strong>층수:</strong> ${state.floors}층</li>
            <li><strong>한 층 면적 (부지 점유):</strong> ${state.baseAreaM2} m²</li>
            <li><strong>건물 총면적:</strong> ${state.totalAreaM2} m²</li>
            <li><strong>구역 합계:</strong> ${zonesSum} m²</li>
            <li><strong>주재료(≤4):</strong> ${matsPrimary.join(', ') || '-'}</li>
            <li><strong>부재료:</strong> ${matsSecondary.join(', ') || '-'}</li>
          </ul>
          <div class="kv-card" style="margin-top:8px;">
            <div class="kv-label">주의</div>
            <small class="text-dim">아이템 배치는 구역별로 <b>4m²당 1개</b>까지만 가능해. 3층 이상은 관련 지식 보유자(캐릭 or NPC)가 최소 1명 참여해야 해.</small>
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
      // 닫기
      back.querySelector('#cancel-build')?.addEventListener('click', () => closeModal(null));

      // 이전
      back.querySelector('#prev-step')?.addEventListener('click', () => { if (state.step > 1) { state.step--; render(); } });

      // 다음/건설 시작
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
            const f = Number(back.querySelector('#floors')?.value || 1);
            const ba = Number(back.querySelector('#baseAreaM2')?.value || 0);
            if (!Number.isFinite(f) || f < 1) { showToast('층수는 1층 이상이야.', 'error'); return; }
            if (!Number.isFinite(ba) || ba <= 0) { showToast('한 층 면적을 올바르게 입력해줘.', 'error'); return; }
            if (ba > availableArea) { showToast(`남은 면적(${availableArea}m²)을 넘을 수 없어.`, 'error'); return; }
            state.floors = f;
            state.baseAreaM2 = ba;
            state.totalAreaM2 = f * ba;
            if (!state.zones.length || state.zones.length === 1) {
                state.zones = [{ name:'본관', purpose: state.purpose, roomId:'', areaM2: state.totalAreaM2 }];
            } else {
                // 구역이 여러개면 면적 재조정 필요 알림
                showToast('총면적이 변경되었으니, 5단계에서 구역 면적을 다시 확인해줘!', 'info');
            }
            break;
          }

          case 5: {
            const sum = (state.zones||[]).reduce((a,b)=>a+Number(b.areaM2||0),0);
            if (sum !== Number(state.totalAreaM2)) {
              showToast(`구역 면적 합계(${sum})가 건물 총면적(${state.totalAreaM2})과 같아야 해.`, 'error'); 
              return;
            }
            break;
          }

          case 6:
            if (!Array.isArray(state.primaryMaterials) || state.primaryMaterials.length < 1) {
              showToast('주재료를 하나 이상 선택해줘. (최대 4개)', 'error'); return;
            }
            if (state.primaryMaterials.length > 4) {
              showToast('주재료는 최대 4개까지 선택할 수 있어.', 'error'); return;
            }
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
            // 4m²당 1개 규칙 프리체크
            for (const z of (state.zones || [])) {
              const cap = Math.floor(Number(z.areaM2 || 0) / 4);
              const cnt = (z.items || []).reduce((s,it)=>s + Number(it.count || 1), 0);
              if (cnt > cap) { showToast(`'${z.name||z.roomId||"구역"}'은 최대 ${cap}개까지만 배치 가능해.`, 'error'); return; }
            }

            // 서버 규격에 맞는 contractor 만들기
            let contractor;
            if (state.contractorType === 'npc_team') {
              contractor = { type: 'npc_team', npcTeam: state.npcTeam.map(m => ({ level: Number(m.level), count: Number(m.count) })) };
            } else if (state.contractorType === 'characters') {
              contractor = { type: 'characters', charIds: state.selectedCharIds.slice(0, 8) };
            } else if (state.contractorType === 'player' || state.contractorType === 'company' || state.contractorType === 'self') {
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
                scale: 'custom', // scale은 이제 사용하지 않지만 호환성을 위해 남김
                floors: Number(state.floors || 1),
                baseAreaM2: Number(state.baseAreaM2 || 0),
                totalAreaM2: Number(state.totalAreaM2 || 0),
                zones: (state.zones||[]).map(z=>({
                  name: String(z.name||'').trim()||'구역',
                  purpose: z.purpose || state.purpose,
                  roomId: z.roomId || '',
                  areaM2: Number(z.areaM2||0),
                  items: Array.isArray(z.items) ? z.items : []
                })),
                materials: {
                  primary: state.primaryMaterials || [],
                  secondary: state.secondaryMaterials || []
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

      // 단계별 입력 리스너
      if (state.step === 1) {
        back.querySelector('#building-name')?.addEventListener('input', e => { state.name = e.target.value; });
      }

      if (state.step === 2) {
        back.querySelectorAll('input[name="building-purpose"]')
          .forEach(r => r.addEventListener('change', e => {
            state.purpose = e.target.value;
            // 방 목록은 유형에 따라 달라지므로 구역의 roomId를 초기화
            state.zones = state.zones.map(z => ({ ...z, roomId: '' }));
          }));
      }

      if (state.step === 3) {
        back.querySelectorAll('input[name="architectural-style"]')
          .forEach(r => r.addEventListener('change', e => { state.style = e.target.value; }));
      }

      if (state.step === 4) {
        const floorsEl = back.querySelector('#floors');
        const baseEl = back.querySelector('#baseAreaM2');
        const baseView = back.querySelector('#baseAreaM2View');
        const totalView = back.querySelector('#totalAreaM2View');

        const recalc = () => {
          state.floors = Math.max(1, Number(floorsEl.value || 1));
          state.baseAreaM2 = Math.max(1, Number(baseEl.value || 1));
          state.totalAreaM2 = state.floors * state.baseAreaM2;
          baseView.textContent = state.baseAreaM2.toLocaleString();
          totalView.textContent = state.totalAreaM2.toLocaleString();
        };
        floorsEl.addEventListener('input', recalc);
        baseEl.addEventListener('input', recalc);
        recalc();
      }

      if (state.step === 5) {
        const tbody = back.querySelector('#zones-tbody');
        const recalc = () => {
          const rows = [...tbody.querySelectorAll('tr')];
          state.zones = rows.map(tr => ({
            name: tr.querySelector('.z-name')?.value || '',
            purpose: tr.querySelector('.z-purpose')?.value || state.purpose,
            roomId: tr.querySelector('.z-room')?.value || '',
            areaM2: Number(tr.querySelector('.z-area')?.value || 0),
            items: [] // 아이템 편집 UI는 추후 확장
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
          const roomOptions = roomListForType(state.purpose);
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td><input type="text" class="z-name" placeholder="신규 구역"></td>
            <td>
              <select class="z-purpose">
                ${Object.entries(assets.purposes).map(([id,p]) =>
                  `<option value="${id}">${esc(p.name)}</option>`).join('')}
              </select>
            </td>
            <td>
              <select class="z-room">
                <option value="">(방 지정 안 함)</option>
                ${roomOptions.map(([rid, r]) => `<option value="${rid}">${esc(r.label)}</option>`).join('')}
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
      }

      if (state.step === 6) {
        const cap = 4;
        state.primaryMaterials = state.primaryMaterials || [];
        state.secondaryMaterials = state.secondaryMaterials || [];
        back.querySelectorAll('[data-p]').forEach(btn => {
          btn.addEventListener('click', () => {
            const id = btn.dataset.p;
            if (!state.primaryMaterials.includes(id)) {
              state.primaryMaterials.push(id);
              if (state.primaryMaterials.length > cap) state.primaryMaterials.shift(); // 5개째면 첫 항목 제거
            } else {
              state.primaryMaterials = state.primaryMaterials.filter(x => x !== id);
            }
            // 한 자재가 주로 가면 부에선 제거
            state.secondaryMaterials = state.secondaryMaterials.filter(x => x !== id);
            render();
          });
        });
        back.querySelectorAll('[data-s]').forEach(btn => {
          btn.addEventListener('click', () => {
            const id = btn.dataset.s;
            if (state.secondaryMaterials.includes(id)) {
              state.secondaryMaterials = state.secondaryMaterials.filter(x => x !== id);
            } else {
              // 부재료엔 제한 없음. 단, 주에 있으면 부로 못 옮김
              if (!state.primaryMaterials.includes(id)) state.secondaryMaterials.push(id);
            }
            render();
          });
        });
      }

      if (state.step === 7) {
        // 탭 전환
        back.querySelectorAll('[data-ct]').forEach(btn=>{
          btn.addEventListener('click', ()=>{
            state.contractorType = btn.dataset.ct;
            if (state.contractorType==='npc_team' && (!state.npcTeam || !state.npcTeam.length)) state.npcTeam = [{level:1,count:1}];
            if (state.contractorType!=='player' && state.contractorType!=='company') state.contractorId = null;
            render();
          });
        });

        // NPC 팀 행 조작
        const tbody = back.querySelector('#npc-tbody');
        if (tbody) {
          const sync = () => {
            const rows = [...tbody.querySelectorAll('tr')];
            state.npcTeam = rows.map(tr => ({
              level: Number(tr.querySelector('.npc-lv')?.value || 1),
              count: Number(tr.querySelector('.npc-cnt')?.value || 1),
            })).filter(m => m.level>=1 && m.count>=1);
          };
          tbody.addEventListener('input', sync);
          tbody.addEventListener('change', sync);
          tbody.addEventListener('click', e => {
            const del = e.target.closest('.npc-del');
            if (!del) return;
            const tr = del.closest('tr'); tr?.remove(); sync();
          });
          back.querySelector('#npc-add')?.addEventListener('click', ()=>{
            const tr = document.createElement('tr');
            tr.innerHTML = `
              <td style="width:130px"><input type="number" class="npc-lv" min="1" max="100" value="1"></td>
              <td style="width:130px"><input type="number" class="npc-cnt" min="1" max="50" value="1"></td>
              <td style="width:40px"><button class="btn small ghost npc-del">-</button></td>
            `;
            tbody.appendChild(tr);
            sync();
          });
        }

        // 캐릭터 체크박스
        back.querySelectorAll('.ct-char')?.forEach(cb=>{
          cb.addEventListener('change', ()=>{
            const id = cb.value;
            if (cb.checked) {
              if (!state.selectedCharIds.includes(id)) state.selectedCharIds.push(id);
            } else {
              state.selectedCharIds = state.selectedCharIds.filter(x => x !== id);
            }
          });
        });

        // ID 입력
        back.querySelector('#player-uid')?.addEventListener('input', e=>{ state.contractorId = e.target.value; });
        back.querySelector('#company-id')?.addEventListener('input', e=>{ state.contractorId = e.target.value; });
      }
    };

    document.body.appendChild(back);
    render();
  });
}

/* ------------------------------
 * 캐릭터 선택 모달 (시설 배치용)
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

/* ------------------------------
 * 메인 렌더링
 * ------------------------------ */
function render(root, plotInfo, plotData, characters, plotDocId) {
  const totalArea = plotData.totalArea || 10000;
  const usedArea = plotData.usedArea || 0;
  const availableArea = Math.max(0, totalArea - usedArea);
  const facilities = Array.isArray(plotData.facilities) ? plotData.facilities : [];
  const tasks = Array.isArray(plotData.tasks) ? plotData.tasks : [];

  const facilityCardsHtml = facilities.map(fac => {
    const assignedChar = characters.find(c => c.id === fac.managerCharId);
    const isBuilding = !fac.type || fac.type === 'building' || !!fac.style;
    const areaTxt = (fac.totalArea || 'N/A');

    const cardContent = isBuilding ? `
      <div class="row" style="justify-content:space-between">
        <b>${esc(fac.name || '건물')} (건물)</b>
        <span>${areaTxt}m² / ${fac.floors}층</span>
      </div>
      <div class="text-dim" style="font-size:12px;">스타일: ${esc(fac.style || '-')} | 안전도: ${esc(fac.safetyLevel || '-')}</div>
      <div class="kv-card" style="margin-top:8px; padding:8px;">
        관리자: ${assignedChar ? `${esc(assignedChar.name)} (건설 Lv.${assignedChar.skills?.construction?.level || 0})` : '없음'}
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
          <button class="btn small" data-facility-id="${fac.id}" data-action="assign-char">관리자 배정</button>
          <button class="btn small" data-facility-id="${fac.id}" data-action="manage-${isBuilding ? 'building' : 'farm'}">관리</button>
        </div>
      </div>
    `;
  }).join('');

  const taskCardsHtml = tasks.map(task => {
    const progress = (task.unitsDone || 0) / (task.unitsTotal || 1);
    const progressPercent = Math.floor(progress * 100);
    // recruitmentUntil 필드가 존재하면 남은 시간을 계산
    let timeRemaining = '';
    if (task.recruitmentUntil && task.recruitmentUntil.toDate) {
        const untilDate = task.recruitmentUntil.toDate();
        const diff = untilDate.getTime() - new Date().getTime();
        if (diff > 0) {
            const minutes = Math.floor(diff / 60000);
            const seconds = Math.floor((diff % 60000) / 1000);
            timeRemaining = ` | ${minutes}분 ${seconds}초 남음`;
        }
    }
      
    return `
    <div class="kv-card">
        <div class="row" style="justify-content:space-between">
            <b>'${task.projectId.substring(0, 8)}...' 프로젝트</b>
            <span class="text-dim">${task.status === 'recruiting' ? `모집 중${timeRemaining}` : '건설 중'}</span>
        </div>
        <div class="progress-bar" style="margin-top: 8px;">
            <div class="progress" style="width: ${progressPercent}%;"></div>
        </div>
        <div class="text-dim" style="font-size: 12px; text-align: right;">${progressPercent}% (${task.unitsDone || 0}/${task.unitsTotal || 0})</div>
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
        
        ${tasks.length > 0 ? '<h4 style="margin-top:24px; margin-bottom:12px;">진행 중인 작업</h4>' : ''}
        <div id="tasks-list" class="col" style="gap:12px;">
            ${taskCardsHtml}
        </div>

        <h4 style="margin-top:24px; margin-bottom:12px;">완공된 시설</h4>
        <div id="facilities-list" class="col" style="gap:12px;">
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

    let materials, purposes, stylesArray, rooms;
    try {
      [materials, purposes, stylesArray, rooms] = await Promise.all([
        fetch('/assets/building_materials.json').then(res => res.json()),
        fetch('/assets/building_purposes.json').then(res => res.json()),
        fetch('/assets/architectural_styles.json').then(res => res.json()),
        fetch('/assets/rooms.json').then(res => res.json()).catch(()=> ({})) // 없으면 빈 객체
      ]);
    } catch (err) {
      console.error("Failed to fetch building assets:", err);
      showToast('건축 데이터를 불러오는 데 실패했어.', 'error');
      return;
    }
    if (!materials || !purposes || !stylesArray) { showToast('건축 데이터가 비어 있어.', 'error'); return; }

    const purposesMap = purposes.reduce((acc, p) => { acc[p.id] = p; return acc; }, {});
    const styles = stylesArray.reduce((acc, style) => { acc[style.id] = style; return acc; }, {});
    const assets = { materials, purposes: purposesMap, styles, rooms };

    await openCustomConstructionModal(characters, userItems, availableArea, assets, plotDocId);
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

  // 캐릭터 배치(시설)
  root.querySelectorAll('[data-action="assign-char"]').forEach(btn => {
    btn.onclick = async () => {
      const facilityId = btn.dataset.facilityId;
      const selectedChar = await openCharacterPickerModal(characters);
      if (selectedChar === undefined) return; // 닫기
      try {
        await assignCharacterToFacility({ plotId: plotDocId, buildingId: facilityId, charId: selectedChar ? selectedChar.id : null });
        showToast('관리자 배치가 완료되었어.', 'success');
      } catch (e) {
        showToast(`배치 실패: ${e.message}`, 'error');
      }
    };
  });

  // 관리 버튼 (스텁)
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
      const plotData = plotSnap.exists() ? plotSnap.data() : { totalArea: 10000, usedArea: 0, facilities: [], tasks: [] };
      if (!root.characters) {
        root.characters = await getUserCharacters() || [];
      }
      render(root, plotInfo, plotData, root.characters, plotDocId);
    }, (error) => {
      console.error("토지 정보 실시간 수신 실패:", error);
      root.innerHTML = `<section class="container narrow"><div class="kv-card error">데이터를 불러오는 데 실패했어.</div></section>`;
    });
    
    // 뷰가 바뀔 때 리스너를 정리하는 클린업 함수 등록
    const viewElement = root.closest('#router-view') || root;
    viewElement.__cleanup = () => {
      if (root.characters) delete root.characters;
      unsub();
    };

  } catch (error) {
    console.error("초기 데이터 로딩 실패:", error);
    root.innerHTML = `<section class="container narrow"><div class="kv-card error">오류: ${esc(error.message)}</div></section>`;
  }
}
