// functions/trade.js

module.exports = (admin, { onCall, HttpsError, logger }) => {
  const db = admin.firestore();

  // ----- 유틸 -----
  const nowTs = () => admin.firestore.Timestamp.now();
  const dayStamp = (d = new Date()) => {
    const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), dd = String(d.getDate()).padStart(2,'0');
    return `${y}-${m}-${dd}`;
  };

  function _assert(cond, code, msg) {
    if (!cond) throw new HttpsError(code, msg);
  }

  function _calculatePrice(item) {
    const prices = {
      consumable: { normal: 1, rare: 5, epic: 25, legend: 50, myth: 100, aether: 250 },
      non_consumable: { normal: 2, rare: 10, epic: 50, legend: 100, myth: 200, aether: 500 }
    };
    const isConsumable = item.isConsumable || item.consumable || item.consume;
    const priceTier = isConsumable ? prices.consumable : prices.non_consumable;
    return priceTier[item.rarity] || 0;
  };

  function _removeItemFromUser(tx, userRef, userSnap, itemId) {
    const items = Array.isArray(userSnap.get('items_all')) ? [...userSnap.get('items_all')] : [];
    const idx = items.findIndex(it => String(it?.id) === String(itemId));
    _assert(idx >= 0, 'failed-precondition', '인벤토리에 해당 아이템이 없어');
    const [item] = items.splice(idx, 1);
    tx.update(userRef, { items_all: items });
    return item;
  }
  function _addItemToUser(tx, userRef, itemObj) {
    const FieldValue = admin.firestore.FieldValue;
    tx.set(userRef, { items_all: FieldValue.arrayUnion(itemObj) }, { merge:true });
  }

  function _pay(tx, userRef, userSnap, amount) {
    const coins = Number(userSnap.get('coins')||0);
    _assert(coins >= amount, 'failed-precondition', '골드가 부족해');
    tx.update(userRef, { coins: coins - amount });
  }
  function _give(tx, userRef, amount) {
    const FieldValue = admin.firestore.FieldValue;
    tx.set(userRef, { coins: FieldValue.increment(amount) }, { merge:true });
  }

  function _hold(tx, userRef, userSnap, amount) {
    const coins = Number(userSnap.get('coins')||0);
    const hold = Number(userSnap.get('coins_hold')||0);
    _assert(coins >= amount, 'failed-precondition', '골드가 부족해(입찰 보증금)');
    tx.update(userRef, { coins: coins - amount, coins_hold: hold + amount });
  }
  function _release(tx, userRef, userSnap, amount) {
    const hold = Number(userSnap.get('coins_hold')||0);
    _assert(hold >= amount, 'internal', '보증금 해제 불가');
    tx.update(userRef, { coins: Number(userSnap.get('coins')||0) + amount, coins_hold: hold - amount });
  }
  function _capture(tx, userRef, userSnap, amount) {
    const hold = Number(userSnap.get('coins_hold')||0);
    _assert(hold >= amount, 'internal', '보증금 확정 불가');
    tx.update(userRef, { coins_hold: hold - amount });
  }

  function _bumpDailyTradeCount(tx, userRef, userSnap) {
    const today = dayStamp();
    const curDay = userSnap.get('trade_listed_day');
    const curCnt = Number(userSnap.get('trade_listed_count')||0);
    if (curDay !== today) {
      tx.update(userRef, { trade_listed_day: today, trade_listed_count: 1 });
      return 1;
    } else {
      _assert(curCnt < 5, 'resource-exhausted', '오늘 일반거래 등록 5회 초과야');
      tx.update(userRef, { trade_listed_count: curCnt + 1 });
      return curCnt + 1;
    }
  }

  // ========== [일반거래] ==========
  const tradeCol = db.collection('market_trades');

  const tradeCreateListing = onCall({ region:'us-central1' }, async (req)=>{
    const uid = req.auth?.uid;
    _assert(uid, 'unauthenticated', '로그인이 필요해');
    const { itemId, price } = req.data || {};
    _assert(itemId && Number.isFinite(Number(price)), 'invalid-argument', '잘못된 입력');
    const userRef = db.doc(`users/${uid}`);
    const listingRef = tradeCol.doc();
    await db.runTransaction(async (tx)=>{
      const userSnap = await tx.get(userRef);
      _assert(userSnap.exists, 'not-found', '유저 없음');
      _bumpDailyTradeCount(tx, userRef, userSnap);
      const item = _removeItemFromUser(tx, userRef, userSnap, String(itemId));
      const basePrice = _calculatePrice(item);
      _assert(basePrice > 0, 'invalid-argument', '가격을 산정할 수 없는 아이템이야');
      const minPrice = Math.floor(basePrice * 0.5);
      const maxPrice = Math.floor(basePrice * 1.5);
      const p = Math.floor(Number(price));
      _assert(p >= minPrice && p <= maxPrice, 'failed-precondition', `가격은 ${minPrice}~${maxPrice} 골드 사이만 가능해`);
      tx.set(listingRef, {
        status:'active', seller_uid: uid, price: p, item,
        createdAt: nowTs()
      });
    });
    return { ok:true, id: listingRef.id };
  });

  const tradeCancelListing = onCall({ region:'us-central1' }, async (req)=>{
    const uid = req.auth?.uid;
    _assert(uid, 'unauthenticated', '로그인이 필요해');
    const { listingId } = req.data || {};
    _assert(listingId, 'invalid-argument', 'listingId 필요');
    const listingRef = tradeCol.doc(String(listingId));
    await db.runTransaction(async (tx) => {
      const listingSnap = await tx.get(listingRef);
      _assert(listingSnap.exists, 'not-found', '판매 물품을 찾을 수 없어');
      const listing = listingSnap.data();
      _assert(listing.seller_uid === uid, 'permission-denied', '내 물건만 취소할 수 있어');
      _assert(listing.status === 'active', 'failed-precondition', '이미 판매되었거나 취소된 물품이야');
      const userRef = db.doc(`users/${uid}`);
      _addItemToUser(tx, userRef, listing.item);
      tx.update(listingRef, { status: 'cancelled', cancelledAt: nowTs() });
    });
    return { ok: true };
  });

  const tradeGetListingDetail = onCall({ region:'us-central1' }, async (req) => {
    const { listingId } = req.data || {};
    _assert(listingId, 'invalid-argument', 'listingId 필요');
    const snap = await tradeCol.doc(String(listingId)).get();
    _assert(snap.exists, 'not-found', '판매 정보를 찾을 수 없어');
    const listing = snap.data();
    return { ok: true, item: listing.item, price: listing.price, seller_uid: listing.seller_uid };
  });

  const tradeListPublic = onCall({ region:'us-central1' }, async (_req)=>{
    const snap = await tradeCol.where('status','==','active').orderBy('createdAt','desc').limit(80).get();
    const rows = snap.docs.map(d=>{
      const x = d.data(); const it = x.item || {};
      return {
        id: d.id,
        price: Number(x.price||0),
        seller_uid: x.seller_uid,
        item_id: String(it.id||''),
        item_name: String(it.name||''),
        item_rarity: String(it.rarity||'normal'),
        createdAt: x.createdAt,
        consumable: it.consumable || it.isConsumable || false,
        uses: it.uses || null
      };
    });
    return { ok:true, rows };
  });

  const tradeBuy = onCall({ region:'us-central1' }, async (req)=>{
    const uid = req.auth?.uid;
    _assert(uid, 'unauthenticated', '로그인이 필요해');
    const { listingId } = req.data || {};
    _assert(listingId, 'invalid-argument', 'listingId 필요');
    const ref = tradeCol.doc(String(listingId));
    await db.runTransaction(async (tx)=>{
      const snap = await tx.get(ref);
      _assert(snap.exists, 'not-found', '리스트 없음');
      const L = snap.data();
      _assert(L.status==='active', 'failed-precondition', '이미 판매됨');
      _assert(L.seller_uid !== uid, 'failed-precondition', '내 물건은 내가 못 사');
      const buyerRef = db.doc(`users/${uid}`);
      const sellerRef = db.doc(`users/${L.seller_uid}`);
      const buyer = await tx.get(buyerRef);
      const seller = await tx.get(sellerRef);
      _assert(buyer.exists && seller.exists, 'not-found', '유저 정보 없음');
      _pay(tx, buyerRef, buyer, Number(L.price||0));
      _give(tx, sellerRef, Number(L.price||0));
      _addItemToUser(tx, buyerRef, L.item);
      tx.update(ref, { status:'sold', buyer_uid: uid, soldAt: nowTs() });
    });
    return { ok:true };
  });

  const tradeListMyListings = onCall({ region:'us-central1' }, async (req)=>{
      const uid = req.auth?.uid;
      _assert(uid, 'unauthenticated', '로그인이 필요해');
      const snap = await tradeCol.where('seller_uid','==',uid).orderBy('createdAt','desc').limit(50).get();
      const rows = snap.docs.map(d=>{
          const x = d.data(); const it = x.item || {};
          return {
              id: d.id,
              status: x.status,
              price: Number(x.price||0),
              item_name: String(it.name||''),
              item_rarity: String(it.rarity||'normal'),
              createdAt: x.createdAt,
              soldAt: x.soldAt || null,
              buyer_uid: x.buyer_uid || null,
          };
      });
      return { ok:true, rows };
  });

  // ========== [경매(일반/특수)] ==========
  const aucCol = db.collection('market_auctions');
  const MIN_MINUTES = 30;
  const MIN_STEP = 1;

  const auctionCreate = onCall({ region:'us-central1' }, async (req)=>{
    const uid = req.auth?.uid;
    _assert(uid, 'unauthenticated', '로그인이 필요해');
    const { itemId, minBid, minutes, kind } = req.data || {};
    const k = (kind==='special') ? 'special' : 'normal';
    const dur = Math.max(MIN_MINUTES, Math.floor(Number(minutes||MIN_MINUTES)));
    _assert(itemId && Number.isFinite(Number(minBid)), 'invalid-argument', '잘못된 입력');
    const userRef = db.doc(`users/${uid}`);
    const aucRef = aucCol.doc();
    await db.runTransaction(async (tx)=>{
      const userSnap = await tx.get(userRef);
      _assert(userSnap.exists, 'not-found', '유저 없음');
      const item = _removeItemFromUser(tx, userRef, userSnap, String(itemId));
      const endMs = Date.now() + dur*60*1000;
      tx.set(aucRef, {
        status:'active', seller_uid: uid, kind: k,
        minBid: Math.max(1, Math.floor(Number(minBid))),
        topBid: null,
        endsAt: admin.firestore.Timestamp.fromMillis(endMs),
        item, createdAt: nowTs()
      });
    });
    return { ok:true, id: aucRef.id };
  });

  const auctionListPublic = onCall({ region:'us-central1' }, async (req)=>{
    const kindReq = req.data?.kind;
    let q = aucCol.where('status','==','active');
    
    if (kindReq === 'special') {
      q = q.where('kind','==','special');
    } else if (kindReq === 'normal') {
      // 'normal'이거나 kind 필드가 아예 없는 레거시 데이터 포함
      q = q.where('kind', 'in', ['normal', null]);
    }

    const snap = await q.orderBy('createdAt','desc').limit(120).get();
    const rows = snap.docs.map(d=>{
      const x = d.data(); const it = x.item || {};
      const base = {
        id: d.id,
        kind: x.kind || 'normal',
        minBid: Number(x.minBid||1),
        topBid: x.topBid || null,
        endsAt: x.endsAt, createdAt: x.createdAt,
        item_id: String(it.id||''),
        consumable: it.consumable || it.isConsumable || false,
        uses: it.uses || null
      };

      if (base.kind === 'special') {
        return {
            ...base,
            description: String(it.description || it.desc_long || it.desc || '')
        };
      }
      return {
        ...base,
        item_name: String(it.name||''),
        item_rarity: String(it.rarity||'normal')
      };
    });
    return { ok:true, rows };
  });
  
  const auctionListMyListings = onCall({ region: 'us-central1' }, async (req) => {
      const uid = req.auth?.uid;
      _assert(uid, 'unauthenticated', '로그인이 필요해');
      const snap = await aucCol.where('seller_uid', '==', uid).orderBy('createdAt', 'desc').limit(50).get();
      const rows = snap.docs.map(d => {
          const x = d.data();
          const it = x.item || {};
          return {
              id: d.id,
              status: x.status,
              kind: x.kind,
              item_name: String(it.name || ''),
              item_rarity: String(it.rarity || 'normal'),
              minBid: Number(x.minBid || 1),
              topBid: x.topBid || null,
              createdAt: x.createdAt,
              endsAt: x.endsAt,
              soldAt: x.soldAt || null,
              buyer_uid: x.buyer_uid || null,
          };
      });
      return { ok: true, rows };
  });


    const auctionGetDetail = onCall({ region:'us-central1' }, async (req)=>{
    const { auctionId } = req.data || {};
    _assert(auctionId, 'invalid-argument', 'auctionId 필요');
    const snap = await aucCol.doc(String(auctionId)).get();
    _assert(snap.exists, 'not-found', '경매 없음');
    const A = snap.data();

    // 특수경매는 정보 비공개
    if ((A.kind || 'normal') === 'special') {
      return { ok: true, kind: 'special' };
    }
    // 일반경매는 상세 정보를 제공
    return {
      ok: true,
      kind: A.kind || 'normal',
      item: A.item,
      minBid: Number(A.minBid || 1),
      topBid: A.topBid || null,
      seller_uid: A.seller_uid
    };
  });




  // [교체] 재입찰(delta hold) + 역전 알림
