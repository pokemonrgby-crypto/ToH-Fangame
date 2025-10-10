// /functions/construction.js
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { FieldValue } = require('firebase-admin/firestore');
const admin = require('firebase-admin');
const db = admin.firestore();
const { v4: uuidv4 } = require('uuid');

// 에셋 로더와 유틸리티
const { buildingMaterials, researchTree } = require('./assets');
const { deductItemsFromInventory, ensureCharacterSkills } = require('./utils');

const MATERIAL_BUYOUT_MULTIPLIER = 2.5; // 자재 긴급 구매 배수

/**
 * 커스텀 설계 요구량/비용/시간/미관 계산
 */
function calculateCustomRequirements({ design, constructionLevel = 1, artStat = 1 }) {
  const materialsData = buildingMaterials();
  if (!materialsData) throw new Error('Building materials asset not found.');

  const { totalArea = 0, materials: designMaterials = {} } = design;

  const requiredMaterials = {};
  if (designMaterials.main) {
    requiredMaterials[designMaterials.main] = (requiredMaterials[designMaterials.main] || 0) + Math.floor(totalArea * 1.8);
  }
  if (designMaterials.secondary) {
    requiredMaterials[designMaterials.secondary] =
      (requiredMaterials[designMaterials.secondary] || 0) + Math.floor(totalArea * 1.2);
  }
  (designMaterials.special || []).forEach((matId) => {
    requiredMaterials[matId] = (requiredMaterials[matId] || 0) + Math.floor(totalArea / 50); // 50m²당 1개
  });

  let baseCost = 0;
  let aestheticValue = 0;
  for (const matId in requiredMaterials) {
    const matInfo = materialsData[matId];
    if (!matInfo) continue;
    baseCost += (matInfo.basePrice || 1) * requiredMaterials[matId];
    if (matInfo.aesthetic_modifier) {
      aestheticValue += requiredMaterials[matId] * (matInfo.aesthetic_modifier - 1) * 10;
    }
  }
  const constructionCost = Math.floor(baseCost * 1.2);

  const aestheticChance = artStat * 0.005;
  if (Math.random() < aestheticChance) {
    aestheticValue *= 1.5 + Math.random();
    aestheticValue += 100;
  }
  aestheticValue = Math.floor(aestheticValue + totalArea * 0.1);

  // duration: 분 단위
  const baseDuration = Math.floor(totalArea * 0.5);
  const durationMultiplier = 1 / (1 + (constructionLevel - 1) * 0.05);
  const durationMinutes = Math.max(10, Math.floor(baseDuration * durationMultiplier));

  return { materials: requiredMaterials, cost: constructionCost, durationMinutes, aestheticValue };
}

/**
 * 건설 시작
 * 입력: { plotId, design{ name,type,style,scale,heightM,totalArea,zones[],materials{main,secondary,special[]}}, contractor{ type,id?,level? }, allowMaterialBuyout }
 * 응답: { success:true, projectId, message }
 */
