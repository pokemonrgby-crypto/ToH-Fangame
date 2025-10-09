/* === functions/battle/index.js (FULL) ===
 * - Firebase Functions v2 (Node 18)
 * - 단일 AI 호출로 배틀로그 생성 (스케치+선택 과정 통합)
 * - 프롬프트: Firestore의 configs/prompts 문서에서 'battle_system_prompt_unified' 사용
 * - EXP: AI가 생성한 exp_char0/exp_char1 적용 (100 누적 시 코인 +1 민팅)
 * - Elo 갱신 (무승부 없음)
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
try { admin.app(); } catch { admin.initializeApp(); }
const db = admin.firestore();
const { Timestamp, FieldValue } = require('firebase-admin/firestore');

const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const { defineSecret } = require('firebase-functions/params');
const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY'); // firebase functions:secrets:set GEMINI_API_KEY

// ---------- 공통 유틸 ----------
const MODEL_POOL = ['gemini-2.5-flash-lite'];

function pickModels() {
  const shuffled = [...MODEL_POOL].sort(() => 0.5 - Math.random());
  return { primary: shuffled[0], fallback: shuffled[1] || shuffled[0] };
}
function stripFences(s = '') {
    return String(s).trim().replace(/^```(?:json)?\s*/, '').replace(/```$/, '').trim();
}
// (기존 코드 상단...)

// ▼▼▼ 이 함수 전체를 교체하세요 ▼▼▼
function tryJsonSafe(t) {
    if (!t) return null;
    try {
        // 1. 코드 블록 마커(```) 제거
        let clean = stripFences(t);

        // 2. 텍스트에서 첫 '{'와 마지막 '}'를 찾아 JSON 객체 부분만 추출
        const firstBrace = clean.indexOf('{');
        const lastBrace = clean.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace > firstBrace) {
            clean = clean.slice(firstBrace, lastBrace + 1);
        }

        // 3. JSON 문법 오류를 유발하는 후행 쉼표(trailing comma) 제거
        clean = clean.replace(/,\s*([}\]])/g, '$1');

        // 4. JSON에 포함될 수 있는 주석 제거
        clean = clean.replace(/\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*$/gm, '$1');

        return JSON.parse(clean);
    } catch (e) {
        // 파싱 실패 시 원본 텍스트와 함께 로그를 남겨 디버깅을 돕습니다.
        logger.error("Gemini JSON parse failed (after robust cleaning)", {
            rawText: String(t).slice(0, 500),
            error: e.message
        });
        // 파싱에 실패하면 null을 반환하여 이후 코드에서 오류를 처리하도록 합니다.
        return null;
    }
}
// ▲▲▲ 이 함수 전체를 교체하세요 ▲▲▲

// (이하 기존 코드...)

