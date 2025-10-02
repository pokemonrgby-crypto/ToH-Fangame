// /functions/farm.js
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions');
const fs = require('fs').promises;
const path = require('path');

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
  
  // [수정] 여러 씨앗 데이터 파일을 읽어와 하나로 합치는 로더
  let _seedsDataCache = null;
  const loadSeedsData = async () => {
      if (_seedsDataCache) return _seedsDataCache;
      try {
          const seedsDir = path.join(__dirname, './assets/seeds');
          const files = await fs.readdir(seedsDir);
          const allSeeds = [];
          for (const file of files) {
              if (file.endsWith('.json')) {
                  const data = await fs.readFile(path.join(seedsDir, file), 'utf8');
                  allSeeds.push(...JSON.parse(data));
              }
          }
          _seedsDataCache = allSeeds;
          return _seedsDataCache;
      } catch (error) {
          logger.error("Failed to load seeds data from directory", error);
          return [];
      }
  };


  // [수정] 관리자용 씨앗 구매 함수 (중첩 로직 및 새 데이터 구조 적용)
  const buySeed = onCall({ region: 'us-central1' }, async (req) => {
    const uid = req.auth?.uid;
    if (!await _isAdmin(uid)) throw new HttpsError('permission-denied', '관리자만 씨앗을 구매할 수 있습니다.');

    const { seedId, quantity } = req.data;
    const nQty = Math.floor(Number(quantity) || 0);
    if (!seedId || nQty <= 0) {
      throw new HttpsError('invalid-argument', '필수 정보(seedId, quantity)가 누락되었습니다.');
    }
    
    const allSeeds = await loadSeedsData();
    const seedInfo = allSeeds.find(s => s.id === seedId);
    if (!seedInfo) throw new HttpsError('not-found', '존재하지 않는 씨앗입니다.');

    const totalPrice = (seedInfo.price || 10) * nQty;

    return db.runTransaction(async (tx) => {
        const userRef = db.doc(`users/${uid}`);
        const userSnap = await tx.get(userRef);
        if (!userSnap.exists) throw new HttpsError('not-found', '사용자 정보를 찾을 수 없습니다.');

        const userData = userSnap.data();
        const userCoins = userData.coins || 0;
        if (userCoins < totalPrice) throw new HttpsError('failed-precondition', '코인이 부족합니다.');

        let items = userData.items_all || [];
        
        // 인벤토리에서 같은 종류의 씨앗(seedId)을 찾습니다.
        const existingSeedIndex = items.findIndex(item => item.type === 'seed' && item.seedInfo?.id === seedId);

        if (existingSeedIndex !== -1) {
            // 이미 씨앗이 있다면 수량(uses)만 증가시킵니다.
            items[existingSeedIndex].uses = (items[existingSeedIndex].uses || 0) + nQty;
        } else {
            // 없다면 새로운 아이템 객체를 생성하여 추가합니다.
            const newSeedItem = {
                id: `item_seed_${seedId}_${Date.now()}`, // 인벤토리 슬롯을 위한 고유 ID
                name: seedInfo.name,
                rarity: seedInfo.rarity,
                description: seedInfo.description,
                isConsumable: true,
                uses: nQty,
                type: 'seed', // [핵심] 아이템 타입을 'seed'로 명시
                seedInfo: { // [핵심] 농사 관련 정보는 별도 객체에 저장
                    id: seedInfo.id,
                    growthTimeMinutes: seedInfo.growthTimeMinutes,
                    harvest: seedInfo.harvest,
                    isPerennial: seedInfo.isPerennial,
                },
                properties: { // [핵심] 감정 기능 충돌 방지를 위해 미리 '감정 완료' 상태로 설정
                    appraised: true,
                    category: 'gardening',
                    placeable: true,
                }
            };
            items.push(newSeedItem);
        }
        
        tx.update(userRef, { 
            coins: FieldValue.increment(-totalPrice),
            items_all: items
        });

        return { ok: true, paid: totalPrice };
    });
  });

  // ... (getFarmPlotDetail, plantSeedOnTile, assignCharacterToFarm 함수들은 그대로 유지)
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
