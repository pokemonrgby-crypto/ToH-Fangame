// pokemonrgby-crypto/toh-fangame/ToH-Fangame-23b32a5f81701f6655ba119074435fa979f65b24/functions/mail.js
module.exports = (admin, { onCall, HttpsError, logger }) => {
  const db = admin.firestore();

  // Helper: 어드민인지 확인
  async function isAdmin(uid) {
    if (!uid) return false;
    try {
      const snap = await db.doc('configs/admins').get();
      const data = snap.exists() ? snap.data() : {};
      const allow = Array.isArray(data.allow) ? data.allow : [];
      const user = await admin.auth().getUser(uid);
      const allowEmails = Array.isArray(data.allowEmails) ? data.allowEmails : [];
      return allow.includes(uid) || (user.email && allowEmails.includes(user.email));
    } catch (e) {
      logger.error('isAdmin check failed', e);
      return false;
    }
  }

  // Callable Function: 관리자가 우편 발송
  const sendMail = onCall({ region: 'us-central1' }, async (req) => {
    const uid = req.auth?.uid;
    if (!await isAdmin(uid)) {
      throw new HttpsError('permission-denied', '관리자 권한이 필요합니다.');
    }

    const { target, title, body } = req.data || {};
    if (!target || !title || !body) {
      throw new HttpsError('invalid-argument', 'target, title, body는 필수입니다.');
    }

    const mailData = {
      title: String(title).slice(0, 100),
      body: String(body).slice(0, 1500),
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
      read: false,
      from: 'admin',
    };

    try {
      if (target === 'all') {
        // 전체 유저에게 발송 (Batch 사용)
        const usersSnap = await db.collection('users').limit(500).get(); // 성능을 위해 500명씩 끊어서 처리 필요
        if (usersSnap.empty) return { ok: true, sentCount: 0 };

        const batch = db.batch();
        usersSnap.forEach(userDoc => {
          const mailRef = db.collection('mail').doc(userDoc.id).collection('msgs').doc();
          batch.set(mailRef, mailData);
        });
        await batch.commit();
        logger.info(`Admin ${uid} sent mail to all ${usersSnap.size} users.`);
        return { ok: true, sentCount: usersSnap.size };

      } else {
        // 특정 UID에게 발송
        const targetUid = String(target);
        const mailRef = db.collection('mail').doc(targetUid).collection('msgs').doc();
        await mailRef.set(mailData);
        logger.info(`Admin ${uid} sent mail to ${targetUid}.`);
        return { ok: true, sentCount: 1 };
      }
    } catch (error) {
      logger.error('Mail sending failed', { error, target, uid });
      throw new HttpsError('internal', '메일 발송 중 오류가 발생했습니다.');
    }
  });

  return { sendMail };
};
