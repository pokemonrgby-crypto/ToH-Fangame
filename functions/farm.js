// /functions/farm.js (신규 파일)
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions');

module.exports = (admin) => {
  const db = admin.firestore();
  const { FieldValue } = admin.firestore;

  async function _isAdmin(uid) {
    if (!uid) return false;
    try {
      const snap = await db.doc('configs/admins').get();
      const d = snap.exists ? snap.data() : {};
      const allow = Array.isArray(d.allow) ? d.allow : [];
      if (allow.includes(uid)) return true;
      const allowEmails = Array.isArray(d.allowEmails) ? d.allowEmails : [];
      const user = await admin.auth().getUser(uid);
      return !!(user?.email && allowEmails.includes(user.email));
    } catch (_) { return false; }
  }

  // 관리자용 씨앗 구매 함수
  const buySeed = onCall({ region: 'us-central1' }, async (req) => {
    const uid = req.auth?.uid;
    if (!await _isAdmin(uid)) throw new HttpsError('permission-denied', '관리자만 씨앗을 구매할 수 있습니다.');

    const { seedId, quantity } = req.data;
    if (!seedId || !quantity || quantity <= 0) {
      throw new HttpsError('invalid-argument', '필수 정보(seedId, quantity)가 누락되었습니다.');
    }
    
    // TODO: seeds.json 같은 곳에서 씨앗 가격 정보 로드
    const pricePerSeed = 10; // 임시 가격
    const totalPrice = pricePerSeed * quantity;

    return db.runTransaction(async (tx) => {
        const userRef = db.doc(`users/${uid}`);
        const userSnap = await tx.get(userRef);
        if (!userSnap.exists) throw new HttpsError('not-found', '사용자 정보를 찾을 수 없습니다.');

        const userCoins = userSnap.data().coins || 0;
        if (userCoins < totalPrice) throw new HttpsError('failed-precondition', '코인이 부족합니다.');

        const newSeedItem = {
            id: `seed_${seedId}_${Date.now()}`,
            name: `${seedId} 씨앗`,
            rarity: 'normal',
            isConsumable: true,
            uses: quantity,
            description: `${seedId}의 씨앗. 농장에 심을 수 있다.`,
            type: 'seed',
            seedId: seedId
        };
        
        tx.update(userRef, { 
            coins: FieldValue.increment(-totalPrice),
            items_all: FieldValue.arrayUnion(newSeedItem)
        });

        return { ok: true, paid: totalPrice, received: newSeedItem };
    });
  });

  // 아래 함수들은 향후 구현을 위한 플레이스홀더입니다.
  const getFarmPlotDetail = onCall({ region: 'us-central1' }, async (req) => {
      if (!await _isAdmin(req.auth?.uid)) throw new HttpsError('permission-denied', '관리자 전용 기능입니다.');
      return { ok: true, message: "향후 구현될 기능입니다." };
  });
  const plantSeedOnTile = onCall({ region: 'us-central1' }, async (req) => {
      if (!await _isAdmin(req.auth?.uid)) throw new HttpsError('permission-denied', '관리자 전용 기능입니다.');
      return { ok: true, message: "향후 구현될 기능입니다." };
  });
  const assignCharacterToFarm = onCall({ region: 'us-central1' }, async (req) => {
      if (!await _isAdmin(req.auth?.uid)) throw new HttpsError('permission-denied', '관리자 전용 기능입니다.');
      return { ok: true, message: "향후 구현될 기능입니다." };
  });

  return { buySeed, getFarmPlotDetail, plantSeedOnTile, assignCharacterToFarm };
};
