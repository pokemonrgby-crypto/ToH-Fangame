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
        // [수정] skills 필드가 없으면 새로운 능력치를 포함한 기본값으로 초기화
        const skills = data.skills || {
          gardening: 0,
          art: 0,
          construction: 0,
          speech: 0,
          mining: 0,
          cooking: 0,
          processing: 0,
          crafting: 0,
          research: 0
        };

        return {
          id: doc.id,
          name: data.name || '이름 없음',
          image_url: data.image_url || null,
          thumb_url: data.thumb_url || null,
          skills: skills
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
