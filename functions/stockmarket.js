// functions/stockmarket.js (세계관+기업 사건 처리 / 인덱스-우회 내장 / 품질(quality) / 평균단가=250 스케일 / 강도 상하한)
// [수정] 총 발행량 및 수수료 기능 추가

module.exports = (admin, { onCall, HttpsError, logger, onSchedule, GEMINI_API_KEY }) => {
  const db = admin.firestore();
  const { FieldValue } = admin.firestore;

  // ---- fetch polyfill (Node<18) ----
  try {
    if (typeof fetch !== 'function') {
      const nf = require('node-fetch');
      global.fetch = nf.default || nf;
    }
  } catch (_) { /* no-op */ }

  // ---------- helpers ----------
  const nowISO = () => new Date().toISOString();
  const KST_TZ = 'Asia/Seoul';

  const toKST = (d = new Date()) => new Date(new Date(d).toLocaleString('en-US', { timeZone: KST_TZ }));
  const dayStamp = (d = new Date()) => {
    const k = toKST(d);
    const y = k.getFullYear();
    const m = String(k.getMonth() + 1).padStart(2, '0');
    const dd = String(k.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  };
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

  // 5분 버킷 (KST)
  const get5MinBucketId = (d = new Date()) => {
    const k = toKST(d);
    const year = k.getFullYear();
    const month = String(k.getMonth() + 1).padStart(2, '0');
    const day = String(k.getDate()).padStart(2, '0');
    const hour = String(k.getHours()).padStart(2, '0');
    const minute = String(Math.floor(k.getMinutes() / 5) * 5).padStart(2, '0');
    return `${year}-${month}-${day}T${hour}:${minute}`;
  };

  // ---- safe AI ----
  async function callGemini(model, system, user) {
    const key = GEMINI_API_KEY.value();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
    const body = {
      systemInstruction: { role: "system", parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { temperature: 0.8, maxOutputTokens: 4096, responseMimeType: "application/json" }
    };
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Gemini API Error (${res.status}): ${t}`);
    }
    const json = await res.json();
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) throw new Error(`Gemini response malformed: ${JSON.stringify(json).slice(0, 200)}`);
    return text;
  }
  const stripFence = (s='') => String(s).trim().replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/```$/i,'').trim();
  const safeJson   = (s, fb={}) => { try { return JSON.parse(stripFence(s)); } catch { return fb; } };

  // ---- settings (with defaults) ----
  let _cachedSettings = null, _cachedAt = 0;
  const MAGS = ['tiny','small','medium','large','massive'];
  const MAG2RATE = { tiny:0.015, small:0.03, medium:0.08, large:0.20, massive:0.35 }; // 가격 * 비율
  const AVG_UNIT_PRICE = 250; // 평균 단가 가정

  async function getSettings() {
    const now = Date.now();
    if (_cachedSettings && now - _cachedAt < 60_000) return _cachedSettings;
    const snap = await db.doc('configs/stock_settings').get();
    const d = snap.exists ? snap.data() : {};
    _cachedSettings = {
      // AI 강도 하한/상한
      event_mag_min: (d.event_mag_min && MAGS.includes(String(d.event_mag_min))) ? d.event_mag_min : 'small',
      event_mag_max: (d.event_mag_max && MAGS.includes(String(d.event_mag_max))) ? d.event_mag_max : 'large',
      // 세계관 사건: 예고/결과 지연(분)
      world_forecast_lead_minutes: Number.isFinite(+d.world_forecast_lead_minutes) ? +d.world_forecast_lead_minutes : 10,
      world_result_delay_minutes: Number.isFinite(+d.world_result_delay_minutes) ? +d.world_result_delay_minutes : 10,
      // 거래량→목표가 영향 상한 (버킷당 최대 이동폭)
      max_bucket_impact: Number.isFinite(+d.max_bucket_impact) ? +d.max_bucket_impact : 5,
      // 평균 단가 (스케일)
      bluechip_daily_growth_rate: Number.isFinite(+d.bluechip_daily_growth_rate) ? +d.bluechip_daily_growth_rate : 0.005,

      avg_unit_price: Number.isFinite(+d.avg_unit_price) ? +d.avg_unit_price : AVG_UNIT_PRICE,
      // [추가] 거래 수수료 (기본 1%)
      trade_tax_rate: Number.isFinite(+d.trade_tax_rate) ? +d.trade_tax_rate : 0.01,
      
    };
    _cachedAt = now;
    return _cachedSettings;
  }

  // 강도 보정
  function clampMag(mag, minMag, maxMag) {
    const i = MAGS.indexOf(String(mag));
    const lo = MAGS.indexOf(String(minMag));
    const hi = MAGS.indexOf(String(maxMag));
    if (i < 0) return minMag;
    return MAGS[clamp(i, Math.min(lo,hi), Math.max(lo,hi))];
  }

  // 품질(quality) 보정치
  function qualityMultipliers(q='standard') {
    const t = String(q||'').toLowerCase();
    // drift(추세), noise(잡음), volumeImpact(거래량 영향) 배율
    const map = {
      bluechip:   { drift:0.6, noise:0.6, volumeImpact:0.6 },
      growth:     { drift:1.1, noise:1.1, volumeImpact:1.0 },
      speculative:{ drift:1.3, noise:1.4, volumeImpact:1.5 },
      standard:   { drift:1.0, noise:1.0, volumeImpact:1.0 },
    };
    return map[t] || map.standard;
  }

  // 변동성(volatility) 기본치
  function volatilityParams(v='normal') {
    const s = String(v||'').toLowerCase();
    return {
      drift_bps: ({ low:2, normal:5, high:10 }[s] ?? 5),             // 일일 목표가 추세(bps)
      noise: ({ low:0.003, normal:0.006, high:0.015 }[s] ?? 0.006) // 분당 노이즈 비율
    };
  }

  // 이벤트가 가격에 주는 즉시 충격
  function applyEventToPrice(cur, dir, mag) {
    const base = Number.isFinite(+cur) && +cur > 0 ? +cur : 1;
    const rateBase = MAG2RATE[mag] ?? 0.05;
    const randomFactor = 1 + (Math.random() - 0.5) * 0.3; // ±15% 가감
    const sign = dir === 'positive' ? 1 : dir === 'negative' ? -1 : 0;
    const next = base * (1 + sign * rateBase * randomFactor);
    const n = Math.round(next);
    return n > 0 ? n : 1;
  }

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

  // ===== 인덱스 없는 환경에서도 동작하도록 “시도 → 우회” 유틸 =====

  // --- holders 조회: 인덱스(컬렉션 그룹) 없으면 admin.auth()로 전체 유저 스캔 우회 ---
  async function _listAllUids() {
    const uids = [];
    let pageToken = undefined;
    do {
      const page = await admin.auth().listUsers(1000, pageToken);
      page.users.forEach(u => uids.push(u.uid));
      pageToken = page.pageToken;
    } while (pageToken);
    return uids;
  }

  async function _scanHoldersByAuth(stockId) {
    const uids = await _listAllUids();
    const holders = [];
    const limit = 40; // 동시 요청 제한 (과부하 방지)
    for (let i = 0; i < uids.length; i += limit) {
      const slice = uids.slice(i, i + limit);
      const snaps = await Promise.all(
        slice.map(uid => db.doc(`users/${uid}/portfolio/${stockId}`).get())
      );
      snaps.forEach((snap, idx) => {
        if (snap.exists) {
          holders.push({ uid: slice[idx], ref: snap.ref, data: snap.data() });
        }
      });
    }
    return holders;
  }

  async function _fetchHoldersForStock(stockId, logger) {
    try {
      const cg = await db.collectionGroup('portfolio').where('stock_id', '==', stockId).get();
      return cg.docs.map(d => ({ uid: d.ref.parent.parent.id, ref: d.ref, data: d.data() }));
    } catch (e) {
      const msg = String(e?.message || '');
      if (e?.code === 9 || msg.includes('FAILED_PRECONDITION') || msg.includes('requires an index')) {
        logger?.warn?.(`[index-fallback] portfolio CG 인덱스 없음: admin.auth() 우회로 진행`);
        return await _scanHoldersByAuth(stockId);
      }
      throw e;
    }
  }


  
  function _isIndexError(e) {
    const msg = String(e?.message || '');
    return msg.includes('FAILED_PRECONDITION') && msg.includes('requires an index');
  }

  // world_events 예고/확정 대상 찾기 (인덱스 시도 → 실패하면 단일필드로 조회 후 메모리 필터)
  async function fetchWorldEventsForForecast(now, leadMin) {
    const until = admin.firestore.Timestamp.fromDate(new Date(now.getTime() + leadMin * 60 * 1000));
    const col = db.collection('world_events');
    try {
      // 인덱스 필요: processed_preliminary + trigger_time
      const qs = await col
        .where('processed_preliminary','==', false)
        .where('trigger_time', '<=', until).get();
      return qs.docs;
    } catch (e) {
      if (!_isIndexError(e)) throw e;
      logger.warn('[index-fallback] world_events forecast: fallback to single-field scan');
      const qs = await col.where('trigger_time','<=', until).get();
      return qs.docs.filter(d => d.data()?.processed_preliminary === false);
    }
  }

  async function fetchWorldEventsForFinalize(now, delayMin) {
    const until = admin.firestore.Timestamp.fromDate(new Date(now.getTime() - delayMin * 60 * 1000));
    const col = db.collection('world_events');
    try {
      // 인덱스 필요: processed_preliminary + processed_final + trigger_time
      const qs = await col
        .where('processed_preliminary','==', true)
        .where('processed_final','==', false)
        .where('trigger_time','<=', until).get();
      return qs.docs;
    } catch (e) {
      if (!_isIndexError(e)) throw e;
      logger.warn('[index-fallback] world_events finalize: fallback to single-field scan');
      const qs = await col.where('trigger_time','<=', until).get();
      return qs.docs.filter(d => {
        const x = d.data();
        return x?.processed_preliminary === true && x?.processed_final === false;
      });
    }
  }

  async function fetchStocksByWorld(world_id) {
    const col = db.collection('stocks');
    try {
      const qs = await col.where('world_id','==', world_id).where('status','==','listed').get();
      return qs.docs;
    } catch (e) {
      if (!_isIndexError(e)) throw e;
      logger.warn('[index-fallback] stocks by world: fallback to single-field + filter');
      const qs = await col.where('world_id','==', world_id).get();
      return qs.docs.filter(d => (d.data()?.status === 'listed'));
    }
  }

  // ===== AI로 방향/강도 뽑기 (강도는 설정 범위로 clamp) =====
  async function aiPickImpact({ premise, subjectName, worldName }) {
    const s = await getSettings();
    const systemPrompt = `역할: 사건의 방향과 강도를 결정하는 간단한 JSON만 반환한다. 마크다운/설명 금지.
형식:
{
  "direction": "positive" | "negative",
  "magnitude": "tiny" | "small" | "medium" | "large" | "massive",
  "title_before": "예고용 한국어 제목(<=40자)"
}`;
    const userPrompt = `사건 전말: ${premise}
대상: ${subjectName ?? '해당 세계/기업'}
세계: ${worldName ?? ''}

규칙:
- 반드시 위 형식의 JSON만 출력.
- direction은 둘 중 하나.
- magnitude는 tiny/small/medium/large/massive 중 하나.`;

    const raw = await callGemini('', systemPrompt, userPrompt);
    const obj = safeJson(raw, {});
    const dir = (obj.direction === 'negative') ? 'negative' : 'positive';
    const clamped = clampMag(obj.magnitude || 'medium', s.event_mag_min, s.event_mag_max);
    return {
      direction: dir,
      magnitude: clamped,
      title_before: obj.title_before || '예고'
    };
  }

  // ===== 일일 계획(target) 보정 =====
  async function nudgeDailyTargetByEvent(tx, stockRef, today, outcome, mag) {
    const dailyRef = db.collection('stock_daily_plans').doc(`${stockRef.id}_${today}`);
    const snap = await tx.get(dailyRef);
    const rate = MAG2RATE[mag] ?? 0.05;
    if (!snap.exists) {
      tx.set(dailyRef, {
        stock_id: stockRef.id, date: today,
        target_price: FieldValue.increment(0), // set 하면서 아래 update로 덮임
        trend_sign: Math.random() < 0.5 ? -1 : 1,
        daily_open: 0,
        drift_bps: 5
      }, { merge: true });
    }
    const sign = outcome === 'positive' ? 1 : -1;
    const cur = Number(snap.data()?.target_price || 0);
    const next = Math.max(1, Math.round(cur * (1 + sign * rate)));
    tx.update(dailyRef, { target_price: next });
  }

  // ==================================================================
  // 1) 일일 AI 기업(개별 종목) 사건 계획 (매일 00:05 KST)
  // ==================================================================
  const planDailyStockEvents = onSchedule({
    schedule: '5 0 * * *',
    timeZone: KST_TZ, region: 'us-central1',
    secrets: [GEMINI_API_KEY],
  }, async () => {
    logger.info('매일 자정, AI 기반 주식 시장(기업) 사건을 생성합니다.');
    const today = dayStamp();
    const stocksSnap = await db.collection('stocks').where('status', '==', 'listed').get();
    const worldsSnap = await db.collection('configs').doc('worlds').get();
    const worldsData = worldsSnap.exists ? worldsSnap.data() : {};

    const s = await getSettings();

    for (const doc of stocksSnap.docs) {
      const stock = doc.data();
      const planRef = db.collection('stock_events').doc(`${doc.id}_${today}`);

      const worldInfo = (worldsData.worlds || []).find(w => w.id === stock.world_id)
        || { id: stock.world_id, name: stock.world_name || stock.world_id || '', intro: '알려지지 않은 세계' };

      const idea = await (async () => {
        try {
          const ai = await aiPickImpact({
            premise: `${stock.name} 관련 기업 소식 생성`,
            subjectName: stock.name,
            worldName: worldInfo.name
          });
          return ai;
        } catch (e) {
          logger.error('기업 사건 AI 실패:', e);
          return { direction:'positive', magnitude: 'small', title_before:'예고' };
        }
      })();

      const numEvents = Math.floor(Math.random() * 3); // 0~2회
      const majorEvents = [];
      for (let i = 0; i < numEvents; i++) {
        const triggerMinute = Math.floor(Math.random() * ((24 * 60) - 10));
        const flip = Math.random() < 0.30; // 결과 뒤집기 확률 30%
        majorEvents.push({
          premise: `${stock.name} 관련 잠정 소식`,
          title_before: idea.title_before,
          potential_impact: idea.direction,
          magnitude: idea.magnitude,
          actual_outcome: flip ? (idea.direction === 'positive' ? 'negative' : 'positive') : idea.direction,
          trigger_minute: triggerMinute,
          forecast_sent: false,
          processed: false,
        });
      }

      await planRef.set({
        stock_id: doc.id,
        date: today,
        world_id: stock.world_id || worldInfo.id || null,
        world_name: stock.world_name || worldInfo.name || null,
        major_events: majorEvents,
        last_processed_minute: -1
      }, { merge: true });

      // 일일 계획(드리프트) 초기화
      const dailyRef = db.collection('stock_daily_plans').doc(`${doc.id}_${today}`);
      const basePrice = Number(stock.current_price || 0);
      const trendSign = Math.random() < 0.5 ? -1 : 1;
      const { drift_bps } = volatilityParams(stock.volatility || 'normal');
      await dailyRef.set({
        stock_id: doc.id,
        date: today,
        target_price: basePrice,
        trend_sign: trendSign,
        daily_open: basePrice,
        drift_bps,
        trend_sign_last_changed_at: FieldValue.serverTimestamp() // 최초 기준 시각 남겨두기
      }, { merge: true });

    }
  });

  // ==================================================================
  // 2) 1분 단위 가격 업데이트 (기업(개별 종목) 사건 반영)
  // ==================================================================
  const updateStockMarket = onSchedule({
    schedule: 'every 1 minutes', timeZone: KST_TZ, region: 'us-central1',
    secrets: [GEMINI_API_KEY],
  }, async () => {
    const today = dayStamp();
    const now = toKST(new Date());
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
                body: `${ev.title_before}\n\n(약 10분 후 결과 반영)`,
              });
            });

            ev.forecast_sent = true;
            planUpdated = true;
          }

          if (ev.forecast_sent && !ev.processed && isPastToday(ev.trigger_minute + 10)) {
            const out = ev.actual_outcome || ev.potential_impact || 'positive';
            const mag = ev.magnitude || 'medium';
            price = applyEventToPrice(price, out, mag);
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
              premise: ev.premise || `${stock.name} 관련 이슈`,
              expected: ev.potential_impact,
              actual: out,
            });

            await nudgeDailyTargetByEvent(tx, stockRef, today, out, mag);
          }
        }

        // 이벤트 없을 때 분당 자연 이동(드리프트+노이즈)
        if (!movedByEvent) {
          const dailyRef = db.collection('stock_daily_plans').doc(`${stockRef.id}_${today}`);
          const dailySnap = await tx.get(dailyRef);

          let dplan = dailySnap.exists ? dailySnap.data() : null;
          if (!dplan) {
            const { drift_bps } = volatilityParams(stock.volatility || 'normal');
            dplan = {
              stock_id: stockRef.id, date: today, target_price: price,
              trend_sign: Math.random() < 0.5 ? -1 : 1, daily_open: price,
              drift_bps, trend_sign_last_changed_at: admin.firestore.Timestamp.now()
            };
            tx.set(dailyRef, dplan, { merge: true });
          }

          // ★★★★★ 30분마다 추세 방향 1/2 확률로 변경 ★★★★★
          let trend = Number(dplan.trend_sign || 1);
          const lastChangedMs = dplan.trend_sign_last_changed_at?.toMillis() || 0;
          const thirtyMinAgoMs = now.getTime() - 30 * 60 * 1000;
          
          if (lastChangedMs < thirtyMinAgoMs) {
            if (Math.random() < 0.5) {
              trend *= -1; // 50% 확률로 방향 전환
            }
            // 확률에 상관없이 시간은 갱신
            tx.update(dailyRef, { trend_sign: trend, trend_sign_last_changed_at: admin.firestore.Timestamp.now() });
          }
          // ★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★

          const v = volatilityParams(stock.volatility || 'normal');
          const q = qualityMultipliers(stock.quality || 'standard');

          const bps = Number(dplan.drift_bps || v.drift_bps) * q.drift;
          const nextTarget = (dplan.target_price || price) * (1 + trend * ((bps) / 10000));
          const gap = nextTarget - price;
          const step = gap * 0.25;

          const noiseFactor = (v.noise * q.noise);
          const noise = (Math.random() - 0.5) * price * noiseFactor;

          let newPrice = price + step + noise;
          if (Math.round(newPrice) === price) newPrice += (Math.random() < 0.5 ? -1 : 1);
          price = Math.max(1, Math.round(newPrice));

          tx.update(dailyRef, { target_price: nextTarget });
        }

        if (price !== Number(stock.current_price)) {
          const history = Array.isArray(stock.price_history) ? stock.price_history.slice(-1439) : [];
          history.push({ date: nowISO(), price });
          tx.update(stockRef, {
            current_price: price,
            price_history: history,
            volatility: stock.volatility || 'normal',
            quality: stock.quality || 'standard',
            type: stock.type || 'corp'
          });
        }

        if (planUpdated) {
          tx.set(planDocRef, plan, { merge: true });
        }

        tx.set(planDocRef, { last_processed_minute: (now.getHours()*60 + now.getMinutes()) }, { merge: true });
      });


      // 메일: 예고
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
      }

      // 메일: 결과
     for (const job of postResultJobs) {
        try {
          // [수정] 시스템 프롬프트를 훨씬 더 구체적이고 몰입감 있게 변경합니다.
          const systemPrompt = `당신은 'Tale of Heros' 세계관의 경제 뉴스 채널 'TNN(Tale News Network)' 소속의 노련한 경제 분석가입니다.
모든 분석과 기사는 해당 세계관에 몰입하여, 마치 그 세상의 주민인 것처럼 작성해야 합니다.

[규칙]
1.  절대로 '게임', '플레이어', '콘텐츠', '업데이트', '개발팀', '버그', '패치' 등 현실 세계의 게임 용어를 사용해서는 안 됩니다.
    (X) "신규 콘텐츠 업데이트로 인해 재료 아이템의 수요가 급증했습니다."
    (O) "최근 [지역 이름]에서 발견된 고대 유물 군락으로 인해, 탐험가들 사이에서 발굴 장비의 수요가 급증하고 있습니다."
2.  결과는 반드시 다음 JSON 형식만을 사용해야 하며, 다른 설명은 절대 포함하지 마십시오.
    {
      "title_after": "사건의 결과를 요약하는 흥미로운 기사 제목 (40자 이내)",
      "body_after": "사건의 원인과 시장에 미친 영향을 분석하는 본문 (2~4문장의 단락)"
    }`;

          // [수정] 유저 프롬프트의 용어를 약간 더 몰입감 있게 변경합니다. (선택 사항)
          const userPrompt = `사건 개요: ${job.premise}
사전 예측: ${job.expected}
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
          logger.error('기업 사건 결과 기사 생성/발송 실패:', e);
        }
      }
    }
  });

  // ==================================================================
  // 2-1) 세계관 사건 처리 (예고/확정)  — 인덱스 실패시 우회 내장
  // ==================================================================
  const processWorldEvents = onSchedule({
    schedule: 'every 1 minutes', timeZone: KST_TZ, region: 'us-central1',
    secrets: [GEMINI_API_KEY],
  }, async () => {
    const now = toKST(new Date());
    const today = dayStamp(now);
    const s = await getSettings();

    // 1) 예고 대상: trigger_time <= now + lead
    const forForecast = await fetchWorldEventsForForecast(now, s.world_forecast_lead_minutes);
    for (const doc of forForecast) {
      const evRef = doc.ref;
      const ev = doc.data();

      if (ev.processed_preliminary) continue;

      // 대상 종목(세계 기준) 조회 (인덱스 실패시 단일 필드 우회)
      const stocks = await fetchStocksByWorld(ev.world_id);
      if (!stocks.length) {
        await evRef.update({ processed_preliminary: true, processed_final: false });
        continue;
      }

      // AI로 방향/강도 추출(클램프)
      let ai = { direction: 'positive', magnitude:'small', title_before:'세계 소식' };
      try {
        ai = await aiPickImpact({ premise: ev.premise, subjectName: ev.world_id, worldName: ev.world_id });
      } catch (e) { logger.error('세계관 사건 AI 실패:', e); }

      // 예고 메일 발송
      try {
        const stockNames = stocks.map(s => s.data().name || s.id).join(', ');
        const forecastTitle = `[세계관 예고] ${ev.world_id || ''}`;
        const forecastBody  = `${ai.title_before}\n\n영향 종목: ${stockNames}\n(약 ${s.world_result_delay_minutes}분 후 결과 반영)`;

        // 모든 구독자에게 (각 종목의 구독자 합집합)
        const subs = new Set();
        stocks.forEach(sd => {
          (sd.data().subscribers || []).forEach(uid => subs.add(uid));
        });
        if (subs.size) {
          const batch = db.batch();
          for (const uid of subs) {
            const mailRef = db.collection('mail').doc(uid).collection('msgs').doc();
            batch.set(mailRef, {
              kind: 'etc',
              title: forecastTitle,
              body: forecastBody,
              sentAt: FieldValue.serverTimestamp(),
              from: '증권 정보국',
              read: false,
            });
          }
          await batch.commit();
        }
      } catch (e) { logger.error('세계관 예고 메일 실패:', e); }
            // [추가] 예고 기록: world_events/{id}/stocks, world_events/{id}/ops/forecast
      try {
        const batch = db.batch();

        // 각 종목별 예고 스냅샷
        for (const sd of stocks) {
          const sdata = sd.data() || {};
          const docRef = evRef.collection('stocks').doc(sd.id);
          batch.set(docRef, {
            stock_id: sd.id,
            name: sdata.name || sd.id,
            world_id: ev.world_id || null,
            forecast: {
              title_before: ai.title_before,
              direction: ai.direction,
              magnitude: ai.magnitude,
              at: FieldValue.serverTimestamp()
            },
            result: { applied: false } // 나중에 finalize에서 채움
          }, { merge: true });
        }

        // 메타: 예고 오퍼레이션 로그
        batch.set(evRef.collection('ops').doc('forecast'), {
          at: FieldValue.serverTimestamp(),
          title_before: ai.title_before,
          direction: ai.direction,
          magnitude: ai.magnitude,
          stock_count: stocks.length
        }, { merge: true });

        await batch.commit();
      } catch (e) {
        logger.error('세계관 예고 기록(서브컬렉션) 실패:', e);
      }


      await evRef.set({
        processed_preliminary: true,
        // AI 결정 저장(후에 확정 반영시 사용)
        direction: ev.direction || ai.direction,
        magnitude: ev.magnitude || ai.magnitude,
      }, { merge: true });
    }

    // 2) 확정 대상: trigger_time <= now - delay
    const forFinalize = await fetchWorldEventsForFinalize(now, s.world_result_delay_minutes);
    for (const doc of forFinalize) {
      const evRef = doc.ref;
      const ev = doc.data();

      if (ev.processed_final) continue;

      const stocks = await fetchStocksByWorld(ev.world_id);
      if (!stocks.length) {
        await evRef.update({ processed_final: true });
        continue;
      }

      const dir = ev.direction === 'negative' ? 'negative' : 'positive';
      const mag = clampMag(ev.magnitude || 'medium', s.event_mag_min, s.event_mag_max);

      // 영향 적용: 각 종목 즉시 가격 충격 + 일일 타겟 보정 + 결과 메일
      for (const sd of stocks) {
        const stockRef = sd.ref;
        try {
          await db.runTransaction(async (tx) => {
            const stockSnap = await tx.get(stockRef);
            if (!stockSnap.exists) return;
            const stock = stockSnap.data();
            if (stock.status !== 'listed') return;

            const priceBefore = Number(stock.current_price || 0);
            let price = priceBefore;
            price = applyEventToPrice(price, dir, mag);

            

            // 히스토리 + 안전 디폴트 보정
            const history = Array.isArray(stock.price_history) ? stock.price_history.slice(-1439) : [];
            history.push({ date: nowISO(), price });

            tx.update(stockRef, {
              current_price: price,
              price_history: history,
              volatility: stock.volatility || 'normal',
              quality: stock.quality || 'standard',
              type: stock.type || 'corp',
            });

            // [추가] 세계관 이벤트 결과 기록: world_events/{id}/stocks/{stockId}
            const evStockRef = evRef.collection('stocks').doc(stockRef.id);
            tx.set(evStockRef, {
              result: {
                applied: true,
                direction: dir,
                magnitude: mag,
                price_before: priceBefore,
                price_after: price,
                at: FieldValue.serverTimestamp()
              }
            }, { merge: true });


            
            await nudgeDailyTargetByEvent(tx, stockRef, today, dir, mag);
          });
        } catch (e) {
          logger.error('세계관 사건 가격 반영 실패:', stockRef.id, e);
        }
      }

      // [추가] finalize 오퍼레이션 로그: world_events/{id}/ops/finalize
      try {
        await evRef.collection('ops').doc('finalize').set({
          at: FieldValue.serverTimestamp(),
          direction: dir,
          magnitude: mag,
          stock_count: stocks.length
        }, { merge: true });
      } catch (e) {
        logger.error('세계관 finalize 로그 기록 실패:', e);
      }

      
      // 결과 메일
      try {
        const subs = new Set();
        stocks.forEach(sd => { (sd.data().subscribers || []).forEach(uid => subs.add(uid)); });
        if (subs.size) {
          const systemPrompt = `역할: 세계관 사건 결과 기사. JSON만.
형식: { "title_after": "<=40자>", "body_after": "2~4문장" }`;
          const userPrompt = `사건 전말: ${ev.premise}
결과: ${dir} / 강도: ${mag}`;
          let titleA = '세계관 결과', bodyA = '결과 요약 수신 실패';
          try {
            const raw = await callGemini('gemini-2.5-flash', systemPrompt, userPrompt);
            const obj = safeJson(raw, {});
            titleA = obj.title_after || obj.title || titleA;
            bodyA  = obj.body_after  || obj.body  || bodyA;
          } catch (e) { logger.error('세계관 결과 기사 실패:', e); }

          const batch = db.batch();
          for (const uid of subs) {
            const mailRef = db.collection('mail').doc(uid).collection('msgs').doc();
            batch.set(mailRef, {
              kind: 'etc',
              title: `[세계 결과] ${ev.world_id || ''}`,
              body: `${titleA}\n\n${bodyA}`,
              sentAt: FieldValue.serverTimestamp(),
              from: '증권 정보국',
              read: false,
            });
          }
          await batch.commit();
        }
      } catch (e) { logger.error('세계관 결과 메일 실패:', e); }

      await evRef.update({ processed_final: true });
    }
  });

  // ==================================================================
  // 3) 매수/매도: 거래량 5분 버킷 집계 (즉시 가격 영향 없음)
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

      // [추가] 발행량 확인
      const total = Number(stock.total_supply || 0);
      const circulating = Number(stock.circulating_supply || 0);
      if (total > 0 && (circulating + quantity) > total) {
        throw new HttpsError('failed-precondition', `매수 가능 수량(${total - circulating}주)을 초과했습니다.`);
      }

      const price = Number(stock.current_price || 0);
      const settings = await getSettings();
      const taxRate = settings.trade_tax_rate || 0.01;
      const cost = price * quantity;
      const tax = Math.ceil(cost * taxRate);
      const totalCost = cost + tax;

      const coins = Number(userSnap.data()?.coins || 0);
      if (coins < totalCost) throw new HttpsError('failed-precondition', '코인이 부족합니다.');

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

      tx.update(userRef, { coins: FieldValue.increment(-totalCost) });
      tx.update(stockRef, { circulating_supply: FieldValue.increment(quantity) }); // [추가] 유통량 증가
      tx.set(portRef, { stock_id: stockId, quantity: nextQty, average_buy_price: nextAvg, updatedAt: FieldValue.serverTimestamp() }, { merge: true });

      return { ok: true, paid: totalCost, quantity, price, tax };
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
      const settings = await getSettings();
      const taxRate = settings.trade_tax_rate || 0.01;
      const income = price * quantity;
      const tax = Math.ceil(income * taxRate);
      const finalIncome = income - tax;


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
      tx.update(userRef, { coins: FieldValue.increment(finalIncome) });
      tx.update(stockRef, { circulating_supply: FieldValue.increment(-quantity) }); // [추가] 유통량 감소

      return { ok: true, received: finalIncome, quantity, price, tax };
    });
  });

const adjustStockPricesByVolume = onSchedule({
  schedule: 'every 5 minutes', timeZone: KST_TZ, region: 'us-central1',
}, async () => {
  logger.info('[주가 볼륨 반영] 비활성화됨: 거래량에 따른 가격 변동 없음');
  return;
});

const nudgeBluechipsDaily = onSchedule({
  schedule: '10 2 * * *', timeZone: KST_TZ, region: 'us-central1'
}, async () => {
  const s = await getSettings();
  const grow = Number(s.bluechip_daily_growth_rate || 0.01);
  const snap = await db.collection('stocks')
    .where('status', '==', 'listed')
    .where('quality', '==', 'bluechip')
    .get();
  if (snap.empty) return;
  const now = nowISO();
  const batch = db.batch();
  snap.docs.forEach(doc => {
    const d = doc.data() || {};
    const cur = Math.max(1, Number(d.current_price || 1));
    const next = Math.max(1, Math.round(cur * (1 + grow)));
    const hist = Array.isArray(d.price_history) ? d.price_history.slice(-1439) : [];
    hist.push({ date: now, price: next });
    batch.update(doc.ref, { current_price: next, price_history: hist });
  });
  await batch.commit();
  logger.info(`[bluechip 우상향] ${snap.size}개 종목 일괄 +${(grow*100).toFixed(2)}%`);
});


  // ==================================================================
  // 4) 기타(구독/상장/배당/관리)
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
      
      // [추가] 길드 주식 발행량: 멤버 수 * 1000
      const totalSupply = Math.max(1000, members * 1000);

      tx.set(stockRef, {
        name: `길드: ${g.name || guildId}`, type: 'guild', guild_id: guildId, status: 'listed',
        current_price: initPrice, price_history: [{ date: nowISO(), price: initPrice }], subscribers: [],
        volatility: 'normal', quality: 'standard',
        total_supply: totalSupply,
        circulating_supply: 0
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
    const sdoc = stockSnap.data();
    if (sdoc.type !== 'guild') throw new HttpsError('failed-precondition', '길드 주식만 배당을 지원합니다.');
    const guildId = sdoc.guild_id;
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
    const { name, world_id, world_name, type, initial_price, volatility, description, quality, total_supply } = req.data;
    if (!name || !world_id || !type || !initial_price || initial_price <= 0) {
      throw new HttpsError('invalid-argument', '필수 인자가 누락되었습니다.');
    }
    const stockId = `corp_${world_id}_${name.replace(/\s+/g, '_').slice(0, 10)}`.toLowerCase();
    const stockRef = db.collection('stocks').doc(stockId);
    const doc = await stockRef.get();
    if (doc.exists) throw new HttpsError('already-exists', '이미 존재하는 주식회사입니다.');
    
    const totalSupply = Math.max(1000, Number(total_supply) || 1000000); // [추가] 총 발행량 설정

    const newStock = {
      name, world_id, world_name: world_name || world_id, type, status: 'listed',
      current_price: initial_price, volatility: volatility || 'normal', quality: quality || 'standard',
      description: description || '',
      price_history: [{ date: nowISO(), price: initial_price }], subscribers: [], createdAt: FieldValue.serverTimestamp(),
      total_supply: totalSupply,
      circulating_supply: 0
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

    // 강도도 AI에게 맡기되 settings 범위로 clamp
    let ai = { magnitude:'medium', title_before:'임시 제목' };
    try {
      const tmp = await aiPickImpact({ premise, subjectName: stock_id });
      ai.magnitude = tmp.magnitude; ai.title_before = tmp.title_before;
    } catch {}

    const newEvent = {
      premise: premise,
      title_before: ai.title_before,
      potential_impact: potential_impact,
      magnitude: ai.magnitude,
      actual_outcome: Math.random() < 0.85 ? potential_impact : (potential_impact === 'positive' ? 'negative' : 'positive'),
      trigger_minute: _tm, forecast_sent: false, processed: false, is_manual: true,
    };
    await planRef.set({ major_events: FieldValue.arrayUnion(newEvent) }, { merge: true });
    return { ok: true, event: newEvent };
  });

  const adminDelistAllAndRefund = onCall({ region: 'us-central1', timeoutSeconds: 540 }, async (req) => {
    const uid = req.auth?.uid;
    if (!await _isAdmin(uid)) throw new HttpsError('permission-denied', '관리자 전용 기능입니다.');
  
    const refundMode = String(req.data?.refund_mode || 'current');
    const fixedPrice = Math.floor(Number(req.data?.fixed_price || 250));
    if (refundMode === 'fixed' && fixedPrice <= 0) {
      throw new HttpsError('invalid-argument', '고정 환불가는 1 이상이어야 합니다.');
    }
  
    logger.info(`[일괄폐지 시작] Mode: ${refundMode}, FixedPrice: ${fixedPrice}`);
  
    const listedSnap = await db.collection('stocks').where('status','==','listed').get();
    if (listedSnap.empty) {
      logger.info('[일괄폐지] 대상 주식 없음.');
      return { ok: true, stocks: 0, users: 0, paid: 0, failedRefunds: [] };
    }
  
    let totalPaid = 0;
    let userCount = new Set();
    let stockCount = 0;
    const failedRefunds = []; // 환불 실패 유저 목록
  
    for (const sdoc of listedSnap.docs) {
      const stockId = sdoc.id;
      const sdata = sdoc.data() || {};
      logger.info(`처리 중인 주식: ${sdata.name || stockId}`);
  
      const pricePerShare = (refundMode === 'current')
        ? Math.max(1, Math.floor(Number(sdata.current_price || 1)))
        : fixedPrice;
  
      const holders = await _fetchHoldersForStock(stockId, logger);

      if (holders.length > 0) {
        logger.info(`  -> ${holders.length}명의 보유자 처리 시작...`);
        for (const h of holders) {
          const holderUid = h.uid;
          const qty = Math.floor(Number(h.data?.quantity || 0));
          if (qty > 0 && holderUid) {
            const pay = qty * pricePerShare;
            try {
              await db.runTransaction(async (tx) => {
                const userRef = db.doc(`users/${holderUid}`);
                const portRef = h.ref;
                const userSnap = await tx.get(userRef);

                // exists는 "속성"이야 (함수 아님)
                if (!userSnap.exists) {
                  logger.warn(`유저 문서 없음: ${holderUid}, 환불 건너뛰지만 포트폴리오는 정리합니다.`);
                  tx.delete(portRef);
                  return;
                }

                tx.update(userRef, { coins: FieldValue.increment(pay) });
                tx.delete(portRef);
              });

              totalPaid += pay;
              userCount.add(holderUid);
            } catch (error) {
              logger.error(`환불 실패: User ${holderUid} (Stock ${stockId}). 원인: ${error.message}`);
              failedRefunds.push({
                uid: holderUid,
                stockId: stockId,
                stockName: sdata.name || 'N/A',
                refundAmount: pay,
                reason: error.message
              });
              await h.ref.delete().catch(e => logger.error(`실패 후 포트폴리오 정리 실패: ${holderUid}`, e));
            }
          } else {
            await h.ref.delete().catch(e => logger.error(`빈 포트폴리오 정리 실패: ${holderUid}`, e));
          }
        }
      }


      // 주식 상장 폐지
      await sdoc.ref.update({ status: 'delisted', delistedAt: FieldValue.serverTimestamp() });
      stockCount++;
      logger.info(`  -> ${sdata.name || stockId} 처리 완료.`);
    }
  
    logger.info(`[일괄폐지 완료] stocks=${stockCount} users=${userCount.size} paid=${totalPaid}, failures=${failedRefunds.length}`);
    return { ok: true, stocks: stockCount, users: userCount.size, paid: totalPaid, failedRefunds };
  });

  return {
    // ... (기존 stockmarket.js의 다른 export 함수들)
    planDailyStockEvents,
    updateStockMarket,
    processWorldEvents,
    adjustStockPricesByVolume,
    buyStock,
    sellStock,
    subscribeToStock,
    createGuildStock,
    distributeDividends,
    adminCreateStock,
    adminCreateManualEvent,
    nudgeBluechipsDaily,
    adminDelistAllAndRefund,
  };
};