const auctionBid = onCall({ region:'us-central1' }, async (req)=>{
  const uid = req.auth?.uid;
  _assert(uid, 'unauthenticated', '로그인이 필요해');
  const { auctionId, amount } = req.data || {};
  _assert(auctionId && Number.isFinite(Number(amount)), 'invalid-argument', '잘못된 입력');

  const ref = aucCol.doc(String(auctionId));
  await db.runTransaction(async (tx)=>{
    const snap = await tx.get(ref);
    _assert(snap.exists, 'not-found', '경매 없음');
    const A = snap.data();
    _assert(A.status==='active', 'failed-precondition', '종료된 경매야');
    _assert(A.seller_uid !== uid, 'failed-precondition', '내 경매엔 입찰 불가');
    _assert(A.endsAt?.toMillis() > Date.now(), 'failed-precondition', '이미 마감됨');

    const bid = Math.floor(Number(amount));
    const prev = A.topBid || null;
    const minOk = Math.max(Number(A.minBid||1), (prev?.amount||0) + MIN_STEP);
    _assert(bid >= minOk, 'failed-precondition', `입찰가는 최소 ${minOk} 이상이어야 해`);

    const meRef = db.doc(`users/${uid}`);
    const me = await tx.get(meRef);
    _assert(me.exists, 'not-found', '유저 없음');

    if (prev?.uid && prev.uid === uid) {
      // 같은 사람이 금액 올릴 때: 증가분만 홀드
      const delta = bid - Number(prev.amount||0);
      _assert(delta >= MIN_STEP, 'failed-precondition', '이전 입찰보다 높아야 해');
      _hold(tx, meRef, me, delta);
    } else {
      // 새 사람의 입찰: 전체 금액 홀드 후 이전 보증금 해제
      _hold(tx, meRef, me, bid);
      if (prev?.uid) {
        const prevRef = db.doc(`users/${prev.uid}`);
        const prevSnap = await tx.get(prevRef);
        if (prevSnap.exists) _release(tx, prevRef, prevSnap, Number(prev.amount||0));
      }
    }

    tx.update(ref, { topBid: { uid, amount: bid }, updatedAt: nowTs() });
    tx.set(ref.collection('bids').doc(), { uid, amount: bid, at: nowTs() });

    // 역전 알림: 이전 최고입찰자가 있고, 내가 그 사람이 아닐 때
    if (prev?.uid && prev.uid !== uid) {
      const mailRef = db.collection('mail').doc(prev.uid).collection('msgs').doc();
      tx.set(mailRef, {
        kind: 'notice',
        title: '경매 입찰 알림',
        body: `참여 중인 경매가 다른 입찰로 갱신되었습니다. 경매: ${ref.id}`,
        sentAt: nowTs(),
        read: false,
        from: 'system',
        attachments: { coins:0, items:[], ticket:null },
        claimed: false
      });
    }
  });

  return { ok:true };
});


  const auctionSettle = onCall({ region:'us-central1' }, async (req)=>{
    const uid = req.auth?.uid;
    _assert(uid, 'unauthenticated', '로그인이 필요해');
    const { auctionId } = req.data || {};
    _assert(auctionId, 'invalid-argument', 'auctionId 필요');
    const ref = aucCol.doc(String(auctionId));
    await db.runTransaction(async (tx)=>{
      const snap = await tx.get(ref);
      _assert(snap.exists, 'not-found', '경매 없음');
      const A = snap.data();
      _assert(A.status==='active', 'failed-precondition', '이미 정산됨');
      _assert(A.endsAt?.toMillis() <= Date.now(), 'failed-precondition', '아직 마감 전이야');
      const sellerRef = db.doc(`users/${A.seller_uid}`);
      const seller = await tx.get(sellerRef);
      _assert(seller.exists, 'not-found', '판매자 정보 없음');
      if (A.topBid?.uid) {
        const winRef = db.doc(`users/${A.topBid.uid}`);
        const win = await tx.get(winRef);
        _assert(win.exists, 'not-found', '낙찰자 정보 없음');
        _capture(tx, winRef, win, Number(A.topBid.amount||0));
        _give(tx, sellerRef, Number(A.topBid.amount||0));
        _addItemToUser(tx, winRef, A.item);
        tx.update(ref, { status:'sold', buyer_uid: A.topBid.uid, soldAt: nowTs() });
      } else {
        _give(tx, sellerRef, 1);
        tx.update(ref, { status:'system_sold', buyer_uid:'__system__', soldAt: nowTs() });
      }
    });
    return { ok:true };
  });

  // [추가] 내가 입찰한 경매 목록/최근입찰