// Gemini 호출 (서버 직통)
async function callGeminiServer(model, systemText, userText, temperature = 0.85, maxOutputTokens = 8192) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY.value()}`;
    const body = {
        systemInstruction: { role: 'system', parts: [{ text: String(systemText || '') }] },
        contents: [{ role: 'user', parts: [{ text: String(userText || '') }] }],
        generationConfig: {
            temperature,
            maxOutputTokens,
            topK: 40,
            topP: 0.95,
            candidateCount: 1,
            responseMimeType: "application/json"
        },
        safetySettings: [
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        ]
    };
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new HttpsError('internal', `Gemini ${model} 호출 실패: ${res.status} ${txt}`);
    }
    const j = await res.json().catch(() => null);
    const text = j?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    if (!text) throw new HttpsError('internal', 'Gemini 응답이 비어 있음');
    return text;
}

// 서버에서 프롬프트 로드 (configs/prompts)
async function fetchPromptDocServer(id) {
    const ref = db.doc('configs/prompts');
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('failed-precondition', '프롬프트 저장소(configs/prompts)가 없어');
    const all = snap.data() || {};
    const raw = all[id];
    if (raw === undefined || raw === null) throw new HttpsError('not-found', `프롬프트 ${id} 가 없어`);
    let content = (typeof raw === 'object' ? (raw.content ?? raw.text ?? raw.value ?? '') : String(raw ?? '')).trim();
    if (!content) throw new HttpsError('failed-precondition', `프롬프트 ${id} 내용이 비어 있어`);
    return content;
}

// Elo 갱신 (무승부 없음)
function nextElo(Ra = 1000, Rb = 1000, sA = 1, sB = 0, kA = 24, kB = 24) {
    const Ea = 1 / (1 + Math.pow(10, (Rb - Ra) / 400));
    const Eb = 1 - Ea;
    const Ra2 = Math.round(Ra + kA * (sA - Ea));
    const Rb2 = Math.round(Rb + kB * (sB - Eb));
    return [Ra2, Rb2];
}

// ========== 배틀 실행 V2 (단일 AI 호출) ==========
exports.runBattleV2 = onCall({ region: 'us-central1', secrets: [GEMINI_API_KEY] }, async (req) => {
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요해');

    const { attackerId, defenderId, worldId = 'gionkir', simulate = false } = req.data || {};
    if (!attackerId || !defenderId) throw new HttpsError('invalid-argument', 'attackerId/defenderId 필요');
    
    const userRef = db.doc(`users/${uid}`);
    const nowSec = Math.floor(Date.now() / 1000);
    const cooldownDuration = 180;
    const newCooldownUntil = nowSec + cooldownDuration;

    // --- 요청하신 선-쿨타임 로직 적용 ---
    if (!simulate) {
        // 1. 기존 쿨타임 확인
        const userSnap = await userRef.get();
        const userData = userSnap.data() || {};
        const rawCooldown = userData.cooldown_all_until;
        const currentCooldownUntil = (typeof rawCooldown === 'number')
            ? (Number(rawCooldown) || 0)
            : (rawCooldown?.toMillis ? Math.floor(rawCooldown.toMillis() / 1000) : 0);

        if (currentCooldownUntil > nowSec) {
            const left = currentCooldownUntil - nowSec;
            throw new HttpsError('failed-precondition', `공용 쿨타임이 ${left}초 남았습니다.`);
        }

        // 2. 새로운 쿨타임을 즉시 적용
        await userRef.set({ cooldown_all_until: newCooldownUntil }, { merge: true });
    }

    try {
        // --- 기존 배틀 로직 시작 ---
        const Aref = db.doc(`chars/${attackerId}`);
        const Bref = db.doc(`chars/${defenderId}`);
        const [As, Bs] = await Promise.all([Aref.get(), Bref.get()]);
        if (!As.exists || !Bs.exists) throw new HttpsError('not-found', '캐릭터 문서를 찾을 수 없어');
        const A = As.data() || {}, B = Bs.data() || {};
        if (A.owner_uid !== uid) throw new HttpsError('permission-denied', '내 캐릭터만 배틀 시작 가능');

        let relationNote = '없음';
        try {
            const rId = [attackerId, defenderId].sort().join('__');
            const noteSnap = await db.doc(`relations/${rId}/meta/note`).get();
            relationNote = noteSnap.exists ? String(noteSnap.data()?.note || '없음') : '없음';
        } catch { relationNote = '없음'; }

        // 1. 통합 시스템 프롬프트 로드
        const systemPrompt = await fetchPromptDocServer('battle_system_prompt_unified');

        // 2. AI 입력 데이터 구성
        const simplifyForAI = (char, inv) => {
            const equippedSkills = (char.abilities_equipped || []).map(idx => (char.abilities_all || [])[idx]).filter(Boolean);
            const equippedItems = (char.items_equipped || []).map(id => inv.find(i => i.id === id)).filter(Boolean);
            
            const skillsAsText = equippedSkills.map(s => `${s.name}: ${s.desc_soft}`).join('\n') || '없음';
            const itemsAsJson = equippedItems.map(i => ({
                name: i.name,
                description: i.desc_soft || i.desc || i.description || '',
                properties: i.properties || {},
                rarity: i.rarity
            }));

            const narrativeSummary = char.narratives?.slice(1).map(n => n.short).join(' ') || char.narratives?.[0]?.short || '특이사항 없음';
            
            return {
                name: char.name,
                narrative_long: char.narratives?.[0]?.long || char.summary,
                narrative_short_summary: narrativeSummary,
                skills: skillsAsText,
                items: itemsAsJson,
                origin: char.world_id,
            };
        };
        
        const myInvSnap = await userRef.get();
        const myInv = myInvSnap.exists ? (myInvSnap.data().items_all || []) : [];
        const oppInvSnap = await db.doc(`users/${B.owner_uid}`).get();
        const oppInv = oppInvSnap.exists ? (oppInvSnap.data().items_all || []) : [];

        const attackerData = simplifyForAI(A, myInv);
        const defenderData = simplifyForAI(B, oppInv);

        const userPrompt = `
<INPUT>
  ## 캐릭터 관계
  - ${relationNote}

  ## 캐릭터 1 (index 0) 정보
  ${JSON.stringify(attackerData, null, 2)}
  캐릭터 1 정보 끝
  
  ## 캐릭터 2 (index 1) 정보
  ${JSON.stringify(defenderData, null, 2)}
  캐릭터 2 정보 끝
