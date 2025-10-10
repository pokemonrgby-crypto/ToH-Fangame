// /functions/construction.js  (전체 교체)
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const admin = require('firebase-admin');
const db = admin.firestore();
const { v4: uuidv4 } = require('uuid');

// 에셋 로더들 (없으면 안전하게 fallback)
const { buildingMaterials, researchTree, roomsCatalog } = require('./assets');
const { deductItemsFromInventory, ensureCharacterSkills } = require('./utils');

/* =======================
 * 튜닝 상수
 * ======================= */
const MATERIAL_BUYOUT_MULTIPLIER = 2.5;     // 자재 긴급 구매 배수
const BASE_NPC_UNIT_COST = 40;              // NPC 1인 기본비용
const NPC_COST_GROWTH = 1.12;               // NPC 비용 지수 성장(레벨당)
const WORK_UNIT_AREA = 50;                  // 공정 1칸 = 50 m²
const RECRUIT_MIN_PER_UNIT = 10;            // 인원 모집형(자체/타인/건설사)의 모집 시간: 유닛당 10분
const AUTO_CREATE_PLOT_IF_MISSING = true;   // 부지 문서 없을 때 자동 생성(오류 방지)

/* =======================
 * 보조 계산기
 * ======================= */
function safeAssets(fn, fallback = {}) {
  try { return fn?.() || fallback; } catch { return fallback; }
}

function npcMemberCost(level) {
  // 지수 성장 비용
  return Math.ceil(BASE_NPC_UNIT_COST * Math.pow(NPC_COST_GROWTH, Number(level || 1)));
}

function npcTeamCost(npcTeam = []) {
  // [{level, count}]
  return npcTeam.reduce((sum, m) => sum + npcMemberCost(m.level) * Math.max(1, Number(m.count || 1)), 0);
}

function npcTeamLaborPower(npcTeam = []) {
  // 노동 파워: 레벨에 선형 가중(완만), 수는 합산
  // (1 + level*0.03) * count
  return npcTeam.reduce((sum, m) => sum + (1 + Number(m.level || 1) * 0.03) * Math.max(1, Number(m.count || 1)), 0);
}

function charsLaborStats(chars = []) {
  // { lvSum, artSum, power }  // power는 (1 + lv*0.04) 합산
  let lvSum = 0, artSum = 0, power = 0;
  for (const c of chars) {
    const lv = Number(c?.skills?.construction?.level || 1);
    const art = Number(c?.skills?.art?.level || 0);
    lvSum += lv;
    artSum += art;
    power += 1 + lv * 0.04;
  }
  return { lvSum, artSum, power };
}

function workUnits(totalArea) {
  return Math.max(1, Math.ceil(Number(totalArea || 0) / WORK_UNIT_AREA));
}

function minutesFromUnits(units, laborPower) {
  // 기본: 유닛당 20분 → 노동 파워로 나눔(감소), 최소 10분
  const base = units * 20;
  const divisor = Math.max(1, 1 + laborPower); // 파워 0이면 1, 파워 n이면 (1+n)로 나눔
  return Math.max(10, Math.floor(base / divisor));
}

function aestheticBonusFromLabor({ npcTeam = [], chars = [] }) {
  // NPC: 레벨 합의 0.5%p, 캐릭터: 미술 스탯 합의 1%p
  const teamLvSum = npcTeam.reduce((s, m) => s + Number(m.level || 1) * Math.max(1, Number(m.count || 1)), 0);
  const charArtSum = chars.reduce((s, c) => s + Number(c?.skills?.art?.level || 0), 0);
  return teamLvSum * 0.5 + charArtSum * 1.0; // 점수로 더함(비율X)
}

/* =======================
 * 요구량/비용/시간/미관 계산
 * ======================= */
function calculateCustomRequirements({ design, constructionLevel = 1, artStat = 0 }) {
  const mats = safeAssets(buildingMaterials, {});
  const { totalArea = 0, materials: dm = {} } = design || {};

  const req = {};
  if (dm.main) req[dm.main] = (req[dm.main] || 0) + Math.floor(totalArea * 1.8);
  if (dm.secondary) req[dm.secondary] = (req[dm.secondary] || 0) + Math.floor(totalArea * 1.2);
  (dm.special || []).forEach(id => { req[id] = (req[id] || 0) + Math.floor(totalArea / 50); });

  let baseCost = 0, aestheticValue = 0;
  for (const id in req) {
    const info = mats[id];
    const price = Number(info?.basePrice || 1);
    baseCost += price * req[id];
    if (info?.aesthetic_modifier) {
      aestheticValue += req[id] * (info.aesthetic_modifier - 1) * 10;
    }
  }
  const buildCost = Math.floor(baseCost * 1.2);

  // 미관: 아트 스탯 보정
  aestheticValue = Math.floor(aestheticValue + (totalArea * 0.1) + artStat * 2);

  // durationMinutes는 외부에서 laborPower로 재산정
  const baseUnits = workUnits(totalArea);
  return { materials: req, cost: buildCost, baseUnits, aestheticValue };
}

