const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { Timestamp, FieldValue } = require('firebase-admin/firestore');
const { logger } = require('firebase-functions');

// --- 프리롤 링버퍼 (V2/V3와 동일한 유틸리티 재사용) ---
const PREROLL_SIZE = 50;
function d100(){ return Math.floor(Math.random()*100)+1; }
async function takeRollTx(tx, docRef){
    const snap = await tx.get(docRef);
    let d = snap.exists ? (snap.data()||{}) : {};
    if (!Array.isArray(d.prerolls) || d.prerolls.length !== PREROLL_SIZE) {
        d = { prerolls: Array.from({length:PREROLL_SIZE},()=>d100()), cursor:0 };
    }
    const i = (d.cursor||0) % PREROLL_SIZE;
    const roll = d.prerolls[i];
    d.prerolls[i] = d100();
    d.cursor = (i+1) % PREROLL_SIZE;
    d.updatedAt = Timestamp.now();
    tx.set(docRef, d, { merge:true });
    return roll;
}

// --- Gemini 호출 (V3와 유사한 유틸리티) ---
async function callGemini(apiKey, model, systemText, userText) {
    const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const body = {
        systemInstruction: { role: 'system', parts: [{ text: systemText }] },
        contents: [{ role: 'user', parts: [{ text: userText }] }],
        generationConfig: { temperature: 0.8, maxOutputTokens: 4096, responseMimeType: "application/json" }
    };
    const res = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    if (!res.ok) throw new HttpsError('internal', `Gemini Error ${res.status}: ${await res.text()}`);
    const json = await res.json();
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) throw new HttpsError('internal','Empty Gemini response');
    try { return JSON.parse(text); } catch(e){ throw new HttpsError('internal',`Gemini JSON parse failed: ${text}`); }
}

// --- 공용 유틸 ---
const clamp = (n,min,max)=>Math.max(min,Math.min(max,n));
const rangeMap = (r, min, max) => min + ((Math.max(1, r)-1) % (max-min+1));

function calculateLevel(exp) {
    if (!exp || exp <= 0) return 1;
    // 단순 레벨링 커브 예시 (100 exp 당 1레벨)
    const level = Math.floor(exp / 100) + 1;
    return Math.min(100, level); // 최대 레벨 100
}

