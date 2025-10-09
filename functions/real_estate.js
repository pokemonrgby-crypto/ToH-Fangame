// /functions/real_estate.js (신규 파일)
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions');

module.exports = (admin) => {
    const db = admin.firestore();
    const { FieldValue } = admin.firestore;

    /**
     * 시설(건물, 농지 등)에 캐릭터를 배치합니다.
     */
    const assignCharacterToFacility = onCall({ region: 'us-central1' }, async (req) => {
        const uid = req.auth?.uid;
        const { plotId, facilityId, charId } = req.data || {};
        if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
        if (!plotId || !facilityId) throw new HttpsError('invalid-argument', '필수 정보(plotId, facilityId)가 누락되었습니다.');

        // TODO: 이 plotId의 소유자가 uid인지 검증하는 로직이 필요합니다.

        return await db.runTransaction(async (tx) => {
            const plotRef = db.doc(`land_plots/${plotId}`);
            const plotSnap = await tx.get(plotRef);
            if (!plotSnap.exists) throw new HttpsError('not-found', '해당 토지를 찾을 수 없습니다.');
            
            const plotData = plotSnap.data();
            const facilities = plotData.facilities || [];
            const facilityIndex = facilities.findIndex(f => f.id === facilityId);
            
            if (facilityIndex === -1) throw new HttpsError('not-found', '해당 시설을 찾을 수 없습니다.');

            // 기존에 이 캐릭터가 다른 시설에 할당되어 있었다면 해제
            facilities.forEach(fac => {
                if (fac.assignedCharId === charId) {
                    fac.assignedCharId = null;
                }
            });

            // 새로운 캐릭터를 시설에 할당 (charId가 null이면 할당 해제)
            facilities[facilityIndex].assignedCharId = charId || null;

            // 레거시 캐릭터 스탯 구조 마이그레이션 (직업 적용 시)
            if (charId) {
                const charRef = db.doc(`chars/${charId}`);
                const cSnap = await tx.get(charRef);
                if (cSnap.exists) {
                    const cData = cSnap.data() || {};
                    let skills = cData.skills || {};
                    let needsUpdate = false;
                    const defaultSkillKeys = ['gardening', 'art', 'construction', 'speech', 'mining', 'cooking', 'processing', 'crafting', 'research', 'strength', 'charisma'];
                    
                    for (const key of defaultSkillKeys) {
                        if (!skills[key] || typeof skills[key] === 'number') {
                            const level = Number(skills[key] || 0);
                            skills[key] = {
                                level,
                                exp: 0,
                                nextExp: Math.floor(200 * (2 ** Math.sqrt(level)))
                            };
                            needsUpdate = true;
                        }
                    }
                    if (!cData.job) {
                        // 직업이 없는 경우 '백수'로 설정
                        tx.update(charRef, { job: '백수' });
                    }
                    if (needsUpdate) {
                        tx.update(charRef, { skills, updatedAt: Date.now() });
                    }
                }
            }

            tx.update(plotRef, { facilities, updatedAt: Date.now() });
            return { ok: true, assignedCharId: charId };
        });
    });

    /**
     * 새로운 농지를 생성합니다.
     */
    const createFarmland = onCall({ region: 'us-central1' }, async (req) => {
        const uid = req.auth?.uid;
        const { plotId, name, area } = req.data;
        if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
        if (!plotId || !name || !area) throw new HttpsError('invalid-argument', '필수 정보(plotId, name, area)가 누락되었습니다.');

        const plotRef = db.doc(`land_plots/${plotId}`);
        return db.runTransaction(async (tx) => {
            const plotSnap = await tx.get(plotRef);
            const plotData = plotSnap.exists() ? plotSnap.data() : { totalArea: 10000, usedArea: 0, facilities: [] };

            const availableArea = (plotData.totalArea || 10000) - (plotData.usedArea || 0);
            if (area > availableArea) {
                throw new HttpsError('failed-precondition', '사용 가능한 토지 면적이 부족합니다.');
            }

            const newFarmland = {
                id: `farmland_${Date.now()}`,
                type: 'farmland',
                name: name,
                area: area,
                plantings: [],
                assignedCharId: null
            };

            const facilities = plotData.facilities || [];
            facilities.push(newFarmland);

            tx.set(plotRef, {
                owner_uid: uid,
                totalArea: plotData.totalArea || 10000,
                usedArea: (plotData.usedArea || 0) + area,
                facilities: facilities
            }, { merge: true });

            return { ok: true, facility: newFarmland };
        });
    });

    // TODO: 건물 건설 함수 구현
    const startConstruction = onCall({ region: 'us-central1' }, (req) => {
        throw new HttpsError('unimplemented', '건물 건설 기능은 아직 준비 중입니다.');
    });

    return { assignCharacterToFacility, createFarmland, startConstruction };
};
