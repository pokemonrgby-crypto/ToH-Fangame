// /functions/encounter_v2.js
const { Timestamp, FieldValue } = require('firebase-admin/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');

const MODEL_POOL = ['gemini-2.0-flash-lite', 'gemini-2.5-flash-lite', 'gemini-2.0-flash', 'gemini-2.5-flash'];
const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY');

function pickModels() {
  const shuffled = [...MODEL_POOL].sort(() => 0.5 - Math.random());
  return { primary: shuffled[0], fallback: shuffled[1] || shuffled[0] };
}

async function loadPrompt(db, id) {
  const ref = db.collection('configs').doc('prompts');
  const doc = await ref.get();
  if (!doc.exists) return '';
  const data = doc.data() || {};
  return String(data[id] || '');
}

async function callGemini({ apiKey, systemText, userText, logger, modelName }) {
    if (!modelName) throw new Error("callGemini에 modelName이 제공되지 않았습니다.");
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
    const body = {
        systemInstruction: { role: 'system', parts: [{ text: String(systemText || '') }] },
        contents: [{ role: 'user', parts: [{ text: String(userText || '') }] }],
        generationConfig: { temperature: 0.9, maxOutputTokens: 8192, responseMimeType: "application/json" }
    };
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        logger?.error?.("Gemini API Error", { status: res.status, text: errorText });
        throw new Error(`Gemini API Error: ${res.status}`);
    }
    const j = await res.json();
    const text = j?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    try {
        let parsed = JSON.parse(text);
        if (Array.isArray(parsed) && parsed.length > 0) {
            parsed = parsed[0];
        }
        return parsed;
    } catch (e) {
        logger?.error?.("Gemini JSON parse failed", { rawText: text.slice(0, 500), error: String(e?.message || e) });
        return {};
    }
}

