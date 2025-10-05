// functions/raid.js
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { FieldValue, Timestamp } = require('firebase-admin/firestore');

// 이 함수는 functions/index.js에서 admin, logger, GEMINI_API_KEY와 함께 호출됩니다.
module.exports = (admin, { logger, GEMINI_API_KEY }) => {
    const db = admin.firestore();

    const RAID_COOLDOWN_MS = 10 * 60 * 1000; // 10분
    const MAX_RAID_DAMAGE = 10000;

    // --- Helper Functions ---

    async function callGemini(systemText, userText) {
        // ... (functions/battle/index.js 또는 encounter_v2.js에서 Gemini 호출 함수를 가져옵니다)
        const model = 'gemini-2.5-flash'; // 또는 다른 적절한 모델
        const apiKey = GEMINI_API_KEY.value();
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const body = {
          systemInstruction: { role: 'system', parts: [{ text: systemText }] },
          contents: [{ role: 'user', parts: [{ text: userText }] }],
          generationConfig: {
            temperature: 0.85,
            maxOutputTokens: 8192,
            responseMimeType: "application/json"
          }
        };
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!res.ok) {
            const txt = await res.text();
            throw new HttpsError('internal', `Gemini API Error (${res.status}): ${txt}`);
        }
        const json = await res.json();
        const text = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (!text) throw new HttpsError('internal', `Gemini response was empty.`);
        return JSON.parse(text);
    }

    async function getActiveRaid() {
        const raidStatusRef = db.doc('raid/status');
        const raidSnap = await raidStatusRef.get();
        if (!raidSnap.exists || !raidSnap.data().activeRaidId) {
            return null;
        }
        const activeRaidId = raidSnap.data().activeRaidId;
        const bossRef = db.doc(`raids/${activeRaidId}`);
        const bossSnap = await bossRef.get();
        return bossSnap.exists ? { id: bossSnap.id, ...bossSnap.data() } : null;
    }

    // --- Callable Functions ---

    const startRaid = onCall({ region: 'us-central1', secrets: [GEMINI_API_KEY] }, async (req) => {
        const uid = req.auth?.uid;
        if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');

        const { myCharId, partyCharIds } = req.data;
        if (!myCharId || !Array.isArray(partyCharIds) || partyCharIds.length !== 3) {
            throw new HttpsError('invalid-argument', '나의 캐릭터 1명과 파티원 3명의 ID가 필요합니다.');
        }

        const allCharIds = [myCharId, ...partyCharIds];
        let raidBoss, userSnap, myCharSnap;
        try {
            [raidBoss, userSnap, myCharSnap] = await Promise.all([
                getActiveRaid(),
                db.doc(`users/${uid}`).get(),
                db.doc(`chars/${myCharId}`).get()
            ]);
        } catch (e) {
            throw new HttpsError('internal', '데이터 조회 중 오류 발생');
        }

        if (!raidBoss || raidBoss.endsAt.toMillis() < Date.now()) {
            throw new HttpsError('failed-precondition', '현재 진행 중인 레이드가 없습니다.');
        }
        if (raidBoss.currentHp <= 0) {
            throw new HttpsError('failed-precondition', '레이드 보스가 이미 처치되었습니다.');
        }

        const userData = userSnap.data() || {};
        const lastRaidTime = userData.cooldown_raid_until?.toMillis() || 0;
        if (Date.now() < lastRaidTime) {
            const remaining = Math.ceil((lastRaidTime - Date.now()) / 1000);
            throw new HttpsError('failed-precondition', `레이드 쿨타임이 ${remaining}초 남았습니다.`);
        }
        
        if (!myCharSnap.exists || myCharSnap.data().owner_uid !== uid) {
            throw new HttpsError('permission-denied', '자신의 캐릭터로만 레이드를 시작할 수 있습니다.');
        }

        const charDocs = await db.collection('chars').where(admin.firestore.FieldPath.documentId(), 'in', allCharIds).get();
        const partyChars = charDocs.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        const systemPrompt = await db.doc('configs/prompts').get().then(d => d.data().raid_battle_system);
        
        const partyForAI = partyChars.map((c, index) => {
            const items = (c.items_equipped || []).map(it => ({
                name: it.name,
                description: it.description,
                properties: it.properties,
                rarity: it.rarity
            }));
            return {
                charIndex: index + 1,
                name: c.name,
                summary: c.summary,
                items: items
            };
        });

        const userPrompt = `
            # 보스 정보
            ${JSON.stringify({ name: raidBoss.name, description: raidBoss.description }, null, 2)}
            
            # 파티 정보
            ${JSON.stringify(partyForAI, null, 2)}
        `;

        const aiResult = await callGemini(systemPrompt, userPrompt);
        const totalDamage = Math.min(MAX_RAID_DAMAGE, aiResult.totalDamage || 0);

        const logRef = db.collection('raid_logs').doc();
        const contribRef = db.collection('raids').doc(raidBoss.id).collection('contributions');

        await db.runTransaction(async tx => {
            const bossDoc = await tx.get(db.doc(`raids/${raidBoss.id}`));
            const currentHp = bossDoc.data().currentHp;
            const finalHp = Math.max(0, currentHp - totalDamage);

            tx.update(bossDoc.ref, { currentHp: finalHp });
            tx.set(logRef, {
                raidId: raidBoss.id,
                log: aiResult.log,
                party: partyChars.map(c => ({ id: c.id, name: c.name, owner_uid: c.owner_uid })),
                totalDamage,
                contributions: aiResult.contributions,
                createdAt: FieldValue.serverTimestamp()
            });

            for (const char of partyChars) {
                const charContrib = aiResult.contributions.find(con => con.charIndex === partyForAI.find(p => p.name === char.name)?.charIndex);
                if (charContrib) {
                    const exp = Math.min(1000, charContrib.exp || 0);
                    tx.update(db.doc(`chars/${char.id}`), {
                        exp_total: FieldValue.increment(exp),
                        exp: FieldValue.increment(exp) // Assuming exp overflows into coins elsewhere
                    });
                    tx.set(contribRef.doc(char.id), {
                        totalContribution: FieldValue.increment(charContrib.contribution),
                        owner_uid: char.owner_uid,
                        charName: char.name,
                        lastUpdated: FieldValue.serverTimestamp()
                    }, { merge: true });
                }
            }

            tx.set(db.doc(`users/${uid}`), { cooldown_raid_until: Timestamp.fromMillis(Date.now() + RAID_COOLDOWN_MS) }, { merge: true });
        });

        return { ok: true, logId: logRef.id };
    });

    const setupNewRaidBoss = onSchedule({ schedule: 'every 72 hours', timeZone: 'Asia/Seoul' }, async () => {
        logger.info('새로운 레이드 보스를 설정합니다.');
        // 이전 레이드 보상 지급 로직
        const activeRaid = await getActiveRaid();
        if (activeRaid) {
            await distributeRaidRewards(activeRaid.id);
        }

        // 새 보스 생성
        const newBoss = {
            name: "파멸의 군주, 모르고스", // 예시
            description: "차원의 틈새에서 나타난 고대의 존재입니다. 그의 숨결은 현실을 부패시킵니다.",
            totalHp: 10000000,
            currentHp: 10000000,
            startsAt: FieldValue.serverTimestamp(),
            endsAt: Timestamp.fromMillis(Date.now() + 3 * 24 * 60 * 60 * 1000),
        };
        const newBossRef = await db.collection('raids').add(newBoss);
        await db.doc('raid/status').set({ activeRaidId: newBossRef.id });
        logger.info(`새로운 레이드 보스 ${newBossRef.id}가 생성되었습니다.`);
    });
    
    async function distributeRaidRewards(raidId) {
        logger.info(`레이드 ${raidId}의 보상을 지급합니다.`);
        const contributionsSnap = await db.collection('raids').doc(raidId).collection('contributions').orderBy('totalContribution', 'desc').get();
        
        if (contributionsSnap.empty) {
            logger.info('참여자가 없어 보상 지급을 건너뜁니다.');
            return;
        }

        const rewards = [
            { rank: 10, gold: 500, ticket: { myth: 99.5, aether: 0.5 } },
            { rank: 30, gold: 300, ticket: { myth: 100 } },
            { rank: 100, gold: 100, ticket: null },
            { rank: Infinity, gold: 5, ticket: null }
        ];

        let rank = 1;
        for (const doc of contributionsSnap.docs) {
            const data = doc.data();
            const rewardTier = rewards.find(r => rank <= r.rank);
            
            const mail = {
                title: `레이드 '${raidId}' 참여 보상`,
                body: `레이드 기여도 ${rank}위 보상입니다. 참여해주셔서 감사합니다.`,
                attachments: {
                    coins: rewardTier.gold,
                    ticket: rewardTier.ticket ? { weights: rewardTier.ticket } : null
                },
                sentAt: FieldValue.serverTimestamp(),
                read: false,
                kind: 'general',
            };
            
            await db.collection('mail').doc(data.owner_uid).collection('msgs').add(mail);
            rank++;
        }
        logger.info(`${rank - 1}명의 유저에게 레이드 보상을 발송했습니다.`);
    }

    return { startRaid, setupNewRaidBoss };
};