</INPUT>
        `.trim();

        // 3. AI 호출
        const { primary, fallback } = pickModels();
        let finalRaw = '';
        try {
            finalRaw = await callGeminiServer(primary, systemPrompt, userPrompt);
        } catch (e) {
            logger.warn(`[runBattleV2] Primary model ${primary} failed, trying fallback ${fallback}.`, { error: e.message });
            finalRaw = await callGeminiServer(fallback, systemPrompt, userPrompt);
        }
        const finalJson = tryJsonSafe(finalRaw);

        if (!finalJson || typeof finalJson.winner_index !== 'number') {
            logger.error('battle V2 invalid response', { head: String(finalRaw || '').slice(0, 400) });
            throw new HttpsError('internal', 'AI가 유효한 배틀 결과를 반환하지 않았어');
        }

        const winner_index = finalJson.winner_index === 0 ? 0 : 1;
        const expA = simulate ? 0 : Math.max(5, Math.min(50, parseInt(finalJson.exp_char0 || 0, 10) || 10));
        const expB = simulate ? 0 : Math.max(5, Math.min(50, parseInt(finalJson.exp_char1 || 0, 10) || 10));
        const battleTitle = String(finalJson.title || '치열한 결투');
        const battleContent = String(finalJson.content || '결과를 생성하는 데 실패했습니다.');

        // 4. 결과 저장
        const logRef = db.collection('battle_logs').doc();
        const sA = winner_index === 0 ? 1 : 0;
        const sB = winner_index === 1 ? 1 : 0;

        if (simulate) {
            await logRef.set({
                attacker_char: `chars/${attackerId}`, defender_char: `chars/${defenderId}`,
                attacker_snapshot: { name: A.name, thumb_url: A.thumb_url || null },
                defender_snapshot: { name: B.name, thumb_url: B.thumb_url || null },
                winner: winner_index,
                title: battleTitle, content: battleContent,
                exp_char0: 0, exp_char1: 0,
                simulated: true,
                endedAt: Timestamp.now()
            });
        } else {
            await db.runTransaction(async (tx) => {
                const [Ashot, Bshot] = await Promise.all([tx.get(Aref), tx.get(Bref)]);
                if (!Ashot.exists || !Bshot.exists) throw new HttpsError('aborted', 'char vanished');

                const A0 = Ashot.data() || {}, B0 = Bshot.data() || {};
                const Ra = Math.floor(Number(A0.elo || 1000));
                const Rb = Math.floor(Number(B0.elo || 1000));
                const [Ra2, Rb2] = nextElo(Ra, Rb, sA, sB, 24, 24);

                const calculateExp = (charData, addExp) => {
                    if (addExp <= 0) return { minted: 0, finalExp: charData.exp || 0 };
                    const exp0 = Math.floor(Number(charData.exp || 0));
                    const exp1 = exp0 + addExp;
                    const minted = Math.floor(exp1 / 100);
                    const finalExp = exp1 % 100;
                    return { minted, finalExp };
                };

                const { minted: mintedA, finalExp: finalExpA } = calculateExp(A0, expA);
                const { minted: mintedB, finalExp: finalExpB } = calculateExp(B0, expB);

                tx.update(Aref, {
                    elo: Ra2, battle_count: FieldValue.increment(1),
                    wins: FieldValue.increment(sA), losses: FieldValue.increment(sB),
                    exp_total: FieldValue.increment(expA), exp: finalExpA,
                    updatedAt: Timestamp.now(),
                });

                tx.update(Bref, {
                    elo: Rb2, battle_count: FieldValue.increment(1),
                    wins: FieldValue.increment(sB), losses: FieldValue.increment(sA),
                    exp_total: FieldValue.increment(expB), exp: finalExpB,
                    updatedAt: Timestamp.now(),
                });

                if (mintedA > 0) tx.set(db.doc(`users/${A0.owner_uid}`), { coins: FieldValue.increment(mintedA) }, { merge: true });
                if (mintedB > 0) tx.set(db.doc(`users/${B0.owner_uid}`), { coins: FieldValue.increment(mintedB) }, { merge: true });

                tx.set(logRef, {
                    attacker_char: `chars/${attackerId}`, defender_char: `chars/${defenderId}`,
                    attacker_snapshot: { name: A.name, thumb_url: A.thumb_url || null },
                    defender_snapshot: { name: B.name, thumb_url: B.thumb_url || null },
                    winner: winner_index,
                    title: battleTitle, content: battleContent,
                    exp_char0: expA, exp_char1: expB,
                    endedAt: Timestamp.now()
                });
            });
        }
        
        // --- 기존 배틀 로직 종료 ---
        // 성공적으로 완료되었으므로, 처음에 적용한 쿨타임은 그대로 유지됩니다.
        return { ok: true, logId: logRef.id, simulate };

    } catch (error) {
        // --- 오류 발생 시 쿨타임 제거 로직 ---
        if (!simulate) {
            try {
                // 안전장치: 현재 설정된 쿨타임이 우리가 설정한 값과 동일할 때만 초기화합니다.
                const userSnapAfterError = await userRef.get();
                if (userSnapAfterError.exists()) {
                    const finalCooldown = userSnapAfterError.data().cooldown_all_until;
                    if (finalCooldown === newCooldownUntil) {
                        await userRef.set({ cooldown_all_until: 0 }, { merge: true });
                        logger.warn(`Battle failed for user ${uid}. Cooldown has been cleared.`, { error: error.message });
                    }
                }
            } catch (cleanupError) {
                logger.error(`Failed to clear cooldown for user ${uid} after battle error.`, { originalError: error.message, cleanupError: cleanupError.message });
            }
        }
        
        // 원래 발생했던 오류를 클라이언트로 다시 전달합니다.
        throw error;
    }
});

// 이전 함수(runBattleTextOnly)를 새 V2 함수를 가리키도록 하여 호환성을 유지합니다.
exports.runBattleTextOnly = exports.runBattleV2;
