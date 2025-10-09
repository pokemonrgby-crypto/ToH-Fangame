// /functions/utils.js
const admin = require('firebase-admin');
const db = admin.firestore();

/**
 * 사용자의 인벤토리에서 여러 아이템을 차감하는 헬퍼 함수
 * @param {admin.firestore.Transaction} transaction - Firestore 트랜잭션 객체
 * @param {string} uid - 사용자 UID
 * @param {Object} itemsToDeduct - 차감할 아이템과 수량. 예: { "processed_wood": 100, "stone_brick": 50 }
 */
async function deductItemsFromInventory(transaction, uid, itemsToDeduct) {
    const inventoryRef = db.collection('users').doc(uid).collection('inventory');
    const itemIds = Object.keys(itemsToDeduct);
    const itemDocs = await transaction.getAll(...itemIds.map(id => inventoryRef.doc(id)));

    for (const doc of itemDocs) {
        const itemId = doc.id;
        const requiredAmount = itemsToDeduct[itemId];
        const currentAmount = doc.exists ? doc.data().quantity : 0;

        if (currentAmount < requiredAmount) {
            throw new Error(`'${itemId}' 아이템이 부족합니다. (현재: ${currentAmount}, 필요: ${requiredAmount})`);
        }

        transaction.update(inventoryRef.doc(itemId), {
            quantity: admin.firestore.FieldValue.increment(-requiredAmount)
        });
    }
}

/**
 * 캐릭터 문서에 skills 객체가 없으면 기본값을 채워넣어줍니다. (레거시 호환)
 * @param {admin.firestore.Transaction} transaction - Firestore 트랜잭션 객체
 * @param {admin.firestore.DocumentReference} charRef - 캐릭터 문서 참조
 * @param {object} charData - 캐릭터 데이터
 * @returns {object} skills 객체가 보장된 캐릭터 데이터
 */
async function ensureCharacterSkills(transaction, charRef, charData) {
    if (charData.skills && typeof charData.skills === 'object') {
        return charData; // 이미 skills 객체가 있으면 그대로 반환
    }

    console.log(`[Legacy] Initializing skills for character: ${charRef.id}`);
    const defaultSkills = {
        strength: { level: 1, exp: 0, nextLevelExp: 100 },
        intelligence: { level: 1, exp: 0, nextLevelExp: 100 },
        wisdom: { level: 1, exp: 0, nextLevelExp: 100 },
        dexterity: { level: 1, exp: 0, nextLevelExp: 100 },
        stamina: { level: 1, exp: 0, nextLevelExp: 100 },
        charisma: { level: 1, exp: 0, nextLevelExp: 100 },
        faith: { level: 1, exp: 0, nextLevelExp: 100 },
        art: { level: 1, exp: 0, nextLevelExp: 100 },
        research: { level: 1, exp: 0, nextLevelExp: 100 },
        crafting: { level: 1, exp: 0, nextLevelExp: 100 },
        construction: { level: 1, exp: 0, nextLevelExp: 100 }, // 건설 스킬 추가
        gardening: { level: 1, exp: 0, nextLevelExp: 100 },
    };

    // 트랜잭션 내에서 업데이트
    transaction.update(charRef, { skills: defaultSkills });

    // 업데이트된 데이터를 반환
    return { ...charData, skills: defaultSkills };
}

module.exports = { deductItemsFromInventory, ensureCharacterSkills };
