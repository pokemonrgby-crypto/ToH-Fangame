const functions = require('firebase-functions');
const admin = require('firebase-admin');

const db = admin.firestore();

// 건물 건설
exports.constructBuilding = functions.https.onCall(async (data, context) => {
    const { buildingId } = data;
    const uid = context.auth.uid;

    if (!buildingId) {
        throw new functions.https.HttpsError('invalid-argument', 'Building ID is required.');
    }

    // TODO: Load buildings.json and find the building data
    // For now, let's assume we have it.
    const buildingData = { /* Get from buildings.json */ }; 
    const cost = buildingData.grades[0].construction_cost;

    // TODO: Check and deduct materials from user's inventory

    const newBuilding = {
        owner: uid,
        buildingId: buildingId,
        grade: 1,
        area: buildingData.area,
        purpose: buildingData.purpose,
        placedFacilities: {},
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const buildingRef = await db.collection('buildings').add(newBuilding);

    return { success: true, buildingId: buildingRef.id };
});


// 연구 시작 (어드민 전용)
exports.startResearch = functions.https.onCall(async (data, context) => {
    const { researchId, characterId } = data;
    const uid = context.auth.uid;

    // 어드민 체크
    const userRecord = await admin.auth().getUser(uid);
    if (!userRecord.customClaims || !userRecord.customClaims.admin) {
        throw new functions.https.HttpsError('permission-denied', 'Only admins can start researches.');
    }

    if (!researchId || !characterId) {
        throw new functions.https.HttpsError('invalid-argument', 'Research ID and Character ID are required.');
    }
    
    // TODO:
    // 1. Load research_tree.json and get research data.
    // 2. Check if the character has the required facility.
    // 3. Check and deduct required materials.
    // 4. Create a document in 'activeResearch' collection with a completion timestamp.
    // 5. When completed (e.g., via a scheduled function), calculate success, grant EXP, and add to the 'knowledge' collection.

    return { success: true, message: `Research ${researchId} started for ${characterId}.` };
});
