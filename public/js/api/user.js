// /public/js/api/user.js
import { db, auth, fx, func, storage, sx } from './firebase.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-functions.js';

// BYOK 키 저장 위치 통일 (ai.js의 'toh_byok'와도 동기화)
export function getLocalGeminiKey(){
  return localStorage.getItem('toh_gemini_key')
      || localStorage.getItem('toh_byok')
      || '';
}
export function setLocalGeminiKey(k){
  const v = (k||'').trim();
  localStorage.setItem('toh_gemini_key', v);
  localStorage.setItem('toh_byok', v); // ai.js 호환
}

export const ONE_WEEK_MS = 7*24*60*60*1000;

function userRef(uid){ return fx.doc(db,'users', uid); }

export async function ensureUserDoc(){
  const u = auth.currentUser;
  if(!u) throw new Error('로그인이 필요해');
  const ref = fx.doc(db,'users', u.uid);
  const snap = await fx.getDoc(ref);

  const fallbackNick = (u.displayName || '모험가').slice(0,20);
  const now = Date.now();

  if(!snap.exists()){
    const base = {
      uid: u.uid,
      nickname: fallbackNick,
      nickname_lower: fallbackNick.toLowerCase(),
      avatarURL: u.photoURL || '',
      createdAt: now,
      updatedAt: now,
      lastNicknameChangeAt: 0
    };
    await fx.setDoc(ref, base, { merge:true });
    return base;
    }else{
    const cur = snap.data() || {};
    const patch = { updatedAt: now };

    if(cur.uid !== u.uid) patch.uid = u.uid;
    if(typeof cur.createdAt !== 'number') patch.createdAt = now;

    if((!cur.avatarURL || cur.avatarURL==='') && u.photoURL) patch.avatarURL = u.photoURL;

    if(!cur.nickname){
      patch.nickname = fallbackNick;
      patch.nickname_lower = fallbackNick.toLowerCase();
      if(typeof cur.lastNicknameChangeAt !== 'number') patch.lastNicknameChangeAt = 0;
    }

    if(Object.keys(patch).length > 0){
      await fx.setDoc(ref, patch, { merge:true });
    }
    return { ...cur, ...patch };
  }
}


export async function loadUserProfile(){
  const u = auth.currentUser; if(!u) throw new Error('로그인이 필요해');
  const snap = await fx.getDoc(userRef(u.uid));
  if(!snap.exists()) return await ensureUserDoc();
  return snap.data();
}

export function leftMsForNicknameChange(profile){
  const last = profile?.lastNicknameChangeAt||0;
  const passed = Date.now()-last;
  return Math.max(0, ONE_WEEK_MS - passed);
}

export async function updateNickname(newName){
  const u=auth.currentUser; if(!u) throw new Error('로그인이 필요해');
  const name=(newName||'').trim();
  if(!name) throw new Error('닉네임을 입력해줘');
  if([...name].length>20) throw new Error('닉네임은 20자 이하야');

  const ref=userRef(u.uid);
  const snap=await fx.getDoc(ref);
  const cur=snap.data()||{};
  const left=leftMsForNicknameChange(cur);
  if(left>0) throw new Error('닉네임은 7일마다 변경 가능해');

  await fx.updateDoc(ref,{
    nickname:name,
    nickname_lower:name.toLowerCase(),
    lastNicknameChangeAt: Date.now(),
    updatedAt: Date.now()
  });
  return name;
}

export async function uploadAvatarBlob(blob){
  const u = auth.currentUser;
  if(!u) throw new Error('로그인이 필요해');

  // 1) 원본을 256x256 정사각형으로 크롭·리사이즈
  const bmp = await createImageBitmap(blob);
  const side = Math.min(bmp.width, bmp.height);
  const sx0 = (bmp.width - side) / 2;
  const sy0 = (bmp.height - side) / 2;
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(bmp, sx0, sy0, side, side, 0, 0, 256, 256);

  // 2) JPEG로 압축 (900KB 이하로 낮춤)
  async function toBlobWithQuality(q){
    return new Promise(resolve => {
      canvas.toBlob(b => resolve(b), 'image/jpeg', q);
    });
  }
  let q = 0.9;
  let jpgBlob = await toBlobWithQuality(q);
  // FileReader 없이 Blob 크기로 판단
  while (jpgBlob && jpgBlob.size > 900_000 && q > 0.4){
    q -= 0.1;
    jpgBlob = await toBlobWithQuality(q);
  }

  // 3) [수정] Storage에 올리기 (경로를 storage.rules와 일치시킴)
  const r = sx.ref(storage, `users/${u.uid}/avatar.jpg`);
  await sx.uploadBytes(r, jpgBlob, { contentType: 'image/jpeg' });

  // 4) 다운로드 URL + 캐시버스터(?v=ts)
  const rawUrl = await sx.getDownloadURL(r);
  const ts = Date.now();
  const url = `${rawUrl}?v=${ts}`;

  // 5) users/{uid} 문서에 avatarURL 저장 (b64는 비우기)
  await fx.setDoc(userRef(u.uid), {
    avatarURL: url,
    avatarUpdatedAt: ts,
    avatar_b64: ''  // 과거 호환: 그냥 빈문자열로 정리
  }, { merge:true });

  // 6) 호출측(me.js)이 바로 <img src>로 쓰게 URL 반환
  return url;
}


export async function restoreAvatarFromGoogle(){
  const u = auth.currentUser;
  if(!u) throw new Error('로그인이 필요해');

  const base = u.photoURL || '';
  const ts = Date.now();
  const url = base ? `${base}${base.includes('?') ? '&' : '?'}v=${ts}` : '';

  await fx.setDoc(userRef(u.uid), {
    avatarURL: url,
    avatarUpdatedAt: ts,
    avatar_b64: '',
    updatedAt: Date.now()
  }, { merge:true });

  return url;
}


// (수정 후 코드)
export async function getUserInventory(uid = null) {
  const targetUid = uid || auth.currentUser?.uid;
  if (!targetUid) return [];
  
  try {
    const userDocRef = fx.doc(db, 'users', targetUid);
    const userDocSnap = await fx.getDoc(userDocRef);
    return userDocSnap.exists() ? (userDocSnap.data().items_all || []) : [];
  } catch (e) {
    console.error(`Failed to get inventory for UID ${targetUid}:`, e);
    return [];
  }
}

// (파일 맨 아래에 추가)
/**
 * 아이템의 잠금 상태를 서버에 요청하여 토글합니다.
 * @param {string} itemId - 잠금 상태를 변경할 아이템의 ID
 * @param {boolean} lock - true: 잠금, false: 해제
 * @returns {Promise<{ok: boolean, itemId: string, isLocked: boolean}>}
 */
export async function toggleItemLock(itemId, lock) {
  if (!auth.currentUser) throw new Error('로그인이 필요합니다.');
  const call = httpsCallable(func, 'toggleItemLock');
  const result = await call({ itemId, lock });
  return result.data;
}
