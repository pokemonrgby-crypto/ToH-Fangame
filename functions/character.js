// /functions/character.js

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions');
const { FieldValue } = require('firebase-admin/firestore');

// AI 호출 관련 헬퍼 함수 (다른 파일에서 가져오거나 여기에 직접 정의)
async function callGemini(apiKey, model, systemText, userText) {
    const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const body = {
      systemInstruction: { role: 'system', parts: [{ text: systemText }] },
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      generationConfig: {
        temperature: 0.85,
        maxOutputTokens: 8192,
        responseMimeType: "application/json",
      }
    };
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) {
        const txt = await res.text();
        throw new HttpsError('internal', `Gemini API Error (${res.status}): ${txt}`);
    }
    const json = await res.json();
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) throw new HttpsError('internal', 'Gemini response was empty.');
    try {
        // AI가 JSON 코드 블록(```json ... ```)을 반환하는 경우를 대비해 파싱 전처리
        const cleanText = text.replace(/^```(?:json)?\s*/, '').replace(/```$/, '').trim();
        return JSON.parse(cleanText);
    } catch (e) {
        logger.error("Gemini JSON parse failed", { rawText: text, error: e.message });
        throw new HttpsError('internal', 'AI 응답 파싱에 실패했습니다.');
    }
}

// AI 응답 정규화 함수
function normalizeAiOutput(parsed, userInput = '') {
    const p = parsed || {};
    const name = String(p.name || '').trim();
    const intro = String(p.intro || p.summary || '').trim();

    const narratives = (Array.isArray(p.narratives) ? p.narratives : [])
        .slice(0, 1)
        .map(n => ({
            title: String(n?.title || '서사').slice(0, 60),
            long: String(n?.long || '').slice(0, 2000),
            short: String(n?.short || '').slice(0, 200),
        }));

    const skills = (Array.isArray(p.skills) ? p.skills : [])
        .slice(0, 4)
        .map(s => ({
            name: String(s?.name || '').slice(0, 24),
            effect: String(s?.effect || s?.desc || '').slice(0, 160)
        }));

    return { name, intro, narratives, skills };
}


module.exports = (admin, { onCall, HttpsError, logger, GEMINI_API_KEY }) => {
    const db = admin.firestore();

    const createChar = onCall({ region: 'us-central1', secrets: [GEMINI_API_KEY] }, async (req) => {
        const uid = req.auth?.uid;
        if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');

        const { world, userInput, name, desc } = req.data;
        if (!world || !userInput || !name || !desc) {
            throw new HttpsError('invalid-argument', '필수 정보가 누락되었습니다.');
        }

        // 프롬프트 로드
        const promptsSnap = await db.doc('configs/prompts').get();
        // ANCHOR: [오류 수정] .exists() -> .exists 로 변경
        const systemPromptRaw = promptsSnap.exists ? promptsSnap.data()?.char_create_system || '' : '';
        if (!systemPromptRaw) throw new HttpsError('internal', '캐릭터 생성 시스템 프롬프트를 찾을 수 없습니다.');
        
        // 프롬프트 변수 채우기
        const systemFilled = systemPromptRaw
            .replace(/{world_summary}/g, world?.summary ?? '')
            .replace(/{world_detail}/g, world?.detail ?? '')
            .replace(/{world_json}/g, JSON.stringify(world?.rawJson ?? world ?? {}))
            .replace(/{user_input}/g, userInput ?? '');
        
        // AI 호출
        const aiResult = await callGemini(GEMINI_API_KEY.value(), 'gemini-2.5-flash-lite', systemFilled, userInput);
        const normalized = normalizeAiOutput(aiResult, userInput);

        // Firestore에 저장할 최종 데이터 생성
        const nid = 'n' + Date.now();
        const firstNarrative = normalized.narratives[0] || {};
        
        const payload = {
            owner_uid: uid,
            world_id: world?.id || 'gionkir',
            name: name.slice(0, 20),
            summary: normalized.intro.slice(0, 600),
            narratives: [{
                id: nid,
                title: (firstNarrative.title || `${name}의 시작`).slice(0, 60),
                long: firstNarrative.long || '새로운 이야기가 시작됩니다.',
                short: firstNarrative.short || '새로운 시작',
                createdAt: Date.now(),
                updatedAt: Date.now(),
            }],
            narrative_latest_id: nid,
            abilities_all: normalized.skills.map(s => ({ name: s.name, desc_soft: s.effect, level: 0 })),
            abilities_equipped: [0, 1],
            items_equipped: [],
            skills: { gardening: 0, art: 0, construction: 0, speech: 0, mining: 0, cooking: 0, processing: 0, crafting: 0, research: 0 },
            image_url: '',
            elo: 1000,
            likes_weekly: 0,
            likes_total: 0,
            exp: 0,
            exp_total: 0,
            input_info: { name, desc, world_name: world?.name || world?.id },
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
        };

        const charRef = await db.collection('chars').add(payload);
        
        logger.info(`New character created by ${uid}: ${charRef.id}`);
        return { ok: true, id: charRef.id };
    });

  const getUserCharacters = onCall({ region: 'us-central1' }, async (req) => {
    const uid = req.auth?.uid;
    if (!uid) {
      throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
    }

    try {
      const charsSnap = await db.collection('chars').where('owner_uid', '==', uid).get();
      
      if (charsSnap.empty) {
        return { ok: true, characters: [] };
      }

      const characters = charsSnap.docs.map(doc => {
        const data = doc.data();
        
        // [수정] 스킬 필드 데이터 구조 변경 및 레거시 호환 처리
        const defaultSkill = { level: 0, exp: 0, nextExp: 1 };
        const baseSkills = {
          gardening: defaultSkill, art: defaultSkill, construction: defaultSkill,
          speech: defaultSkill, mining: defaultSkill, cooking: defaultSkill,
          processing: defaultSkill, crafting: defaultSkill, research: defaultSkill
        };

        let skills = data.skills || {};
        const finalSkills = {};
        for (const key of Object.keys(baseSkills)) {
          // [설명] 기존 데이터가 숫자(레벨)이면 새 구조로 변환, 없으면 기본값 사용
          if (typeof skills[key] === 'number') {
            const level = skills[key];
            finalSkills[key] = {
              level,
              exp: 0,
              nextExp: Math.floor(200 ** (Math.sqrt(level)))
            };
          } else if (typeof skills[key] === 'object' && skills[key] !== null) {
            finalSkills[key] = {
              level: skills[key].level || 0,
              exp: skills[key].exp || 0,
              nextExp: skills[key].nextExp || 1
            };
          } else {
            finalSkills[key] = baseSkills[key];
          }
        }

        return {
          id: doc.id,
          name: data.name || '이름 없음',
          image_url: data.image_url || null,
          thumb_url: data.thumb_url || null,
          skills: finalSkills
        };
      });

      return { ok: true, characters };
    } catch (error) {
      logger.error(`Error fetching characters for user ${uid}:`, error);
      throw new HttpsError('internal', '캐릭터 목록을 불러오는 중 오류가 발생했습니다.');
    }
  });

  return { createChar, getUserCharacters };
};
