// /functions/stockmarket.js
module.exports = (admin, { onCall, HttpsError, logger, onSchedule, GEMINI_API_KEY }) => {
  const db = admin.firestore();
  const { FieldValue } = admin.firestore;

  // ---------- helpers ----------
  const nowISO = () => new Date().toISOString();
  const dayStamp = (d = new Date()) => {
    const kstOffset = 9 * 60 * 60 * 1000;
    const kstDate = new Date(d.getTime() + kstOffset);
    return kstDate.toISOString().slice(0, 10);
  };
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

  async function callGemini(model, system, user) {
    const key = GEMINI_API_KEY.value();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
    const body = {
      contents: [{ role: "user", parts: [{ text: `[SYSTEM]\n${system}\n\n[USER]\n${user}` }] }],
      generationConfig: { temperature: 0.8, maxOutputTokens: 1024, responseMimeType: "application/json" }
    };
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Gemini API Error (${res.status}): ${errorText}`);
    }
    const json = await res.json();
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) throw new Error(`Gemini response malformed: ${JSON.stringify(json).slice(0, 200)}`);
    return text;
  }

  const applyEventToPrice = (cur, dir, mag) => {
    const randomFactor = 1 + (Math.random() - 0.5) * 0.4;
    const rateBase = { small: 0.03, medium: 0.08, large: 0.20, massive: 0.35 }[mag] ?? 0.05;
    const finalRate = rateBase * randomFactor;
    const rate = dir === 'positive' ? finalRate : dir === 'negative' ? -finalRate : 0;
    return Math.max(1, Math.round(cur * (1 + rate)));
  };

  const applyTradeToPrice = (currentPrice, quantity, isBuy) => {
    const baseRate = 0.001;
    const changeRate = baseRate * (quantity / 100);
    const multiplier = isBuy ? (1 + changeRate) : (1 - changeRate);
    return Math.max(1, Math.round(currentPrice * multiplier));
  };
  const ensureListed = (s) => {
    if (!s || s.status !== 'listed') throw new HttpsError('failed-precondition', '상장 상태가 아닙니다.');
  };
  async function _isAdmin(uid) {
    if (!uid) return false;
    try {
      const snap = await db.doc('configs/admins').get();
      const d = snap.exists ? snap.data() : {};
      const allow = Array.isArray(d.allow) ? d.allow : [];
      const allowEmails = Array.isArray(d.allowEmails) ? d.allowEmails : [];
      if (allow.includes(uid)) return true;
      const user = await admin.auth().getUser(uid);
      return !!(user?.email && allowEmails.includes(user.email));
    } catch (_) { return false; }
  }


  // ==================================================================
  // 1) 일일 AI 이벤트 계획 스케줄러 (매일 00:05 KST)
  // ==================================================================
  const planDailyStockEvents = onSchedule({
    schedule: '5 0 * * *',
    timeZone: 'Asia/Seoul', region: 'us-central1',
    secrets: [GEMINI_API_KEY],
  }, async () => {
    logger.info('매일 자정, AI 기반 주식 시장 이벤트를 생성합니다.');
    const today = dayStamp();
    const stocksSnap = await db.collection('stocks').where('status', '==', 'listed').get();
    const worldsSnap = await db.collection('configs').doc('worlds').get();
    const worldsData = worldsSnap.exists() ? worldsSnap.data() : {};

    for (const doc of stocksSnap.docs) {
      const stock = doc.data();
      const planRef = db.collection('stock_events').doc(`${doc.id}_${today}`);

      const worldInfo = (worldsData.worlds || []).find(w => w.id === stock.world_id)
        || { id: stock.world_id, name: stock.world_name || stock.world_id || '', intro: '알려지지 않은 세계' };

      const systemPrompt = `당신은 게임 속 주식 시장의 사건을 만드는 AI입니다.
반드시 JSON 하나로만 답하세요: {"premise":"...", "title_before":"...", "potential_impact":"positive|negative"}`;
      const userPrompt = `주식회사: ${stock.name} (${stock.type}, vol:${stock.volatility})
세계관: ${JSON.stringify({ id: worldInfo.id, name: worldInfo.name, intro: worldInfo.intro })}`;

      const numEvents = Math.floor(Math.random() * 3); // 하루 0~2회
      const majorEvents = [];

      for (let i = 0; i < numEvents; i++) {
        try {
          const ideaRaw = await callGemini('gemini-1.5-flash', systemPrompt, userPrompt);
          const idea = JSON.parse(ideaRaw);
          const triggerMinute = Math.floor(Math.random() * (24 * 60));
          const actual_outcome = Math.random() < 0.7 ? idea.potential_impact
            : (idea.potential_impact === 'positive' ? 'negative' : 'positive');

          majorEvents.push({
            premise: idea.premise,
            title_before: idea.title_before,
            potential_impact: idea.potential_impact,
            actual_outcome,
            trigger_minute: triggerMinute,
            forecast_sent: false,
            processed: false,
          });
        } catch (e) {
          logger.error(`AI 이벤트 생성 실패 (Stock ${doc.id}):`, e);
        }
      }

      // ★ 항상 문서를 남긴다 (이벤트 0개여도)
      await planRef.set({
        stock_id: doc.id,
        date: today,
        world_id: stock.world_id || worldInfo.id || null,
        world_name: stock.world_name || worldInfo.name || null,
        major_events: majorEvents
      }, { merge: true });

      // [신규] 일일 잔물결 계획(목표가/트렌드) 초기화
      const dailyRef = db.collection('stock_daily_plans').doc(`${doc.id}_${today}`);
      const basePrice = Number(stock.current_price || 0);
      const trendSign = Math.random() < 0.5 ? -1 : 1;  // 하루 방향성
      const driftBps = ({ low: 2, normal: 5, high: 10 }[stock.volatility] ?? 5); // 분당 bps
      
      await dailyRef.set({
        stock_id: doc.id,
        date: today,
        target_price: basePrice,
        trend_sign: trendSign,   // -1, +1
        daily_open: basePrice,
        drift_bps: driftBps      // 분당 기초 변동폭
      }, { merge: true });
    }
  });

  // ==================================================================
  // 2) 1분 단위 가격 업데이트 (모든 상장주 대상)
  // ==================================================================
  const updateStockMarket = onSchedule({
    schedule: 'every 1 minutes', timeZone: 'Asia/Seoul', region: 'us-central1',
    secrets: [GEMINI_API_KEY],
  }, async () => {
    const today = dayStamp();
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
    const currentMinute = now.getHours() * 60 + now.getMinutes();

    const stocksSnap = await db.collection('stocks').where('status', '==', 'listed').get();

    for (const stockDoc of stocksSnap.docs) {
      const stockRef = stockDoc.ref;
      const planDocRef = db.collection('stock_events').doc(`${stockRef.id}_${today}`);

      await db.runTransaction(async (tx) => {
        const [stockSnap, planSnap] = await Promise.all([tx.get(stockRef), tx.get(planDocRef)]);
        if (!stockSnap.exists) return;

        const stock = stockSnap.data();
        const plan = planSnap.exists ? planSnap.data() : { stock_id: stockRef.id, date: today, major_events: [] };
        let price = Number(stock.current_price || 0);
        let planUpdated = false;

        const events = Array.isArray(plan.major_events) ? plan.major_events : [];

        for (const event of events) {
          if (event.trigger_minute + 10 === currentMinute && event.forecast_sent && !event.processed) {
            price = applyEventToPrice(price, event.actual_outcome, 'large');
            const systemPrompt = `사건의 전말과 실제 결과가 주어졌다. 투자자들에게 충격을 줄 만한 '결과 기사'를 JSON으로 작성하라: {"title_after":"...","body_after":"..."}`;
            const userPrompt = `사건 전말: ${event.premise}\n예상: ${event.potential_impact}\n실제 결과: ${event.actual_outcome}`;
            try {
              const resultRaw = await callGemini('gemini-1.5-flash', systemPrompt, userPrompt);
              const news = JSON.parse(resultRaw);
              const subscribers = stock.subscribers || [];
              const worldName = plan.world_name || stock.world_name || stock.world_id || '';
              const worldBadge = worldName ? `【${worldName}】 ` : '';
              subscribers.forEach(uid => {
                const mailRef = db.collection('mail').doc(uid).collection('msgs').doc();
                tx.set(mailRef, {
                  kind: 'etc',
                  title: `[주식 결과] ${worldBadge}${stock.name}`,
                  body: `${news.title_after}\n\n${news.body_after}`,
                  sentAt: FieldValue.serverTimestamp(), from: '증권 정보국', read: false,
                });
              });
            } catch (e) { logger.error('결과 기사 생성 실패:', e); }
            event.processed = true;
            planUpdated = true;
          }
        }
        // (기존 잔물결 로직...)
        const didMoveByEvent = events.some(ev => ev.forecast_sent && ev.processed && (ev.trigger_minute + 10 === currentMinute));
        if (!didMoveByEvent) {
            // ...
        }

        const history = Array.isArray(stock.price_history) ? stock.price_history.slice(-1439) : [];
        history.push({ date: nowISO(), price });
        tx.update(stockRef, { current_price: price, price_history: history });

        if (planUpdated) {
          tx.set(planDocRef, { major_events: events }, { merge: true });
        }
      });
    }

    // ANCHOR: 세계관 사건 처리 로직 추가  [전체 교체본]
    // 인덱스 없이 안전하게: processed == false만 쿼리 → 시간 조건은 코드에서 검사
    try {
      const nowUtc = new Date(); // UTC 기준, Timestamp 비교에 문제 없음
      const worldEventsSnap = await db.collection('world_events')
        .where('processed', '==', false)
        .get();

      for (const eventDoc of worldEventsSnap.docs) {
        const event = eventDoc.data();

        // trigger_time 타입 호환: Timestamp → Date, 문자열 ISO도 허용
        const trig = event?.trigger_time?.toDate?.() ? event.trigger_time.toDate()
                    : (event?.trigger_time ? new Date(event.trigger_time) : null);

        // 실행 시점 전이면 건너뜀
        if (!trig || trig > nowUtc) continue;

        try {
          // 이 세계관의 상장 종목 전체 조회
          const affectedStocksSnap = await db.collection('stocks')
            .where('world_id', '==', event.world_id)
            .where('status', '==', 'listed')
            .get();

          for (const stockDoc of affectedStocksSnap.docs) {
            const stock = stockDoc.data();

            // 1) 사건 영향 분석 (모델은 상단 callGemini 그대로 활용)
            const systemPrompt =
              `당신은 경제 분석 AI입니다. 아래 세계관 사건이 해당 회사 주가에 미칠 단기 영향(positive|negative|neutral)과 ` +
              `뉴스 타이틀/본문을 JSON으로만 답하세요. 예: {"impact":"positive","news_title":"...","news_body":"..."}`;
            const userPrompt =
              `세계관 사건:\n${event.premise}\n\n대상 회사:\n${stock.name}\n` +
              (stock.description ? `설명: ${stock.description}\n` : ``) +
              `세계관: ${stock.world_name || stock.world_id}`;

            let analysis = { impact: 'neutral', news_title: '', news_body: '' };
            try {
              const raw = await callGemini('gemini-1.5-flash', systemPrompt, userPrompt);
              const parsed = JSON.parse(raw);
              const impact = ['positive','negative','neutral'].includes(parsed?.impact) ? parsed.impact : 'neutral';
              analysis = {
                impact,
                news_title: String(parsed?.news_title || `${stock.world_name || stock.world_id} 속보`),
                news_body: String(parsed?.news_body || `${event.premise}`)
              };
            } catch (e) {
              logger.warn(`세계관 사건 분석 실패(기본값 사용): ${stockDoc.id}`, e);
            }

            // 2) 가격 반영 (세계관 사건은 medium 강도로)
            if (analysis.impact !== 'neutral') {
              const newPrice = applyEventToPrice(stock.current_price, analysis.impact, 'medium');
              const history = Array.isArray(stock.price_history) ? stock.price_history.slice(-1439) : [];
              history.push({ date: nowISO(), price: newPrice });
              await stockDoc.ref.update({
                current_price: newPrice,
                price_history: history
              });
            }

            // 3) 구독자 뉴스 메일 발송
            const subscribers = Array.isArray(stock.subscribers) ? stock.subscribers : [];
            if (subscribers.length > 0) {
              const batch = db.batch();
              for (const uid of subscribers) {
                const mailRef = db.collection('mail').doc(uid).collection('msgs').doc();
                batch.set(mailRef, {
                  kind: 'etc',
                  title: `[세계관 속보] ${analysis.news_title || (stock.world_name || stock.world_id)}`,
                  body: `${analysis.news_body || event.premise}\n\n(회사: ${stock.name})`,
                  createdAt: FieldValue.serverTimestamp(),
                  sentAt: FieldValue.serverTimestamp(),
                  from: '세계 정세 분석국'
                });
              }
              await batch.commit();
            }
          } // end for stocks

          // 모든 종목 반영이 끝나면 처리 완료 표시
          await eventDoc.ref.update({
            processed: true,
            processed_at: FieldValue.serverTimestamp()
          });
    
        } catch (errEach) {
          // 개별 사건 처리 중 오류: 다음 사건은 계속 처리
          logger.error(`세계관 사건 처리 중 오류 (event: ${eventDoc.id})`, errEach);
          // 필요시 실패 누적필드 남기고 싶으면 주석 해제
          // await eventDoc.ref.set({ last_error: String(errEach?.message || errEach) }, { merge: true });
        }
      } // end for events

    } catch (errAll) {
      logger.error('세계관 사건 조회/처리 루프 실패', errAll);
    }


  // ==================================================================
  // 3) 매수/매도: 현재가와 히스토리를 항상 동시 갱신
  // ==================================================================
  const buyStock = onCall({ region: 'us-central1' }, async (req) => {
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
    const stockId = String(req.data?.stockId || '').trim();
    const quantity = Math.floor(Number(req.data?.quantity || 0));
    if (!stockId || quantity <= 0) throw new HttpsError('invalid-argument', 'stockId/quantity가 올바르지 않습니다.');

    return await db.runTransaction(async (tx) => {
      const userRef = db.doc(`users/${uid}`);
      const stockRef = db.collection('stocks').doc(stockId);
      const portRef = db.doc(`users/${uid}/portfolio/${stockId}`);
      const planRef = db.collection('stock_daily_plans').doc(`${stockId}_${dayStamp()}`);

      const [userSnap, stockSnap, portSnap, planSnap] = await Promise.all([tx.get(userRef), tx.get(stockRef), tx.get(portRef), tx.get(planRef)]);
      if (!stockSnap.exists) throw new HttpsError('not-found', '해당 종목이 없습니다.');
      const stock = stockSnap.data();
      ensureListed(stock);

      const price = Number(stock.current_price || 0);
      const cost = price * quantity;
      const coins = Number(userSnap.data()?.coins || 0);
      if (coins < cost) throw new HttpsError('failed-precondition', '코인이 부족합니다.');

      const newPrice = applyTradeToPrice(price, quantity, true);

      // 목표가 조정
      if (planSnap.exists) {
        const plan = planSnap.data();
        const currentTarget = plan.target_price || price;
        const impact = Math.round(cost * 0.0005); // 거래대금의 0.05%
        tx.update(planRef, { target_price: currentTarget + impact });
      }

      const heldQty = Number(portSnap.data()?.quantity || 0);
      const heldAvg = Number(portSnap.data()?.average_buy_price || 0);
      const nextQty = heldQty + quantity;
      const nextAvg = Math.round(((heldQty * heldAvg) + (price * quantity)) / nextQty);

      tx.update(userRef, { coins: FieldValue.increment(-cost) });
      tx.set(portRef, { stock_id: stockId, quantity: nextQty, average_buy_price: nextAvg, updatedAt: FieldValue.serverTimestamp() }, { merge: true });

      // 히스토리 push
      const histBuy = Array.isArray(stock.price_history) ? stock.price_history.slice(-1439) : [];
      histBuy.push({ date: nowISO(), price: Number(newPrice) });
      tx.update(stockRef, { current_price: Number(newPrice), price_history: histBuy });

      return { ok: true, paid: cost, quantity, price };
    });
  });

  const sellStock = onCall({ region: 'us-central1' }, async (req) => {
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
    const stockId = String(req.data?.stockId || '').trim();
    const quantity = Math.floor(Number(req.data?.quantity || 0));
    if (!stockId || quantity <= 0) throw new HttpsError('invalid-argument', 'stockId/quantity가 올바르지 않습니다.');

    return await db.runTransaction(async (tx) => {
      const userRef = db.doc(`users/${uid}`);
      const stockRef = db.collection('stocks').doc(stockId);
      const portRef = db.doc(`users/${uid}/portfolio/${stockId}`);
      const planRef = db.collection('stock_daily_plans').doc(`${stockId}_${dayStamp()}`);

      const [userSnap, stockSnap, portSnap, planSnap] = await Promise.all([tx.get(userRef), tx.get(stockRef), tx.get(portRef), tx.get(planRef)]);
      if (!stockSnap.exists) throw new HttpsError('not-found', '해당 종목이 없습니다.');
      const stock = stockSnap.data();
      ensureListed(stock);

      const heldQty = Number(portSnap.data()?.quantity || 0);
      if (heldQty < quantity) throw new HttpsError('failed-precondition', '보유 수량이 부족합니다.');

      const price = Number(stock.current_price || 0);
      const income = price * quantity;

      const newPrice = applyTradeToPrice(price, quantity, false);

      // 목표가 조정
      if (planSnap.exists) {
        const plan = planSnap.data();
        const currentTarget = plan.target_price || price;
        const impact = Math.round(income * 0.0005); // 거래대금의 0.05%
        tx.update(planRef, { target_price: currentTarget - impact });
      }

      const nextQty = heldQty - quantity;
      if (nextQty > 0) {
        tx.update(portRef, { quantity: nextQty, updatedAt: FieldValue.serverTimestamp() });
      } else {
        tx.delete(portRef);
      }
      tx.update(userRef, { coins: FieldValue.increment(income) });

      const histSell = Array.isArray(stock.price_history) ? stock.price_history.slice(-1439) : [];
      histSell.push({ date: nowISO(), price: Number(newPrice) });
      tx.update(stockRef, { current_price: Number(newPrice), price_history: histSell });

      return { ok: true, received: income, quantity, price };
    });
  });

  // ==================================================================
  // 4) 기타: 구독/상장/배당
  // ==================================================================
  const subscribeToStock = onCall({ region: 'us-central1' }, async (req) => {
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
    const stockId = String(req.data?.stockId || '').trim();
    const subscribe = req.data?.subscribe;
    if (!stockId) throw new HttpsError('invalid-argument', 'stockId가 필요합니다.');
    const stockRef = db.collection('stocks').doc(stockId);
    const snap = await stockRef.get();
    if (!snap.exists) throw new HttpsError('not-found', '해당 종목이 없습니다.');
    const has = Array.isArray(snap.data().subscribers) && snap.data().subscribers.includes(uid);
    const op = (subscribe === true || (subscribe === undefined && !has)) ? FieldValue.arrayUnion(uid) : FieldValue.arrayRemove(uid);
    await stockRef.update({ subscribers: op });
    return { ok: true, subscribed: (subscribe === true || (subscribe === undefined && !has)) };
  });

  const createGuildStock = onCall({ region: 'us-central1' }, async (req) => {
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
    const guildId = String(req.data?.guildId || '').trim();
    if (!guildId) throw new HttpsError('invalid-argument', 'guildId가 필요합니다.');
    return await db.runTransaction(async (tx) => {
      const guildRef = db.collection('guilds').doc(guildId);
      const guildSnap = await tx.get(guildRef);
      if (!guildSnap.exists) throw new HttpsError('not-found', '길드를 찾을 수 없습니다.');
      const g = guildSnap.data();
      if (g.owner_uid !== uid) throw new HttpsError('permission-denied', '길드장만 상장할 수 있습니다.');
      const stockId = `guild_${guildId}`;
      const stockRef = db.collection('stocks').doc(stockId);
      const stockExist = await tx.get(stockRef);
      if (stockExist.exists) throw new HttpsError('already-exists', '이미 상장된 길드입니다.');
      const level = Number(g.level || 1), members = Number(g.member_count || 1), weekly = Number(g.weekly_points || 0), coins = Number(g.coins || 0);
      const base = (level * 100) + (members * 5) + Math.floor(weekly / 10) + Math.floor(coins / 100);
      const initPrice = clamp(base, 10, 100000);
      tx.set(stockRef, {
        name: `길드: ${g.name || guildId}`, type: 'guild', guild_id: guildId, status: 'listed',
        current_price: initPrice, price_history: [{ date: nowISO(), price: initPrice }], subscribers: [],
      });
      tx.set(guildRef, { stock_treasury: FieldValue.increment(0) }, { merge: true });
      return { ok: true, stockId, price: initPrice };
    });
  });

  const distributeDividends = onCall({ region: 'us-central1' }, async (req) => {
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
    const stockId = String(req.data?.stockId || '').trim();
    const amount = Math.floor(Number(req.data?.amount || 0));
    if (!stockId || amount <= 0) throw new HttpsError('invalid-argument', 'stockId/amount가 올바르지 않습니다.');
    const stockRef = db.collection('stocks').doc(stockId);
    const stockSnap = await stockRef.get();
    if (!stockSnap.exists) throw new HttpsError('not-found', '종목이 없습니다.');
    const s = stockSnap.data();
    if (s.type !== 'guild') throw new HttpsError('failed-precondition', '길드 주식만 배당을 지원합니다.');
    const guildId = s.guild_id;
    if (!guildId) throw new HttpsError('failed-precondition', '길드 연결 정보가 없습니다.');
    const guildRef = db.collection('guilds').doc(guildId);
    const guildSnap = await guildRef.get();
    if (!guildSnap.exists) throw new HttpsError('not-found', '길드를 찾을 수 없습니다.');
    const g = guildSnap.data();
    if (g.owner_uid !== uid) throw new HttpsError('permission-denied', '길드장만 배당할 수 있습니다.');
    const treasury = Number(g.stock_treasury || 0);
    if (treasury < amount) throw new HttpsError('failed-precondition', '길드 주식 금고 잔액이 부족합니다.');
    const holdersSnap = await db.collectionGroup('portfolio').where('stock_id', '==', stockId).get();
    if (holdersSnap.empty) throw new HttpsError('failed-precondition', '보유자가 없습니다.');
    const holders = holdersSnap.docs.map(d => ({ uid: d.ref.parent.parent.id, ...d.data() }));
    const totalShares = holders.reduce((s, h) => s + Number(h.quantity || 0), 0);
    if (totalShares <= 0) throw new HttpsError('failed-precondition', '유효한 보유 수량이 없습니다.');
    const batch = db.batch();
    let distributed = 0;
    for (const h of holders) {
      const share = Number(h.quantity || 0) / totalShares;
      const pay = Math.floor(amount * share);
      if (pay <= 0) continue;
      const userRef = db.doc(`users/${h.uid}`);
      batch.update(userRef, { coins: FieldValue.increment(pay) });
      distributed += pay;
    }
    batch.update(guildRef, { stock_treasury: treasury - distributed });
    await batch.commit();
    return { ok: true, distributed, holders: holders.length };
  });

  const adminCreateStock = onCall({ region: 'us-central1' }, async (req) => {
    const uid = req.auth?.uid;
    if (!await _isAdmin(uid)) throw new HttpsError('permission-denied', '관리자 전용 기능입니다.');
    const { name, world_id, world_name, type, initial_price, volatility, description } = req.data;
    if (!name || !world_id || !type || !initial_price || initial_price <= 0) {
      throw new HttpsError('invalid-argument', '필수 인자가 누락되었습니다.');
    }
    const stockId = `corp_${world_id}_${name.replace(/\s+/g, '_').slice(0, 10)}`.toLowerCase();
    const stockRef = db.collection('stocks').doc(stockId);
    const doc = await stockRef.get();
    if (doc.exists) throw new HttpsError('already-exists', '이미 존재하는 주식회사입니다.');
    const newStock = {
        name, world_id, world_name: world_name || world_id, type, status: 'listed',
        current_price: initial_price, volatility: volatility || 'normal', description: description || '',
        price_history: [{ date: nowISO(), price: initial_price }], subscribers: [], createdAt: FieldValue.serverTimestamp(),
    };
    await stockRef.set(newStock);
    return { ok: true, stockId };
  });

  const adminCreateManualEvent = onCall({ region: 'us-central1', secrets: [GEMINI_API_KEY] }, async (req) => {
    const uid = req.auth?.uid;
    if (!await _isAdmin(uid)) throw new HttpsError('permission-denied', '관리자 전용 기능입니다.');
    const { stock_id, potential_impact, premise, trigger_minute } = req.data;
    if (!stock_id || !potential_impact || !premise || trigger_minute === null) {
        throw new HttpsError('invalid-argument', '필수 인자가 누락되었습니다.');
    }
    const today = dayStamp();
    const planRef = db.collection('stock_events').doc(`${stock_id}_${today}`);
    const systemPrompt = `당신은 게임 속 주식 시장의 사건을 만드는 AI입니다. 반드시 JSON 하나로만 답하세요: {"title_before":"미리 공개될 자극적인 뉴스 제목"}`;
    const userPrompt = `사건 전말 프롬프트: ${premise}\n사건의 방향성: ${potential_impact}`;
    const ideaRaw = await callGemini('gemini-1.5-flash', systemPrompt, userPrompt);
    const idea = JSON.parse(ideaRaw);
    const newEvent = {
        premise: premise, title_before: idea.title_before, potential_impact: potential_impact,
        actual_outcome: Math.random() < 0.85 ? potential_impact : (potential_impact === 'positive' ? 'negative' : 'positive'),
        trigger_minute: trigger_minute, forecast_sent: false, processed: false, is_manual: true,
    };
    await planRef.set({ major_events: FieldValue.arrayUnion(newEvent) }, { merge: true });
    return { ok: true, event: newEvent };
  });

  // ANCHOR: 세계관 사건 생성 함수
  const adminCreateWorldEvent = onCall({ region: 'us-central1' }, async (req) => {
    const uid = req.auth?.uid;
    if (!await _isAdmin(uid)) throw new HttpsError('permission-denied', '관리자 전용 기능입니다.');

    const { world_id, premise, trigger_time } = req.data;
    if (!world_id || !premise || !trigger_time) {
        throw new HttpsError('invalid-argument', '세계관, 사건 내용, 실행 시간은 필수입니다.');
    }

    const eventRef = db.collection('world_events').doc();
    await eventRef.set({
        world_id,
        premise,
        trigger_time: admin.firestore.Timestamp.fromDate(new Date(trigger_time)),
        processed: false,
        createdAt: FieldValue.serverTimestamp(),
        createdBy: uid,
    });

    return { ok: true, eventId: eventRef.id };
  });

  return {
    planDailyStockEvents, updateStockMarket, buyStock, sellStock, subscribeToStock,
    createGuildStock, distributeDividends, adminCreateStock, adminCreateManualEvent,
    adminCreateWorldEvent // export 추가
  };
};