/* =======================
 * 유효성 보강(방/룸 검증)
 * ======================= */
function validateRooms(design) {
  const rooms = safeAssets(roomsCatalog, null);
  if (!rooms) return; // 에셋 없으면 스킵(호환)
  const type = design?.type;
  for (const z of (design?.zones || [])) {
    if (!z.roomId) continue; // roomId 없는 기존 설계와 호환
    const r = rooms[z.roomId];
    if (!r) throw new HttpsError('invalid-argument', `알 수 없는 방(roomId=${z.roomId})입니다.`);
    if (Array.isArray(r.forTypes) && r.forTypes.length && !r.forTypes.includes(type)) {
      throw new HttpsError('failed-precondition', `방(${r.label})은 ${type} 유형 건물에 배정할 수 없습니다.`);
    }
  }
}

/* =======================
 * 시작: 건설
 * ======================= */
/**
 * 입력:
 * {
 *   plotId,
 *   design: {
 *     name, type, style, scale, heightM, totalArea,
 *     zones: [{ name, roomId?, purpose?, areaM2 }],
 *     materials: { main, secondary, special:[] }
 *   },
 *   contractor: {
 *     // 아래 3가지 방식 중 하나
 *     type: 'npc_team', npcTeam: [{level, count}]
 *     type: 'characters', charIds: [charId,...]
 *     type: 'self' | 'player' | 'company', id?: string
 *   },
 *   allowMaterialBuyout: true
 * }
 */