module.exports = (admin, { GEMINI_API_KEY }) => {
    const db = admin.firestore();

    async function hasStoryAccess(uid){
        if (!uid) return false;
        try {
            const [a, b] = await Promise.all([db.doc('configs/admins').get(), db.doc('configs/betatesters').get()]);
            const A = a.exists ? a.data() : {}; const B = b.exists ? b.data() : {};
            const allowUids = new Set([...(A.allow||[]), ...(B.allow||[])]);
            return allowUids.has(uid);
        } catch { return false; }
    }

    // V4-1) 스토리 런 시작/상태 초기화
    const startOrGetStoryRunV4 = onCall({ region: 'us-central1' }, async (req) => {
        const uid = req.auth?.uid;
        if (!await hasStoryAccess(uid)) throw new HttpsError('permission-denied', '권한 없음');
        const { charId } = req.data || {};
        if (!charId) throw new HttpsError('invalid-argument', 'charId 필요');

        const runRef = db.doc(`storyRuns/${charId}`);
        const playerRef = db.doc(`storyPlayers/${charId}`);
        
        const [runSnap, playerSnap, charSnap] = await Promise.all([runRef.get(), playerRef.get(), db.doc(`chars/${charId}`).get()]);

        if (!runSnap.exists || !runSnap.data().rules) throw new HttpsError('failed-precondition', 'V2 뼈대와 규칙이 먼저 필요합니다.');
        if (!charSnap.exists) throw new HttpsError('not-found', '캐릭터를 찾을 수 없습니다.');

        if (playerSnap.exists) {
            return { ok: true, playerState: playerSnap.data() };
        }

        const runData = runSnap.data();
        const rules = runData.rules;
        const startNode = runData.graph.nodes.find(n => n.id === 'N1');
        
        const initialLevel = calculateLevel(charSnap.data()[rules.leveling.expField] || 0);
        const initialHp = rules.leveling.hpBase + (rules.leveling.hpPerLevel * (initialLevel - 1));

        const playerState = {
            charId,
            runId: runData.runId,
            hp: initialHp,
            maxHp: initialHp,
            level: initialLevel,
            currentNodeId: startNode.id,
            inventory: [], // { id, name, description, rarity, effect, isConsumable, uses, count }
            currencies: { story_coins: 0 },
            battle: null, // or { monster, log: [] }
            runStatus: 'active', // 'active', 'completed', 'failed'
            createdAt: Timestamp.now(),
            updatedAt: Timestamp.now(),
        };

        await playerRef.set(playerState);
        return { ok: true, playerState };
    });

    // V4-2) 월드맵 이동 및 매복 전투 발생
    const moveOnMapV4 = onCall({ region: 'us-central1' }, async (req) => {
        const uid = req.auth?.uid;
        if (!await hasStoryAccess(uid)) throw new HttpsError('permission-denied', '권한 없음');
        const { charId, targetNodeId } = req.data || {};
        if (!charId || !targetNodeId) throw new HttpsError('invalid-argument', 'charId/targetNodeId 필요');

        const runRef = db.doc(`storyRuns/${charId}`);
        const playerRef = db.doc(`storyPlayers/${charId}`);

        return await db.runTransaction(async (tx) => {
            const [runDoc, playerDoc] = await Promise.all([tx.get(runRef), tx.get(playerRef)]);
            if (!runDoc.exists) throw new HttpsError('failed-precondition', '스토리 런 없음');
            if (!playerDoc.exists) throw new HttpsError('failed-precondition', '플레이어 상태 없음');
            
            const run = runDoc.data();
            const player = playerDoc.data();
            if (player.battle) throw new HttpsError('failed-precondition', '전투 중에는 이동할 수 없습니다.');

            const currentNode = run.graph.nodes.find(n => n.id === player.currentNodeId);
            const isConnected = currentNode.connects.some(c => c.to === targetNodeId);
            if (!isConnected) throw new HttpsError('invalid-argument', '연결되지 않은 노드입니다.');

            const targetNode = run.graph.nodes.find(n => n.id === targetNodeId);
            let battle = null;
            let message = `${targetNode.name}(으)로 이동했습니다.`;

            // 필드 -> 필드 이동 시 매복 판정
            if (currentNode.kind === 'field' && targetNode.kind === 'field') {
                const roll = await takeRollTx(tx, runRef);
                if (roll <= run.rules.travel.ambushChance) {
                    // 매복 성공! 전투 생성
                    const gradeRoll = await takeRollTx(tx, runRef);
                    let grade = '';
                    let cumulative = 0;
                    const gradeProbs = run.rules.gradeProb[targetNode.difficulty];
                    for (const g in gradeProbs) {
                        cumulative += gradeProbs[g];
                        if (gradeRoll <= cumulative) {
                            grade = g;
                            break;
                        }
                    }

                    const monsterTemplates = run.enrichment.monstersByDifficulty[targetNode.difficulty].monsters;
                    const monsterRoll = await takeRollTx(tx, runRef);
                    const template = monsterTemplates[(monsterRoll - 1) % monsterTemplates.length];
                    
                    const hpRoll = await takeRollTx(tx, runRef);
                    const hpRange = run.rules.hpRanges[targetNode.difficulty][grade];
                    const hp = rangeMap(hpRoll, hpRange[0], hpRange[1]);

                    battle = {
                        monster: {
                            ...template,
                            grade,
                            hp,
                            maxHp: hp,
                            difficulty: targetNode.difficulty
                        },
                        log: [`${template.name}(이)가 기습했다!`],
                        turn: 1,
                    };
                    message = `이동 중 ${template.name}의 매복 공격을 받았습니다!`;
                }
            }
            
            const updates = { currentNodeId: targetNodeId, battle, updatedAt: Timestamp.now() };
            tx.update(playerRef, updates);

            return { ok: true, message, playerState: { ...player, ...updates } };
        });
    });

    // V4-3) AI 기반 전투 턴 진행
    const progressBattleTurnV4 = onCall({ region: 'us-central1', secrets: [GEMINI_API_KEY] }, async (req) => {
        const uid = req.auth?.uid;
        if (!await hasStoryAccess(uid)) throw new HttpsError('permission-denied', '권한 없음');
        const { charId, action } = req.data || {}; // action: { type: 'skill', skill: '스킬 설명 텍스트' }
        if (!charId || !action) throw new HttpsError('invalid-argument', 'charId/action 필요');

        const runRef = db.doc(`storyRuns/${charId}`);
        const playerRef = db.doc(`storyPlayers/${charId}`);
        const charRef = db.doc(`chars/${charId}`);

        // --- 1. 데이터 준비 (트랜잭션 외부) ---
        const [runSnap, playerSnap, charSnap] = await Promise.all([runRef.get(), playerRef.get(), charRef.get()]);
        if (!runSnap.exists || !playerSnap.exists || !charSnap.exists) throw new HttpsError('not-found', '필수 데이터 없음');

        const run = runSnap.data();
        let player = playerSnap.data();
        const character = charSnap.data();
        if (!player.battle) throw new HttpsError('failed-precondition', '전투 상태가 아닙니다.');
        
        const rules = run.rules;
        const monster = player.battle.monster;
        const playerLevel = player.level; // 플레이어 상태의 레벨을 사용

        // --- 2. 서버사이드 판정 (막기 확률) ---
        const blockBase = rules.blockBase[monster.difficulty][monster.grade];
        const monsterApproxLevel = (Object.keys(rules.gradeProb).indexOf(monster.difficulty) * 10 + 5);
        const levelDiff = playerLevel - monsterApproxLevel;
        const levelAdj = clamp(levelDiff * rules.levelAdj.perLevel, rules.levelAdj.min, rules.levelAdj.max);
        const finalBlockChance = clamp(blockBase + levelAdj, 5, 95);
        
        const blockRoll = await db.runTransaction(tx => takeRollTx(tx, runRef));
        const isPlayerBlocked = blockRoll <= finalBlockChance;

        // --- 3. Gemini AI 호출 (서사 생성) ---
        const system = `역할: 게임 전투 진행 AI
규칙:
- 전투 상황을 생생하고 흥미진진하게 묘사.
- 입력된 "isPlayerBlocked" 값을 반드시 존중하여 서술. 막았다면 피해는 0.
- 플레이어 스킬은 텍스트 설명 기반. 그 효과를 창의적으로 해석하되, 몬스터 등급과 난이도를 고려하여 위력을 조절.
- 최종 결과는 반드시 지정된 JSON 형식으로만 출력. 마크다운/설명 금지.`;

        const user = `
상황:
- 플레이어: 레벨 ${playerLevel}, HP ${player.hp}/${player.maxHp}
- 몬스터: ${monster.name} (${monster.grade}), HP ${monster.hp}/${monster.maxHp}, 난이도 ${monster.difficulty}
- 몬스터 정보: ${monster.description}
- 플레이어 스킬 목록: ${JSON.stringify((character.skills||[]).map(s=>s.name))}
- 몬스터 스킬 목록: ${JSON.stringify(monster.skills.map(s=>s.name))}

턴 진행:
1. 플레이어가 "${action.skill}" 스킬 사용을 시도합니다.
2. 몬스터는 무작위 스킬로 반격합니다.
3. 이번 턴에 플레이어의 '막기' 판정 결과는 "${isPlayerBlocked ? '성공' : '실패'}"입니다.

요청:
위 상황을 바탕으로 한 턴의 전투를 서술하고, 아래 JSON 형식으로 결과를 반환해줘.
- narrative: 전투 묘사 (2~4 문장)
- damageToMonster: 플레이어가 몬스터에게 입힌 피해량 (0 이상의 정수)
- damageToPlayer: 몬스터가 플레이어에게 입힌 피해량 (막기 성공 시 반드시 0)

JSON 출력 예시:
{
  "narrative": "플레이어가 스킬을 쓰자 빛이 폭발했습니다. 몬스터는 고통스러워하며 비명을 질렀지만, 이내 강력한 반격을 날렸습니다. 플레이어는 간신히 공격을 막아냈습니다.",
  "damageToMonster": 25,
  "damageToPlayer": 0
}`;

        const aiResult = await callGemini(GEMINI_API_KEY.value(), 'gemini-2.5-flash-lite', system, user);

        // --- 4. 서버사이드 데미지 보정 (신규 로직) ---
        const aiDamageToMonster = aiResult.damageToMonster || 0;
        const aiDamageToPlayer = aiResult.damageToPlayer || 0;

        // 플레이어의 레벨에 따른 데미지 범위 설정
        const playerMinDamage = Math.floor(playerLevel * 1.2 + 5);
        const playerMaxDamage = Math.floor(playerLevel * 2.5 + 10);
        const finalDamageToMonster = clamp(aiDamageToMonster, playerMinDamage, playerMaxDamage);

        // 몬스터의 난이도/등급에 따른 데미지 범위 설정 (rules 활용)
        const monsterDmgRange = rules.dmgRanges[monster.difficulty][monster.grade];
        const finalDamageToPlayer = isPlayerBlocked ? 0 : clamp(aiDamageToPlayer, monsterDmgRange[0], monsterDmgRange[1]);

        logger.info(`Damage calculation for char ${charId}:`, {
            ai_proposals: { toMonster: aiDamageToMonster, toPlayer: aiDamageToPlayer },
            playerLevel,
            playerDmgRange: { min: playerMinDamage, max: playerMaxDamage },
            monsterDmgRange: { min: monsterDmgRange[0], max: monsterDmgRange[1] },
            isPlayerBlocked,
            finalDamage: { toMonster: finalDamageToMonster, toPlayer: finalDamageToPlayer }
        });


        // --- 5. 결과 처리 및 상태 업데이트 (트랜잭션) ---
        return await db.runTransaction(async (tx) => {
            const freshPlayerDoc = await tx.get(playerRef);
            if (!freshPlayerDoc.exists) throw new HttpsError('aborted', '플레이어 데이터 없음');
            
            let pState = freshPlayerDoc.data();
            let mState = pState.battle.monster;
            
            // 보정된 최종 데미지를 적용
            mState.hp -= finalDamageToMonster;
            pState.hp -= finalDamageToPlayer;

            const battleLog = [
                ...pState.battle.log,
                `[턴 ${pState.battle.turn}] ${aiResult.narrative} (플레이어 피해: ${finalDamageToPlayer}, 몬스터 피해: ${finalDamageToMonster})`
            ];

            let outcome = null;
            if (mState.hp <= 0) {
                outcome = 'win';
                battleLog.push(`${mState.name}을(를) 쓰러뜨렸습니다!`);
            } else if (pState.hp <= 0) {
                pState.hp = 0;
                outcome = 'loss';
                battleLog.push('전투에서 패배했습니다...');
            }

            if (outcome) {
                // 전투 종료
                pState.battle = null;
                pState.runStatus = (outcome === 'loss' ? 'failed' : pState.runStatus);
                
                let rewards = null;
                if (outcome === 'win') {
                    // 보상 계산
                    const dropKey = rules.dropKeyByGrade[mState.grade];
                    const rates = rules.dropRates[dropKey];
                    const dropRoll = await takeRollTx(tx, runRef);
                    
                    let rarityDropped = null;
                    let cumulative = 0;
                    // dropRates의 등급 순서가 보장된다고 가정
                    for (const r in rates) {
                        cumulative += rates[r];
                        if (dropRoll <= cumulative) {
                            rarityDropped = r;
                            break;
                        }
                    }

                    const expGain = (Object.keys(rules.gradeProb['easy']).indexOf(mState.grade) + 1) * 10 * (Object.keys(rules.gradeProb).indexOf(mState.difficulty) + 1);
                    const coinGain = rangeMap(await takeRollTx(tx, runRef), 10, 50);
                    
                    rewards = { expGain, coinGain, items: [] };
                    
                    if (rarityDropped && run.enrichment.dropLore?.length > 0) {
                        const loreRoll = await takeRollTx(tx, runRef);
                        const lore = run.enrichment.dropLore[(loreRoll - 1) % run.enrichment.dropLore.length];
                        const serial = pState.inventory.length + 1;
                        
                        const newItem = {
                            id: `${charId}_${pState.runId}_${serial}`,
                            name: lore.name,
                            description: lore.description,
                            rarity: rarityDropped,
                            isConsumable: true,
                            uses: 1,
                            count: 1,
                            // TODO: 아이템 효과 부여 로직 추가
                        };
                        pState.inventory.push(newItem);
                        rewards.items.push(newItem);
                    }
                    
                    pState.currencies.story_coins += coinGain;
                    // 경험치는 캐릭터 문서에 직접 업데이트
                    const charUpdateRef = db.doc(`chars/${charId}`);
                    tx.update(charUpdateRef, { [rules.leveling.expField]: FieldValue.increment(expGain) });
                }
                
                tx.update(playerRef, { ...pState, updatedAt: Timestamp.now() });
                return { ok: true, outcome, battleLog, rewards, playerState: pState };

            } else {
                // 전투 지속
                pState.battle.monster = mState;
                pState.battle.log = battleLog;
                pState.battle.turn += 1;
                tx.update(playerRef, { ...pState, updatedAt: Timestamp.now() });
                return { ok: true, outcome: 'ongoing', battleLog, playerState: pState };
            }
        });
    });

    return {
        startOrGetStoryRunV4,
        moveOnMapV4,
        progressBattleTurnV4,
    };
};
