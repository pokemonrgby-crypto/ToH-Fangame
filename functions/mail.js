// functions/mail.js
// 메일: 발송(sendMail) / 수령(claimMail)
// [구조 변경] 이제 sendMail 시점에서 copyFrom을 처리하여 item 정보를 메일에 직접 저장합니다.
// claimMail은 저장된 item 정보를 그대로 지급하기만 합니다.

module.exports = (admin, { onCall, HttpsError, logger, GEMINI_API_KEY }) => {
  const db = admin.firestore();
  const fetch = (...args)=>import('node-fetch').then(({default:fetch})=>fetch(...args));

  async function _callGeminiForItem(systemText, userText) {
    const apiKey = GEMINI_API_KEY.value();
    if (!apiKey) {
      logger.error('GEMINI_API_KEY is not set in environment variables.');
      throw new HttpsError('internal', 'AI API 키가 설정되지 않았습니다.');
    }
    const model = 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const body = {
      systemInstruction: { role: 'system', parts: [{ text: systemText }] },
      contents: [{ role: 'user', parts: [{ text: userText || '' }] }],
      generationConfig: {
        temperature: 0.9,
        maxOutputTokens: 8192,
        responseMimeType: "application/json"
      },
      safetySettings: [
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" }
      ]
    };
    const res = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    if(!res.ok){
      const txt = await res.text().catch(()=> '');
      throw new HttpsError('internal', `Gemini API 호출 실패: ${res.status} ${txt}`);
    }
    const j = await res.json().catch(()=>null);
    const text = j?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
    if(!text) throw new HttpsError('internal', 'Gemini 응답이 비어 있습니다.');
    return text;
  }

  async function isAdmin(uid){
    if(!uid) return false;
    try{
      const snap = await db.doc('configs/admins').get();
      const d = snap.exists ? snap.data() : {};
      const allow = Array.isArray(d.allow) ? d.allow : [];
      const allowEmails = Array.isArray(d.allowEmails) ? d.allowEmails : [];
      if (allow.includes(uid)) return true;
      const u = await admin.auth().getUser(uid);
      return !!(u?.email && allowEmails.includes(u.email));
    }catch(e){
      logger.error('[mail] isAdmin fail', e);
      return false;
    }
  }

  function tsFrom(ms){
    try{
      const n = Number(ms);
      if (Number.isFinite(n) && n>0) return admin.firestore.Timestamp.fromMillis(n);
    }catch{}
    return null;
  }

  // === 발송 ===
  const sendMail = onCall({ region:'us-central1' }, async (req)=>{
    const uid = req.auth?.uid;
    if (!await isAdmin(uid)) throw new HttpsError('permission-denied','관리자만 가능');

    const {
      target, title, body, kind,
      expiresAt,
      attachments,
      expiresDays, prizeCoins, prizeItems
    } = req.data || {};

    if (!target || !title || !body) throw new HttpsError('invalid-argument','target/title/body 필수');

    let expires = null;
    if (expiresAt) {
      expires = tsFrom(expiresAt);
    } else if (String(kind||'')==='general' && (expiresDays||0)>0) {
      const now = admin.firestore.Timestamp.now();
      expires = admin.firestore.Timestamp.fromMillis(now.toMillis() + Number(expiresDays)*24*60*60*1000);
    }

    let attach = { coins:0, items:[], ticket:null };
    if (attachments?.ticket) {
      const w = attachments.ticket.weights || {};
      attach.ticket = {
        weights: {
          normal: Math.max(0, Number(w.normal||0)|0),
          rare:   Math.max(0, Number(w.rare||0)|0),
          epic:   Math.max(0, Number(w.epic||0)|0),
          legend: Math.max(0, Number(w.legend||0)|0),
          myth:   Math.max(0, Number(w.myth||0)|0),
          aether: Math.max(0, Number(w.aether||0)|0),
        }
      };
    }
    if (Number(prizeCoins)>0) attach.coins = Math.floor(Number(prizeCoins));
    if (Array.isArray(prizeItems)) {
      attach.items = prizeItems.map(it=>({
        name: String(it?.name||''),
        rarity: String(it?.rarity||'normal'),
        consumable: !!it?.consumable,
        count: Math.max(1, Math.floor(Number(it?.count||1)))
      })).filter(x=>x.name);
    }
    if (attachments?.coins) attach.coins = Math.max(attach.coins, Math.floor(Number(attachments.coins)||0));
    if (attachments?.items) {
      const arr = Array.isArray(attachments.items) ? attachments.items : [];
      attach.items.push(...arr.map(it=>({
        name: String(it?.name||''),
        rarity: String(it?.rarity||'normal'),
        consumable: !!it?.consumable,
        count: Math.max(1, Math.floor(Number(it?.count||1)))
      })).filter(x=>x.name));
    }

    if (attachments?.copyFrom) {
      const srcUid   = String(attachments.copyFrom.uid || '').trim();
      const srcItem  = String(attachments.copyFrom.itemId || '').trim();
      const srcCount = Math.min(50, Math.max(1, Math.floor(Number(attachments.copyFrom.count || 1))));
      
      if (srcUid && srcItem) {
        try {
          const srcSnap = await db.doc(`users/${srcUid}`).get();
          const srcList = srcSnap.exists ? (srcSnap.get('items_all') || []) : [];
          const base = srcList.find(x => x.id === srcItem);
          
          if (base) {
            for (let i = 0; i < srcCount; i++) {
              const newItemData = {
                name: String(base.name || 'Gift'),
                rarity: String(base.rarity || 'normal'),
                description: String(base.description || ''),
                count: Math.max(1, Math.floor(Number(base.count || 1))),
                isConsumable: !!(base.isConsumable || base.consumable || base.consume),
              };
              if (base.uses) newItemData.uses = base.uses;
              if (base.properties) newItemData.properties = base.properties;
              if (base.type) newItemData.type = base.type;
              if (base.seedInfo) newItemData.seedInfo = base.seedInfo;
              if (base.placeable !== undefined) newItemData.placeable = base.placeable;
              if (base.promptId) newItemData.promptId = base.promptId;
              if (base.isPromptUse) newItemData.isPromptUse = base.isPromptUse;

              attach.items.push(newItemData);
            }
          } else {
            logger.warn(`[sendMail] copyFrom source item not found: uid=${srcUid}, itemId=${srcItem}`);
          }
        } catch(e) {
          logger.error('[sendMail] copyFrom processing failed:', e);
        }
      }
    }

    const doc = {
      kind: (['notice','warning','general'].includes(kind)) ? kind : 'notice',
      title: String(title).slice(0,100),
      body:  String(body).slice(0,1500),
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
      read: false,
      from: 'admin',
      expiresAt: expires,
      attachments: attach,
      claimed: false
    };

    try{
      if (target === 'all'){
        const usersSnap = await db.collection('users').limit(500).get();
        if (usersSnap.empty) return { ok:true, sentCount:0 };
        const batch = db.batch();
        usersSnap.forEach(u=>{
          const ref = db.collection('mail').doc(u.id).collection('msgs').doc();
          batch.set(ref, doc);
        });
        await batch.commit();
        return { ok:true, sentCount: usersSnap.size };
      } else {
        const ref = db.collection('mail').doc(String(target)).collection('msgs').doc();
        await ref.set(doc);
        return { ok:true, sentCount: 1 };
      }
    }catch(e){
      logger.error('[mail] send error', e);
      throw new HttpsError('internal','메일 발송 실패');
    }
  });

  // === 수령 ===
  const claimMail = onCall({ region:'us-central1', secrets: [GEMINI_API_KEY] }, async (req)=>{
    const uid = req.auth?.uid;
    if(!uid) throw new HttpsError('unauthenticated','로그인이 필요합니다.');
    const { mailId, prompt } = req.data || {};
    if(!mailId) throw new HttpsError('invalid-argument','mailId 필요');

    const mailRef = db.collection('mail').doc(uid).collection('msgs').doc(String(mailId));
    const snap = await mailRef.get();
    if (!snap.exists) throw new HttpsError('not-found','메일이 없습니다.');
    const m = snap.data() || {};

    if (m.claimed) throw new HttpsError('already-exists','이미 수령 완료');
    if (m.expiresAt?.toMillis && m.expiresAt.toMillis() < Date.now()) {
      throw new HttpsError('deadline-exceeded','유효기간이 지났습니다.');
    }

    if (m.kind !== 'general'){
      await mailRef.update({ read:true, claimed:true, claimedAt: admin.firestore.FieldValue.serverTimestamp() });
      return { ok:true, readOnly:true };
    }

    const userRef = db.doc(`users/${uid}`);

    const coins = Math.max(0, Math.floor(Number(m?.attachments?.coins||0)));
    const staticItems = Array.isArray(m?.attachments?.items) ? m.attachments.items : [];
    
    let ticketItem = null;
    if (m?.attachments?.ticket){
        const weights = m.attachments.ticket.weights || {};
        const entries = Object.entries(weights).filter(([k,v])=>Number(v)>0);
        const total = entries.reduce((s,[,v])=>s+Number(v),0);
        if (entries.length && total>0){
            let r = Math.floor(Math.random()*total)+1;
            let picked = entries[0][0];
            for (const [rar, w] of entries){ r -= Number(w); if (r<=0){ picked = rar; break; } }
            
            const gachaLogRef = db.collection('gacha_logs').doc();
            let systemText = '', userText = '', rawAiResponse = '', errorLog = '';

            try{
                const ps = await db.collection('configs').doc('prompts').get();
                systemText = String((ps.exists && ps.data()?.gacha_item_system) || '');
                userText = `생성할 아이템의 희귀도: ${picked}\n유저의 요청사항: ${String(prompt||'없음')}`;
                rawAiResponse = await _callGeminiForItem(systemText, userText);
                const gen = rawAiResponse ? JSON.parse(rawAiResponse) : {};
                
                ticketItem = {
                    id: `item_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
                    name: String(gen?.name || '이름 없는 아이템'),
                    description: String(gen?.description || ''),
                    rarity: picked,
                    isConsumable: !!gen?.isConsumable,
                    uses: Math.max(1, Number(gen?.uses||1))
                };
            } catch(e) {
                logger.error('[mail] aiGenerate failed', e);
                errorLog = e.message || String(e);
                ticketItem = { id: `item_${Date.now()}_${Math.random().toString(36).slice(2,8)}`, name: `${picked.toUpperCase()} 등급 보상`, description: 'AI 생성 실패로 기본 보상이 지급되었습니다.', rarity: picked, isConsumable: false, uses: 1 };
            }
            
            const MAX_LOG_CHARS = 200_000;
            const rawLen = (rawAiResponse || '').length;
            const trimmedRaw = rawLen > MAX_LOG_CHARS ? (rawAiResponse.slice(0, MAX_LOG_CHARS) + `...[TRUNCATED]`) : (rawAiResponse || '');

            await gachaLogRef.set({ uid, mailId, at: admin.firestore.FieldValue.serverTimestamp(), request: { rarity: picked, userPrompt: prompt || null }, ai_input: { systemPrompt, userPrompt }, ai_output: { rawResponse: trimmedRaw, truncated: rawLen > MAX_LOG_CHARS, length: rawLen }, result: { generatedItem: ticketItem, error: errorLog || null } }).catch(e => logger.error('[mail] gachaLog write failed', e));
        }
    }

    await db.runTransaction(async (tx)=>{
      const uSnap = await tx.get(userRef);
      if (!uSnap.exists) throw new HttpsError('not-found','유저 문서 없음');

      const curItems = Array.isArray(uSnap.get('items_all')) ? uSnap.get('items_all') : [];
      const itemsToAdd = [];

      for (const it of staticItems){
        itemsToAdd.push({
          id: `mail_${snap.id}_${Math.random().toString(36).slice(2,8)}`,
          ...it
        });
      }
      
      if (ticketItem) itemsToAdd.push(ticketItem);

      // ANCHOR: [수정] 여러 업데이트를 하나의 객체로 합칩니다.
      const updatePayload = {};
      
      if (coins > 0) {
        updatePayload.coins = admin.firestore.FieldValue.increment(coins);
      }

      if (itemsToAdd.length > 0) {
        updatePayload.items_all = [...curItems, ...itemsToAdd];
      }

      // 페이로드가 비어있지 않은 경우에만 업데이트를 실행합니다.
      if (Object.keys(updatePayload).length > 0) {
        tx.update(userRef, updatePayload);
      }
      // ANCHOR_END

      tx.update(mailRef, {
        read: true,
        claimed: true,
        claimedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    return { ok:true, ticket: ticketItem ? { rarity: ticketItem.rarity, id: ticketItem.id } : null };
  });

  return { sendMail, claimMail };
};
