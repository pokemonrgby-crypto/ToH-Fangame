// /functions/company.js (전체 수정)
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const fs = require('fs').promises;
const path = require('path');

// Helper to load asset files
const loadAsset = async (fileName) => {
    const filePath = path.join(__dirname, 'assets', fileName);
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
};

// 재료의 총 가치를 계산하는 헬퍼 함수
const calculateMaterialValue = async (materials) => {
    const materialsData = await loadAsset('building_materials.json');
    let totalValue = 0;
    for (const mat of materials) {
        const materialInfo = materialsData.materials[mat.materialId];
        if (materialInfo) {
            totalValue += materialInfo.basePrice * mat.quantity;
        }
    }
    return totalValue;
};


module.exports = (context) => {
    const { firestore, auth } = context;

    /**
     * 건물 뼈대(Shell) 건설
     * 사용자가 면적과 재료를 지정하여 빈 건물을 생성합니다.
     */
    const createBuildingShell = onCall({ region: 'us-central1' }, async (req) => {
        const uid = req.auth?.uid;
        if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');

        const { area, materials, plotId } = req.data;
        if (!area || !materials || !plotId || area <= 0 || materials.length === 0) {
            throw new HttpsError('invalid-argument', '면적, 재료, 토지 ID는 필수입니다.');
        }

        // TODO: 사용자의 인벤토리에서 'materials' 만큼의 재료를 보유하고 있는지 확인하고 차감하는 로직 필요
        
        const aesthetic_score = await calculateMaterialValue(materials);

        const newBuilding = {
            owner_uid: uid,
            plotId: plotId,
            area: {
                total: area,
                used: 0,
                available: area
            },
            purpose: "uncategorized", // 처음에는 용도 미지정
            materials_used: materials,
            facilities: {}, // 설치된 시설 (key: docId, value: facilityId)
            aesthetic_score: aesthetic_score,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        };

        const buildingRef = await firestore.collection('user_buildings').add(newBuilding);

        return { success: true, buildingId: buildingRef.id, message: `${area}m² 크기의 건물이 건설되었습니다.` };
    });

    /**
     * 건물에 시설 설치
     */
    const installFacility = onCall({ region: 'us-central1' }, async (req) => {
        const uid = req.auth?.uid;
        if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');

        const { buildingId, facilityId } = req.data;
        if (!buildingId || !facilityId) {
            throw new HttpsError('invalid-argument', '건물 ID와 시설 ID는 필수입니다.');
        }
        
        const buildingRef = firestore.doc(`user_buildings/${buildingId}`);
        const buildingDoc = await buildingRef.get();

        if (!buildingDoc.exists || buildingDoc.data().owner_uid !== uid) {
            throw new HttpsError('not-found', '해당 건물을 찾을 수 없거나 소유주가 아닙니다.');
        }

        const buildingData = buildingDoc.data();
        const facilitiesData = await loadAsset('facilities.json');
        const facilityInfo = facilitiesData[facilityId];

        if (!facilityInfo) {
            throw new HttpsError('not-found', '시설 정보를 찾을 수 없습니다.');
        }
        
        if (buildingData.area.available < facilityInfo.area_required) {
            throw new HttpsError('failed-precondition', '시설을 설치할 공간이 부족합니다.');
        }

        // TODO: 사용자 인벤토리에서 시설 설치 비용(facilityInfo.cost) 차감 로직 필요
        // TODO: 사용자가 설치 조건(facilityInfo.placement_requirements)을 만족하는지 확인하는 로직 필요

        const newFacilityRef = buildingRef.collection('facilities').doc();

        await firestore.runTransaction(async (transaction) => {
            transaction.set(newFacilityRef, { facilityId: facilityId, installedAt: admin.firestore.FieldValue.serverTimestamp() });
            
            const newUsedArea = buildingData.area.used + facilityInfo.area_required;
            const newAvailableArea = buildingData.area.total - newUsedArea;
            
            transaction.update(buildingRef, {
                'area.used': newUsedArea,
                'area.available': newAvailableArea,
                [`facilities.${newFacilityRef.id}`]: facilityId
            });
        });

        // 시설 설치 후 건물 용도 자동 업데이트 시도
        await updateBuildingPurpose(buildingId);

        return { success: true, message: `[${facilityInfo.name}] 시설이 설치되었습니다.` };
    });

    /**
     * 건물 용도 변경 (초기화)
     * 용도를 바꾸려면 모든 시설을 철거하고 비용을 지불해야 합니다.
     */
    const resetBuildingPurpose = onCall({ region: 'us-central1' }, async (req) => {
        const uid = req.auth?.uid;
        if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
        
        const { buildingId } = req.data;
        const buildingRef = firestore.doc(`user_buildings/${buildingId}`);
        const buildingDoc = await buildingRef.get();
        const buildingData = buildingDoc.data();

        if (!buildingDoc.exists || buildingData.owner_uid !== uid) {
            throw new HttpsError('not-found', '해당 건물을 찾을 수 없거나 소유주가 아닙니다.');
        }
        
        if (Object.keys(buildingData.facilities).length > 0) {
            throw new HttpsError('failed-precondition', '용도를 변경하려면 모든 시설을 먼저 철거해야 합니다.');
        }

        const CHANGE_PURPOSE_COST = 1000; // 용도 변경 비용 (예시)
        // TODO: 사용자 재화에서 비용 차감 로직 필요

        await buildingRef.update({ purpose: "uncategorized" });

        return { success: true, message: "건물 용도가 초기화되었습니다. 새로운 시설을 설치하여 용도를 지정할 수 있습니다." };
    });

    // 건물 용도를 자동으로 업데이트하는 내부 함수
    const updateBuildingPurpose = async (buildingId) => {
        const buildingRef = firestore.doc(`user_buildings/${buildingId}`);
        const buildingDoc = await buildingRef.get();
        const buildingData = buildingDoc.data();

        const purposesData = await loadAsset('building_purposes.json');
        const installedFacilities = Object.values(buildingData.facilities);
        
        let finalPurpose = "uncategorized";

        for (const purposeId in purposesData) {
            const purposeInfo = purposesData[purposeId];
            const requirements = purposeInfo.requirements;

            if (buildingData.area.total >= requirements.min_area) {
                const hasAllFacilities = requirements.required_facilities.every(reqFacility => 
                    installedFacilities.includes(reqFacility)
                );

                if (hasAllFacilities) {
                    finalPurpose = purposeId;
                    break; // 첫 번째로 매칭되는 용도로 결정
                }
            }
        }
        
        if (buildingData.purpose !== finalPurpose) {
            await buildingRef.update({ purpose: finalPurpose });
        }
    };


    return { createBuildingShell, installFacility, resetBuildingPurpose };
};
