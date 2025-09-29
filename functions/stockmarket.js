// /functions/stockmarket.js  (5분 주기 거래량 집계 방식 적용)
module.exports = (admin, { onCall, HttpsError, logger, onSchedule, GEMINI_API_KEY }) => {
  const db = admin.firestore();
  const { FieldValue } = admin.firestore;

  // [ADD] fetch polyfill for Node < 18 (에뮬/런타임 차이 대비)
  try {
    if (typeof fetch !== 'function') {
      const nf = require('node-fetch');
      global.fetch = nf.default || nf;
    }
  } catch (_) { /* no-op */ }

  // ---------- helpers ----------
  const nowISO = () => new Date().toISOString();
  const dayStamp = (d = new Date()) => {
    const kstOffset = 9 * 60 * 60 * 1000;
    const kstDate = new Date(d.getTime() + kstOffset);
    return kstDate.toISOString().slice(0, 10);
  };
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

  // [신규] 5분 단위 시간 버킷 ID 생성
  const get5MinBucketId = (d = new Date()) => {
    const kstOffset = 9 * 60 * 60 * 1000;
    const kstDate = new Date(d.getTime() + kstOffset);
    const year = kstDate.getUTCFullYear();
    const month = String(kstDate.getUTCMonth() + 1).padStart(2, '0');
    const day = String(kstDate.getUTCDate()).padStart(2, '0');
    const hour = String(kstDate.getUTCHours()).padStart(2, '0');
    const minute = String(Math.floor(kstDate.getUTCMinutes() / 5) * 5).padStart(2, '0');
    return `${year}-${month}-${day}T${hour}:${minute}`;
  };


  async function callGemini(model, system, user) {
    const key = GEMINI_API_KEY.value();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
    const body = {
      systemInstruction: { role: "system", parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: {
        temperature: 0.8,
        maxOutputTokens: 4096,
        responseMimeType: "application/json"
      }
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

  function stripFence(s='') {
    return String(s).trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```$/i, '')
      .trim();
  }
  function safeJson(s, fallback = {}) {
    try { return JSON.parse(stripFence(s)); }
    catch { return fallback; }
  }

  const applyEventToPrice = (cur, dir, mag) => {
    const base = Number.isFinite(+cur) && +cur > 0 ? +cur : 1;
    const randomFactor = 1 + (Math.random() - 0.5) * 0.4;
    const rateBase = { small: 0.03, medium: 0.08, large: 0.20, massive: 0.35 }[mag] ?? 0.05;
    const finalRate = rateBase * randomFactor;
    const sign = dir === 'positive' ? 1 : dir === 'negative' ? -1 : 0;
    const next = base * (1 + sign * finalRate);
    const n = Math.round(next);
    return n > 0 ? n : 1;
  };

  // [수정] 주가 변동이 없도록 현재 가격을 그대로 반환합니다.
  const applyTradeToPrice = (currentPrice, quantity, isBuy) => {
    const price = Number.isFinite(+currentPrice) && +currentPrice > 0 ? +currentPrice : 1;
    return price;
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
    const worldsData = worldsSnap.exists ? worldsSnap.data() : {};

    for (const doc of stocksSnap.docs) {
      const stock = doc.data();
      const planRef = db.collection('stock_events').doc(`${doc.id}_${today}`);

      const worldInfo = (worldsData.worlds || []).find(w => w.id === stock.world_id)
        || { id: stock.world_id, name: stock.world_name || stock.world_id || '', intro: '알려지지 않은 세계' };

      const systemPrompt = `역할: 너는 세계관/회사에 맞는 "사건 아이디어"를 만든다.
출력은 JSON 한 개만. 마크다운/설명/코드펜스 금지.
형식:
{
  "premise": "사건 전말 1문장(한국어).",
  "title_before": "예고용 자극적 한국어 제목(<=40자, 결과 비노출).",
  "potential_impact": "positive" | "negative"
}
규칙:
- potential_impact는 두 값 중 하나만(소문자).
- JSON 외 다른 글자 금지.`;

      const userPrompt = `주식회사: ${stock.name} (${stock.type}, vol:${stock.volatility})
세계관: ${JSON.stringify({ id: worldInfo.id, name: worldInfo.name, intro: worldInfo.intro })}`;

      const numEvents = Math.floor(Math.random() * 3); // 하루 0~2회
      const majorEvents = [];

      for (let i = 0; i < numEvents; i++) {
        try {
          const ideaRaw = await callGemini('gemini-2.5-flash', systemPrompt, userPrompt);
          const idea = safeJson(ideaRaw, { title_before: '임시 제목' });
          const triggerMinute = Math.floor(Math.random() * ((24 * 60) - 10));
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

      await planRef.set({
        stock_id: doc.id,
        date: today,
        world_id: stock.world_id || worldInfo.id || null,
        world_name: stock.world_name || worldInfo.name || null,
        major_events: majorEvents,
        last_processed_minute: -1
      }, { merge: true });

      const dailyRef = db.collection('stock_daily_plans').doc(`${doc.id}_${today}`);
      const basePrice = Number(stock.current_price || 0);
      const trendSign = Math.random() < 0.5 ? -1 : 1;
      const driftBps = ({ low: 2, normal: 5, high: 10 }[stock.volatility] ?? 5);

      await dailyRef.set({
        stock_id: doc.id,
        date: today,
        target_price: basePrice,
        trend_sign: trendSign,
        daily_open: basePrice,
        drift_bps: driftBps
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

    const isPastToday = (m) => {
      const t = ((m % 1440) + 1440) % 1440;
      return currentMinute >= t;
    };

    const stocksSnap = await db.collection('stocks').where('status', '==', 'listed').get();

    for (const stockDoc of stocksSnap.docs) {
      const postForecastMails = [];
      const postResultJobs = [];

      const stockRef = stockDoc.ref;
      const planDocRef = db.collection('stock_events').doc(`${stockRef.id}_${today}`);

      await db.runTransaction(async (tx) => {
        const [stockSnap, planSnap] = await Promise.all([tx.get(stockRef), tx.get(planDocRef)]);
        if (!stockSnap.exists) return;

        const stock = stockSnap.data();
        const plan = planSnap.exists ? planSnap.data() : { stock_id: stockRef.id, date: today, major_events: [], last_processed_minute: -1 };
        let price = Number(stock.current_price || 0);
        let planUpdated = false;

        const events = Array.isArray(plan.major_events) ? plan.major_events : [];
        
        let movedByEvent = false;

        for (const ev of events) {
          if (!ev.forecast_sent && isPastToday(ev.trigger_minute)) {
            const subscribers = Array.isArray(stock.subscribers) ? stock.subscribers : [];
            const worldName = plan.world_name || stock.world_name || stock.world_id || '';
            const worldBadge = worldName ? `【${worldName}】 ` : '';
            subscribers.forEach(uid => {
              postForecastMails.push({
                uid,
                title: `[주식 예고] ${worldBadge}${stock.name}`,
                body: `${ev.title_before}\n\n(10분 후 결과 반영 예정)`,
              });
            });

            ev.forecast_sent = true;
            planUpdated = true;
          }

          if (ev.forecast_sent && !ev.processed && isPastToday(ev.trigger_minute + 10)) {
            price = applyEventToPrice(price, ev.actual_outcome, 'large');
            ev.processed = true;
            movedByEvent = true;
            planUpdated = true;

            const subscribers = Array.isArray(stock.subscribers) ? stock.subscribers : [];
            const worldName = plan.world_name || stock.world_name || stock.world_id || '';
            const worldBadge = worldName ? `【${worldName}】 ` : '';
            postResultJobs.push({
              subscribers,
              worldBadge,
              stockName: stock.name,
              premise: ev.premise,
              expected: ev.potential_impact,
              actual: ev.actual_outcome,
            });

            const dailyRef = db.collection('stock_daily_plans').doc(`${stockRef.id}_${today}`);
            const dailySnap = await tx.get(dailyRef);
            if (dailySnap.exists) {
              const dplan = dailySnap.data();
              const currentTarget = dplan.target_price || price;
              const impactMultiplier = ev.actual_outcome === 'positive' ? 1.075 : 0.925;
              const newTarget = Math.round(currentTarget * impactMultiplier);
              tx.update(dailyRef, { target_price: newTarget });
            }
          }
        }

        if (!movedByEvent) {
          const dailyRef = db.collection('stock_daily_plans').doc(`${stockRef.id}_${today}`);
          const dailySnap = await tx.get(dailyRef);

          let dplan = dailySnap.exists ? dailySnap.data() : null;
          if (!dplan) {
            dplan = {
              stock_id: stockRef.id, date: today, target_price: price,
              trend_sign: Math.random() < 0.5 ? -1 : 1, daily_open: price,
              drift_bps: ({ low: 2, normal: 5, high: 10 }[stock.volatility] ?? 5),
            };
            tx.set(dailyRef, dplan, { merge: true });
          }

          const bps = Number(dplan.drift_bps || 5);
          const trend = Number(dplan.trend_sign || 1);
          const nextTarget = (dplan.target_price || price) * (1 + trend * (bps / 10000));
          const gap = nextTarget - price;
          const step = gap * 0.25;

          const volatility = stock.volatility || 'normal';
          const noiseFactor = { low: 0.003, normal: 0.006, high: 0.015 }[volatility] || 0.006;
          const noise = (Math.random() - 0.5) * price * noiseFactor;

          let newPrice = price + step + noise;
          if (Math.round(newPrice) === price) newPrice += (Math.random() < 0.5 ? -1 : 1);
          price = Math.max(1, Math.round(newPrice));

          tx.update(dailyRef, { target_price: nextTarget });
        }

        if (price !== Number(stock.current_price)) {
          const history = Array.isArray(stock.price_history) ? stock.price_history.slice(-1439) : [];
          history.push({ date: nowISO(), price });
          tx.update(stockRef, { current_price: price, price_history: history });
        }

        if (planUpdated) {
          tx.set(planDocRef, plan, { merge: true });
        }
        
        tx.set(planDocRef, { last_processed_minute: currentMinute }, { merge: true });
      });

      if (postForecastMails.length) {
        const batch = db.batch();
        for (const m of postForecastMails) {
          const mailRef = db.collection('mail').doc(m.uid).collection('msgs').doc();
          batch.set(mailRef, {
            kind: 'etc',
            title: m.title,
            body: m.body,
            sentAt: FieldValue.serverTimestamp(),
            from: '증권 정보국',
            read: false,
          });
        }
        await batch.commit();
        postForecastMails.length = 0;
      }

      for (const job of postResultJobs) {
        try {
          const systemPrompt = `역할: 너는 게임 속 경제 기사 작가야.
출력은 JSON 한 개만. 마크다운/설명/코드펜스 금지.
형식:
{
  "title_after": "<=40자 한국어 제목>",
  "body_after": "2~4문장 한국어 본문. 사건의 '실제 결과'를 간결히 요약."
}`;
          const userPrompt = `사건 전말: ${job.premise}
예상: ${job.expected}
실제 결과: ${job.actual}`;

          const resultRaw = await callGemini('gemini-2.5-flash', systemPrompt, userPrompt);
          const newsObj = safeJson(resultRaw, {});
          const titleA = newsObj.title_after || newsObj.after_title || newsObj.title || '결과 요약';
          const bodyA  = newsObj.body_after  || newsObj.after_body  || newsObj.body  || '요약 본문 수신 실패';

          if (job.subscribers?.length) {
            const batch = db.batch();
            for (const uid of job.subscribers) {
              const mailRef = db.collection('mail').doc(uid).collection('msgs').doc();
              batch.set(mailRef, {
                kind: 'etc',
                title: `[주식 결과] ${job.worldBadge}${job.stockName}`,
                body: `${titleA}\n\n${bodyA}`,
                sentAt: FieldValue.serverTimestamp(),
                from: '증권 정보국',
                read: false,
              });
            }
            await batch.commit();
          }
        } catch (e) {
          logger.error('결과 기사 생성/발송 실패:', e);
        }
      }
      postResultJobs.length = 0;
    }
  });
  
  // ==================================================================
  // 3) 매수/매도: 거래량을 5분 단위로 집계
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
      
      const [userSnap, stockSnap, portSnap] = await Promise.all([tx.get(userRef), tx.get(stockRef), tx.get(portRef)]);
      if (!stockSnap.exists) throw new HttpsError('not-found', '해당 종목이 없습니다.');
      const stock = stockSnap.data();
      ensureListed(stock);

      const price = Number(stock.current_price || 0);
      const cost = price * quantity;
      const coins = Number(userSnap.data()?.coins || 0);
      if (coins < cost) throw new HttpsError('failed-precondition', '코인이 부족합니다.');

      // [수정] 즉시 가격 변동 제거 및 5분 거래량 집계
      // const newPrice = applyTradeToPrice(price, quantity, true);
      const bucketId = get5MinBucketId();
      const volumeRef = db.collection('stock_trade_volumes').doc(`${stockId}_${bucketId}`);

      tx.set(volumeRef, {
        stock_id: stockId,
        bucket_id: bucketId,
        buy_volume: FieldValue.increment(cost),
        sell_volume: FieldValue.increment(0)
      }, { merge: true });

      const heldQty = Number(portSnap.data()?.quantity || 0);
      const heldAvg = Number(portSnap.data()?.average_buy_price || 0);
      const nextQty = heldQty + quantity;
      const nextAvg = Math.round(((heldQty * heldAvg) + (price * quantity)) / nextQty);

      tx.update(userRef, { coins: FieldValue.increment(-cost) });
      tx.set(portRef, { stock_id: stockId, quantity: nextQty, average_buy_price: nextAvg, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      
      // [수정] 가격 업데이트 로직 제거
      // const histBuy = Array.isArray(stock.price_history) ? stock.price_history.slice(-1439) : [];
      // histBuy.push({ date: nowISO(), price: Number(newPrice) });
      // tx.update(stockRef, { current_price: Number(newPrice), price_history: histBuy });

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
      
      const [userSnap, stockSnap, portSnap] = await Promise.all([tx.get(userRef), tx.get(stockRef), tx.get(portRef)]);
      if (!stockSnap.exists) throw new HttpsError('not-found', '해당 종목이 없습니다.');
      const stock = stockSnap.data();
      ensureListed(stock);

      const heldQty = Number(portSnap.data()?.quantity || 0);
      if (heldQty < quantity) throw new HttpsError('failed-precondition', '보유 수량이 부족합니다.');

      const price = Number(stock.current_price || 0);
      const income = price * quantity;

      // [수정] 즉시 가격 변동 제거 및 5분 거래량 집계
      // const newPrice = applyTradeToPrice(price, quantity, false);
      const bucketId = get5MinBucketId();
      const volumeRef = db.collection('stock_trade_volumes').doc(`${stockId}_${bucketId}`);

      tx.set(volumeRef, {
        stock_id: stockId,
        bucket_id: bucketId,
        buy_volume: FieldValue.increment(0),
        sell_volume: FieldValue.increment(income)
      }, { merge: true });

      const nextQty = heldQty - quantity;
      if (nextQty > 0) {
        tx.update(portRef, { quantity: nextQty, updatedAt: FieldValue.serverTimestamp() });
      } else {
        tx.delete(portRef);
      }
      tx.update(userRef, { coins: FieldValue.increment(income) });

      // [수정] 가격 업데이트 로직 제거
      // const histSell = Array.isArray(stock.price_history) ? stock.price_history.slice(-1439) : [];
      // histSell.push({ date: nowISO(), price: Number(newPrice) });
      // tx.update(stockRef, { current_price: Number(newPrice), price_history: histSell });

      return { ok: true, received: income, quantity, price };
    });
  });

  // [신규] 5분마다 거래량 기반으로 목표가(target_price) 조정
  const adjustStockPricesByVolume = onSchedule({
    schedule: 'every 5 minutes', timeZone: 'Asia/Seoul', region: 'us-central1',
  }, async () => {
    const now = new Date();
    const prevBucketDate = new Date(now.getTime() - 5 * 60 * 1000);
    const bucketId = get5MinBucketId(prevBucketDate);
    
    logger.info(`5분 주기 목표가 조정을 시작합니다. (대상 버킷: ${bucketId})`);

    const volumeSnap = await db.collection('stock_trade_volumes')
                               .where('bucket_id', '==', bucketId).get();

    if (volumeSnap.empty) {
      logger.info('지난 5분간 거래량이 집계된 종목이 없습니다.');
      return;
    }
    
    for (const doc of volumeSnap.docs) {
      const volumeData = doc.data();
      const stockId = volumeData.stock_id;
      const today = dayStamp(now);
      const planRef = db.collection('stock_daily_plans').doc(`${stockId}_${today}`);
      
      try {
        await db.runTransaction(async (tx) => {
          const planSnap = await tx.get(planRef);
          if (!planSnap.exists) {
            logger.warn(`일일 계획 문서가 없는 종목입니다: ${stockId}`);
            return;
          }
          
          const plan = planSnap.data();
          const netVolume = (volumeData.buy_volume || 0) - (volumeData.sell_volume || 0);
          
          // [수정] 목표가 영향 계수를 0.0001에서 0.000008로 대폭 하향 조정
          const impact = Math.round(netVolume * 0.000008); 
          const currentTarget = Number(plan.target_price || 0);
          
          if (impact !== 0) {
            tx.update(planRef, { target_price: currentTarget + impact });
            logger.log(`종목 ${stockId}: 순수 거래량 ${netVolume}, 목표가 조정 ${impact}`);
          }
        });
      } catch (e) {
        logger.error(`종목 ${stockId}의 목표가 조정 중 오류 발생:`, e);
      }
    }
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
    const _tm = Math.max(0, Math.min(1429, Math.floor(Number(trigger_minute))));

    if (!stock_id || !potential_impact || !premise || Number.isNaN(_tm)) {
     throw new HttpsError('invalid-argument', '필수 인자가 누락되었습니다.');
    }
    const today = dayStamp();
    const planRef = db.collection('stock_events').doc(`${stock_id}_${today}`);
    const systemPrompt = `역할: 주어진 사건 전말을 바탕으로 '예고용 제목'만 만든다.
출력은 JSON 한 개만. 마크다운/설명/코드펜스 금지.
형식:
{ "title_before": "<=40자 한국어 제목(결과 비노출)>" }
규칙:
- JSON 외 다른 글자 금지.`;
    const userPrompt = `사건 전말 프롬프트: ${premise}
사건의 방향성: ${potential_impact}`;
    const ideaRaw = await callGemini('gemini-2.5-flash', systemPrompt, userPrompt);
    const idea = safeJson(ideaRaw, { title_before: '임시 제목' });
    const newEvent = {
      premise: premise, title_before: idea.title_before, potential_impact: potential_impact,
      actual_outcome: Math.random() < 0.85 ? potential_impact : (potential_impact === 'positive' ? 'negative' : 'positive'),
      trigger_minute: _tm, forecast_sent: false, processed: false, is_manual: true,
    };
    await planRef.set({ major_events: FieldValue.arrayUnion(newEvent) }, { merge: true });
    return { ok: true, event: newEvent };
  });

  const adminCreateWorldEvent = onCall({ region: 'us-central1' }, async (req) => {
    const uid = req.auth?.uid;
    if (!await _isAdmin(uid)) throw new HttpsError('permission-denied', '관리자 전용 기능입니다.');

    const { world_id, premise, trigger_time } = req.data;
    function _parseKST(input) {
      if (input instanceof Date) return input;
      if (typeof input === 'number') return new Date(input);
      const s = String(input || '').trim();
      if (!s) throw new HttpsError('invalid-argument', 'trigger_time이 비어있습니다.');
      if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(s)) return new Date(s);
      return new Date(s.replace(' ', 'T') + ':00+09:00');
    }
    const when = _parseKST(trigger_time);

    if (!world_id || !premise || !trigger_time) {
      throw new HttpsError('invalid-argument', '세계관, 사건 내용, 실행 시간은 필수입니다.');
    }

    const eventRef = db.collection('world_events').doc();
    await eventRef.set({
      world_id,
      premise,
      trigger_time: admin.firestore.Timestamp.fromDate(when),
      processed_preliminary: false,
      processed_final: false,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: uid,
    });

    return { ok: true, eventId: eventRef.id };
  });

  return {
    planDailyStockEvents,
    updateStockMarket,
    adjustStockPricesByVolume,
    buyStock,
    sellStock,
    subscribeToStock,
    createGuildStock,
    distributeDividends,
    adminCreateStock,
    adminCreateManualEvent,
    adminCreateWorldEvent
  };
};
