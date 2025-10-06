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

const { defineSecret } = require('firebase-functions/params');
const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY'); // firebase functions:secrets:set GEMINI_API_KEY

// ---------- 공통 유틸 ----------
function stripFences(s = '') {
    return String(s).trim().replace(/^```(?:json)?\s*/, '').replace(/```$/, '').trim();
}
function tryJsonSafe(t) {
    if (!t) return null;
    try { return JSON.parse(stripFences(t)); } catch { return null; }
}

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

// EXP → 코인 민팅 (100 EXP당 +1 coin)
async function mintByAddExp(tx, charRef, addExp, note) {
    addExp = Math.max(0, Math.floor(Number(addExp) || 0));
    if (addExp <= 0) return { minted: 0, expAfter: null, ownerUid: null };

    const cSnap = await tx.get(charRef);
    if (!cSnap.exists) throw new HttpsError('not-found', 'char not found');
    const c = cSnap.data() || {};
    const ownerUid = c.owner_uid;
    if (!ownerUid) throw new HttpsError('failed-precondition', 'char.owner_uid missing');

    const exp0 = Math.floor(Number(c.exp || 0));
    const exp1 = exp0 + addExp;
    const minted = Math.floor(exp1 / 100);
    const exp2 = exp1 - minted * 100;

    const userRef = db.doc(`users/${ownerUid}`);

    tx.update(charRef, {
        exp_total: FieldValue.increment(addExp),
        exp: exp2,
        updatedAt: Timestamp.now(),
    });
    if (minted > 0) {
        tx.set(userRef, { coins: FieldValue.increment(minted) }, { merge: true });
    }
    tx.set(db.collection('exp_logs').doc(), {
        char_id: charRef.path,
        owner_uid: ownerUid,
        add: addExp, minted,
        note: note || null,
        at: Timestamp.now(),
    });
    return { minted, expAfter: exp2, ownerUid };
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
    const userSnap = await userRef.get();
    // [수정] userSnap.exists() -> userSnap.exists
    const userData = userSnap.exists ? userSnap.data() : {};
    const rawCooldown = userData.cooldown_all_until;
    const cooldownUntil = (typeof rawCooldown === 'number')
        ? (Number(rawCooldown) || 0)
        : (rawCooldown?.toMillis ? Math.floor(rawCooldown.toMillis() / 1000) : 0);

    if (cooldownUntil > nowSec) {
        const left = cooldownUntil - nowSec;
        throw new HttpsError('failed-precondition', `공용 쿨타임이 ${left}초 남았습니다.`);
    }

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
            properties: i.properties || {}, // 아이템 속성 전체 포함
            rarity: i.rarity
        }));

        const narrativeSummary = char.narratives?.slice(1).map(n => n.short).join(' ') || char.narratives?.[0]?.short || '특이사항 없음';
        
        return {
            name: char.name,
            narrative_long: char.narratives?.[0]?.long || char.summary,
            narrative_short_summary: narrativeSummary,
            skills: skillsAsText,
            items: itemsAsJson, // JSON 객체 배열로 전달
            origin: char.world_id,
        };
    };

    const myInv = userData.items_all || [];
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

  ## 캐릭터 2 (index 1) 정보
  ${JSON.stringify(defenderData, null, 2)}
</INPUT>
    `.trim();

    // 3. AI 호출 (단일 호출)
    const finalRaw = await callGeminiServer('gemini-2.5-flash', systemPrompt, userPrompt);
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
            const Ashot = await tx.get(Aref);
            const Bshot = await tx.get(Bref);
            if (!Ashot.exists || !Bshot.exists) throw new HttpsError('aborted', 'char vanished');

            const A0 = Ashot.data() || {}, B0 = Bshot.data() || {};
            const Ra = Math.floor(Number(A0.elo || 1000));
            const Rb = Math.floor(Number(B0.elo || 1000));
            const [Ra2, Rb2] = nextElo(Ra, Rb, sA, sB, 24, 24);

            await mintByAddExp(tx, Aref, expA, `battle:${logRef.id}`);
            await mintByAddExp(tx, Bref, expB, `battle:${logRef.id}`);

            tx.update(Aref, {
                elo: Ra2, battle_count: FieldValue.increment(1),
                wins: FieldValue.increment(sA), losses: FieldValue.increment(sB),
                updatedAt: Timestamp.now(),
            });
            tx.update(Bref, {
                elo: Rb2, battle_count: FieldValue.increment(1),
                wins: FieldValue.increment(sB), losses: FieldValue.increment(sA),
                updatedAt: Timestamp.now(),
            });

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

    // 5. 쿨타임 적용
    const WINDOW = 300;
    const nowSecAfter = Math.floor(Date.now() / 1000);
    const uShot = await userRef.get();
    const exist = uShot.exists ? uShot.get('cooldown_all_until') : 0;
    const existSec = (typeof exist === 'number')
        ? (Number(exist) || 0)
        : (exist?.toMillis ? Math.floor(exist.toMillis() / 1000) : 0);
    const nextBoundary = Math.ceil(nowSecAfter / WINDOW) * WINDOW;
    const untilSec = Math.max(existSec, nextBoundary);
    await userRef.set({ cooldown_all_until: untilSec }, { merge: true });

    return { ok: true, logId: logRef.id, simulated };
});

// 이전 함수(runBattleTextOnly)를 새 V2 함수를 가리키도록 하여 호환성을 유지합니다.
exports.runBattleTextOnly = exports.runBattleV2;