exports.startConstruction = onCall({ region: 'us-central1' }, async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');

  const { plotId, design, contractor, allowMaterialBuyout = false } = req.data || {};

  // 필수 설계 검증
  if (
    !plotId || !design || !contractor ||
    !(Number(design.totalArea) > 0) ||
    !Array.isArray(design.zones) || design.zones.length < 1 ||
    !design.type || !design.style || !design.scale ||
    !design.materials || !design.materials.main
  ) {
    throw new HttpsError('invalid-argument', '필수 설계 정보가 누락되었습니다.');
  }
  validateRooms(design);

  try {
    const result = await db.runTransaction(async (tx) => {
      // 유저
      const userRef = db.collection('users').doc(uid);
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) throw new HttpsError('not-found', '사용자 정보를 찾을 수 없습니다.');
      const user = userSnap.data();

      // 부지
      const plotRef = db.collection('land_plots').doc(plotId);
      let plotSnap = await tx.get(plotRef);
      if (!plotSnap.exists) {
        if (!AUTO_CREATE_PLOT_IF_MISSING) {
          throw new HttpsError('not-found', '부지를 찾을 수 없습니다.');
        }
        // 없으면 자동 생성(남은 면적 10,000m²)
        tx.set(plotRef, { totalArea: 10000, usedArea: 0, facilities: [], tasks: [], ownerId: uid });
        plotSnap = await tx.get(plotRef);
      }
      const plot = plotSnap.data() || {};
      const totalArea = Number(plot.totalArea || 10000);
      const usedArea = Number(plot.usedArea || 0);
      const availableArea = Math.max(0, totalArea - usedArea);
      if (Number(design.totalArea) > availableArea) {
        throw new HttpsError('failed-precondition', `남은 면적(${availableArea}m²)을 초과했습니다.`);
      }

      // 시공 주체 정리
      let npcTeam = [];
      let charRefs = [];
      if (contractor.type === 'npc_team') {
        npcTeam = (contractor.npcTeam || [])
          .map(m => ({ level: Math.max(1, Math.min(100, Number(m.level || 1))), count: Math.max(1, Number(m.count || 1)) }))
          .filter(m => m.count > 0);
        if (!npcTeam.length) throw new HttpsError('invalid-argument', 'NPC 팀 구성이 비었습니다.');
      } else if (contractor.type === 'characters') {
        const ids = Array.isArray(contractor.charIds) ? contractor.charIds.slice(0, 8) : [];
        if (!ids.length) throw new HttpsError('invalid-argument', '참여 캐릭터가 없습니다.');
        for (const id of ids) {
          const ref = db.collection('chars').doc(id);
          const snap = await tx.get(ref);
          if (!snap.exists) throw new HttpsError('not-found', '캐릭터를 찾을 수 없습니다.');
          const c = snap.data();
          if (c.owner_uid !== uid) throw new HttpsError('permission-denied', '내 캐릭터만 참여할 수 있습니다.');
          if (c.activeTaskId) throw new HttpsError('failed-precondition', `캐릭터(${c.name})는 이미 다른 작업 중입니다.`);
          charRefs.push({ ref, data: c });
        }
      } else {
        // self/player/company → 모집형 처리
      }

      // 노동력 파라미터
      let laborPower = 0, artStat = 0, extraLaborCost = 0;
      if (npcTeam.length) {
        laborPower += npcTeamLaborPower(npcTeam);
        extraLaborCost += npcTeamCost(npcTeam);
        artStat += npcTeam.reduce((s, m) => s + m.level * m.count, 0) * 0.2; // 레벨 총합의 20%를 아트 보정으로
      }
      if (charRefs.length) {
        // 스킬 보장 + 합산
        let chars = [];
        for (const cr of charRefs) {
          const ensured = await ensureCharacterSkills(tx, cr.ref, cr.data);
          chars.push(ensured);
        }
        const { power, artSum } = charsLaborStats(chars);
        laborPower += power;
        artStat += artSum;
      }

      // 요구량/기본비용/유닛 수/미관
      const { materials: reqMats, cost: buildCost, baseUnits, aestheticValue: baseAesthetic } =
        calculateCustomRequirements({ design, constructionLevel: 1, artStat });

      // 자재 차감/긴급구매
      const matsAsset = safeAssets(buildingMaterials, {});
      const items = user.items_all || [];
      let buyoutCost = 0;
      const toDeduct = {};
      for (const id in reqMats) {
        const need = Number(reqMats[id] || 0);
        const inv = items.find(it => (it.id === id) || (it.itemId === id));
        const have = inv ? Number(inv.count || inv.quantity || 0) : 0;
        if (have < need) {
          if (!allowMaterialBuyout) {
            const nm = matsAsset?.[id]?.name || id;
            throw new HttpsError('failed-precondition', `자재(${nm})가 부족합니다.`);
          }
          const miss = need - have;
          buyoutCost += miss * Number(matsAsset?.[id]?.basePrice || 1) * MATERIAL_BUYOUT_MULTIPLIER;
          if (have > 0) toDeduct[id] = have;
        } else {
          toDeduct[id] = need;
        }
      }

      // 최종 비용(자재+NPC 팀)
      const finalCost = Math.ceil(buildCost + buyoutCost + extraLaborCost);
      if (Number(user.coins || 0) < finalCost) {
        throw new HttpsError('failed-precondition', `비용이 부족합니다. (필요: ${finalCost})`);
      }
      tx.update(userRef, { coins: FieldValue.increment(-finalCost) });

      // 자재 차감
      if (Object.keys(toDeduct).length) {
        await deductItemsFromInventory(tx, uid, toDeduct);
      }

      // 작업 유닛/예상 시간
      const unitsTotal = baseUnits;
      const isRecruitType = !npcTeam.length && !charRefs.length; // self/player/company
      const durationMinutes = isRecruitType
        ? unitsTotal * RECRUIT_MIN_PER_UNIT // 모집 기간(후속 공정은 태스크 진행으로 처리)
        : minutesFromUnits(unitsTotal, laborPower);

      const projectId = uuidv4();
      const taskId = uuidv4();
      const now = Timestamp.now();
      const completionTime = isRecruitType
        ? null
        : new Date(Date.now() + durationMinutes * 60 * 1000);

      // 부지 작업 큐(tasks) 등록
      const prevTasks = Array.isArray(plot.tasks) ? plot.tasks.slice() : [];
      prevTasks.push({
        id: taskId,
        type: 'construction',
        projectId,
        plotId,
        status: isRecruitType ? 'recruiting' : 'active',
        unitsTotal,
        unitsDone: 0,
        assigned: {
          npcTeam: npcTeam,                         // [{level,count}]
          charIds: charRefs.map(c => c.ref.id),     // []
        },
        createdAt: now,
        recruitmentUntil: isRecruitType
          ? Timestamp.fromDate(new Date(Date.now() + durationMinutes * 60 * 1000))
          : null
      });

      // 캐릭터 점유(단일 작업 원칙)
      for (const cr of charRefs) {
        tx.update(cr.ref, { activeTaskId: taskId, status: 'busy' });
      }

      // 프로젝트 문서
      const projectRef = db.collection('construction_projects').doc(projectId);
      tx.set(projectRef, {
        ownerId: uid,
        plotId,
        projectId,
        design,
        contractor: {
          type: contractor.type,
          npcTeam,
          charIds: charRefs.map(c => c.ref.id),
          externalId: contractor.id || null
        },
        status: isRecruitType ? 'recruiting' : 'inprogress',
        startTime: FieldValue.serverTimestamp(),
        completionTime: completionTime, // recruiting이면 null
        baseAestheticValue: Math.floor(baseAesthetic + aestheticBonusFromLabor({ npcTeam, chars: charRefs.map(c => c.data) })),
        estimatedCost: finalCost,
        taskId
      });

      // 부지 문서 업데이트(tasks만)
      tx.update(plotRef, { tasks: prevTasks });

      return { success: true, projectId, taskId, message: `'${design.name}' 건설을 시작합니다!` };
    });

    return result;
  } catch (err) {
    console.error('startConstruction failed:', err);
    if (err instanceof HttpsError) throw err;
    throw new HttpsError('internal', '건설 시작 중 오류가 발생했습니다.');
  }
});

