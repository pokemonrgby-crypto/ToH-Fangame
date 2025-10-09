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

module.exports = { deductItemsFromInventory };