exports.startConstruction = onCall({ region: 'us-central1' }, async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');

  const {
    plotId,
    design,
    contractor,
    allowMaterialBuyout = false,
  } = req.data || {};

  // 기본 검증
  if (
    !plotId || !design || !contractor ||
    !(Number(design.totalArea) > 0) ||
    !Array.isArray(design.zones) || design.zones.length < 1 ||
    !design.type || !design.style || !design.scale ||
    !design.materials || !design.materials.main
  ) {
    throw new HttpsError('invalid-argument', '필수 설계 정보가 누락되었습니다.');
  }

  let constructionLevel = 1;
  let artStat = 1;
  let laborCost = 0;

  try {
    const result = await db.runTransaction(async (tx) => {
      const userRef = db.collection('users').doc(uid);
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) throw new HttpsError('not-found', '사용자 정보를 찾을 수 없습니다.');
      const userData = userSnap.data();

      // 부지 검증(면적 한도)
      const plotRef = db.collection('land_plots').doc(plotId);
      const plotSnap = await tx.get(plotRef);
      if (!plotSnap.exists) throw new HttpsError('not-found', '부지를 찾을 수 없습니다.');
      const plot = plotSnap.data() || {};
      const totalArea = Number(plot.totalArea || 10000);
      const usedArea = Number(plot.usedArea || 0);
      const availableArea = Math.max(0, totalArea - usedArea);
      if (Number(design.totalArea) > availableArea) {
        throw new HttpsError('failed-precondition', `남은 면적(${availableArea}m²)을 초과했습니다.`);
      }

      // 선행 지식 체크(예시)
      const needKnowledge = new Set();
      for (const z of design.zones) {
        if (z.purpose === 'laboratory') needKnowledge.add('basic_chemistry');
      }
      if (needKnowledge.size) {
        const knowRef = db.collection('knowledge').doc(uid);
        const knowSnap = await tx.get(knowRef);
        const know = knowSnap.exists ? knowSnap.data() : {};
        for (const k of needKnowledge) {
          if (!know[k] || Number(know[k].understanding || 0) < 100) {
            const techName = (researchTree().projects?.[k]?.name) || k;
            throw new HttpsError('failed-precondition', `필요한 기술(${techName})이 부족합니다.`);
          }
        }
      }

      // 시공 주체(캐릭터/NPC/기타)
      if (contractor.type === 'character' && contractor.id) {
        const charRef = db.collection('chars').doc(contractor.id);
        const charSnap = await tx.get(charRef);
        const charData = charSnap.exists ? charSnap.data() : null;
        if (!charData || charData.owner_uid !== uid) {
          throw new HttpsError('permission-denied', '유효하지 않은 캐릭터입니다.');
        }
        const ensured = await ensureCharacterSkills(tx, charRef, charData);
        constructionLevel = ensured.skills?.construction?.level || 1;
        artStat = ensured.skills?.art?.level || 1;
        tx.update(charRef, { status: 'constructing' });
      } else if (contractor.type === 'npc' && contractor.level) {
        constructionLevel = Math.max(1, Math.min(100, Number(contractor.level)));
        artStat = Math.floor(constructionLevel / 2);
        laborCost = Math.floor(50 * Math.pow(constructionLevel, 1.5));
      } else {
        // self/player/company 등: 레벨 1 기본치
        constructionLevel = 1;
        artStat = 1;
      }

      // 요구량/비용/시간 계산
      const { materials: reqMats, cost, durationMinutes, aestheticValue } =
        calculateCustomRequirements({ design, constructionLevel, artStat });

      // 재고/긴급구매 처리
      const matsAsset = buildingMaterials();
      let materialBuyoutCost = 0;
      const toDeduct = {};
      const items = userData.items_all || [];

      for (const matId in reqMats) {
        const need = reqMats[matId];
        const inv = items.find(it => (it.id === matId) || (it.itemId === matId));
        const have = inv ? Number(inv.count || inv.quantity || 0) : 0;

        if (have < need) {
          if (!allowMaterialBuyout) {
            const name = matsAsset?.[matId]?.name || matId;
            throw new HttpsError('failed-precondition', `자재(${name})가 부족합니다.`);
          }
          const miss = need - have;
          materialBuyoutCost += miss * (matsAsset?.[matId]?.basePrice || 1) * MATERIAL_BUYOUT_MULTIPLIER;
          if (have > 0) toDeduct[matId] = have;
        } else {
          toDeduct[matId] = need;
        }
      }

      // 최종 비용 차감
      const finalCost = Math.ceil(cost + laborCost + materialBuyoutCost);
      if ((userData.coins || 0) < finalCost) {
        throw new HttpsError('failed-precondition', `비용이 부족합니다. (필요: ${finalCost})`);
      }
      tx.update(userRef, { coins: FieldValue.increment(-finalCost) });

      // 자재 차감
      if (Object.keys(toDeduct).length > 0) {
        await deductItemsFromInventory(tx, uid, toDeduct);
      }

      // 프로젝트 생성
      const projectId = uuidv4();
      const projectRef = db.collection('construction_projects').doc(projectId);
      const serverNow = admin.firestore.Timestamp.now(); // 레퍼런스용
      const completionTime = new Date(Date.now() + durationMinutes * 60 * 1000);

      tx.set(projectRef, {
        ownerId: uid,
        plotId,
        projectId,
        design,                 // 설계 전문 저장
        contractor,
        status: 'inprogress',
        startTime: FieldValue.serverTimestamp(),
        completionTime,         // Date 저장(나중에 .toDate()로 사용 가능)
        baseAestheticValue: aestheticValue,
        estimatedCost: finalCost,
      });

      return { success: true, projectId, message: `'${design.name}' 건설을 시작합니다!` };
    });

    return result;
  } catch (err) {
    console.error('startConstruction failed:', err);
    if (err instanceof HttpsError) throw err;
    throw new HttpsError('internal', '건설 시작 중 오류가 발생했습니다.');
  }
});

/**
 * 건설 완료
 * 입력: { projectId }
 * 완공 처리: buildings(임베디드: land_plots.facilities)에 건물 추가 + usedArea 증가 + 프로젝트 삭제
 */
