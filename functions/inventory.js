// /functions/inventory.js
const fs = require('fs').promises;
const path = require('path');

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

  // [핵심 수정] 프롬프트 아이템 사용 함수 (사용자 입력 기반 + 강력한 서버 검증)
  const usePromptItem = onCall({ region: 'us-central1', secrets: [GEMINI_API_KEY] }, async (req) => {
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');

    // 프론트에서 `newItemData` 객체를 직접 받습니다.
    const { itemId, newItemData } = req.data;
    if (!itemId || !newItemData) {
      throw new HttpsError('invalid-argument', '아이템 ID와 생성할 씨앗 데이터가 필요합니다.');
    }
    
    // 간단한 입력값 길이 검사
    if ((newItemData.name || '').length > 50 || (newItemData.description || '').length > 500) {
        throw new HttpsError('invalid-argument', '이름 또는 설명이 너무 깁니다.');
    }

    const allItems = await loadAllItems();
    const RARITY_RANK = { normal: 1, rare: 2, epic: 3, legend: 4, myth: 5, aether: 6 };

    const userRef = db.doc(`users/${uid}`);

    return await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) throw new HttpsError('not-found', '사용자 정보를 찾을 수 없습니다.');
      
      const items = userSnap.data()?.items_all || [];
      const itemIndex = items.findIndex(it => it.id === itemId);

      if (itemIndex === -1) throw new HttpsError('not-found', '인벤토리에서 해당 아이템을 찾을 수 없습니다.');
      
      const baseItem = items[itemIndex];
      if (baseItem.isPromptUse !== true) {
        throw new HttpsError('failed-precondition', '프롬프트를 사용할 수 없는 아이템입니다.');
      }

      let generatedItem;
      try {
        // --- 사용자 입력 데이터 검증 (기존 AI 응답 검증 로직 재사용) ---
        const rarity = baseItem.rarity || 'normal';
        const rules = {
            normal: { growthTime: [10, 60], aestheticValue: [10, 50] },
            rare:   { growthTime: [60, 300], aestheticValue: [20, 150] },
            epic:   { growthTime: [300, 1440], aestheticValue: [30, 400] },
            legend: { growthTime: [720, 1440], aestheticValue: [40, 1000] },
            myth:   { growthTime: [1080, 1440], aestheticValue: [100, 2500] },
            aether: { growthTime: [1440, 1440], aestheticValue: [250, 5000] }
        }[rarity] || { growthTime: [10, 60], aestheticValue: [10, 50] };

        const data = newItemData; // AI 응답 대신 사용자 데이터를 직접 사용
        if (!data.name || data.name.length > 50) throw new Error('입력한 이름이 유효하지 않습니다.');
        if (!data.description || data.description.length > 500) throw new Error('입력한 설명이 유효하지 않습니다.');

        const growth = Number(data.growthTimeMinutes);
        if (growth < rules.growthTime[0] || growth > rules.growthTime[1]) throw new Error(`성장 시간이 규칙에 맞지 않습니다. (허용: ${rules.growthTime[0]}~${rules.growthTime[1]})`);
        
        const aesthetic = Number(data.aestheticValue);
        if (aesthetic < rules.aestheticValue[0] || aesthetic > rules.aestheticValue[1]) throw new Error(`미관 점수가 규칙에 맞지 않습니다. (허용: ${rules.aestheticValue[0]}~${rules.aestheticValue[1]})`);

        if (!Array.isArray(data.harvest) || data.harvest.length === 0 || data.harvest.length > 3) throw new Error('수확물 테이블이 유효하지 않습니다. (1~3개 필요)');
        if (data.harvest.filter(h => h.probability === 1.0).length !== 1) throw new Error('확정 수확물(확률 100%)은 반드시 1개여야 합니다.');

        for (const h of data.harvest) {
            const harvestItemInfo = allItems[h.itemId];
            if (!harvestItemInfo) throw new Error(`존재하지 않는 아이템 ID를 수확물로 설정했습니다: ${h.itemId}`);
            
            const harvestRarity = harvestItemInfo.rarity;
            const harvestRank = RARITY_RANK[harvestRarity] || 0;
            const baseRank = RARITY_RANK[rarity] || 0;

            if (h.probability === 1.0) {
                if (harvestRank !== baseRank) throw new Error(`확정 수확물의 등급은 씨앗 등급과 동일한 '${rarity}'여야 합니다.`);
                if (h.min !== 1 || h.max < 1 || h.max > 5) throw new Error('확정 수확물의 수량 규칙이 맞지 않습니다 (min: 1, max: 1~5).');
            } else {
                if (harvestRank > baseRank + 1) throw new Error(`추가 수확물의 등급이 너무 높습니다.`);
                if (harvestRank === baseRank + 1) {
                    if (h.probability > 0.01) throw new Error('한 등급 높은 아이템의 확률은 1%를 초과할 수 없습니다.');
                    if (h.max > 1) throw new Error('한 등급 높은 아이템의 최대 수확량은 1을 초과할 수 없습니다.');
                }
                if (h.min !== 1 || h.max !== 1) throw new Error('추가 수확물의 수량은 1이어야 합니다 (min: 1, max: 1).');
            }
        }
        
        // --- 검증 통과, 새 아이템 생성 ---
        generatedItem = {
            id: `item_seed_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: data.name,
            rarity: rarity,
            description: data.description,
            isConsumable: true,
            uses: 1,
            type: 'seed',
            placeable: true,
            seedInfo: {
                id: `custom_${Date.now()}`,
                growthTimeMinutes: growth,
                isPerennial: baseItem.isPerennial === true,
                harvest: data.harvest
            },
            properties: {
                appraised: true,
                category: 'gardening',
                placeable: true,
                aestheticValue: aesthetic,
            },
            createdByPrompt: true
        };

      } catch (e) {
        logger.error(`[usePromptItem] Custom item validation failed for user ${uid}, item ${itemId}:`, e);
        // 사용자에게 검증 실패 원인을 명확히 전달
        throw new HttpsError('invalid-argument', `아이템 생성 규칙 검증 실패: ${e.message}`);
      }
      
      // 사용한 커스텀 씨앗 아이템 차감 또는 제거
      if (baseItem.uses > 1) {
        items[itemIndex].uses -= 1;
      } else {
        items.splice(itemIndex, 1);
      }
      // 새로 생성된 아이템 인벤토리에 추가
      items.push(generatedItem);

      tx.update(userRef, { items_all: items });

      logger.info(`Item ${itemId} was used by ${uid} to generate ${generatedItem.id}.`);
      return { ok: true, newItem: generatedItem };
    });
  });




// [신규] AI가 생성한 감정 결과를 안전하게 정규화하는 함수
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
