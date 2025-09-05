// /public/js/api/store.js  (전체 교체)
import { db, auth, fx, storage, sx } from './firebase.js';
import { showToast } from '../ui/toast.js';

export const App = {
  state: {
    user: null,
    worlds: null,
    currentWorldId: 'gionkir',
    myChars: [],        // 항상 서버→메모리
  }
};

// ----- 유틸 -----
export function tierOf(elo=1000){
  if (elo < 900) return {name:'Bronze',  color:'#7a5a3a'};
  if (elo < 1100) return {name:'Silver',  color:'#8aa0b8'};
  if (elo < 1300) return {name:'Gold',    color:'#d1a43f'};
  if (elo < 1500) return {name:'Platinum',color:'#69c0c6'};
  if (elo < 1700) return {name:'Diamond', color:'#7ec2ff'};
  return {name:'Master', color:'#b678ff'};
}

export async function fetchWorlds(){
  if (App.state.worlds) return App.state.worlds;
  const w = await fetch('/assets/worlds.json').then(r=>r.json());
  App.state.worlds = w;
  return w;
}

// ----- Auth 후크 밖에서 호출하는 “읽기/쓰기” 래퍼 -----
export async function fetchMyChars(uid){
  const q = fx.query(fx.collection(db,'chars'), fx.where('owner_uid','==', uid));
  const s = await fx.getDocs(q);
  const arr = [];
  s.forEach(d => arr.push({ id: d.id, ...d.data() }));
  App.state.myChars = arr;
  return arr;
}

export async function createCharMinimal({ world_id, name, input_info }){
  const u = auth.currentUser;
  if(!u) throw new Error('로그인이 필요해');
  const now = Date.now();
  const docRef = await fx.addDoc(fx.collection(db,'chars'), {
    owner_uid: u.uid,
    world_id, name, input_info,
    image_url: '',
    abilities_all: [
      {name:'',desc_raw:'',desc_soft:''},
      {name:'',desc_raw:'',desc_soft:''},
      {name:'',desc_raw:'',desc_soft:''},
      {name:'',desc_raw:'',desc_soft:''}
    ],
    abilities_equipped: [0,1],
    items_equipped: [],
    narrative: '',
    summary: '',
    summary_line: '',
    elo: 1000, wins:0, losses:0, draws:0,
    likes_total:0, likes_weekly:0,
    battle_count:0, explore_count:0,
    createdAt: now, updatedAt: now
  });
  showToast('캐릭터가 생성되었어!');
  return docRef.id;
}

export async function updateAbilitiesEquipped(charId, indices){
  const u = auth.currentUser; if(!u) return;
  if(!Array.isArray(indices) || indices.length !== 2) return;
  await fx.updateDoc(fx.doc(db,'chars',charId), { abilities_equipped: indices, updatedAt: Date.now() });
  showToast('스킬 장착 변경');
}

export async function updateItemsEquipped(charId, charItemDocIds /* length ≤3 */){
  const u = auth.currentUser; if(!u) return;
  const safe = (charItemDocIds||[]).slice(0,3);
  await fx.updateDoc(fx.doc(db,'chars',charId), { items_equipped: safe, updatedAt: Date.now() });
  showToast('아이템 장착 변경');
}

// ----- 이미지 1:1 업로드(512x512 중앙 크롭) -----
export async function uploadAvatarSquare(charId, file){
  const u = auth.currentUser;
  if(!u) throw new Error('로그인이 필요해');
  const bmp = await createImageBitmap(await file.arrayBuffer().then(b=>new Blob([b])));
  const size = Math.min(bmp.width, bmp.height);
  const sx0 = (bmp.width  - size)/2;
  const sy0 = (bmp.height - size)/2;

  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 512;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(bmp, sx0, sy0, size, size, 0, 0, 512, 512);

  const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.85));
  const path = `char_avatars/${u.uid}/${charId}/v${Date.now()}.jpg`;
  const r = sx.ref(storage, path);
  await sx.uploadBytes(r, blob, { contentType: 'image/jpeg', cacheControl: 'public,max-age=31536000,immutable' });
  const url = await sx.getDownloadURL(r);
  await fx.updateDoc(fx.doc(db,'chars',charId), { image_url: url, updatedAt: Date.now() });
  showToast('아바타 업로드 완료');
  return url;
}