exports.completeConstruction = onCall({ region: 'us-central1' }, async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');

  const { projectId } = req.data || {};
  if (!projectId) throw new HttpsError('invalid-argument', 'projectId가 필요합니다.');

  const projectRef = db.collection('construction_projects').doc(projectId);

  try {
    const building = await db.runTransaction(async (tx) => {
      const pSnap = await tx.get(projectRef);
      if (!pSnap.exists) throw new HttpsError('not-found', '건설 프로젝트를 찾을 수 없습니다.');
      const p = pSnap.data();
      if (p.ownerId !== uid) throw new HttpsError('permission-denied', '프로젝트 소유주가 아닙니다.');
      const now = new Date();
      const finishAt = p.completionTime?.toDate ? p.completionTime.toDate() : new Date(p.completionTime);
      if (now < finishAt) throw new HttpsError('failed-precondition', '아직 건설이 완료되지 않았습니다.');

      const plotRef = db.collection('land_plots').doc(p.plotId);
      const plotSnap = await tx.get(plotRef);
      if (!plotSnap.exists) throw new HttpsError('not-found', '부지를 찾을 수 없습니다.');
      const plot = plotSnap.data() || {};

      // 설계에서 필드 꺼내기
      const d = p.design || {};
      const buildingId = uuidv4();

      const newBuilding = {
        id: buildingId,
        name: d.name,
        type: d.type,
        style: d.style,
        scale: d.scale,                 // 'small'|'medium'|'large'|'xlarge'
        heightM: Number(d.heightM || 0),
        totalArea: Number(d.totalArea || 0),
        zones: Array.isArray(d.zones) ? d.zones : [],
        materials: d.materials || {},
        contractor: p.contractor,
        completedAt: finishAt,

        // 관리/표시용 초기값
        managerCharId: null,
        collapseChance: 1.0,
        safetyLevel: '안전',
        profitability: 0,
        baseAestheticValue: p.baseAestheticValue || 0,
        finalAestheticGrade: 'F',
        placed_facilities: [],
        status: 'active',
      };

      // usedArea 증가 + 시설 추가(배열 갱신)
      const prevFacilities = Array.isArray(plot.facilities) ? plot.facilities : [];
      const nextFacilities = prevFacilities.concat([newBuilding]);
      const nextUsedArea = Number(plot.usedArea || 0) + Number(d.totalArea || 0);

      tx.update(plotRef, {
        facilities: nextFacilities,
        usedArea: nextUsedArea,
      });

      // 프로젝트 삭제
      tx.delete(projectRef);

      return newBuilding;
    });

    return { success: true, message: `'${building.name}' 건물이 완공되었습니다!`, building };
  } catch (err) {
    console.error('completeConstruction failed:', err);
    if (err instanceof HttpsError) throw err;
    throw new HttpsError('internal', '건물 완공 처리 중 오류가 발생했습니다.');
  }
});

/**
 * 건물 관리자 지정 (임베디드 건물 업데이트)
 * 입력: { plotId, buildingId, charId }
 */
exports.assignManager = onCall({ region: 'us-central1' }, async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');

  const { plotId, buildingId, charId } = req.data || {};
  if (!plotId || !buildingId) throw new HttpsError('invalid-argument', 'plotId/buildingId가 필요합니다.');

  try {
    await db.runTransaction(async (tx) => {
      const plotRef = db.collection('land_plots').doc(plotId);
      const snap = await tx.get(plotRef);
      if (!snap.exists) throw new HttpsError('not-found', '부지를 찾을 수 없습니다.');

      // TODO: 소유권 검증 필요시 추가 (uid vs plot.ownerUid)

      const data = snap.data() || {};
      const facs = Array.isArray(data.facilities) ? data.facilities.slice() : [];
      const idx = facs.findIndex((f) => f.id === buildingId);
      if (idx < 0) throw new HttpsError('not-found', '해당 건물을 찾을 수 없습니다.');

      facs[idx] = { ...facs[idx], managerCharId: charId || null };
      tx.update(plotRef, { facilities: facs });
    });

    return { success: true };
  } catch (err) {
    console.error('assignManager failed:', err);
    if (err instanceof HttpsError) throw err;
    throw new HttpsError('internal', '관리자 지정 중 오류가 발생했습니다.');
  }
});

/**
 * 건물 관리 액션
 * 입력: { plotId, buildingId, action, payload }
 */
