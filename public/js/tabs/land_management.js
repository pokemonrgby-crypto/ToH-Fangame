// /public/js/tabs/land_management.js

import {
    getFirestore,
    doc,
    onSnapshot,
    getDoc,
    setDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
    getFunctions,
    httpsCallable
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import {
    state
} from '../app.js';
import {
    showToast
} from '../ui/toast.js';
import {
    openModal,
    closeModal
} from '../ui/modal.js';
import {
    renderResourceCosts,
    esc,
    formatNumber,
    listenToPlayerState
} from '../ui/utils.js';
// ▼▼▼ [수정된 부분] ▼▼▼
import {
    renderBuildingCard
} from '../ui/buildingCard.js';
import {
    renderFarmCard
} from '../ui/farmCard.js';
// ▲▲▲ [수정된 부분] ▲▲▲

const db = getFirestore();
const functions = getFunctions();

let currentPlotData = null;
let currentPlotDocId = null;
let allCharacters = [];
let unsubscribePlot = null;
let unsubscribePlayer = null;

let assets = {
    buildingPurposes: {},
    architecturalStyles: {},
    buildingMaterials: {},
    rooms: {}
};

async function loadAssets() {
    try {
        const [purposes, styles, materials, rooms] = await Promise.all([
            fetch('/assets/building_purposes.json').then(res => res.json()),
            fetch('/assets/architectural_styles.json').then(res => res.json()),
            fetch('/assets/building_materials.json').then(res => res.json()),
            fetch('/assets/rooms.json').then(res => res.json())
        ]);
        assets.buildingPurposes = purposes;
        assets.architecturalStyles = styles;
        assets.buildingMaterials = materials;
        assets.rooms = rooms;
    } catch (error) {
        console.error("필수 에셋 로딩 실패:", error);
        showToast("건설 에셋을 불러오는 데 실패했습니다.", 'error');
    }
}

function init(plotDocId) {
    const root = document.getElementById('content-root');
    currentPlotDocId = plotDocId;

    root.innerHTML = `
        <div class="container">
            <h1 id="plot-name">부지 정보 로딩 중...</h1>
            <div class="kv-card">
                <p id="plot-description"></p>
                <p><strong>면적:</strong> <span id="plot-area"></span></p>
                <p><strong>소유주:</strong> <span id="plot-owner"></span></p>
            </div>

            <div class="section-title">
                <h2>시설 관리</h2>
                <div>
                    <button id="add-farm-btn" class="btn">경작지 추가</button>
                    <button id="add-building-btn" class="btn">새 건물 설계</button>
                </div>
            </div>
            <div id="facilities-list" class="grid-container">
                </div>
        </div>
    `;

    document.getElementById('add-building-btn').addEventListener('click', () => {
        if (currentPlotData) {
            openCustomConstructionModal(plotDocId, currentPlotData);
        }
    });

    document.getElementById('add-farm-btn').addEventListener('click', () => {
        // TODO: 경작지 추가 기능 구현
        showToast('경작지 추가 기능은 아직 준비 중입니다.');
    });


    // Listen to plot data
    const plotRef = doc(db, 'plots', plotDocId);
    unsubscribePlot = onSnapshot(plotRef, (doc) => {
        if (doc.exists()) {
            currentPlotData = doc.data();
            render(root, currentPlotData, allCharacters, plotDocId);
        } else {
            root.innerHTML = `<p>부지 정보를 찾을 수 없습니다.</p>`;
            console.error("Plot not found!");
        }
    }, (error) => {
        console.error("Error listening to plot:", error);
        root.innerHTML = `<p>부지 정보를 불러오는 중 오류가 발생했습니다.</p>`;
    });

    // Listen to player state for character data
    unsubscribePlayer = listenToPlayerState((playerData) => {
        allCharacters = playerData.characters;
        if (currentPlotData) {
            render(root, currentPlotData, allCharacters, plotDocId);
        }
    });
}

// ▼▼▼ [수정된 부분] ▼▼▼
function render(root, plotData, characters, plotDocId) {
    // 부지 기본 정보 렌더링
    root.querySelector('#plot-name').textContent = plotData.name || '이름 없는 부지';
    root.querySelector('#plot-description').textContent = plotData.description || '설명 없음';
    root.querySelector('#plot-area').textContent = `${formatNumber(plotData.totalAreaM2)} m² (사용 가능: ${formatNumber(plotData.availableAreaM2)} m²)`;
    root.querySelector('#plot-owner').textContent = plotData.ownerName || '소유주 정보 없음';

    // 시설 목록 렌더링
    const facilitiesList = root.querySelector('#facilities-list');
    facilitiesList.innerHTML = ''; // 기존 목록 비우기

    if (!plotData.facilities || plotData.facilities.length === 0) {
        facilitiesList.innerHTML = '<p>아직 건설된 시설이 없습니다.</p>';
        return;
    }

    plotData.facilities.forEach(facility => {
        let card;
        if (facility.type === 'building') {
            card = renderBuildingCard(facility, characters, plotDocId);
        } else if (facility.type === 'farm') {
            card = renderFarmCard(facility, characters, plotDocId);
        }

        if (card) {
            facilitiesList.appendChild(card);
        }
    });
}
// ▲▲▲ [수정된 부분] ▲▲▲


function openCustomConstructionModal(plotDocId, plotData) {
    let state = {
        step: 1,
        buildingName: '나의 새 건물',
        purposeId: null,
        styleId: null,
        materialId: null,
        floors: 1,
        baseAreaM2: 100,
        totalAreaM2: 100,
        copyFirstFloor_enabled: false, // 1층 설계 복사 여부
        zones: [],
        designSummary: {},
    };

    const updateTotalArea = () => {
        state.totalAreaM2 = (state.floors || 1) * (state.baseAreaM2 || 0);
        const totalAreaView = document.getElementById('totalAreaM2View');
        const baseAreaView = document.getElementById('baseAreaM2View');
        if (totalAreaView) totalAreaView.textContent = `${formatNumber(state.totalAreaM2)} m²`;
        if (baseAreaView) baseAreaView.textContent = `${formatNumber(state.baseAreaM2)} m²`;
    };

    const renderStep = () => {
        let content = '';
        switch (state.step) {
            case 1:
                content = step1();
                break;
            case 2:
                content = step2();
                break;
            case 3:
                content = step3();
                break;
            case 4:
                content = step4(plotData.availableAreaM2);
                break;
            case 5:
                content = step5();
                break;
            case 6:
                content = step6();
                break;
            case 7:
                content = step7();
                break;
            case 8:
                content = step8();
                break;
            default:
                content = `<p>알 수 없는 단계입니다.</p>`
        }
        const modalContent = `
            ${content}
            <div class="modal-navigation">
                ${state.step > 1 ? '<button id="prev-step" class="btn secondary">이전</button>' : ''}
                <button id="next-step" class="btn">${state.step === 8 ? '건설 시작' : '다음'}</button>
            </div>
        `;
        openModal(modalContent, attachModalEvents);
    };

    const step1 = () => `
        <h2>새 건물 설계 - 1단계: 기본 정보</h2>
        <div class="kv-card">
            <div class="kv-label">건물 이름</div>
            <input type="text" id="buildingName" value="${esc(state.buildingName)}" placeholder="예: 중앙 본관">
        </div>
        <div class="kv-card" style="margin-top:8px;">
            <div class="kv-label">건물 용도</div>
            <select id="purposeId">
                <option value="">-- 선택 --</option>
                ${Object.entries(assets.buildingPurposes).map(([id, p]) => `<option value="${id}" ${state.purposeId === id ? 'selected' : ''}>${p.name}</option>`).join('')}
            </select>
            <small class="text-dim">${state.purposeId ? assets.buildingPurposes[state.purposeId].description : '건물의 주된 사용 목적을 선택하세요.'}</small>
        </div>
    `;

    const step2 = () => `
        <h2>새 건물 설계 - 2단계: 건축 양식</h2>
        <div class="grid-container">
            ${Object.entries(assets.architecturalStyles).map(([id, s]) => `
                <label class="radio-card ${state.styleId === id ? 'selected' : ''}">
                    <input type="radio" name="styleId" value="${id}" ${state.styleId === id ? 'checked' : ''}>
                    <div class="card-content">
                        <b>${s.name}</b>
                        <small>${s.description}</small>
                    </div>
                </label>
            `).join('')}
        </div>
    `;

    const step3 = () => `
        <h2>새 건물 설계 - 3단계: 주 자재</h2>
        <div class="grid-container">
            ${Object.entries(assets.buildingMaterials).map(([id, m]) => `
                <label class="radio-card ${state.materialId === id ? 'selected' : ''}">
                    <input type="radio" name="materialId" value="${id}" ${state.materialId === id ? 'checked' : ''}>
                    <div class="card-content">
                        <b>${m.name}</b>
                        <small>${m.description}</small>
                        <div class="text-dim" style="font-size: 11px; margin-top: 4px;">안전도: ${m.safetyModifier > 0 ? '+' : ''}${m.safetyModifier} / 비용: ${m.costModifier * 100}%</div>
                    </div>
                </label>
            `).join('')}
        </div>
    `;

    // ▼▼▼ [수정된 부분] ▼▼▼
    const step4 = (availableArea) => `
        <h2>새 건물 설계 - 4단계: 층수 & 면적</h2>
        <div class="grid2" style="gap:12px;">
            <div class="kv-card">
                <div class="kv-label">층수</div>
                <input type="number" id="floors" min="1" value="${state.floors || 1}">
            </div>
            <div class="kv-card">
                <div class="kv-label">한 층 면적 (m²)</div>
                <input type="number" id="baseAreaM2" min="1" value="${state.baseAreaM2 || 100}">
            </div>
        </div>
        
        <div class="kv-card" style="margin-top:8px;">
            <label class="row" style="gap:8px; align-items:center; cursor:pointer;">
                <input type="checkbox" id="copyFirstFloor" ${state.copyFirstFloor_enabled ? 'checked' : ''}>
                <span><b>1층 설계 나머지 층에 모두 복사</b> (아파트, 타워 등)</span>
            </label>
            <small class="text-dim">이 옵션을 선택하면 5단계에서 1층의 구역만 설정하고, 총면적이 아닌 1층 면적을 기준으로 구역을 나눕니다.</small>
        </div>

        <div class="kv-card" style="margin-top:8px;">
            <div class="kv-label">부지 점유 면적 (1층 면적) — 남은 면적: ${formatNumber(availableArea)}m²</div>
            <div><b id="baseAreaM2View">${formatNumber(state.baseAreaM2 || 100)}</b> m²</div>
        </div>
        <div class="kv-card" style="margin-top:8px;">
            <div class="kv-label">건물 총면적 (비용/자재 계산용)</div>
            <div><b id="totalAreaM2View">${formatNumber((state.floors || 1) * (state.baseAreaM2 || 100))}</b> m²</div>
        </div>
    `;
    // ▲▲▲ [수정된 부분] ▲▲▲

    const step5 = () => {
        // ▼▼▼ [수정된 부분] ▼▼▼
        const areaToDivide = state.copyFirstFloor_enabled ? state.baseAreaM2 : state.totalAreaM2;
        const areaLabel = state.copyFirstFloor_enabled ? `1층 면적(${formatNumber(areaToDivide)}m²)` : `건물 총면적(${formatNumber(areaToDivide)}m²)`;
        const currentSum = state.zones.reduce((sum, z) => sum + Number(z.areaM2 || 0), 0);
        // ▲▲▲ [수정된 부분] ▲▲▲

        return `
            <h2>새 건물 설계 - 5단계: 구역 분할</h2>
            <p>${areaLabel}에 맞춰 구역을 나눠주세요. 합계는 ${formatNumber(areaToDivide)}m²와 같아야 합니다.</p>
            <div id="zone-list">
                ${state.zones.map((zone, index) => `
                    <div class="zone-row" data-index="${index}">
                        <input type="text" class="zone-name" value="${esc(zone.name)}" placeholder="구역 이름 (예: 로비)">
                        <input type="number" class="zone-area" value="${zone.areaM2}" placeholder="면적 (m²)">
                        <button class="btn small danger remove-zone-btn">삭제</button>
                    </div>
                `).join('')}
            </div>
            <button id="add-zone-btn" class="btn secondary small" style="margin-top:8px;">구역 추가</button>
            <div style="margin-top:16px;">
                <b>현재 합계: <span id="zone-sum">${formatNumber(currentSum)}</span> m² / ${formatNumber(areaToDivide)} m²</b>
            </div>
        `;
    };

    const step6 = () => `<h2>새 건물 설계 - 6단계: 방 배치 (준비 중)</h2><p>각 구역에 어떤 방을 배치할지 설정합니다. (이 기능은 현재 개발 중입니다.)</p>`;
    const step7 = () => `<h2>새 건물 설계 - 7단계: 외관/내부 마감 (준비 중)</h2><p>건물의 외관과 내부 마감재를 선택합니다. (이 기능은 현재 개발 중입니다.)</p>`;

    const step8 = () => {
        state.designSummary = {
            name: state.buildingName,
            purpose: assets.buildingPurposes[state.purposeId],
            style: assets.architecturalStyles[state.styleId],
            material: assets.buildingMaterials[state.materialId],
            floors: state.floors,
            baseAreaM2: state.baseAreaM2,
            totalAreaM2: state.totalAreaM2,
            zones: state.zones,
            copyFirstFloor: state.copyFirstFloor_enabled,
        };

        const {
            summary,
            costs
        } = calculateDesignCosts(state.designSummary);

        state.finalCosts = costs; // 최종 비용 저장

        return `
            <h2>새 건물 설계 - 최종 확인</h2>
            <p>아래 내용을 확인하고 '건설 시작' 버튼을 눌러주세요.</p>
            <div class="kv-card">
                ${summary.map(s => `<div><strong>${s.label}:</strong> ${s.value}</div>`).join('')}
            </div>
            <div class="kv-card" style="margin-top:8px;">
                <h3>예상 비용 및 자재</h3>
                ${renderResourceCosts(costs)}
            </div>
        `;
    };


    const attachModalEvents = () => {
        const back = document.querySelector('.modal-content');
        if (!back) return;

        back.querySelector('#prev-step')?.addEventListener('click', () => {
            state.step--;
            renderStep();
        });

        back.querySelector('#next-step')?.addEventListener('click', async () => {
            if (await validateStep()) {
                if (state.step === 8) {
                    // 최종 제출 로직
                    submitConstructionProject();
                } else {
                    state.step++;
                    renderStep();
                }
            }
        });


        // Step-specific listeners
        if (state.step === 1) {
            back.querySelector('#buildingName').addEventListener('input', e => state.buildingName = e.target.value);
            back.querySelector('#purposeId').addEventListener('change', e => {
                state.purposeId = e.target.value;
                // re-render to show description
                renderStep();
            });
        }
        if (state.step === 2 || state.step === 3) {
            const groupName = state.step === 2 ? 'styleId' : 'materialId';
            back.querySelectorAll(`input[name="${groupName}"]`).forEach(radio => {
                radio.addEventListener('change', (e) => {
                    state[groupName] = e.target.value;
                    // re-render for visual feedback
                    renderStep();
                });
            });
        }
        if (state.step === 4) {
            const floorsInput = back.querySelector('#floors');
            const baseAreaInput = back.querySelector('#baseAreaM2');
            floorsInput.addEventListener('input', () => {
                state.floors = parseInt(floorsInput.value, 10) || 1;
                updateTotalArea();
            });
            baseAreaInput.addEventListener('input', () => {
                state.baseAreaM2 = parseInt(baseAreaInput.value, 10) || 0;
                updateTotalArea();
            });
            // ▼▼▼ [수정된 부분] ▼▼▼
            back.querySelector('#copyFirstFloor')?.addEventListener('change', e => {
                state.copyFirstFloor_enabled = e.target.checked;
                showToast(state.copyFirstFloor_enabled ? '1층 설계 복사 활성화' : '1층 설계 복사 비활성화', 'info');
                // 옵션 변경 시 5단계 구역 설정을 초기화
                state.zones = [];
            });
            // ▲▲▲ [수정된 부분] ▲▲▲
        }

        if (state.step === 5) {
            const zoneList = back.querySelector('#zone-list');
            const sumEl = back.querySelector('#zone-sum');
            const areaToDivide = state.copyFirstFloor_enabled ? state.baseAreaM2 : state.totalAreaM2;

            const updateZoneSum = () => {
                const currentSum = state.zones.reduce((sum, z) => sum + Number(z.areaM2 || 0), 0);
                sumEl.textContent = formatNumber(currentSum);
                if (currentSum === areaToDivide) {
                    sumEl.parentElement.style.color = 'var(--color-success)';
                } else {
                    sumEl.parentElement.style.color = 'var(--color-danger)';
                }
            };

            const updateStateFromUI = () => {
                const newZones = [];
                zoneList.querySelectorAll('.zone-row').forEach(row => {
                    newZones.push({
                        name: row.querySelector('.zone-name').value,
                        areaM2: Number(row.querySelector('.zone-area').value) || 0,
                    });
                });
                state.zones = newZones;
                updateZoneSum();
            };

            zoneList.addEventListener('input', updateStateFromUI);
            zoneList.addEventListener('click', (e) => {
                if (e.target.classList.contains('remove-zone-btn')) {
                    e.target.closest('.zone-row').remove();
                    updateStateFromUI();
                }
            });

            back.querySelector('#add-zone-btn').addEventListener('click', () => {
                const newZone = {
                    name: '',
                    areaM2: 0
                };
                state.zones.push(newZone);
                const index = state.zones.length - 1;

                const row = document.createElement('div');
                row.className = 'zone-row';
                row.dataset.index = index;
                row.innerHTML = `
                    <input type="text" class="zone-name" placeholder="구역 이름 (예: 로비)">
                    <input type="number" class="zone-area" placeholder="면적 (m²)">
                    <button class="btn small danger remove-zone-btn">삭제</button>
                `;
                zoneList.appendChild(row);
            });
        }
    };


    const validateStep = async () => {
        switch (state.step) {
            case 1:
                if (!state.buildingName.trim()) {
                    showToast('건물 이름을 입력해주세요.', 'error');
                    return false;
                }
                if (!state.purposeId) {
                    showToast('건물 용도를 선택해주세요.', 'error');
                    return false;
                }
                break;
            case 2:
                if (!state.styleId) {
                    showToast('건축 양식을 선택해주세요.', 'error');
                    return false;
                }
                break;
            case 3:
                if (!state.materialId) {
                    showToast('주 자재를 선택해주세요.', 'error');
                    return false;
                }
                break;
            case 4:
                if (state.baseAreaM2 <= 0 || state.floors <= 0) {
                    showToast('층수와 면적은 0보다 커야 합니다.', 'error');
                    return false;
                }
                if (state.baseAreaM2 > plotData.availableAreaM2) {
                    showToast('건물 1층 면적이 부지의 남은 면적보다 클 수 없습니다.', 'error');
                    return false;
                }
                break;
            case 5:
                // ▼▼▼ [수정된 부분] ▼▼▼
                const areaToDivide = state.copyFirstFloor_enabled ? state.baseAreaM2 : state.totalAreaM2;
                const totalZoneArea = state.zones.reduce((sum, z) => sum + Number(z.areaM2 || 0), 0);
                if (totalZoneArea !== areaToDivide) {
                    showToast(`구역 면적의 합계(${formatNumber(totalZoneArea)}m²)가 목표 면적(${formatNumber(areaToDivide)}m²)과 일치해야 합니다.`, 'error');
                    return false;
                }
                if (state.zones.some(z => !z.name.trim())) {
                    showToast('모든 구역의 이름을 입력해주세요.', 'error');
                    return false;
                }
                break;
                // ▲▲▲ [수정된 부분] ▲▲▲
        }
        return true;
    };


    const submitConstructionProject = async () => {
        // ▼▼▼ [수정된 부분] ▼▼▼
        let finalZones = state.zones;
        // 1층 복사 옵션이 활성화된 경우, 모든 층에 구역을 복제
        if (state.copyFirstFloor_enabled && state.floors > 1) {
            finalZones = [];
            for (let i = 1; i <= state.floors; i++) {
                state.zones.forEach(zone => {
                    finalZones.push({
                        ...zone,
                        name: `${i}층 - ${zone.name}`, // 각 층에 맞는 이름 부여
                    });
                });
            }
            // 면적 합계가 총면적과 맞는지 다시 한번 확인
            const totalZoneArea = finalZones.reduce((sum, z) => sum + Number(z.areaM2 || 0), 0);
            if (totalZoneArea !== state.totalAreaM2) {
                showToast(`[오류] 복사된 구역의 총면적(${formatNumber(totalZoneArea)}m²)이 건물 총면적(${formatNumber(state.totalAreaM2)}m²)과 일치하지 않습니다.`, 'error');
                return;
            }
        }
        // ▲▲▲ [수정된 부분] ▲▲▲

        const payload = {
            plotId: plotDocId,
            design: {
                type: 'building',
                name: state.buildingName,
                purposeId: state.purposeId,
                styleId: state.styleId,
                materialId: state.materialId,
                floors: state.floors,
                baseAreaM2: state.baseAreaM2,
                totalAreaM2: state.totalAreaM2,
                zones: finalZones.map(z => ({ // finalZones 사용
                    name: z.name,
                    areaM2: z.areaM2,
                    rooms: [] // 방 배치는 나중에
                })),
            },
            costs: state.finalCosts,
        };

        try {
            const startConstruction = httpsCallable(functions, 'startConstructionProject');
            showToast('건설 프로젝트를 서버에 제출 중입니다...', 'info');
            const result = await startConstruction(payload);
            closeModal();
            showToast(result.data.message, 'success');
        } catch (error) {
            console.error("건설 시작 오류:", error);
            showToast(`오류가 발생했습니다: ${error.message}`, 'error');
        }
    };

    renderStep();
}

function calculateDesignCosts(designSummary) {
    const {
        purpose,
        style,
        material,
        totalAreaM2
    } = designSummary;
    const summary = [{
            label: '이름',
            value: esc(designSummary.name)
        },
        {
            label: '용도',
            value: esc(purpose.name)
        },
        {
            label: '건축 양식',
            value: esc(style.name)
        },
        {
            label: '주 자재',
            value: esc(material.name)
        },
        {
            label: '규모',
            value: `${designSummary.floors}층, 총 ${formatNumber(totalAreaM2)}m²`
        },
        // ▼▼▼ [수정된 부분] ▼▼▼
        {
            label: '구역 설정',
            value: `${designSummary.zones.length}개 구역 ${designSummary.copyFirstFloor ? '(1층 설계 복사됨)' : ''}`
        },
        // ▲▲▲ [수정된 부분] ▲▲▲
    ];

    // 비용 계산 로직 (functions/construction.js와 유사하게)
    const baseCostPerM2 = 100; // m²당 기본 비용
    const cost = Math.round(totalAreaM2 * baseCostPerM2 * style.costModifier * material.costModifier);

    // 자재 계산 로직
    const materials = {};
    const primaryMaterial = material.id;
    materials[primaryMaterial] = (materials[primaryMaterial] || 0) + totalAreaM2 * 2; // m²당 2단위
    style.requiredMaterials.forEach(mat => {
        materials[mat.id] = (materials[mat.id] || 0) + totalAreaM2 * mat.amountPerM2;
    });

    const costs = {
        money: cost,
        items: Object.entries(materials).map(([id, amount]) => ({
            id,
            amount: Math.ceil(amount)
        })),
        labor: Math.ceil(totalAreaM2 * 5), // m²당 5 노동력
    };

    return {
        summary,
        costs
    };
}


function cleanup() {
    if (unsubscribePlot) {
        unsubscribePlot();
        unsubscribePlot = null;
    }
    if (unsubscribePlayer) {
        unsubscribePlayer();
        unsubscribePlayer = null;
    }
    currentPlotData = null;
    currentPlotDocId = null;
    allCharacters = [];
}

export const landManagement = {
    init,
    cleanup,
    loadAssets
};
