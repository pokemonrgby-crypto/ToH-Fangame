// /functions/character.js (수정)
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions');

module.exports = (admin) => {
  const db = admin.firestore();

  const getUserCharacters = onCall({ region: 'us-central1' }, async (req) => {
    const uid = req.auth?.uid;
    if (!uid) {
      throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
    }

    try {
      const charsSnap = await db.collection('chars').where('owner_uid', '==', uid).get();
      
      if (charsSnap.empty) {
        return { ok: true, characters: [] };
      }

      const characters = charsSnap.docs.map(doc => {
        const data = doc.data();
        
        // [수정] 스킬 필드 데이터 구조 변경 및 레거시 호환 처리
        const defaultSkill = { level: 0, exp: 0, nextExp: 1 };
        const baseSkills = {
          gardening: defaultSkill, art: defaultSkill, construction: defaultSkill,
          speech: defaultSkill, mining: defaultSkill, cooking: defaultSkill,
          processing: defaultSkill, crafting: defaultSkill, research: defaultSkill
        };

        let skills = data.skills || {};
        const finalSkills = {};
        for (const key of Object.keys(baseSkills)) {
          // [설명] 기존 데이터가 숫자(레벨)이면 새 구조로 변환, 없으면 기본값 사용
          if (typeof skills[key] === 'number') {
            const level = skills[key];
            finalSkills[key] = {
              level,
              exp: 0,
              nextExp: Math.floor(200 ** (Math.sqrt(level)))
            };
          } else if (typeof skills[key] === 'object' && skills[key] !== null) {
            finalSkills[key] = {
              level: skills[key].level || 0,
              exp: skills[key].exp || 0,
              nextExp: skills[key].nextExp || 1
            };
          } else {
            finalSkills[key] = baseSkills[key];
          }
        }

        return {
          id: doc.id,
          name: data.name || '이름 없음',
          image_url: data.image_url || null,
          thumb_url: data.thumb_url || null,
          skills: finalSkills
        };
      });

      return { ok: true, characters };
    } catch (error) {
      logger.error(`Error fetching characters for user ${uid}:`, error);
      throw new HttpsError('internal', '캐릭터 목록을 불러오는 중 오류가 발생했습니다.');
    }
  });

  return { getUserCharacters };
};
