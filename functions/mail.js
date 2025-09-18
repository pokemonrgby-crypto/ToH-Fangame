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
  const db = admin.firestore();
  const uid = req.auth?.uid;

  // 관리자 판정
  async function isAdmin(uid) {
    if (!uid) return false;
    try {
      const snap = await db.doc('configs/admins').get();
      const data = snap.exists ? snap.data() : {};
      const allow = Array.isArray(data.allow) ? data.allow : [];
      const allowEmails = Array.isArray(data.allowEmails) ? data.allowEmails : [];
      if (allow.includes(uid)) return true;
      const user = await admin.auth().getUser(uid);
      return !!(user?.email && allowEmails.includes(user.email));
    } catch {
      return false;
    }
  }
  if (!await isAdmin(uid)) throw new HttpsError('permission-denied', '관리자 권한이 필요합니다.');

  // 입력
  const { target, title, body, kind, expiresDays, prizeCoins, prizeItems } = req.data || {};
  if (!target || !title || !body) throw new HttpsError('invalid-argument', 'target, title, body는 필수입니다.');

  const now = admin.firestore.Timestamp.now();
  const isGeneral = (String(kind||'') === 'general');
  const expiresAt = isGeneral
    ? admin.firestore.Timestamp.fromMillis(now.toMillis() + Math.max(1, Number(expiresDays||7)) * 24*60*60*1000)
    : null;

  const attachments = {
    coins: Math.max(0, Math.floor(Number(prizeCoins||0))),
    items: Array.isArray(prizeItems) ? prizeItems.map(it => ({
      name: String(it?.name||''),
      rarity: String(it?.rarity||'common'),
      consumable: !!it?.consumable,
      count: Math.max(1, Math.floor(Number(it?.count||1)))
    })).filter(x => x.name) : []
  };

  const mailData = {
    kind: (['warning','notice','general'].includes(kind)) ? kind : 'notice',
    title: String(title).slice(0, 100),
    body: String(body).slice(0, 1500),
    sentAt: admin.firestore.FieldValue.serverTimestamp(),
    read: false,
    from: 'admin',
    expiresAt,
    attachments,
    claimed: false
  };

  try {
    if (target === 'all') {
      const usersSnap = await db.collection('users').limit(500).get();
      if (usersSnap.empty) return { ok: true, sentCount: 0 };
      const batch = db.batch();
      usersSnap.forEach(u => {
        const mailRef = db.collection('mail').doc(u.id).collection('msgs').doc();
        batch.set(mailRef, mailData);
      });
      await batch.commit();
      return { ok: true, sentCount: usersSnap.size };
    } else {
      const mailRef = db.collection('mail').doc(String(target)).collection('msgs').doc();
      await mailRef.set(mailData);
      return { ok: true, sentCount: 1 };
    }
  } catch (e) {
    throw new HttpsError('internal', '메일 발송 중 오류가 발생했습니다.');
  }
});
// 일반메일 보상 수령
const claimMail = onCall({ region: 'us-central1' }, async (req) => {
  const db = admin.firestore();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  const { mailId } = req.data || {};
  if (!mailId) throw new HttpsError('invalid-argument', 'mailId 필요');

  const mailRef = db.collection('mail').doc(uid).collection('msgs').doc(String(mailId));
  const snap = await mailRef.get();
  if (!snap.exists) throw new HttpsError('not-found', '메일이 없습니다.');

  const m = snap.data() || {};
  if (m.kind !== 'general') throw new HttpsError('failed-precondition', '보상 대상 메일이 아닙니다.');
  if (m.claimed) throw new HttpsError('already-exists', '이미 수령 완료');
  if (m.expiresAt?.toMillis && m.expiresAt.toMillis() < Date.now()) {
    throw new HttpsError('deadline-exceeded', '유효기간이 지났습니다.');
  }

  const userRef = db.doc(`users/${uid}`);
  await db.runTransaction(async (tx) => {
    const uSnap = await tx.get(userRef);
    if (!uSnap.exists) throw new HttpsError('not-found', '유저 문서 없음');

    const coins = Math.max(0, Math.floor(Number(m?.attachments?.coins||0)));
    const items = Array.isArray(m?.attachments?.items) ? m.attachments.items : [];

    if (coins > 0) {
      tx.update(userRef, { coins: admin.firestore.FieldValue.increment(coins) });
    }
    if (items.length) {
      const cur = Array.isArray(uSnap.get('items_all')) ? uSnap.get('items_all') : [];
      const add = items.map((it) => ({
        id: `mail_${snap.id}_${Math.random().toString(36).slice(2,8)}`,
        name: String(it.name||'Gift'),
        rarity: String(it.rarity||'common'),
        isConsumable: !!it.consumable,
        count: Math.max(1, Math.floor(Number(it.count||1))),
        source: { type:'mail', mailId: snap.id }
      }));
      tx.update(userRef, { items_all: [...cur, ...add] });
    }

    tx.update(mailRef, {
      claimed: true,
      claimedAt: admin.firestore.FieldValue.serverTimestamp()
    });
  });

  return { ok: true };
});


return { sendMail, claimMail };

};
