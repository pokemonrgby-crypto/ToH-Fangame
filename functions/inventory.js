// /functions/inventory.js
module.exports = (admin, { onCall, HttpsError, logger, GEMINI_API_KEY }) => {
  const db = admin.firestore();
  const fetch = (...args)=>import('node-fetch').then(({default:fetch})=>fetch(...args));

  // Gemini API 호출 헬퍼 함수
  async function _callGemini(systemText, userText) {
    const apiKey = GEMINI_API_KEY.value();
    if (!apiKey) {
      logger.error('GEMINI_API_KEY is not set.');
      throw new HttpsError('internal', 'AI API 키가 설정되지 않았습니다.');
    }
    const model = 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const body = {
      systemInstruction: { role: 'system', parts: [{ text: systemText }] },
      contents: [{ role: 'user', parts: [{ text: userText || '' }] }],
      generationConfig: {
        temperature: 0.8,
        maxOutputTokens: 2048,
        responseMimeType: "application/json"
      }
    };
    const res = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    if(!res.ok){
      const txt = await res.text().catch(()=> '');
      throw new HttpsError('internal', `Gemini API 호출 실패: ${res.status} ${txt}`);
    }
    const j = await res.json().catch(()=>null);
    const text = j?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if(!text) throw new HttpsError('internal', 'Gemini 응답이 비어 있습니다.');
    return text;
  }

  /**
   * 아이템 감정 (Appraise Item) 함수
   */
  const appraiseItem = onCall({ region: 'us-central1', secrets: [GEMINI_API_KEY] }, async (req) => {
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');

    const { itemId } = req.data;
    if (!itemId) throw new HttpsError('invalid-argument', '아이템 ID가 필요합니다.');

    const userRef = db.doc(`users/${uid}`);

    return await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) throw new HttpsError('not-found', '사용자 정보를 찾을 수 없습니다.');
      
      const items = userSnap.data()?.items_all || [];
      const itemIndex = items.findIndex(it => it.id === itemId);

      if (itemIndex === -1) throw new HttpsError('not-found', '인벤토리에서 해당 아이템을 찾을 수 없습니다.');
      
      const item = items[itemIndex];
      if (item.properties?.appraised) throw new HttpsError('failed-precondition', '이미 감정된 아이템입니다.');

      // AI 프롬프트 로드
      const promptsSnap = await tx.get(db.doc('configs/prompts'));
      const systemPrompt = promptsSnap.exists() ? promptsSnap.data()?.appraise_item_system : '';
      if (!systemPrompt) throw new HttpsError('internal', '아이템 감정용 시스템 프롬프트를 찾을 수 없습니다.');

      const userPrompt = JSON.stringify({
        name: item.name,
        rarity: item.rarity,
        description: item.description || item.desc_soft || '',
        // source: item.source || null // 획득처 정보가 있다면 추가 가능
      });

      // AI 호출
      const aiResponseRaw = await _callGemini(systemPrompt, userPrompt);
      const generatedProperties = JSON.parse(aiResponseRaw);

      // 감정 결과(properties)를 아이템에 추가
      items[itemIndex].properties = { ...generatedProperties, appraised: true };

      // Firestore 문서 업데이트
      tx.update(userRef, { items_all: items });

      logger.info(`Item ${itemId} for user ${uid} has been appraised.`);
      return { ok: true, item: items[itemIndex] };
    });
  });

  /**
   * 사용자의 인벤토리에서 특정 아이템의 isLocked 상태를 토글합니다.
   */
  const toggleItemLock = onCall({ region: 'us-central1' }, async (req) => {
    const uid = req.auth?.uid;
    if (!uid) {
      throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
    }

    const { itemId, lock } = req.data;
    if (!itemId || typeof lock !== 'boolean') {
      throw new HttpsError('invalid-argument', 'itemId와 잠금 상태(lock)가 필요합니다.');
    }

    const userRef = db.doc(`users/${uid}`);

    try {
      await db.runTransaction(async (tx) => {
        const userSnap = await tx.get(userRef);
        if (!userSnap.exists) {
          throw new HttpsError('not-found', '사용자 정보를 찾을 수 없습니다.');
        }

        const items = userSnap.data()?.items_all || [];
        const itemIndex = items.findIndex(it => it.id === itemId);

        if (itemIndex === -1) {
          throw new HttpsError('not-found', '인벤토리에서 해당 아이템을 찾을 수 없습니다.');
        }

        // isLocked 필드가 없으면 false로 간주하고 토글
        items[itemIndex].isLocked = lock;

        tx.update(userRef, { items_all: items });
      });

      logger.info(`Item ${itemId} for user ${uid} has been ${lock ? 'locked' : 'unlocked'}.`);
      return { ok: true, itemId, isLocked: lock };

    } catch (error) {
      logger.error(`Error toggling item lock for user ${uid}, item ${itemId}:`, error);
      if (error instanceof HttpsError) {
        throw error;
      }
      throw new HttpsError('internal', '아이템 잠금 상태 변경 중 오류가 발생했습니다.');
    }
  });

  return {
    toggleItemLock,
    appraiseItem, // 새로 추가된 함수 export
  };
};
