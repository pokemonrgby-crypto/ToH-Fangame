// /public/js/tabs/land_management.js (전체 교체)
import { auth, db, fx } from '../api/firebase.js';
import { showToast } from '../ui/toast.js';
import { ensureModalCss, confirmModal, promptModal } from '../ui/modal.js';

// real_estate.js에서 startConstruction 함수를 가져옵니다.
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

// [MODIFIED] 다단계 커스텀 건축 모달 UI
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
            requiredArea: 1
        };

        const render = () => {
            let contentHtml = '';
            switch (state.step) {
                case 1:
                    contentHtml = `
                        <h2>새 건물 설계 - 1단계: 이름</h2>
                        <p>건물의 이름을 입력하세요.</p>
                        <input type="text" id="building-name" value="${state.name}" placeholder="예: 대장간, 연금술사의 탑">
                    `;
                    break;
                case 2:
                    contentHtml = `
                        <h2>새 건물 설계 - 2단계: 용도</h2>
                        <p>건물의 주된 용도를 선택하세요.</p>
                        <div class="radio-grid">
                            ${Object.values(materialsAsset.purposes).map(p => `
                                <label>
                                    <input type="radio" name="building-purpose" value="${p.id}" ${state.purpose === p.id ? 'checked' : ''}>
                                    <span>${p.name}</span>
                                    <small>${p.description}</small>
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
                                    <span>${s.name}</span>
                                    <small>${s.description}</small>
                                </label>
                            `).join('')}
                        </div>
                    `;
                    break;
                case 4:
                    const materialOptions = Object.values(materialsAsset.materials);
                    contentHtml = `
                        <h2>새 건물 설계 - 4단계: 주 자재</h2>
                        <p>건설에 사용할 주요 자재를 선택하세요. (복수 선택 가능)</p>
                        <div class="checkbox-grid">
                            ${materialOptions.map(m => {
                                const userMaterial = userItems.find(i => i.id === m.id);
                                const possessed = userMaterial ? userMaterial.quantity : 0;
                                const disabled = possessed === 0;
                                return `
                                    <label class="${disabled ? 'disabled' : ''}">
                                        <input type="checkbox" name="building-material" value="${m.id}" ${state.materials.includes(m.id) ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
                                        <span>${m.name} (보유: ${possessed})</span>
                                        <small>${m.description}</small>
                                    </label>
                                `;
                            }).join('')}
                        </div>
                    `;
                    break;
                case 5:
                    const selectedPurpose = materialsAsset.purposes[state.purpose];
                    const selectedStyle = materialsAsset.styles[state.style];
                    const selectedMaterials = state.materials.map(id => materialsAsset.materials[id]);

                    let totalCost = 0;
                    selectedMaterials.forEach(m => {
                        const materialInfo = materialsAsset.materials[m.id];
                        if (materialInfo) {
                            totalCost += materialInfo.cost || 0;
                        }
                    });
                    
                    state.totalCost = totalCost;

                    contentHtml = `
                        <h2>새 건물 설계 - 최종 확인</h2>
                        <p>아래 내용으로 건설을 시작하시겠습니까?</p>
                        <ul>
                            <li><strong>이름:</strong> ${state.name}</li>
                            <li><strong>용도:</strong> ${selectedPurpose.name}</li>
                            <li><strong>건축 양식:</strong> ${selectedStyle.name}</li>
                            <li><strong>주 자재:</strong> ${selectedMaterials.map(m => m.name).join(', ')}</li>
                            <li><strong>필요 면적:</strong> ${state.requiredArea}</li>
                            <li><strong>총 비용:</strong> ${state.totalCost.toLocaleString()} G</li>
                        </ul>
                    `;
                    break;
            }

            back.innerHTML = `
                <div class="modal-card col" style="gap: 16px; min-width: 500px;">
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
                    // 각 단계별 유효성 검사 및 상태 업데이트
                    switch (state.step) {
                        case 1:
                            if (!state.name.trim()) {
                                showToast('건물 이름을 입력해주세요.', 'error');
                                return;
                            }
                            break;
                        case 2:
                            if (!state.purpose) {
                                showToast('건물 용도를 선택해주세요.', 'error');
                                return;
                            }
                            break;
                        case 3:
                            if (!state.style) {
                                showToast('건축 양식을 선택해주세요.', 'error');
                                return;
                            }
                            break;
                        case 4:
                            if (state.materials.length === 0) {
                                showToast('주 자재를 하나 이상 선택해주세요.', 'error');
                                return;
                            }
                            break;
                        case 5:
                            // 건설 시작 로직
                            showToast('건설을 시작합니다...', 'info');
                            const buildingData = {
                                name: state.name,
                                purpose: state.purpose,
                                style: state.style,
                                materials: state.materials,
                                requiredArea: state.requiredArea,
                                cost: state.totalCost,
                                isCustom: true
                            };
                            try {
                                // [FIX] startConstruction 함수를 올바른 인자와 함께 호출합니다.
                                const result = await startConstruction({ plotId: plotDocId, ...buildingData });
                                if (result && result.success) { // 'success' 필드가 있다고 가정
                                    showToast('새로운 건물 건설을 시작했습니다!', 'success');
                                    resolve(result); // 성공 결과와 함께 Promise 해결
                                } else {
                                    showToast(result.error || '건설 시작에 실패했습니다.', 'error');
                                    resolve(null); // 실패 시 null로 해결
                                }
                            } catch (err) {
                                console.error('Error starting custom construction:', err);
                                showToast(err.message || '알 수 없는 오류로 건설에 실패했습니다.', 'error');
                                resolve(null);
                            }
                            closeModal();
                            return; // 다음 단계로 넘어가지 않도록 여기서 함수 종료
                    }

                    // 다음 단계로 이동
                    if (state.step < 5) {
                        state.step++;
                        render();
                    }
                });
            }

            // 각 단계별 입력 필드에 이벤트 리스너 추가
            switch (state.step) {
                case 1:
                    document.getElementById('building-name').addEventListener('input', e => {
                        state.name = e.target.value;
                    });
                    break;
                case 2:
                    document.querySelectorAll('input[name="building-purpose"]').forEach(radio => {
                        radio.addEventListener('change', e => {
                            state.purpose = e.target.value;
                        });
                    });
                    break;
                case 3:
                    document.querySelectorAll('input[name="architectural-style"]').forEach(radio => {
                        radio.addEventListener('change', e => {
                            state.style = e.target.value;
                        });
                    });
                    break;
                case 4:
                    document.querySelectorAll('input[name="building-material"]').forEach(checkbox => {
                        checkbox.addEventListener('change', e => {
                            if (e.target.checked) {
                                if (!state.materials.includes(e.target.value)) {
                                    state.materials.push(e.target.value);
                                }
                            } else {
                                state.materials = state.materials.filter(m => m !== e.target.value);
                            }
                        });
                    });
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

// [MODIFIED] attachEvents 함수
function attachEvents(root, plotInfo, plotDocId, availableArea, characters) {
    root.querySelector('#btn-new-building').onclick = async () => {
        const userData = (await fx.getDoc(fx.doc(db, 'users', auth.currentUser.uid))).data();
        const userItems = userData.items_all || [];

        // [FIX] 필요한 모든 에셋 파일을 불러와 하나의 객체로 합칩니다.
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

        // architectural_styles.json은 배열이므로 코드가 사용하기 편한 객체 형태로 변환합니다.
        const styles = stylesArray.reduce((acc, style) => {
            acc[style.id] = style;
            return acc;
        }, {});

        const materialsAsset = { materials, purposes, styles };
        
        // [FIX] plotDocId를 모달에 전달하고, 중복 API 호출을 제거합니다.
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
            // 캐릭터 목록은 자주 바뀌지 않으므로 최초 한 번만 불러오거나, 필요 시 다시 불러오도록 최적화 가능
            if (!root.characters) {
                const characters = await getUserCharacters();
                root.characters = characters || [];
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
