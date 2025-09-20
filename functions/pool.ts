// functions/pool.ts
import * as admin from 'firebase-admin';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { FieldValue } from 'firebase-admin/firestore';

if (!admin.apps.length) admin.initializeApp();

export const syncCharPool = onDocumentWritten('chars/{id}', async (e)=>{
  const after = e.data?.after?.data() as any | undefined;
  const before = e.data?.before?.data() as any | undefined;
  const id = e.params.id;
  const db = admin.firestore();
  const ref = db.doc(`char_pool/${id}`);

  if(!after){ // 삭제
    await ref.delete().catch(()=>{});
    return;
  }
  const is_valid = (after.is_valid !== false) && !after.deletedAt;
  const locked_until = Number(after.match?.locked_until||0);
  const can_match = is_valid && (locked_until <= Math.floor(Date.now()/1000));

  await ref.set({
    char: `chars/${id}`,
    owner_uid: after.owner_uid || null,
    name: after.name || null,
    thumb_url: after.thumb_url || after.image_url || null,
    elo: Number(after.elo||1000),
    is_valid,
    locked_until,
    can_match,
    world_id: after.world_id || null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge:true });
});

export const onCharDeleteCleanup = onDocumentDeleted('chars/{charId}', async (event) => {
  const charId = event.params.charId;
  // 삭제 직전의 캐릭터 데이터를 가져옵니다.
  const deletedChar = event.data.data();

  // 캐릭터 데이터가 없거나 길드 정보(guildId)가 없으면 함수를 종료합니다.
  if (!deletedChar || !deletedChar.guildId) {
    console.log(`Character ${charId} was deleted, but had no guild affiliation.`);
    return;
  }

  const guildId = deletedChar.guildId;
  const guildRef = admin.firestore().doc(`guilds/${guildId}`);
  const memberRef = admin.firestore().doc(`guild_members/${guildId}__${charId}`);

  console.log(`Character ${charId} deleted from guild ${guildId}. Cleaning up...`);

  try {
    // 트랜잭션을 사용하여 여러 작업을 안전하게 한 번에 처리합니다.
    await admin.firestore().runTransaction(async (tx) => {
      const guildSnap = await tx.get(guildRef);
      if (!guildSnap.exists) {
        console.warn(`Guild ${guildId} not found for deleted char ${charId}. Deleting member doc anyway.`);
        // 길드가 없더라도, 유령 멤버 문서는 삭제합니다.
        tx.delete(memberRef);
        return;
      }

      // 길드 문서에서 캐릭터 관련 정보를 업데이트합니다.
      const updates = {
        // 1. 멤버 수를 1 감소시킵니다.
        member_count: FieldValue.increment(-1),
        // 2. 캐릭터 ID를 각종 직책 목록에서 제거합니다.
        staff_cids: FieldValue.arrayRemove(charId),
        honorary_leader_cids: FieldValue.arrayRemove(charId),
        honorary_vice_cids: FieldValue.arrayRemove(charId),
      };

      tx.update(guildRef, updates);
      // 3. guild_members 문서 자체를 삭제합니다.
      tx.delete(memberRef);
    });

    console.log(`Successfully cleaned up guild info for deleted character ${charId}`);
  } catch (error) {
    console.error(`Error during guild cleanup for character ${charId}:`, error);
    // 트랜잭션 실패 시에도 최소한의 정리를 시도할 수 있습니다 (예: 멤버 문서만이라도 삭제)
    await memberRef.delete().catch(e => console.error(`Failed to force delete member ref for ${charId}`, e));
  }
});
