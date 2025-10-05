// /functions/raid.js

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { FieldValue, Timestamp } = require('firebase-admin/firestore');

// 이 함수는 functions/index.js에서 admin, logger, GEMINI_API_KEY와 함께 호출됩니다.
module.exports = (admin, { logger, GEMINI_API_KEY }) => {
    const db = admin.firestore();

    const RAID_COOLDOWN_MS = 10 * 60 * 1000; // 10분
    const MAX_RAID_DAMAGE = 10000; // 최대 데미지 제한
    const MAX_EXP_PER_RAID = 1000; // 최대 경험치(기여도) 제한

    // --- Helper Functions ---

    async function callGemini(systemText, userText) {
        const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
        const model = 'gemini-2.5-pro';
        const apiKey = GEMINI_API_KEY.value();
        if (!apiKey) {
            throw new HttpsError('internal', 'AI API 키가 설정되지 않았습니다.');
        }
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const body = {
          systemInstruction: { role: 'system', parts: [{ text: systemText }] },
          contents: [{ role: 'user', parts: [{ text: userText }] }],
          generationConfig: {
            temperature: 0.70,
            maxOutputTokens: 16384,
            responseMimeType: "application/json",
            responseSchema: {
              type: "object",
              required: ["log", "totalDamage", "contributions"],
              properties: {
                log: { type: "string", maxLength: 16000 },
                totalDamage: { type: "integer", minimum: 1, maximum: 10000 },
                contributions: {
                  type: "array",
                  minItems: 4,
                  maxItems: 4,
                  items: {
                    type: "object",
                    required: ["charId", "contribution", "exp"],
                    properties: {
                      charId: { type: "string", minLength: 1 },
                      contribution: { type: "integer", minimum: 1, maximum: 1000 },
                      exp: { type: "integer", minimum: 1, maximum: 1000 }
                    }
                  }
                }
              }
            }
          },
          // ANCHOR: [수정된 부분] 안전 설정을 추가하여 응답 잘림 현상을 방지합니다.
          safetySettings: [
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_UNSPECIFIED", threshold: "BLOCK_NONE" }
          ]
          // ANCHOR_END
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
            let clean = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```\s*$/, '').trim();
            const firstBrace = clean.indexOf('{');
            const lastBrace = clean.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace > firstBrace) {
                clean = clean.slice(firstBrace, lastBrace + 1);
            }
            clean = clean.replace(/,\s*([}\]])/g, '$1');
            clean = clean.replace(/\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*$/gm, '$1');
            return JSON.parse(clean);
        } catch (e) {
            logger.error("Gemini JSON parse failed (after robust cleaning)", {
                rawText: text.slice(0, 500),
                error: e.message
            });
            throw new HttpsError('internal', 'AI 응답을 파싱하는 데 최종적으로 실패했습니다.');
        }
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
    
    async function _isAdmin(uid) {
        if (!uid) return false;
        try {
          const snap = await db.doc('configs/admins').get();
          const d = snap.exists ? snap.data() : {};
          const allow = Array.isArray(d.allow) ? d.allow : [];
          if (allow.includes(uid)) return true;
          const allowEmails = Array.isArray(d.allowEmails) ? d.allowEmails : [];
          const user = await admin.auth().getUser(uid);
          return !!(user?.email && allowEmails.includes(user.email));
        } catch (_) { return false; }
    }

    // --- Callable Functions ---

    const getActiveRaidBoss = onCall({ region: 'us-central1' }, async (req) => {
        const boss = await getActiveRaid();
        return boss;
    });

    const getRaidRankings = onCall({ region: 'us-central1' }, async (req) => {
        const { raidId } = req.data;
        if (!raidId) {
            return { rankings: [] };
        }
        const contributionsSnap = await db.collection('raids').doc(raidId).collection('contributions').orderBy('totalContribution', 'desc').limit(10).get();
        const rankings = contributionsSnap.docs.map(doc => doc.data());
        return { rankings };
    });
    
    const findRandomPartyForRaid = onCall({ region: 'us-central1' }, async (req) => {
        const myCharId = req.data?.myCharId;
        const myUid = req.auth?.uid;
        if (!myCharId || !myUid) {
            throw new HttpsError('invalid-argument', '캐릭터 ID와 인증 정보가 필요합니다.');
        }

        const myCharSnap = await db.doc(`chars/${myCharId}`).get();
        if (!myCharSnap.exists) {
            throw new HttpsError('not-found', '내 캐릭터 정보를 찾을 수 없습니다.');
        }
        const myCharData = myCharSnap.data();
        const myCharOwner = myCharData.owner_uid;

        const poolCol = db.collection('char_pool');
        const candidates = new Map();
        
        const randomKey = poolCol.doc().id;
        const q1 = await poolCol
            .where('can_match', '==', true)
            .orderBy(admin.firestore.FieldPath.documentId())
            .startAt(randomKey)
            .limit(100)
            .get();

        q1.docs.forEach(doc => candidates.set(doc.id, { id: doc.id, ...doc.data() }));

        if (candidates.size < 100) {
            const q2 = await poolCol
                .where('can_match', '==', true)
                .orderBy(admin.firestore.FieldPath.documentId())
                .limit(100)
                .get();
            q2.docs.forEach(doc => candidates.set(doc.id, { id: doc.id, ...doc.data() }));
        }

        const filteredCandidates = Array.from(candidates.values()).filter(c => {
            const charId = (c.char?.replace('chars/', '')) || c.id;
            if (!charId) return false;
            if (charId === myCharId || c.owner_uid === myCharOwner) {
                return false;
            }
            return true;
        });

        if (filteredCandidates.length < 3) {
            throw new HttpsError('not-found', '매칭할 파티원을 3명 이상 찾을 수 없습니다.');
        }

        const party = [];
        const available = [...filteredCandidates];
        while (party.length < 3 && available.length > 0) {
            const randomIndex = Math.floor(Math.random() * available.length);
            party.push(available.splice(randomIndex, 1)[0]);
        }

        return { partyCharIds: party.map(p => (p.char ? p.char.replace('chars/', '') : p.id)) };
    });

    const findGuildPartyForRaid = onCall({ region: 'us-central1' }, async (req) => {
        const { myCharId, guildId } = req.data;
        const myUid = req.auth?.uid;
        if (!myCharId || !guildId || !myUid) {
            throw new HttpsError('invalid-argument', '캐릭터 ID, 길드 ID, 인증 정보가 필요합니다.');
        }

        const membersSnap = await db.collection('guild_members')
            .where('guildId', '==', guildId)
            .get();

        if (membersSnap.empty) {
            throw new HttpsError('not-found', '길드원을 찾을 수 없습니다.');
        }
        
        const guildMemberCharIds = membersSnap.docs
            .map(doc => doc.data())
            .filter(member => member.charId !== myCharId && member.leftAt == null)
            .map(member => member.charId);

        if (guildMemberCharIds.length < 3) {
            throw new HttpsError('failed-precondition', '파티를 구성할 길드원이 3명 이상 필요합니다.');
        }
        
        const party = [];
        const available = [...guildMemberCharIds];
        while (party.length < 3 && available.length > 0) {
            const randomIndex = Math.floor(Math.random() * available.length);
            party.push(available.splice(randomIndex, 1)[0]);
        }

        return { partyCharIds: party };
    });

    
    const startRaid = onCall({ region: 'us-central1', secrets: [GEMINI_API_KEY] }, async (req) => {
        const uid = req.auth?.uid;
        if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');

        const { myCharId, partyCharIds } = req.data;
        if (!myCharId || !Array.isArray(partyCharIds) || partyCharIds.length !== 3) {
            throw new HttpsError('invalid-argument', '나의 캐릭터 1명과 파티원 3명의 ID가 필요합니다.');
        }

        const allCharIds = [myCharId, ...partyCharIds];
        let raidBoss, userSnap;
        try {
            [raidBoss, userSnap] = await Promise.all([
                getActiveRaid(),
                db.doc(`users/${uid}`).get()
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
        
        const myCharSnap = await db.doc(`chars/${myCharId}`).get();
        if (!myCharSnap.exists || myCharSnap.data().owner_uid !== uid) {
            throw new HttpsError('permission-denied', '자신의 캐릭터로만 레이드를 시작할 수 있습니다.');
        }

        const charDocs = await db.collection('chars').where(admin.firestore.FieldPath.documentId(), 'in', allCharIds).get();
        const partyChars = charDocs.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        const allOwnerUids = [...new Set(partyChars.map(c => c.owner_uid))];
        const userInventories = new Map();

        const userSnaps = await Promise.all(
            allOwnerUids.map(ownerId => db.doc(`users/${ownerId}`).get())
        );
        userSnaps.forEach(snap => {
            if (snap.exists) {
                userInventories.set(snap.id, snap.data().items_all || []);
            }
        });

        const partyForAI = partyChars.map((c) => {
            const equippedSkills = (c.abilities_equipped || [])
                .map(idx => (c.abilities_all || [])[idx])
                .filter(Boolean)
                .map(skill => ({
                    name: skill.name,
                    description: skill.desc_soft || skill.desc || ''
                }));

            const ownerInventory = userInventories.get(c.owner_uid) || [];
            const equippedItems = (c.items_equipped || [])
                .map(itemId => {
                    const item = ownerInventory.find(i => i.id === itemId);
                    if (!item) return null;
                    return {
                        name: item.name,
                        description: item.description || item.desc || '',
                        properties: item.properties || {},
                        rarity: item.rarity
                    };
                })
                .filter(Boolean);
            
            const latestNarrative = (c.narratives || []).sort((a,b) => (b.createdAt || 0) - (a.createdAt || 0))[0];

            return {
                charId: c.id,
                name: c.name,
                summary: c.summary,
                narrative_long: latestNarrative?.long || c.summary || '',
                skills: equippedSkills,
                equipped_items: equippedItems
            };
        });

        const systemPrompt = await db.doc('configs/prompts').get().then(d => d.data().raid_battle_system || 'You are a battle narrator.');
        
        const userPrompt = `
# 보스 정보
${JSON.stringify({ name: raidBoss.name, description: raidBoss.description, skills: raidBoss.skills }, null, 2)}

# 파티 정보 (charId를 기준으로 기여도를 반환해야 함)
${JSON.stringify(partyForAI, null, 2)}
        `;

        const aiResult = await callGemini(systemPrompt, userPrompt);
        let totalDamage = 1;

        {
          if (aiResult && typeof aiResult.log === 'string') {
            aiResult.log = aiResult.log.replace(/\[\/SLOW\]/g, '[RESUME]');
          }

          const tdRaw = Number(aiResult?.totalDamage);
          totalDamage = Math.max(1, Math.min(MAX_RAID_DAMAGE, Number.isFinite(tdRaw) ? Math.round(tdRaw) : 1));

          if (!Array.isArray(aiResult?.contributions) || aiResult.contributions.length !== 4) {
            throw new HttpsError('internal', 'AI 응답의 contributions 길이가 4가 아닙니다.');
          }
          aiResult.contributions = aiResult.contributions.map(c => {
            const cid = String(c?.charId || '');
            const val = Math.round(Number(c?.contribution));
            const safe = Math.max(1, Math.min(MAX_EXP_PER_RAID, Number.isFinite(val) ? val : 1));
            return { charId: cid, contribution: safe, exp: safe };
          });
        }

        const logRef = db.collection('raid_logs').doc();
        const contribRef = db.collection('raids').doc(raidBoss.id).collection('contributions');
        
        const partyIds = partyChars.map(c => c.id);

        await db.runTransaction(async tx => {
            const bossDoc = await tx.get(db.doc(`raids/${raidBoss.id}`));
            const currentHp = bossDoc.data().currentHp;
            const finalHp = Math.max(0, currentHp - totalDamage);

            tx.update(bossDoc.ref, { currentHp: finalHp });
            tx.set(logRef, {
                raidId: raidBoss.id,
                raidName: raidBoss.name,
                log: aiResult.log,
                party: partyChars.map(c => ({ 
                    id: c.id, 
                    name: c.name, 
                    owner_uid: c.owner_uid,
                    thumb_url: c.thumb_url || null
                })),
                party_ids: partyIds,
                totalDamage,
                contributions: aiResult.contributions,
                createdAt: FieldValue.serverTimestamp()
            });

            for (const char of partyChars) {
                const charContribData = (aiResult.contributions || []).find(con => con.charId === char.id);
                if (charContribData) {
                    const exp = Math.min(MAX_EXP_PER_RAID, charContribData.exp || 0);
                    
                    tx.update(db.doc(`chars/${char.id}`), {
                        exp_total: FieldValue.increment(exp),
                        exp: FieldValue.increment(exp),
                        raid_count: FieldValue.increment(1)
                    });

                    tx.set(contribRef.doc(char.id), {
                        charId: char.id,
                        totalContribution: FieldValue.increment(exp),
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
    
    async function distributeRaidRewards(raidId) {
        logger.info(`Distributing rewards for raid ${raidId}.`);
        const contributionsSnap = await db.collection('raids').doc(raidId).collection('contributions').orderBy('totalContribution', 'desc').get();
        
        if (contributionsSnap.empty) {
            logger.info('No participants, skipping reward distribution.');
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
            if (!data.owner_uid) continue;
            
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
                 from: '시스템'
            };
            
            await db.collection('mail').doc(data.owner_uid).collection('msgs').add(mail);
            rank++;
        }
        logger.info(`${rank - 1} users have been sent raid rewards.`);
    }

    const adminSetupNewRaidBoss = onCall({ region: 'us-central1' }, async (req) => {
        const uid = req.auth?.uid;
        if (!await _isAdmin(uid)) {
            throw new HttpsError('permission-denied', '관리자만 실행할 수 있습니다.');
        }

        const { name, description, totalHp, durationDays, imageUrl, skills } = req.data;
        if (!name || !description || !totalHp || !durationDays || !Array.isArray(skills) || skills.length !== 4) {
            throw new HttpsError('invalid-argument', '보스 정보(이름, 설명, HP, 기간, 이미지, 스킬 4개)가 올바르지 않습니다.');
        }
        
        const activeRaid = await getActiveRaid();
        if (activeRaid) {
            await distributeRaidRewards(activeRaid.id);
        }

        const newBoss = {
            name: String(name),
            description: String(description),
            totalHp: Number(totalHp),
            currentHp: Number(totalHp),
            imageUrl: String(imageUrl || ''),
            skills: skills,
            startsAt: FieldValue.serverTimestamp(),
            endsAt: Timestamp.fromMillis(Date.now() + Number(durationDays) * 24 * 60 * 60 * 1000),
        };
        const newBossRef = await db.collection('raids').add(newBoss);
        await db.doc('raid/status').set({ activeRaidId: newBossRef.id });
        
        logger.info(`관리자(${uid})가 새로운 레이드 보스 ${newBossRef.id}를 생성했습니다.`);
        return { ok: true, bossId: newBossRef.id };
    });

    return { 
        startRaid, 
        getActiveRaidBoss, 
        getRaidRankings, 
        findRandomPartyForRaid, 
        findGuildPartyForRaid,
        adminSetupNewRaidBoss 
    };
};