module.exports = (admin, { HttpsError, logger }) => {
    const db = admin.firestore();

    const startEncounter = onCall({ secrets: [GEMINI_API_KEY], region: 'us-central1' }, async (req) => {
        const uid = req.auth?.uid;
        if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');

        // [수정] 조우 시작 전, 공용 쿨타임을 확인합니다.
        const userSnap = await db.collection('users').doc(uid).get();
        const userData = userSnap.data() || {};
        const nowSec = Math.floor(Date.now() / 1000);
        const cooldownUntil = userData.cooldown_all_until || 0; // cooldown_all_until 확인
        const left = cooldownUntil - nowSec;
        if (left > 0) {
            throw new HttpsError('failed-precondition', `공용 쿨타임이 ${left}초 남았습니다.`);
        }

        const { myCharId, opponentCharId, myChar_forAI, opponentChar_forAI, relation_note, simulate } = req.data;
        if (!myCharId || !opponentCharId || !myChar_forAI || !opponentChar_forAI) {
            throw new HttpsError('invalid-argument', '캐릭터 정보가 필요합니다.');
        }

        let debugStep = '초기화';
        try {
            debugStep = '캐릭터 소유권 확인 및 세계관 정보 조회';
            const myCharSnap = await db.collection('chars').doc(myCharId).get();
            if (!myCharSnap.exists) throw new HttpsError('not-found', '내 캐릭터 정보를 찾을 수 없습니다.');
            if (myCharSnap.data().owner_uid !== uid) throw new HttpsError('permission-denied', '자신의 캐릭터로만 조우를 시작할 수 있습니다.');
            
            const myChar = myCharSnap.data();
            const worldId = myChar.world_id || 'gionkir';
            const worldSnap = await db.collection('worlds').doc(worldId).get();
            const worldData = worldSnap.exists ? worldSnap.data() : {};
            const relationNote = relation_note || '아직 관계 정보가 없습니다.';

            const opponentCharSnapForSim = await db.collection('chars').doc(opponentCharId).get();
            if (!opponentCharSnapForSim.exists) throw new HttpsError('not-found', '상대 캐릭터를 찾을 수 없습니다.');
            const opponentCharForSim = opponentCharSnapForSim.data();

            debugStep = '프롬프트 생성';
            const systemPrompt = await loadPrompt(db, 'encounter_system_prompt');

            const userPrompt = `
                ## 세계관 정보
                - 이름: ${worldData.name || worldId}
                - 소개: ${worldData.intro || ''}
                - 상세 설정: ${worldData.detail?.lore || ''}

                ## 캐릭터 A
                ${JSON.stringify(myChar_forAI, null, 2)}

                ## 캐릭터 B
                ${JSON.stringify(opponentChar_forAI, null, 2)}

                ## 두 캐릭터의 기존 관계
                ${relationNote}
            `;

            debugStep = 'Gemini AI 호출 (조우 서사 생성)';
            const { primary, fallback } = pickModels();
            let result = {};
            try {
                result = await callGemini({ apiKey: GEMINI_API_KEY.value(), systemText: systemPrompt, userText: userPrompt, logger, modelName: primary });
            } catch (e) {
                logger.warn(`1차 모델(${primary}) 실패, 대체 모델(${fallback})로 재시도.`, { error: e.message });
                result = await callGemini({ apiKey: GEMINI_API_KEY.value(), systemText: systemPrompt, userText: userPrompt, logger, modelName: fallback });
            }
            if (!result.title || !result.content) throw new HttpsError('internal', `AI가 유효한 조우 서사를 생성하지 못했습니다. 응답: ${JSON.stringify(result)}`);

// ★ 모의 조우: 통계/보상/관계 갱신 없이 로그만 기록
if (simulate) {
  const logRef = db.collection('encounter_logs').doc();
  await logRef.set({
    a_char: `chars/${myCharId}`,
    b_char: `chars/${opponentCharId}`,
    a_snapshot: { name: myChar.name, thumb_url: myChar.thumb_url || null },
    b_snapshot: { name: opponentCharForSim.name, thumb_url: opponentCharForSim.thumb_url || null },
    title: result.title,
    content: result.content,
    exp_a: 0,
    exp_b: 0,
    simulated: true,                 // ★ 모의 로그 표시
    createdAt: Timestamp.now(),
    endedAt: Timestamp.now()
  });

  // ★ 공용 쿨타임 5분 설정(4모드 공유)
  const nowSim = Math.floor(Date.now() / 1000);
  await db.collection('users').doc(uid).set(
    { cooldown_all_until: nowSim + 300 },
    { merge: true }
  );

  logger.log('모의 조우 생성 완료(로그만 기록)');
  return { ok: true, logId: logRef.id, simulated: true };
}





          
            debugStep = '데이터베이스 트랜잭션 시작';
            const expA = Math.max(5, Math.min(250, Number(result.exp_char_a) || 20));
            const expB = Math.max(5, Math.min(250, Number(result.exp_char_b) || 20));
            
            const logRef = db.collection('encounter_logs').doc();
            await db.runTransaction(async (tx) => {
                const charARef = db.collection('chars').doc(myCharId);
                const charBRef = db.collection('chars').doc(opponentCharId);
                
                const opponentCharSnap = await tx.get(charBRef);
                if (!opponentCharSnap.exists) throw new HttpsError('not-found', '상대 캐릭터를 찾을 수 없습니다.');
                const opponentChar = opponentCharSnap.data();

                const userARef = db.collection('users').doc(myChar.owner_uid);
                const userBRef = db.collection('users').doc(opponentChar.owner_uid);

                const [charASnap, charBSnap] = await Promise.all([ tx.get(charARef), tx.get(charBRef) ]);
                if (!charASnap.exists || !charBSnap.exists) throw new HttpsError('not-found', '트랜잭션 중 캐릭터 정보를 찾을 수 없습니다.');
                
                const charAData = charASnap.data(); 
                const charBData = charBSnap.data();
                const expA_total = (charAData.exp || 0) + expA; 
                const coinsToMintA = Math.floor(expA_total / 100); 
                const finalExpA = expA_total % 100;
                
                const expB_total = (charBData.exp || 0) + expB; 
                const coinsToMintB = Math.floor(expB_total / 100); 
                const finalExpB = expB_total % 100;

                tx.set(logRef, { a_char: `chars/${myCharId}`, b_char: `chars/${opponentCharId}`, a_snapshot: { name: myChar.name, thumb_url: myChar.thumb_url || null }, b_snapshot: { name: opponentChar.name, thumb_url: opponentChar.thumb_url || null }, title: result.title, content: result.content, exp_a: expA, exp_b: expB, createdAt: Timestamp.now(), endedAt: Timestamp.now() });
                tx.update(charARef, { encounter_count: FieldValue.increment(1), exp_total: FieldValue.increment(expA), exp: finalExpA, updatedAt: Timestamp.now() });
                tx.update(charBRef, { encounter_count: FieldValue.increment(1), exp_total: FieldValue.increment(expB), exp: finalExpB, updatedAt: Timestamp.now() });
                if (coinsToMintA > 0) tx.set(userARef, { coins: FieldValue.increment(coinsToMintA) }, { merge: true });
                if (coinsToMintB > 0) tx.set(userBRef, { coins: FieldValue.increment(coinsToMintB) }, { merge: true });
            });
            try {
                debugStep = "AI 호출 (관계 노트 생성)";
                const relSystemPrompt = await loadPrompt(db, 'relation_create_system');
                const relUserPrompt = `
                    ## 컨텍스트
                    - 캐릭터 1: ${myChar.name}
                    - 캐릭터 2: ${opponentChar.name}
                    - 기존 관계: ${relationNote}

                    ## 입력 데이터: 최근 조우 내용
                    ${result.title}\n${result.content}
                `;
                const relResult = await callGemini({ apiKey: GEMINI_API_KEY.value(), systemText: relSystemPrompt, userText: relUserPrompt, logger, modelName: primary });

                if (relResult && relResult.note) {
                    debugStep = "관계 정보 Firestore에 저장";
                    const sortedPair = [myCharId, opponentCharId].sort();
                    const relId = sortedPair.join('__');
                    const baseRef = db.collection('relations').doc(relId);
                    const noteRef = baseRef.collection('meta').doc('note');
                    
                    await baseRef.set({ pair: sortedPair, updatedAt: FieldValue.serverTimestamp(), lastEncounterLogId: logRef.id }, { merge: true });
                    await noteRef.set({ note: relResult.note, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
                    logger.log(`관계 업데이트 성공: ${relId}`);
                }
            } catch (relError) {
                logger.error('관계 생성/업데이트 실패:', { message: relError.message });
            }

          // [수정] 조우 성공 시 공용 쿨타임을 300초(5분)로 설정합니다.
          const nowSecAfter = Math.floor(Date.now() / 1000);
          await db.collection('users').doc(uid).set(
            { cooldown_all_until: nowSecAfter + 300 }, // cooldown_all_until 사용
            { merge: true }
         );

            logger.log('조우 생성 완료');
            return { ok: true, logId: logRef.id };

        } catch (error) {
            logger.error('startEncounter 실패:', { step: debugStep, message: error.message, stack: error.stack });
            if (error instanceof HttpsError) throw error;
            throw new HttpsError('internal', `[서버 오류] 단계: ${debugStep}, 내용: ${error.message}`);
        }
    });

    return { startEncounter };
};