const auctionListMyBids = onCall({ region:'us-central1' }, async (req)=>{
  const uid = req.auth?.uid;
  _assert(uid, 'unauthenticated', '로그인이 필요해');

  const snap = await db.collectionGroup('bids')
    .where('uid','==',uid)
    .orderBy('at','desc')
    .limit(100)
    .get();

  const rows = [];
  for (const d of snap.docs) {
    const aucRef = d.ref.parent.parent;
    if (!aucRef) continue;
    const aSnap = await aucRef.get();
    if (!aSnap.exists) continue;
    const A = aSnap.data() || {};
    rows.push({
      id: aucRef.id,
      kind: A.kind || 'normal',
      status: A.status || 'active',
      myAmount: Number(d.data().amount||0),
      topBid: A.topBid || null,
      endsAt: A.endsAt || null,
      createdAt: A.createdAt || null,
      item_name: A.item?.name || null,
      item_rarity: A.item?.rarity || null,
      minBid: Number(A.minBid||1),
      seller_uid: A.seller_uid || null
    });
  }
  return { ok:true, rows };
});


  return {
    tradeCreateListing,
    tradeCancelListing,
    tradeGetListingDetail,
    tradeListPublic,
    tradeListMyListings,
    tradeBuy,
    auctionCreate,
    auctionGetDetail,
    auctionListPublic,
    auctionListMyListings,
    auctionBid,
    auctionSettle,
    auctionListMyBids,
  };
};