/* =======================
 * 완공 처리
 * ======================= */
exports.completeConstruction = onCall({ region: 'us-central1' }, async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  const { projectId } = req.data || {};
  if (!projectId) throw new HttpsError('invalid-argument', 'projectId가 필요합니다.');

  try {
    const building = await db.runTransaction(async (tx) => {
      const projectRef = db.collection('construction_projects').doc(projectId);
      const pSnap = await tx.get(projectRef);
      if (!pSnap.exists) throw new HttpsError('not-found', '건설 프로젝트를 찾을 수 없습니다.');
      const p = pSnap.data();
      if (p.ownerId !== uid) throw new HttpsError('permission-denied', '프로젝트 소유주가 아닙니다.');
      if (p.status === 'recruiting') throw new HttpsError('failed-precondition', '아직 인원 모집 중입니다.');

      // 시간 체크(태스크 시스템이 진척시키는 전제로, 여기서는 completionTime 존재 시 검사)
      if (p.completionTime) {
        const finishAt = p.completionTime.toDate ? p.completionTime.toDate() : new Date(p.completionTime);
        if (new Date() < finishAt) throw new HttpsError('failed-precondition', '아직 건설이 완료되지 않았습니다.');
      }

      const plotRef = db.collection('land_plots').doc(p.plotId);
      const plotSnap = await tx.get(plotRef);
      if (!plotSnap.exists) throw new HttpsError('not-found', '부지를 찾을 수 없습니다.');
      const plot = plotSnap.data() || {};

      const d = p.design || {};
      const buildingId = uuidv4();

      const newBuilding = {
        id: buildingId,
        name: d.name,
        type: d.type,
        style: d.style,
        scale: d.scale,
        heightM: Number(d.heightM || 0),
        totalArea: Number(d.totalArea || 0),
        zones: Array.isArray(d.zones) ? d.zones : [],
        materials: d.materials || {},
        contractor: p.contractor,
        completedAt: Timestamp.now(),

        managerCharId: null,
        collapseChance: 1.0,
        safetyLevel: '안전',
        profitability: 0,
        baseAestheticValue: p.baseAestheticValue || 0,
        finalAestheticGrade: 'F',
        placed_facilities: [],
        status: 'active',
      };

      // 부지 반영: usedArea 증가 + 시설 추가
      const nextFacilities = (Array.isArray(plot.facilities) ? plot.facilities.slice() : []).concat([newBuilding]);
      const nextUsedArea = Number(plot.usedArea || 0) + Number(d.totalArea || 0);

      // 태스크 정리(완료 및 제거)
      let nextTasks = Array.isArray(plot.tasks) ? plot.tasks.slice() : [];
      nextTasks = nextTasks.filter(t => t.id !== p.taskId);

      tx.update(plotRef, {
        facilities: nextFacilities,
        usedArea: nextUsedArea,
        tasks: nextTasks
      });

      // 참여 캐릭터 작업 해제
      const charIds = p?.contractor?.charIds || [];
      for (const id of charIds) {
        const ref = db.collection('chars').doc(id);
        tx.update(ref, { activeTaskId: admin.firestore.FieldValue.delete(), status: 'idle' });
      }

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

/* =======================
 * 관리자(캐릭터) 배정
 * ======================= */
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

      const data = snap.data() || {};
      const facs = Array.isArray(data.facilities) ? data.facilities.slice() : [];
      const idx = facs.findIndex(f => f.id === buildingId);
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

/* =======================
 * 건물 관리(점검/보수/재건/수익/미관)
 * ======================= */
exports.manageBuilding = onCall({ region: 'us-central1' }, async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  const { plotId, buildingId, action } = req.data || {};
  if (!plotId || !buildingId || !action) {
    throw new HttpsError('invalid-argument', '필수 정보(plotId, buildingId, action)가 누락되었습니다.');
  }

  try {
    let message = '';
    await db.runTransaction(async (tx) => {
      const plotRef = db.collection('land_plots').doc(plotId);
      const snap = await tx.get(plotRef);
      if (!snap.exists) throw new HttpsError('not-found', '부지를 찾을 수 없습니다.');

      const data = snap.data() || {};
      const facs = Array.isArray(data.facilities) ? data.facilities.slice() : [];
      const idx = facs.findIndex(f => f.id === buildingId);
      if (idx < 0) throw new HttpsError('not-found', '해당 건물을 찾을 수 없습니다.');
      let b = { ...facs[idx] };

      const height = Number(b.heightM || b.height || 0);
      const isXL = (b.scale === 'xlarge' || b.scale === '초대형');

      if (action === 'inspect_collapse') {
        b.collapseChance = Number(b.collapseChance || 1.0) + Math.random() * (height / 100) + (isXL ? 1 : 0);
        if (b.collapseChance > 100) b.collapseChance = 100;
        const cc = b.collapseChance;
        b.safetyLevel = cc > 90 ? '붕괴 직전' : cc > 70 ? '위급' : cc > 40 ? '위험' : cc > 15 ? '불안' : '안전';
        b.lastInspection = new Date();
        message = `[${b.name}] 붕괴도 조사 완료. 현재 안전도: ${b.safetyLevel} (${cc.toFixed(2)}%)`;
      } else if (action === 'repair') {
        if (!['불안', '위험', '위급'].includes(b.safetyLevel)) {
          throw new HttpsError('failed-precondition', "보수 작업은 '불안', '위험', '위급'일 때만 가능합니다.");
        }
        b.collapseChance = Math.max(1.0, Number(b.collapseChance || 1.0) - (10 + Math.random() * 15));
        const cc = b.collapseChance;
        b.safetyLevel = cc > 90 ? '붕괴 직전' : cc > 70 ? '위급' : cc > 40 ? '위험' : cc > 15 ? '불안' : '안전';
        message = `[${b.name}] 보수 작업 완료. 현재 안전도: ${b.safetyLevel} (${cc.toFixed(2)}%)`;
      } else if (action === 'rebuild') {
        if (b.safetyLevel !== '붕괴 직전') throw new HttpsError('failed-precondition', "재건축은 '붕괴 직전'에서만 가능합니다.");
        b.status = 'rebuild_required';
        message = `[${b.name}] 재건축 플래그가 설정되었습니다.`;
      } else if (action === 'inspect_aesthetic') {
        let score = Number(b.baseAestheticValue || 0);
        // TODO: placed_facilities/items 반영
        b.finalAestheticGrade =
          score > 1000 ? 'SSS' : score > 700 ? 'SS' : score > 500 ? 'S' :
          score > 300 ? 'A' : score > 150 ? 'B' : score > 50 ? 'C' : 'F';
        message = `[${b.name}] 미관도 조사 완료. 최종 등급: ${b.finalAestheticGrade} (${score}점)`;
      } else if (action === 'inspect_profit') {
        const basePer100 = 20; // TODO: building_types 에셋 적용
        const area = Number(b.totalArea || 0);
        const aesth = Number(b.baseAestheticValue || 0);
        b.profitability = Math.round(basePer100 * (area / 100) * (1 + aesth / 200));
        message = `[${b.name}] 추정 수익성: ${b.profitability} G/h`;
      } else {
        throw new HttpsError('invalid-argument', '알 수 없는 관리 명령입니다.');
      }

      facs[idx] = b;
      tx.update(plotRef, { facilities: facs });
    });

    return { success: true, message };
  } catch (err) {
    console.error('manageBuilding failed:', err);
    if (err instanceof HttpsError) throw err;
    throw new HttpsError('internal', err.message || '건물 관리 명령 수행 중 오류가 발생했습니다.');
  }
});
