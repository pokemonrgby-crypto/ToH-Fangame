// /public/js/api/secure-char.js
import { auth, func } from './firebase.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-functions.js';

export async function createCharSecure(payload){
  if (!auth.currentUser) throw new Error('로그인이 필요해');
  
  const call = httpsCallable(func, 'createChar');
  const res = await call(payload);

  if (!res.data?.ok) {
    throw new Error(res.data?.error || '서버에서 캐릭터 생성에 실패했습니다.');
  }
  
  return res.data; // { ok:true, id: '...' }
}