exports.manageBuilding = onCall({ region: 'us-central1' }, async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');

  const { plotId, buildingId, action, payload } = req.data || {};
  if (!plotId || !buildingId || !action) {
    throw new HttpsError('invalid-argument', '필수 정보(plotId, buildingId, action)가 누락되었습니다.');
  }

  try {
    let resultMessage = '';
    await db.runTransaction(async (tx) => {
      const plotRef = db.collection('land_plots').doc(plotId);
      const snap = await tx.get(plotRef);
      if (!snap.exists) throw new HttpsError('not-found', '부지를 찾을 수 없습니다.');

      // TODO: 소유권 검증 (uid vs plot.ownerUid)
      const data = snap.data() || {};
      const facs = Array.isArray(data.facilities) ? data.facilities.slice() : [];
      const idx = facs.findIndex((f) => f.id === buildingId);
      if (idx < 0) throw new HttpsError('not-found', '해당 건물을 찾을 수 없습니다.');

      let b = { ...facs[idx] };

      const height = Number(b.heightM || b.height || 0);
      const isXL = (b.scale === 'xlarge' || b.scale === '초대형');

      if (action === 'inspect_collapse') {
        b.collapseChance = Number(b.collapseChance || 1.0);
        b.collapseChance += Math.random() * (height / 100) + (isXL ? 1 : 0);
        if (b.collapseChance > 100) b.collapseChance = 100;

        // 안전도 재평가
        const cc = b.collapseChance;
        b.safetyLevel =
          cc > 90 ? '붕괴 직전' :
          cc > 70 ? '위급' :
          cc > 40 ? '위험' :
          cc > 15 ? '불안' : '안전';

        b.lastInspection = new Date();
        resultMessage = `[${b.name}] 붕괴도 조사 완료. 현재 안전도: ${b.safetyLevel} (${cc.toFixed(2)}%)`;
      }
      else if (action === 'repair') {
        if (!['불안', '위험', '위급'].includes(b.safetyLevel)) {
          throw new HttpsError('failed-precondition', "보수 작업은 '불안', '위험', '위급'일 때만 가능합니다.");
        }
        b.collapseChance = Math.max(1.0, Number(b.collapseChance || 1.0) - (Math.random() * 15 + 10));
        // 안전도 재평가
        const cc = b.collapseChance;
        b.safetyLevel =
          cc > 90 ? '붕괴 직전' :
          cc > 70 ? '위급' :
          cc > 40 ? '위험' :
          cc > 15 ? '불안' : '안전';
        resultMessage = `[${b.name}] 보수 작업 완료. 현재 안전도: ${b.safetyLevel} (${cc.toFixed(2)}%)`;
      }
      else if (action === 'rebuild') {
        if (b.safetyLevel !== '붕괴 직전') {
          throw new HttpsError('failed-precondition', "재건축은 '붕괴 직전' 상태에서만 가능합니다.");
        }
        // 실제 재건축은 별도의 startConstruction 흐름으로 새 프로젝트를 만드는 편이 안전.
        b.status = 'rebuild_required';
        resultMessage = `[${b.name}] 재건축 플래그가 설정되었습니다.`;
      }
      else if (action === 'inspect_aesthetic') {
        let totalAesthetic = Number(b.baseAestheticValue || 0);
        // TODO: placed_facilities/items의 미관 가산 로직
        b.finalAestheticGrade =
          totalAesthetic > 1000 ? 'SSS' :
          totalAesthetic > 700 ? 'SS' :
          totalAesthetic > 500 ? 'S' :
          totalAesthetic > 300 ? 'A' :
          totalAesthetic > 150 ? 'B' :
          totalAesthetic > 50 ? 'C' : 'F';
        resultMessage = `[${b.name}] 미관도 조사 완료. 최종 등급: ${b.finalAestheticGrade} (${totalAesthetic}점)`;
      }
      else if (action === 'inspect_profit') {
        // 간단 계산 예시: 타입/면적/미관 보정
        const basePer100 = 20; // TODO: building_types 에셋 적용
        const area = Number(b.totalArea || 0);
        const aesthetic = Number(b.baseAestheticValue || 0);
        const gph = basePer100 * (area / 100) * (1 + aesthetic / 200);
        b.profitability = Math.round(gph);
        resultMessage = `[${b.name}] 추정 수익성: ${b.profitability} G/h`;
      }
      else {
        throw new HttpsError('invalid-argument', '알 수 없는 관리 명령입니다.');
      }

      facs[idx] = b;
      tx.update(plotRef, { facilities: facs });
    });

    return { success: true, message: resultMessage };
  } catch (err) {
    console.error(`manageBuilding failed:`, err);
    if (err instanceof HttpsError) throw err;
    throw new HttpsError('internal', err.message || '건물 관리 명령 수행 중 오류가 발생했습니다.');
  }
});
