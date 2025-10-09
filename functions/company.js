// /functions/company.js (전체 수정)
const { onCall, HttpsError } = require('firebase-functions/v2/');
const admin = require('firebase-admin');

// ... (loadAsset, isAdmin 등 헬퍼 함수는 그대로 둡니다)

// 건축 속도와 품질을 계산하는 헬퍼 함수
const calculateConstructionMetrics = async (characterId) => {
    // TODO: 캐릭터의 'construction' 스탯을 기반으로 계산
    // 예: const charDoc = await firestore.doc(`chars/${characterId}`).get();
    // const constructionStat = charDoc.data().stats.construction;
    const constructionStat = 10; // 임시 값
    return {
        speed: 1 + (constructionStat / 10), // 스탯 10당 진행도 1% 추가/시간
        qualityBonus: constructionStat * 1.5 // 스탯 1당 품질 1.5 증가
    };
};

module.exports = (context) => {
    const { firestore, auth } = context;

    /**
     * 건설 프로젝트 시작 (핵심 함수)
     * 이제 이 함수 하나로 모든 유형의 건설을 시작합니다.
     */
    const startConstructionProject = onCall({ region: 'us-central1' }, async (req) => {
        const uid = req.auth?.uid;
        if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');

        const { plotId, area, materials, buildType, assignedCharacterId, npcId } = req.data;
        if (!plotId || !area || !materials || !buildType) {
            throw new HttpsError('invalid-argument', '필수 정보가 누락되었습니다.');
        }

        // TODO: 사용자가 재료를 충분히 가지고 있는지 확인하고 차감하는 로직

        const baseConstructionTime = area * 10; // 면적 1당 10분의 기본 시간
        const baseQuality = 50; // 기본 품질 점수

        const newProject = {
            owner_uid: uid,
            plotId,
            area: { total: area, used: 0, available: area },
            purpose: "uncategorized",
            materials_used: materials,
            facilities: {},
            status: 'under_construction',
            progress: 0,
            quality: baseQuality,
            builder_type: buildType, // 'self', 'npc', 'contract'
            assigned_workers: {}, // { charId: speed }
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            estimated_time: baseConstructionTime,
        };

        if (buildType === 'self') {
            if (!assignedCharacterId) throw new HttpsError('invalid-argument', '직접 건설할 캐릭터를 선택해야 합니다.');
            const { speed, qualityBonus } = await calculateConstructionMetrics(assignedCharacterId);
            newProject.quality += qualityBonus;
            newProject.estimated_time /= speed;
            newProject.assigned_workers[assignedCharacterId] = speed;
        } else if (buildType === 'npc') {
            if (!npcId) throw new HttpsError('invalid-argument', '고용할 NPC를 선택해야 합니다.');
            // TODO: npcId를 기반으로 NPC의 스탯을 가져와 speed와 quality 계산
            // const npcData = await loadAsset('npcs.json'); const npc = npcData[npcId];
            const npcSpeed = 5; const npcQualityBonus = 75; // 예시 NPC 스탯
            newProject.quality += npcQualityBonus;
            newProject.estimated_time /= npcSpeed;
            // TODO: NPC 고용 비용 차감 로직
        } else if (buildType === 'contract') {
             // 계약 방식은 postConstructionContract 함수를 통해 별도 처리
             throw new HttpsError('invalid-argument', "계약은 '건설 계약 등록' 기능을 이용해주세요.");
        }

        const projectRef = await firestore.collection('user_buildings').add(newProject);
        return { success: true, projectId: projectRef.id, message: '건설 프로젝트가 시작되었습니다.' };
    });

    /**
     * 건설 계약 등록 (다른 플레이어에게 의뢰)
     */
    const postConstructionContract = onCall({ region: 'us-central1' }, async (req) => {
        const uid = req.auth?.uid;
        if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');

        const { plotId, area, materials, payment, minStat } = req.data;
        // TODO: 의뢰 비용(자재, 보상금)이 충분한지 확인

        const newContract = {
            clientId: uid,
            plotId,
            area,
            materials_supplied: materials,
            payment,
            min_construction_stat: minStat,
            status: 'open',
            applicants: [],
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        const contractRef = await firestore.collection('construction_contracts').add(newContract);
        return { success: true, contractId: contractRef.id, message: '건설 계약이 등록되었습니다.' };
    });
    
    // TODO: 계약 수락(acceptContract), 건설 진행(workOnProject), 프로젝트 완료(completeProject) 등의 함수 추가 필요

    // 기존 함수들은 삭제하거나 새 시스템에 맞게 수정
    // return { createBuildingShell, installFacility, resetBuildingPurpose };
    return { startConstructionProject, postConstructionContract };
};
