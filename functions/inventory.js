// /functions/inventory.js
const fs = require('fs').promises;
const path = require('path');
const { FieldValue } = require('firebase-admin/firestore'); // <--- 이 부분이 핵심입니다!

module.exports = (admin, { onCall, HttpsError, logger, GEMINI_API_KEY }) => {
  const db = admin.firestore();

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
        maxOutputTokens: 4096,
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
  
  // 검증을 위해 functions/assets/items.json 파일을 로드하는 헬퍼
  let allItemsCache = null;
  const loadAllItems = async () => {
      if (allItemsCache) return allItemsCache;
      try {
          const itemsPath = path.join(__dirname, './assets/items.json');
          const data = await fs.readFile(itemsPath, 'utf8');
          allItemsCache = JSON.parse(data);
          return allItemsCache;
      } catch (error) {
          logger.error("Failed to load items.json for validation", error);
          return {};
      }
  };

  // [핵심 수정] 프롬프트 아이템 사용 함수 (사용자 텍스트 프롬프트 기반)
  const usePromptItem = onCall({ region: 'us-central1', secrets: [GEMINI_API_KEY] }, async (req) => {
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');

    const { itemId, userPrompt } = req.data;
    if (!itemId || !userPrompt) {
      throw new HttpsError('invalid-argument', '아이템 ID와 사용자 프롬프트가 필요합니다.');
    }
    if (String(userPrompt).length > 300) {
        throw new HttpsError('invalid-argument', '프롬프트가 너무 깁니다 (최대 300자).');
    }

    const userRef = db.doc(`users/${uid}`);
    
    return await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) throw new HttpsError('not-found', '사용자 정보를 찾을 수 없습니다.');
      
      const items = userSnap.data()?.items_all || [];
      const itemIndex = items.findIndex(it => it.id === itemId);

      if (itemIndex === -1) throw new HttpsError('not-found', '인벤토리에서 해당 아이템을 찾을 수 없습니다.');
      
      const baseItem = items[itemIndex];
      if (baseItem.isPromptUse !== true || !baseItem.promptId) {
        throw new HttpsError('failed-precondition', '프롬프트를 사용할 수 없는 아이템입니다.');
      }

      // 1. 시스템 프롬프트 로드
      const promptsSnap = await tx.get(db.doc('configs/prompts'));
      const systemPrompt = promptsSnap.exists ? promptsSnap.data()?.[baseItem.promptId] : '';
      if (!systemPrompt) throw new HttpsError('internal', `시스템 프롬프트(${baseItem.promptId})를 찾을 수 없습니다.`);
      
      // 2. AI 호출을 위한 입력 데이터 구성
      const aiUserInput = JSON.stringify({
        baseItem: {
          rarity: baseItem.rarity,
          isPerennial: baseItem.isPerennial === true
        },
        userRequest: userPrompt
      }, null, 2);

      // 3. AI 호출하여 새로운 씨앗 JSON 생성
      const aiResponseRaw = await _callGemini(systemPrompt, aiUserInput);
      
      // AI의 원본 응답을 Firebase Functions 로그에 기록합니다.
      logger.info(`[usePromptItem] AI Raw Response for user ${uid}:`, {
          itemId: itemId,
          userPrompt: userPrompt,
          aiResponse: aiResponseRaw
      });
      
      const generatedSeedData = JSON.parse(aiResponseRaw);
      
      // 4. AI가 생성한 새로운 수확물 아이템(newItem)을 DB에 저장
      const finalHarvest = [];
      const newCustomItems = [];

      for (const harvestEntry of generatedSeedData.harvest) {
        if (harvestEntry.newItem) {
          const newItem = harvestEntry.newItem;
          const newItemRef = db.collection('custom_items').doc();
          
          const customItemData = {
            id: newItemRef.id,
            name: String(newItem.name).slice(0, 50),
            description: String(newItem.description).slice(0, 500),
            rarity: String(newItem.rarity || baseItem.rarity),
            type: 'material', // 기본 타입
            createdBy: uid,
            createdAt: FieldValue.serverTimestamp()
          };
          
          tx.set(newItemRef, customItemData);
          newCustomItems.push(customItemData); // 로그용으로 저장

          finalHarvest.push({
            itemId: newItemRef.id,
            min: harvestEntry.min,
            max: harvestEntry.max,
            probability: harvestEntry.probability
          });
        } else {
          // 기존 아이템 참조는 그대로 추가
          finalHarvest.push(harvestEntry);
        }
      }

      // 5. 최종 씨앗 아이템 객체 생성
      const newSeedItem = {
        id: `item_seed_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: generatedSeedData.name,
        rarity: baseItem.rarity, // 등급은 원본 아이템을 따름
        description: generatedSeedData.description,
        isConsumable: true,
        uses: 1,
        type: 'seed',
        placeable: true,
        seedInfo: {
            id: `custom_${Date.now()}`,
            growthTimeMinutes: generatedSeedData.growthTimeMinutes,
            isPerennial: generatedSeedData.isPerennial === true,
            harvest: finalHarvest
        },
        properties: {
            appraised: true,
            category: 'gardening',
            placeable: true,
            aestheticValue: generatedSeedData.aestheticValue,
        },
        createdByPrompt: true,
        originalPrompt: userPrompt
      };

      // 6. 인벤토리 업데이트 (사용한 씨앗 차감, 새로 만든 씨앗 추가)
      if (baseItem.uses > 1) {
        items[itemIndex].uses -= 1;
      } else {
        items.splice(itemIndex, 1);
      }
      items.push(newSeedItem);

      tx.update(userRef, { items_all: items });

      logger.info(`Item ${itemId} used by ${uid}. New seed ${newSeedItem.id} created. New custom items:`, { items: newCustomItems.map(it=>it.id) });
      
      // 클라이언트에서 디버깅할 수 있도록 AI 원본 응답을 반환값에 포함합니다.
      return { ok: true, newItem: newSeedItem, _debug: { aiResponseRaw } };
    });
  });


  // (기존 appraiseItem, toggleItemLock 함수는 그대로 유지)
  
  // [최종 수정] AI가 생성한 감정 결과를 안전하게 정규화하는 함수
  function normalizeAppraisalResult(generated, baseItem) {
    const G = generated || {};
    const B = baseItem || {};
    const R = (B.rarity || 'normal').toLowerCase();

    const result = { appraised: true };

    // 1. (기존과 동일)
    const validCategories = ["equipment", "consumable", "material", "furniture", "decoration", "etc"];
    const validSubCategories = [
      "weapon", "armor", "shield", "clothing", "boots", "gloves", "accessory",
      "potion", "food", "scroll", "bomb", "tome", "ore", "herb", "leather",
      "cloth", "gem", "monsterPart", "essence", "chair", "table", "bed",
      "storage", "painting", "sculpture", "rug", "lighting", "plant",
      "key", "quest", "collectible", "junk"
    ];

    if (typeof G.category === 'string' && validCategories.includes(G.category)) {
      result.category = G.category;
    }
    if (typeof G.subCategory === 'string' && validSubCategories.includes(G.subCategory)) {
      result.subCategory = G.subCategory;
    }

    // 2. (기존과 동일)
    result.equipable = G.equipable === true;
    result.placeable = G.placeable === true;

    // 3. aestheticValue 계산 조건 (기존과 동일)
    if (result.placeable || 
        result.category === "furniture" || 
        result.category === "decoration" ||
        result.subCategory === "clothing" ||
        result.subCategory === "accessory") {
      const ranges = {
        normal: { min: 10, max: 50 },
        rare:   { min: 20, max: 150 },
        epic:   { min: 30, max: 400 },
        legend: { min: 40, max: 1000 },
        myth:   { min: 100, max: 2500 },
        aether: { min: 250, max: 5000 },
      };
      const range = ranges[R] || ranges.normal;
      let value = Math.max(range.min, Math.min(range.max, Math.floor(Number(G.aestheticValue) || range.min)));

      // [수정] 보너스 규칙 적용 조건에 의상/장신구 추가
      if (result.category === "furniture" || 
          result.category === "decoration" ||
          result.subCategory === "clothing" ||
          result.subCategory === "accessory") {
        const bonusRatio = 0.3 + Math.random() * 0.7; // 30% ~ 100%
        value = Math.floor(value * (1 + bonusRatio));
      }
      result.aestheticValue = value;
    }

    // 4. (기존과 동일)
    if (Array.isArray(G.effects)) {
      result.effects = G.effects.slice(0, 2).map(eff => {
        if (typeof eff === 'object' && eff !== null) {
          return {
            trigger: String(eff.trigger || '').slice(0, 50),
            description: String(eff.description || '').slice(0, 200)
          };
        }
        return { description: String(eff || '').slice(0, 200) };
      }).filter(e => e.description);
    }

    return result;
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
      const systemPrompt = promptsSnap.exists ? promptsSnap.data()?.appraise_item_system : '';
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

      // [수정] 감정 결과를 그대로 저장하는 대신, 정규화 함수를 통과시킵니다.
      const finalProperties = normalizeAppraisalResult(generatedProperties, item);

      // 감정 결과(properties)를 아이템에 추가
      items[itemIndex].properties = finalProperties;

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
    usePromptItem,
  };
};
