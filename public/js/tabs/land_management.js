// /public/js/tabs/land_management.js (전체 교체)
import { auth, db, fx } from '../api/firebase.js';
import { showToast } from '../ui/toast.js';
import { ensureModalCss, confirmModal, promptModal } from '../ui/modal.js';

import { assignCharacterToFacility, createFarmland, startConstruction } from '../api/real_estate.js';
import { getUserCharacters } from '../api/char.js';

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

async function openCustomConstructionModal(characters, userItems, availableArea, materialsAsset, plotDocId) {
    ensureModalCss();
    return new Promise(resolve => {
        const back = document.createElement('div');
        back.className = 'modal-back';
        
        let state = {
            step: 1,
            name: '',
            purpose: null,
            style: null,
            materials: [],
            totalCost: 0,
            requiredArea: 10 // 기본 면적 10m²로 설정
        };

        const render = () => {
            let contentHtml = '';
            switch (state.step) {
                case 1:
                    contentHtml = `
                        <h2>새 건물 설계 - 1단계: 이름</h2>
                        <p>건물의 이름을 입력하세요.</p>
                        <input type="text" id="building-name" value="${esc(state.name)}" placeholder="예: 대장간, 연금술사의 탑">
                    `;
                    break;
                case 2:
                    contentHtml = `
                        <h2>새 건물 설계 - 2단계: 용도</h2>
                        <p>건물의 주된 용도를 선택하세요.</p>
                        <div class="radio-grid">
                            ${Object.entries(materialsAsset.purposes).map(([id, p]) => `
                                <label>
                                    <input type="radio" name="building-purpose" value="${id}" ${state.purpose === id ? 'checked' : ''}>
                                    <div>
                                        <span>${esc(p.name)}</span>
                                        <small>${esc(p.description)}</small>
                                    </div>
                                </label>
                            `).join('')}
                        </div>
                    `;
                    break;
                case 3:
                    contentHtml = `
                        <h2>새 건물 설계 - 3단계: 건축 양식</h2>
                        <p>건물의 건축 양식을 선택하세요.</p>
                        <div class="radio-grid">
                            ${Object.values(materialsAsset.styles).map(s => `
                                <label>
                                    <input type="radio" name="architectural-style" value="${s.id}" ${state.style === s.id ? 'checked' : ''}>
                                    <div>
                                        <span>${esc(s.name)}</span>
                                        <small>${esc(s.description)}</small>
                                    </div>
                                </label>
                            `).join('')}
                        </div>
                    `;
                    break;
                case 4:
                    const materialEntries = Object.entries(materialsAsset.materials);
                    contentHtml = `
                        <h2>새 건물 설계 - 4단계: 주 자재</h2>
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
                                            <small>${esc(m.description)}</small>
                                            ${needsPurchase ? `<small style="color:#f59e0b; font-weight:bold; margin-top:4px;">※ 보유량이 없어 구매가 필요합니다.</small>` : ''}
                                        </div>
                                    </label>
                                `;
                            }).join('')}
                        </div>
                    `;
                    break;
                case 5:
                    const selectedPurpose = materialsAsset.purposes[state.purpose];
                    const selectedStyle = materialsAsset.styles[state.style];
                    const selectedMaterialsInfo = state.materials.map(id => ({ id, ...materialsAsset.materials[id] }));

                    let buyoutCost = 0;
                    const materialsSummary = [];
                    // NOTE: 자재 요구량은 예시이며, 실제 게임에서는 설계에 따라 더 복잡한 계산이 필요합니다.
                    const DUMMY_REQUIRED_QTY_PER_AREA = 10;

                    selectedMaterialsInfo.forEach(material => {
                        const requiredQty = state.requiredArea * DUMMY_REQUIRED_QTY_PER_AREA;
                        const userMaterial = userItems.find(i => i.id === material.id || i.itemId === material.id);
                        const possessed = userMaterial ? (userMaterial.quantity || userMaterial.count || 0) : 0;
                        const missingQty = Math.max(0, requiredQty - possessed);

                        if (missingQty > 0) {
                            const price = material.basePrice || 1;
                            buyoutCost += missingQty * price * 2.5; // 긴급 구매 배수 2.5 적용
                        }
                        materialsSummary.push(`<li>${esc(material.name)} ${requiredQty}개 (보유: ${possessed})${missingQty > 0 ? ` - <b style="color:#f59e0b;">${missingQty}개 구매</b>` : ''}</li>`);
                    });
                    
                    state.totalCost = Math.ceil(buyoutCost);

                    contentHtml = `
                        <h2>새 건물 설계 - 최종 확인</h2>
                        <p>아래 내용으로 건설을 시작하시겠습니까?</p>
                        <ul>
                            <li><strong>이름:</strong> ${esc(state.name)}</li>
                            <li><strong>용도:</strong> ${esc(selectedPurpose.name)}</li>
                            <li><strong>건축 양식:</strong> ${esc(selectedStyle.name)}</li>
                            <li><strong>필요 면적:</strong> ${state.requiredArea} m²</li>
                        </ul>
                        <div class="kv-card" style="margin-top:8px;">
                          <div class="kv-label">필요 자재</div>
                          <ul style="padding-left: 20px; margin: 0; font-size: 13px;">
                              ${materialsSummary.join('')}
                          </ul>
                          <hr style="margin: 12px 0; border-color: #2a2f36;">
                          <div class="row" style="justify-content:space-between;">
                            <span>자재 구매 비용:</span>
                            <b style="color:#f59e0b;">🪙 ${buyoutCost.toLocaleString()} G</b>
                          </div>
                        </div>
                        <div class="row" style="justify-content:space-between; margin-top:12px; font-size: 16px;">
                          <b>총 비용:</b>
                          <b>🪙 ${state.totalCost.toLocaleString()} G</b>
                        </div>
                    `;
                    break;
            }

            back.innerHTML = `
                <div class="modal-card col" style="gap: 16px; max-width: 720px; width: 90vw;">
                    ${contentHtml}
                    <div class="row" style="justify-content: space-between; margin-top: 16px;">
                        <button class="btn ghost" id="prev-step" ${state.step === 1 ? 'disabled' : ''}>이전</button>
                        <div>
                            <button class="btn ghost" id="cancel-build">취소</button>
                            <button class="btn primary" id="next-step">${state.step === 5 ? '건설 시작' : '다음'}</button>
                        </div>
                    </div>
                </div>
            `;
            attachModalEvents();
        };

        const attachModalEvents = () => {
            const closeModal = () => {
                document.body.removeChild(back);
                resolve(null);
            };

            document.getElementById('cancel-build').addEventListener('click', closeModal);

            const prevStepBtn = document.getElementById('prev-step');
            if (prevStepBtn) {
                prevStepBtn.addEventListener('click', () => {
                    if (state.step > 1) {
                        state.step--;
                        render();
                    }
                });
            }

            const nextStepBtn = document.getElementById('next-step');
            if (nextStepBtn) {
                nextStepBtn.addEventListener('click', async () => {
                    switch (state.step) {
                        case 1:
                            if (!state.name.trim()) { showToast('건물 이름을 입력해주세요.', 'error'); return; }
                            break;
                        case 2:
                            if (!state.purpose) { showToast('건물 용도를 선택해주세요.', 'error'); return; }
                            break;
                        case 3:
                            if (!state.style) { showToast('건축 양식을 선택해주세요.', 'error'); return; }
                            break;
                        case 4:
                            if (state.materials.length === 0) { showToast('주 자재를 하나 이상 선택해주세요.', 'error'); return; }
                            break;
                        case 5:
                            const buildingData = {
                                name: state.name,
                                purpose: state.purpose,
                                style: state.style,
                                materials: state.materials,
                                requiredArea: state.requiredArea,
                                cost: state.totalCost,
                                isCustom: true,
                                allowMaterialBuyout: true // 부족한 자재 구매 허용 플래그
                            };
                            try {
                                const result = await startConstruction({ plotId: plotDocId, ...buildingData });
                                if (result && result.success) {
                                    showToast('새로운 건물 건설을 시작했습니다!', 'success');
                                    resolve(result);
                                } else {
                                    showToast(result.error || '건설 시작에 실패했습니다.', 'error');
                                    resolve(null);
                                }
                            } catch (err) {
                                showToast(err.message || '알 수 없는 오류로 건설에 실패했습니다.', 'error');
                                resolve(null);
                            }
                            closeModal();
                            return;
                    }

                    if (state.step < 5) {
                        state.step++;
                        render();
                    }
                });
            }

            switch (state.step) {
                case 1:
                    document.getElementById('building-name').addEventListener('input', e => { state.name = e.target.value; });
                    break;
                case 2:
                    document.querySelectorAll('input[name="building-purpose"]').forEach(r => r.addEventListener('change', e => { state.purpose = e.target.value; }));
                    break;
                case 3:
                    document.querySelectorAll('input[name="architectural-style"]').forEach(r => r.addEventListener('change', e => { state.style = e.target.value; }));
                    break;
                case 4:
                    document.querySelectorAll('input[name="building-material"]').forEach(c => c.addEventListener('change', e => {
                        if (e.target.checked) !state.materials.includes(e.target.value) && state.materials.push(e.target.value);
                        else state.materials = state.materials.filter(m => m !== e.target.value);
                    }));
                    break;
            }
        };
        
        document.body.appendChild(back);
        render();
    });
}


function render(root, plotInfo, plotData, characters, plotDocId) {
    const totalArea = plotData.totalArea || 10000;
    const usedArea = plotData.usedArea || 0;
    const availableArea = totalArea - usedArea;
    const facilities = plotData.facilities || [];

    const facilityCardsHtml = facilities.map(fac => {
        const assignedChar = characters.find(c => c.id === fac.assignedCharId);
        const cardContent = fac.type === 'building' ? `
            <div class="row" style="justify-content:space-between">
                <b>${esc(fac.name)} (건물)</b>
                <span>${fac.area || 'N/A'}m² / ${fac.height || 'N/A'}m</span>
            </div>
            <div class="text-dim" style="font-size:12px;">스타일: ${esc(fac.style)} | 안전도: ${esc(fac.safetyLevel)}</div>
            <div class="kv-card" style="margin-top:8px; padding:8px;">
                담당: ${assignedChar ? `${esc(assignedChar.name)} (건설 Lv.${assignedChar.skills?.construction?.level || 0})` : '없음'}
            </div>
        ` : `
            <div class="row" style="justify-content:space-between">
                <b>${esc(fac.name)} (농지)</b>
                <span>${fac.area}m²</span>
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

function attachEvents(root, plotInfo, plotDocId, availableArea, characters) {
    root.querySelector('#btn-new-building').onclick = async () => {
        const userData = (await fx.getDoc(fx.doc(db, 'users', auth.currentUser.uid))).data();
        const userItems = userData.items_all || [];
        
        const [materials, purposes, stylesArray] = await Promise.all([
            fetch('/assets/building_materials.json').then(res => res.json()),
            fetch('/assets/building_purposes.json').then(res => res.json()),
            fetch('/assets/architectural_styles.json').then(res => res.json())
        ]).catch(err => {
            console.error("Failed to fetch building assets:", err);
            showToast('건축 데이터를 불러오는 데 실패했습니다.', 'error');
            return [null, null, null];
        });

        if (!materials || !purposes || !stylesArray) return;

        const styles = stylesArray.reduce((acc, style) => {
            acc[style.id] = style;
            return acc;
        }, {});

        const materialsAsset = { materials, purposes, styles };

        await openCustomConstructionModal(characters, userItems, availableArea, materialsAsset, plotDocId);
    };
    
    root.querySelector('#btn-new-farmland').onclick = async () => {
        const name = await promptModal({ title: '새로운 농지의 이름을 입력하세요.', placeholder: '나의 텃밭' });
        if (!name) return;

        const areaStr = await promptModal({ title: `경작할 면적을 입력하세요 (최대: ${availableArea}m²)`, placeholder: `최대 ${availableArea}` });
        if (!areaStr) return;

        const area = parseInt(areaStr, 10);
        if (isNaN(area) || area <= 0 || area > availableArea) {
            showToast('올바른 면적을 입력해주세요.');
            return;
        }

        try {
            await createFarmland({ plotId: plotDocId, name, area });
            showToast(`'${name}' 농지가 생성되었습니다.`);
        } catch (e) {
            showToast(`농지 생성 실패: ${e.message}`);
        }
    };

    root.querySelectorAll('[data-action="assign-char"]').forEach(btn => {
        btn.onclick = async () => {
            const facilityId = btn.dataset.facilityId;
            const selectedChar = await openCharacterPickerModal(characters);
            if (selectedChar === undefined) return;
            
            try {
                await assignCharacterToFacility({ plotId: plotDocId, facilityId, charId: selectedChar ? selectedChar.id : null });
                showToast('캐릭터 배치가 완료되었습니다.');
            } catch (e) {
                showToast(`배치 실패: ${e.message}`);
            }
        };
    });
}

export async function showLandManagement() {
    const root = document.getElementById('view');
    const plotInfo = parseLandPlotInfo();

    if (!auth.currentUser || !plotInfo) {
        root.innerHTML = `<section class="container narrow"><div class="kv-card">잘못된 접근입니다.</div></section>`;
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
            root.innerHTML = `<section class="container narrow"><div class="kv-card error">데이터를 불러오는 데 실패했습니다.</div></section>`;
        });
        
        root.closest('#view').__cleanup = () => {
             if (root.characters) delete root.characters;
             unsub();
        }

    } catch (error) {
        console.error("초기 데이터 로딩 실패:", error);
        root.innerHTML = `<section class="container narrow"><div class="kv-card error">오류: ${esc(error.message)}</div></section>`;
    }
}
