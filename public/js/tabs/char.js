// /public/js/tabs/char.js
import { db, auth, fx } from '../api/firebase.js';
import { attachSupporterFX } from '../ui/supporter_fx.js';
// [추가] getDocFromServer와 getDocsFromServer 함수를 직접 가져옵니다.
import { startAfter, getDocFromServer, getDocsFromServer } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js';
import {
  tierOf, uploadAvatarSquare, updateAbilitiesEquipped, updateItemsEquipped,
  getCharMainImageUrl, fetchWorlds, deleteRelation 
} from '../api/store.js';
import { getUserInventory } from '../api/user.js'; // 사용자 인벤토리 함수 import
import { showToast } from '../ui/toast.js';

// ---------- utils ----------
// [추가] esc 함수를 다른 파일에서도 쓸 수 있도록 상단으로 옮기고 export 합니다.
export function esc(s){
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function parseId(){
// (기존 내용과 동일)
  const h = location.hash || '';
  // #/char/{cid} 또는 #/char/{cid}/narrative/{nid}
  const m = h.match(/^#\/char\/([^/]+)(?:\/narrative\/([^/]+))?$/);
  return m ? { charId: m[1], narrId: m[2] || null } : { charId:null, narrId:null };
}

function rateText(w,l){ const W=+w||0, L=+l||0, T=W+L; return T? Math.round(W*100/T)+'%':'0%'; }
function normalizeChar(c){
  const out={...c};
  out.elo = out.elo ?? 1000;
  out.abilities_all = Array.isArray(out.abilities_all)? out.abilities_all : (Array.isArray(out.abilities)? out.abilities: []);
  out.abilities_equipped = Array.isArray(out.abilities_equipped)? out.abilities_equipped.slice(0,2): [];
  out.items_all = Array.isArray(out.items_all) ? out.items_all : [];
  out.items_equipped = Array.isArray(out.items_equipped)? out.items_equipped.slice(0,3): [];
  out.thumb_url = out.thumb_url || '';
  out.image_url = out.thumb_url || out.image_b64 || out.image_url || '';
  out.narrative_items = Array.isArray(out.narrative_items) ? out.narrative_items
  : (out.narrative ? [{ title:'서사', body: out.narrative }] : []);
  return out;
}

// [수정] 다른 파일에서 재사용할 수 있도록 export 추가
export function rarityStyle(r) {
  const map = {
    normal: { bg: '#2a2f3a', border: '#5f6673', text: '#c8d0dc', label: '일반' },
    rare:   { bg: '#0f2742', border: '#3b78cf', text: '#cfe4ff', label: '레어' },
    epic:   { bg: '#20163a', border: '#7e5cff', text: '#e6dcff', label: '유니크' },
    legend: { bg: '#2b220b', border: '#f3c34f', text: '#ffe9ad', label: '레전드' },
    myth:   { bg: '#3a0f14', border: '#ff5b66', text: '#ffc9ce', label: '신화' },
    aether: { 
      bg: '#2f2b3b', 
      border: 'linear-gradient(135deg, #ff3b30, #ff9500, #ffd60a, #34c759, #00c7be, #007aff, #5856d6, #af52de)', 
      text: '#f8f8f2', 
      label: '에테르' 
    },

  };
  return map[(r || '').toLowerCase()] || map.normal;
}

// [추가] adventure.js에서 가져온 함수들
export function isConsumableItem(it){ return !!(it?.consumable || it?.isConsumable); }
export function getUsesLeft(it){
  if (typeof it?.uses === 'number') return it.uses;
  if (typeof it?.remainingUses === 'number') return it.remainingUses;
  return null;
}
export function useBadgeHtml(it){
  if (!isConsumableItem(it)) return '';
  const left = getUsesLeft(it);
  const label = (left === null) ? '소모품' : `남은 ${left}회`;
  return `<span class="chip" style="margin-left:auto;font-size:11px;padding:2px 6px">${esc(label)}</span>`;
}


function ensureModalCss(){
  if (document.getElementById('toh-modal-css')) return;
  const st = document.createElement('style');
  st.id = 'toh-modal-css';
  st.textContent = `
    .modal-back{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;
                background:rgba(0,0,0,.45)}
    .modal-card{background:#0e1116;border:1px solid #273247;border-radius:14px;padding:14px;max-width:720px;width:92vw;
                max-height:80vh;overflow:auto}
  `;
  document.head.appendChild(st);
}




export function ensureItemCss() {
  if (document.getElementById('toh-item-css')) return;
  const st = document.createElement('style');
  st.id = 'toh-item-css';
  st.textContent = `
  /* [추가] 모달 창을 위한 스타일 */
  .modal-back{position:fixed;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;z-index:9999}
  .modal-card{background:#0e1116;border:1px solid #273247;border-radius:14px;padding:16px;max-width:800px;width:94vw;max-height:90vh;display:flex;flex-direction:column;}

  /* 아이템 카드 효과 */
  .shine-effect { position: relative; overflow: hidden; }
  .shine-effect::after { content: ''; position: absolute; top: -50%; left: -50%; width: 200%; height: 200%; background: linear-gradient(to right, rgba(255,255,255,0) 0%, rgba(255,255,255,0.3) 50%, rgba(255,255,255,0) 100%); transform: rotate(30deg); animation: shine 3s infinite ease-in-out; pointer-events: none; }
  @keyframes shine { 0% { transform: translateX(-75%) translateY(-25%) rotate(30deg); } 100% { transform: translateX(75%) translateY(25%) rotate(30deg); } }
  .item-card { transition: box-shadow .18s ease, transform .18s ease, filter .18s ease; will-change: transform, box-shadow; outline: none; }
  /* 공통 아이템 카드 베이스 */
.kv-card.item-card{
  border:1px solid #273247;
  border-radius:12px;
  background:rgba(255,255,255,.03);
  padding:10px;
}

  /* === AETHER rarity: animated rainbow background === */
.kv-card.rarity-aether,
.item.rarity-aether {
  position: relative;
  overflow: hidden;
  border: 1px solid #fff;
}

/* 무지개 애니메이션 레이어 (바닥) */
.kv-card.rarity-aether::before,
.item.rarity-aether::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(
    120deg,
    #ff375f, #ff9f0a, #ffd60a, #34c759, #00c7be, #0a84ff, #5e5ce6, #ff2d55, #ff375f
  );
  background-size: 300% 300%;
  filter: saturate(120%);
  animation: aetherFlow 8s linear infinite;
  z-index: 0;
}

/* 가독성을 위한 어둡기 오버레이 (위) */
.kv-card.rarity-aether::after,
.item.rarity-aether::after {
  content: '';
  position: absolute;
  inset: 0;
  background: rgba(15,16,20,.65);
  z-index: 1;
}

/* 실제 내용은 제일 위 레이어 */
.kv-card.rarity-aether > *,
.item.rarity-aether > * {
  position: relative;
  z-index: 2;
}

@keyframes aetherFlow {
  0%   { background-position:   0% 50%; }
  50%  { background-position: 100% 50%; }
  100% { background-position:   0% 50%; }
}

/* 모션 최소화 환경 배려 */
@media (prefers-reduced-motion: reduce){
  .kv-card.rarity-aether::before,
  .item.rarity-aether::before { animation: none; }
}

  .item-card:hover, .item-card:focus-visible { transform: translateY(-2px); box-shadow: 0 6px 18px rgba(0,0,0,.35); filter: brightness(1.05); }`;
  document.head.appendChild(st);
}

// [교체] adventure.js의 showItemDetailModal 함수로 교체합니다.
// (battle.js에서 필요한 onUpdate 콜백 기능이 포함되어 있습니다)
export function showItemDetailModal(item, context = {}) {
    ensureItemCss();
    if (document.querySelector('.modal-back[data-kind="item-detail"]')) return;
    const { equippedIds = [], onUpdate = null } = context;
    const isEquipped = equippedIds.includes(item.id);

    const style = rarityStyle(item.rarity);
    const getItemDesc = (it) => (it?.desc_long || it?.desc_soft || it?.desc || it?.description || '').replace(/\n/g, '<br>');
    const getEffectsHtml = (it) => {
        const eff = it?.effects;
        if (!eff) return '';
        if (Array.isArray(eff)) return `<ul style="margin:6px 0 0 16px; padding:0;">${eff.map(x=>`<li>${esc(String(x||''))}</li>`).join('')}</ul>`;
        if (typeof eff === 'object') return `<ul style="margin:6px 0 0 16px; padding:0;">${Object.entries(eff).map(([k,v])=>`<li><b>${esc(k)}</b>: ${esc(String(v??''))}</li>`).join('')}</ul>`;
        return `<div>${esc(String(eff))}</div>`;
    };

    const back = document.createElement('div');
    back.className = 'modal-back';
    back.dataset.kind = 'item-detail';  // 중복 방지용 식별자
  
    back.style.zIndex = '10001'; // 아이템 피커 모달 위에 표시되도록 z-index 증가
    back.innerHTML = `
    <div class="modal-card" style="background:#0e1116;border:1px solid #273247;border-radius:14px;padding:14px;max-width:720px;width:92vw;">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px;">
        <div>
          <div class="row" style="align-items:center;gap:8px;flex-wrap:wrap">
            <div style="font-weight:900; font-size:18px;">${esc(item.name)}</div>
            <span class="chip" style="background:${style.border}; color:${style.bg}; font-weight:800;">${esc(style.label)}</span>
            ${useBadgeHtml(item)}
          </div>
        </div>
        <button class="btn ghost" id="mCloseDetail">닫기</button>
      </div>
      <div class="kv-card ${(item.rarity||'').toLowerCase()==='aether' ? 'rarity-aether' : ''}" style="padding:12px;">
        <div style="font-size:14px; line-height:1.6;">${getItemDesc(item) || '상세 설명이 없습니다.'}</div>
        ${item.effects ? `<hr style="margin:12px 0; border-color:#273247;"><div class="kv-label">효과</div><div style="font-size:13px;">${getEffectsHtml(item)}</div>` : ''}
      </div>
      <div id="itemActions" style="display:flex; justify-content:flex-end; gap:8px; margin-top:12px;"></div>
    </div>
  `;
    const closeModal = () => back.remove();
    back.addEventListener('click', e => { if (e.target === back) closeModal(); });
    back.querySelector('#mCloseDetail').onclick = closeModal;

    const actionsContainer = back.querySelector('#itemActions');

// 인벤토리(피커)에서만 버튼을 노출: onUpdate가 함수로 넘어온 경우에 한정
if (typeof onUpdate === 'function') {
  if (isEquipped) {
    const btnUnequip = document.createElement('button');
    btnUnequip.className = 'btn';
    btnUnequip.textContent = '장착 해제';
    btnUnequip.onclick = () => {
      const newEquipped = equippedIds.filter(id => id !== item.id);
      onUpdate(newEquipped);
      closeModal();
    };
    actionsContainer.appendChild(btnUnequip);
  } else if (equippedIds.length < 3) {
    const btnEquip = document.createElement('button');
    btnEquip.className = 'btn primary';
    btnEquip.textContent = '장착하기';
    btnEquip.onclick = () => {
      const newEquipped = [...equippedIds, item.id];
      onUpdate(newEquipped);
      closeModal();
    };
    actionsContainer.appendChild(btnEquip);
  }
}
// onUpdate가 없으면(= 피커 밖에서 띄운 상세창이면) 버튼 영역은 비워둔다.


    document.body.appendChild(back);
}

// ---------- entry ----------
export async function showCharDetail(){
  const { charId, narrId } = parseId();
  const root = document.getElementById('view');
  if(!root){ console.warn('[char] #view not found'); return; }
  if(!charId){
    root.innerHTML='<section class="container narrow"><p>잘못된 경로</p></section>';
    return;
  }

  try{
    // [수정] fx.getDoc -> getDocFromServer: 캐시를 무시하고 항상 서버에서 최신 캐릭터 정보를 가져옵니다.
    const snap = await getDocFromServer(fx.doc(db,'chars', charId));
    if(!snap.exists()){
      root.innerHTML='<section class="container narrow"><p>캐릭터가 없네</p></section>';
      return;
    }
    const c = normalizeChar({ id:snap.id, ...snap.data() });
    if (narrId) { renderNarrativePage(c, narrId); return; }
    else{ await render(c); }
  }catch(e){
    console.error('[char] load error', e);
    const msg = e?.code==='permission-denied'
      ? '권한이 없어 캐릭터를 불러올 수 없어. 먼저 로그인해줘!'
      : '캐릭터 로딩 중 오류가 났어.';
    root.innerHTML = `<section class="container narrow"><p>${msg}</p><pre class="text-dim" style="white-space:pre-wrap">${e?.message || e}</pre></section>`;
  }
}


// ---------- render ----------
// /public/js/tabs/char.js

// (기존 코드와 동일)

// ---------- render ----------
async function render(c){
  const root = document.getElementById('view');
  const tier = tierOf(c.elo||1000);
  const isOwner = auth.currentUser && auth.currentUser.uid === c.owner_uid;
  
  // 1. 캐릭터 주인의 프로필에서 후원자 디자인 이름을 문자열로 가져옵니다.
  let supporterTier = '';
  if (c.owner_uid) {
    try {
      const ownerSnap = await fx.getDoc(fx.doc(db, 'users', c.owner_uid));
      // 'supporter_tier' 필드가 존재하고 문자열이면 값을 사용합니다.
      if (ownerSnap.exists()) {
        supporterTier = ownerSnap.data().supporter_tier; // 이 값은 undefined, null, "", "none" 또는 유효한 등급일 수 있습니다.
      }
    } catch (e) {
      console.warn("후원자 정보 조회 실패:", e);
    }
  }
  const expVal = Number.isFinite(c.exp) ? c.exp : 0;
  const expPct = Math.max(0, Math.min(100, (c.exp_progress ?? ((expVal)%100)) ));
  const _rawWorlds = await fetchWorlds().catch(()=>null);
  let worldName = c.world_id || 'world:default';
  try {
    const ws = Array.isArray(_rawWorlds) ? _rawWorlds : (_rawWorlds && Array.isArray(_rawWorlds.worlds)) ? _rawWorlds.worlds : _rawWorlds;
    if (Array.isArray(ws)) {
      const w = ws.find(x => (x.id === c.world_id) || (x.slug === c.world_id));
      worldName = (w?.name) || worldName;
    } else if (ws && typeof ws === 'object') {
      const w = ws[c.world_id];
      worldName = (typeof w === 'string') ? w : (w?.name || worldName);
    }
  } catch (_) {}

  root.innerHTML = `
  <section class="container narrow">
    <div class="card p16 char-card">
      <div class="char-header">
        
        <div class="avatar-wrap ${supporterTier ? `supporter-${supporterTier}` : ''}" style="border-color:${tier.color}">
          <div class="avatar-clip">
            <img id="charAvatar" src="${c.thumb_url||c.image_b64||c.image_url||''}" alt=""
                 onerror="this.src=''; this.classList.add('noimg')" />
          </div>

          
          <div class="top-actions" style="z-index:99">
            <button class="fab-circle" id="btnLike" title="좋아요">♥</button>
            ${isOwner? `<button class="fab-circle" id="btnUpload" title="이미지 업로드">⤴</button>`:''}
          </div>
        </div>
        
        <div class="char-name">${c.name||'(이름 없음)'}</div>
        <div class="chips-row">
          <span class="tier-chip" style="background:${tier.color}1a; color:#fff; border-color:${tier.color}80;">${tier.name || 'Tier'}</span>
          <span class="chip">${worldName}</span>
        </div>
        <div class="expbar" aria-label="EXP" style="position:relative;width:100%;max-width:760px;height:10px;border-radius:999px;background:#0d1420;border:1px solid #273247;overflow:hidden;margin-top:8px;">
          <div style="position:absolute;inset:0 auto 0 0;width:${expPct}%;background:linear-gradient(90deg,#4ac1ff,#7a9bff,#c2b5ff);box-shadow:0 0 12px #7ab8ff77 inset;"></div>
          <div style="position:absolute;top:-22px;right:0;font-size:12px;color:#9aa5b1;">EXP ${expVal}</div>
        </div>
        <div class="char-stats4">
          <div class="stat-box stat-win"><div class="k">승률</div><div class="v">${rateText(c.wins,c.losses)}</div></div>
          <div class="stat-box stat-like"><div class="k">누적 좋아요</div><div class="v">${c.likes_total||0}</div></div>
          <div class="stat-box stat-elo"><div class="k">Elo</div><div class="v">${c.elo||1000}</div></div>
          <div class="stat-box stat-week"><div class="k">주간 좋아요</div><div class="v">${c.likes_weekly||0}</div></div>
        </div>
        <div class="char-counters">전투 ${c.battle_count||0} · 조우 ${c.encounter_count||0} · 탐험 ${c.explore_count||0}</div>
      </div>
    </div>
    <div class="book-card mt16">
      <div class="bookmarks">
        <button class="bookmark active" data-tab="bio">기본 소개 / 서사</button>
        <button class="bookmark" data-tab="loadout">스킬 / 아이템</button>
        <button class="bookmark" data-tab="history">배틀 / 조우 / 탐험 전적</button>
      </div>
      <div class="bookview" id="bookview"></div>
    </div>
  </section>`;

  // ANCHOR: [교체] 후원자 FX 부착 로직 수정
  const wrap = root.querySelector('.avatar-wrap');

  // 2. supporterTier에 유효한 값이 있고(null, undefined, ""가 아님), 'none'이 아닐 때만 FX를 부착합니다.
  if (wrap && supporterTier && supporterTier !== 'none' && !wrap.dataset.fxAttached) {
    wrap.dataset.fxAttached = '1';
    
    // 유효한 후원자 등급 목록
    const validTiers = ['nexus', 'flame', 'galaxy', 'forest', 'orbits'];
    
    // supporterTier 값이 유효한 목록에 포함되어 있으면 해당 값을 사용하고,
    // 목록에 없더라도 유효한 값이면 'orbits'를 기본값으로 사용합니다.
    const effectTheme = validTiers.includes(supporterTier) ? supporterTier : 'orbits';
    
    // 결정된 테마로 이펙트 함수를 호출합니다.
    attachSupporterFX(wrap, effectTheme);
  }
  // ANCHOR_END

  getCharMainImageUrl(c.id, {cacheFirst:true}).then(url=>{
    const img = document.getElementById('charAvatar');
    if(!url || !img) return;
    const pre = new Image();
    pre.onload = ()=> { img.src = url; };   // 로딩 끝나면 한 번에 교체
    pre.src = url;
  }).catch(()=>{ /* keep thumbnail */ });


  mountFixedActions(c, isOwner);

  if(isOwner){
    root.querySelector('#btnUpload')?.addEventListener('click', ()=>{
      const i=document.createElement('input'); i.type='file'; i.accept='image/*';
      i.onchange=async()=>{
        const f=i.files?.[0]; if(!f) return;
        await uploadAvatarSquare(c.id, f);
        showToast('프로필 업데이트 완료!');
        location.reload();
      };
      i.click();
    });
  }
  const btnLike = root.querySelector('#btnLike');
if (btnLike) {
  const LIKED_KEY = `toh_liked_${c.id}`;
  // 이미 좋아요를 눌렀다면 버튼을 비활성화하고 스타일 변경
  if (localStorage.getItem(LIKED_KEY)) {
    btnLike.style.background = '#ff69b4';
    btnLike.innerHTML = '❤️';
    btnLike.disabled = true;
  }

  btnLike.addEventListener('click', async () => {
    if (!auth.currentUser) return showToast('로그인해야 좋아요를 누를 수 있어.');
    if (isOwner) return showToast('자기 캐릭터는 좋아할 수 없어!');
    if (localStorage.getItem(LIKED_KEY)) return showToast('이미 좋아한 캐릭터야.');

    try {
      btnLike.disabled = true;
     // Firestore 규칙에 맞춰 3필드만 정확히 변경
      const ref = fx.doc(db, 'chars', c.id);
      await fx.updateDoc(ref, {
        likes_total:  fx.increment(1),
        likes_weekly: fx.increment(1),
        updatedAt:    fx.serverTimestamp()
      });


      // 성공 시 로컬에 기록하여 중복 방지
      localStorage.setItem(LIKED_KEY, '1');

      showToast('좋아요! 이 캐릭터를 응원합니다.');
      btnLike.style.background = '#ff69b4';
      btnLike.innerHTML = '❤️';

      // 화면의 좋아요 카운트도 즉시 업데이트
      const likeStat = root.querySelector('.stat-like .v');
      if (likeStat) likeStat.textContent = (parseInt(likeStat.textContent, 10) || 0) + 1;
      const weekStat = root.querySelector('.stat-week .v');
      if (weekStat) weekStat.textContent = (parseInt(weekStat.textContent, 10) || 0) + 1;

    } catch (e) {
      console.error('[like] error', e);
      showToast(`좋아요 실패: ${e.message}`);
      btnLike.disabled = false; // 실패 시 다시 누를 수 있도록 복구
    }
  });
}

  const bv = root.querySelector('#bookview');
  const tabs = root.querySelectorAll('.bookmark');
  tabs.forEach(b=>b.onclick=()=>{
    tabs.forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    const t=b.dataset.tab;
    if(t==='bio') renderBio(c, bv);
    else if(t==='loadout') renderLoadout(c, bv);
    else renderHistory(c, bv);
  });
  renderBio(c, bv);
}
// (이하 코드 동일)

function mountFixedActions(c, isOwner){
  document.querySelector('.fixed-actions')?.remove();

  const bar = document.createElement('div');
  bar.className = 'fixed-actions';

  if (!auth.currentUser) {
    // 로그인 안 되어 있으면 아무 것도 안 띄움
    return;
  }

  if (isOwner) {
    // 내 캐릭터일 때: 기존과 동일
    bar.innerHTML = `
      <button class="btn large" id="fabEncounter">조우 시작</button>
      <button class="btn large primary" id="fabBattle">배틀 시작</button>
    `;
    document.body.appendChild(bar);

    bar.querySelector('#fabBattle').onclick = ()=>{
      sessionStorage.setItem('toh.match.intent', JSON.stringify({ charId:c.id, mode:'battle', ts: Date.now() }));
      location.hash = '#/battle';
    };
    bar.querySelector('#fabEncounter').onclick = ()=>{
      sessionStorage.setItem('toh.match.intent', JSON.stringify({ charId:c.id, mode:'encounter', ts: Date.now() }));
      location.hash = '#/encounter';
    };
    return;
  }

  // ★ 다른 사람 캐릭터일 때: 모의 버튼 제공
  bar.innerHTML = `
    <button class="btn large" id="fabMockEncounter">모의조우</button>
    <button class="btn large primary" id="fabMockBattle">모의전투</button>
  `;
  document.body.appendChild(bar);

  // 내 대표 캐릭터 하나 고르기(최근 업데이트 순 1개)
  async function getMyDefaultCharId(){
    const q = fx.query(
      fx.collection(db,'chars'),
      fx.where('owner_uid','==', auth.currentUser.uid),
      fx.orderBy('updatedAt','desc'),
      fx.limit(1)
    );
    const s = await getDocsFromServer(q);
    return s.docs[0]?.id || null;
  }

  async function goMock(mode){
    const myCharId = await getMyDefaultCharId();
    if(!myCharId){
      showToast('내 캐릭터가 없어. 먼저 캐릭터를 만들어줘!');
      return;
    }
    // targetId에 현재 보고 있는 상대 캐릭터를 고정
    sessionStorage.setItem('toh.match.intent', JSON.stringify({
      charId: myCharId,
      mode,
      sim: true,
      targetId: c.id,
      ts: Date.now()
    }));
    location.hash = mode === 'battle' ? '#/battle' : '#/encounter';
  }

  bar.querySelector('#fabMockBattle').onclick = ()=> goMock('battle');
  bar.querySelector('#fabMockEncounter').onclick = ()=> goMock('encounter');
}



// ---------- views ----------
function renderBio(c, view){
  view.innerHTML = `
    <div class="subtabs">
      <button class="sub active" data-s="summary">기본 소개</button>
      <button class="sub" data-s="narr">서사</button>
      <button class="sub" data-s="epis">미니 에피소드</button>
      <button class="sub" data-s="rel">관계</button>
    </div>
    <div id="subview" class="p12"></div>
  `;

  const sv = view.querySelector('#subview');
  const subs = view.querySelectorAll('.subtabs .sub');
  subs.forEach(b=>b.onclick=()=>{
    subs.forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    renderBioSub(b.dataset.s, c, sv);
  });
  renderBioSub('summary', c, sv);
}

// /public/js/tabs/char (2).js

// ... (다른 함수들은 그대로 유지) ...

// public/js/tabs/char.js

async function renderBioSub(which, c, sv){
  if(which==='summary'){
    sv.innerHTML = `
      <div class="kv-label">기본 소개</div>
      <div class="kv-card" style="white-space:pre-line">${esc(c.summary)||'-'}</div>
    `;
  } else if(which==='narr'){
    const list = normalizeNarratives(c);
    if(list.length === 0){
      sv.innerHTML = `<div class="kv-card text-dim">아직 등록된 서사가 없어.</div>`;
      return;
    }
    sv.innerHTML = `
      <div class="kv-label">서사 목록</div>
      <div class="list">
        ${list.map(n => `
          <button class="kv-card" data-nid="${esc(n.id)}" style="text-align:left; cursor:pointer">
            <div style="font-weight:800; margin-bottom:6px">${esc(n.title || '서사')}</div>
            <div style="
              color:#9aa5b1;
              display:-webkit-box;
              -webkit-line-clamp:2;
              -webkit-box-orient:vertical;
              overflow:hidden;
            ">
              ${esc((n.long || '').replace(/\s+/g,' ').trim())}
            </div>
          </button>
        `).join('')}
      </div>
    `;
    sv.querySelectorAll('[data-nid]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const nid = btn.getAttribute('data-nid');
        location.hash = `#/char/${c.id}/narrative/${nid}`;
      });
    });
  } else if(which==='epis'){
    sv.innerHTML = `
      <div class="kv-label">미니 에피소드</div>
      <div class="kv-card text-dim">조우/배틀에서 생성된 에피소드가 여기에 쌓일 예정이야.</div>
    `;
  } else if(which==='rel'){
    sv.innerHTML = `
      <div class="kv-label">관계</div>
      <div id="relList" class="col" style="gap:8px">불러오는 중...</div>
    `;
    
    const box = sv.querySelector('#relList');
    try {
      const q = fx.query(fx.collection(db, 'relations'), fx.where('pair', 'array-contains', c.id), fx.limit(50));
      const snapshot = await fx.getDocs(q);

      if (snapshot.empty) {
        box.innerHTML = `<div class="kv-card text-dim">아직 관계를 맺은 캐릭터가 없습니다.</div>`;
        return;
      }
      
      const rels = [];
      snapshot.forEach(doc => rels.push({ id: doc.id, ...doc.data() }));

      const detailedRelPromises = rels.map(async (r) => {
        // [수정] a_charRef 또는 b_charRef 필드가 없는 비정상 데이터를 건너뛰도록 방어 코드를 추가합니다.
        if (!r.a_charRef || !r.b_charRef) {
          console.warn('Skipping malformed relation document:', r);
          return null;
        }

        const otherCharId = r.a_charRef.endsWith(c.id) ? r.b_charRef.replace('chars/','') : r.a_charRef.replace('chars/','');
        
        const [otherCharSnap, noteSnap] = await Promise.all([
          fx.getDoc(fx.doc(db, 'chars', otherCharId)),
          fx.getDoc(fx.doc(db, 'relations', r.id, 'meta', 'note'))
        ]);
        
        return {
          ...r,
          otherChar: otherCharSnap.exists() ? { id: otherCharId, ...otherCharSnap.data() } : { id: otherCharId, name: '(알수없음)', thumb_url: '' },
          note: noteSnap.exists() ? noteSnap.data().note : '메모 없음'
        };
      });
      
      // [수정] Promise.all 이후 null 값을 제거하여 안전하게 렌더링합니다.
      const detailedRels = (await Promise.all(detailedRelPromises)).filter(Boolean);

      if (detailedRels.length === 0) {
        box.innerHTML = `<div class="kv-card text-dim">아직 관계를 맺은 캐릭터가 없습니다.</div>`;
        return;
      }

      box.innerHTML = detailedRels.map(r => {
        const isParty = auth.currentUser && (c.owner_uid === auth.currentUser.uid || r.otherChar.owner_uid === auth.currentUser.uid);
        
        return `
        <button class="kv-card" data-relation-id="${r.id}" style="text-align: left; width: 100%; cursor: pointer;">
          <div style="display:flex; justify-content:space-between; align-items:flex-start;">
            <div style="display:flex; align-items:center; gap: 10px;">
              <img src="${esc(r.otherChar.thumb_url)}" onerror="this.style.display='none'" style="width: 48px; height: 48px; border-radius: 8px; object-fit: cover; background: #111;">
              <div>
                <div style="font-weight:700;">🤝 ${esc(r.otherChar.name)}</div>
                <div class="text-dim" style="font-size:12px; margin-top: 4px;">클릭하여 상세보기</div>
              </div>
            </div>
            ${isParty ? `<button class="btn ghost small btn-delete-relation" data-del-id1="${c.id}" data-del-id2="${r.otherChar.id}">삭제</button>` : ''}
          </div>
        </button>
      `}).join('');

      box.addEventListener('click', (e) => {
        const deleteButton = e.target.closest('.btn-delete-relation');
        if (deleteButton) {
          e.stopPropagation();
          if (!confirm('정말로 이 관계를 삭제하시겠습니까?')) return;
          
          const id1 = deleteButton.dataset.delId1;
          const id2 = deleteButton.dataset.delId2;
          deleteRelation(id1, id2)
            .then(() => {
              showToast('관계를 삭제했습니다.');
              renderBioSub('rel', c, sv);
            })
            .catch(err => showToast(`삭제 실패: ${err.message}`));
          return;
        }

        const card = e.target.closest('button[data-relation-id]');
        if (card) {
          const relId = card.dataset.relationId;
          const relationData = detailedRels.find(r => r.id === relId);
          if (relationData) {
            showRelationDetailModal(c, relationData.otherChar, relationData);
          }
        }
      });
    } catch (e) {
      console.error('관계 로딩 실패:', e);
      box.innerHTML = `<div class="kv-card text-dim">관계를 불러오는 중 오류가 발생했습니다.</div>`;
    }
  }
}


// 아이템 장착 모달
async function openItemPicker(c, onSave) {
  const inv = await getUserInventory();
  ensureItemCss();

  let selectedIds = [...(c.items_equipped || [])];

  const back = document.createElement('div');
  back.className = 'modal-back';
  back.dataset.kind = 'item-picker';  // 상세 모달과 구분!

  back.style.zIndex = '10000';

  const renderModalContent = () => {
    back.innerHTML = `
      <div class="modal-card" style="background:#0e1116;border:1px solid #273247;border-radius:14px;padding:16px;max-width:800px;width:94vw;max-height:90vh;display:flex;flex-direction:column;">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-shrink:0;">
          <div style="font-weight:900; font-size: 18px;">아이템 장착 관리</div>
          <button class="btn ghost" id="mClose">닫기</button>
        </div>
        <div class="text-dim" style="font-size:13px; margin-top:4px;">아이템을 클릭하여 상세 정보를 보고, 다시 클릭하여 장착/해제하세요. (${selectedIds.length} / 3)</div>
        <div class="item-picker-grid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; overflow-y: auto; padding: 5px; margin: 12px 0; flex-grow: 1;">
          ${inv.length === 0 ? '<div class="text-dim" style="grid-column: 1 / -1;">보유한 아이템이 없습니다.</div>' :
            inv.map(item => {
              const style = rarityStyle(item.rarity);
              const isSelected = selectedIds.includes(item.id);
              return `
                  <div class="kv-card item-picker-card ${(item.rarity||'').toLowerCase()==='aether' ? 'rarity-aether' : ''} ${isSelected ? 'selected' : ''}" data-item-id="${item.id}" style="padding:10px; border: 2px solid ${isSelected ? '#4aa3ff' : 'transparent'}; cursor:pointer;">

                  <div style="font-weight:700; color: ${style.text}; pointer-events:none;">${esc(item.name)}</div>
                  <div style="font-size:12px; opacity:.8; margin-top: 4px; height: 3em; overflow:hidden; pointer-events:none;">${esc(item.desc_soft || item.desc || item.description || (item.desc_long ? String(item.desc_long).split('\n')[0] : '-') )}</div>
                </div>
              `;
            }).join('')
          }
        </div>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:auto;flex-shrink:0;padding-top:12px;">
          <button class="btn large" id="btnSaveItems">선택 완료</button>
        </div>
      </div>
    `;

// 아이템 장착 모달
    back.querySelectorAll('.item-picker-card').forEach(card => {
        card.addEventListener('click', () => {
            const itemId = card.dataset.itemId;
            const item = inv.find(it => it.id === itemId);
            if (!item) return;
            
            showItemDetailModal(item, {
                equippedIds: selectedIds,
                onUpdate: (newSelectedIds) => {
                    selectedIds = newSelectedIds;
                    renderModalContent(); // 부모 모달(피커) 새로고침
                }
            });
        });
    });

    back.querySelector('#mClose').onclick = () => back.remove();
    back.querySelector('#btnSaveItems').onclick = async () => {
      try {
        await updateItemsEquipped(c.id, selectedIds);
        showToast('아이템 장착 정보가 저장되었습니다.');
        c.items_equipped = selectedIds;
        onSave(selectedIds);  // 저장된 장착 목록을 콜백으로 넘겨줘
        back.remove();
      } catch (e) {
        showToast('아이템 저장에 실패했습니다: ' + e.message);
      }
    };
  };

  renderModalContent();
  document.body.appendChild(back);
  back.onclick = (e) => { if (e.target === back) back.remove(); };
}


// 스킬/아이템 탭
async function renderLoadout(c, view){
    ensureItemCss(); // aether 무지개 CSS를 로드아웃 진입 시 바로 주입
  const isOwner = auth.currentUser && auth.currentUser.uid === c.owner_uid;

  const abilitiesAll = Array.isArray(c.abilities_all) ? c.abilities_all : [];
  const equippedAb = Array.isArray(c.abilities_equipped)
    ? c.abilities_equipped.filter(i=>Number.isInteger(i)&&i>=0&&i<abilitiesAll.length).slice(0,2)
    : [];
  
  const equippedItemIds = Array.isArray(c.items_equipped)? c.items_equipped.slice(0,3): [];
  
  // [핵심 수정] 상대방 캐릭터일 경우, 상대방의 user 문서를 읽어와 인벤토리를 가져옵니다.
  let inv = [];
  if (isOwner) {
    inv = await getUserInventory();
  } else {
    try {
      const userDocRef = fx.doc(db, 'users', c.owner_uid);
      const userDocSnap = await fx.getDoc(userDocRef);
      inv = userDocSnap.exists() ? (userDocSnap.data().items_all || []) : [];
    } catch (e) {
      console.error("Failed to get opponent inventory:", e);
      inv = []; // 실패 시 빈 배열로 처리
    }
  }

  view.innerHTML = `
    <div class="p12">
      <h4>스킬 (4개 중 <b>${isOwner ? '반드시 2개 선택' : '목록'}</b>)</h4>
      ${abilitiesAll.length===0
        ? `<div class="kv-card text-dim">등록된 스킬이 없어.</div>`
        : `<div class="grid2 mt8">
            ${abilitiesAll.map((ab,i)=>`
              <label class="skill">
                <input type="checkbox" data-i="${i}" ${equippedAb.includes(i) ? 'checked' : ''} ${isOwner ? '' : 'disabled'}/>
                <div>
                  <div class="name">${ab?.name || ('스킬 ' + (i+1))}</div>
                  <div class="desc">${ab?.desc_soft || '-'}</div>
                </div>
              </label>`).join('')}
          </div>`}
    </div>
    <div class="p12">
      <h4 class="mt12">아이템 장착 (최대 3개)</h4>
      <div class="grid3 mt8" id="slots"></div>
      ${isOwner ? `<button id="btnEquip" class="btn mt8">인벤토리에서 선택/교체</button>` : ''}
    </div>
  `;

  if(isOwner && abilitiesAll.length>0){
    const boxes = Array.from(view.querySelectorAll('.skill input[type=checkbox]'));
    boxes.forEach(b=>{
      b.onchange = async ()=>{
        const on = boxes.filter(x=>x.checked).map(x=>+x.dataset.i);
        if(on.length>2){ b.checked = false; showToast('스킬은 딱 2개만!'); return; }
        if(on.length===2){
          try{ await updateAbilitiesEquipped(c.id, on); showToast('스킬 저장 완료'); }
          catch(e){ showToast('스킬 저장 실패: 로그인/권한을 확인해줘'); }
        }
      };
    });
  }

  const slotBox = view.querySelector('#slots');
  const renderSlots = ()=>{
    slotBox.innerHTML = [0,1,2].map(slotIndex => {
      const docId = equippedItemIds[slotIndex];
      if(!docId) return `<div class="slot">(비어 있음)</div>`;

      const it = inv.find(i => i.id === docId);
      if(!it) return `<div class="slot" style="color: #ff5b66;">(아이템 정보 없음)</div>`;

      const style = rarityStyle(it.rarity);
      const isAether = (it.rarity || '').toLowerCase() === 'aether';
      const borderStyle = isAether ? '' : `border-left: 3px solid ${style.border};`; // 에테르 등급은 CSS 클래스가 테두리를 처리하므로 인라인 스타일 제거

      return `
        <button class="kv-card item-card ${isAether ? 'rarity-aether' : ''}" data-item-id="${it.id}"
          style="text-align:left; cursor:pointer; ${borderStyle} ${isAether ? '' : `background:${style.bg};`}">

          <div class="name" style="color:${style.text}">${it.name || '아이템'}</div>
          <div class="desc" style="font-size:12px; opacity:0.8;">${esc(it.desc_soft || it.desc || it.description || (it.desc_long ? String(it.desc_long).split('\n')[0] : '-') )}</div>
        </button>`;
    }).join('');

    slotBox.querySelectorAll('.item[data-item-id]').forEach(btn => {
        btn.onclick = () => {
            const itemId = btn.dataset.itemId;
            const item = inv.find(i => i.id === itemId);
            if(item) {
                showItemDetailModal(item);
            }
        };
    });
  };
  renderSlots();

  if(isOwner){
    view.querySelector('#btnEquip')?.addEventListener('click', ()=>{
      openItemPicker(c, (newIds) => {
        if (Array.isArray(newIds)) {
    // 로컬 상태 반영
          c.items_equipped = [...newIds];
    // 이 함수 스코프 상단의 equippedItemIds 값을 동기화
          equippedItemIds.length = 0;
          equippedItemIds.push(...newIds);
    // 슬롯 UI만 다시 그림
          renderSlots();
          showToast('아이템 장착이 갱신됐어!');
        }
      });
    });
  }
}


// 표준 narratives → {id,title,long,short} 배열, 없으면 legacy narrative_items 변환
function normalizeNarratives(c){
  if (Array.isArray(c.narratives) && c.narratives.length){
    return c.narratives.map(n => ({
      id: n.id || ('n'+Math.random().toString(36).slice(2)),
      title: n.title || '서사',
      long: n.long || '',
      short: n.short || ''
    }));
  }
  if (Array.isArray(c.narrative_items) && c.narrative_items.length){
    return c.narrative_items.map((it, i) => ({
      id: 'legacy-'+i,
      title: it.title || '서사',
      long: it.body || '',
      short: ''
    }));
  }
  return [];
}

// 서사 전용 페이지: 제목 → long → short (short는 여기에서만 노출)
function renderNarrativePage(c, narrId){
  const root = document.getElementById('view');
  const list = normalizeNarratives(c);
  const n = list.find(x=>x.id===narrId) || list[0];
  if(!n){
    root.innerHTML = `<section class="container narrow"><div class="kv-card text-dim">해당 서사를 찾을 수 없어.</div></section>`;
    return;
  }

  root.innerHTML = `
  <section class="container narrow">
    <div class="book-card mt16">
      <div class="bookmarks">
        <button class="bookmark" onclick="location.hash='#/char/${c.id}'">← 캐릭터로 돌아가기</button>
      </div>
      <div class="bookview" id="nView">
        <div class="kv-card">
          <div style="font-weight:900; font-size:18px; margin-bottom:8px">${esc(n.title || '서사')}</div>
          <div id="nLong" style="margin-bottom:10px"></div>

          <div class="kv-label">요약</div>
          <div>${esc(n.short || '(요약이 아직 없어요)')}</div>
        </div>
      </div>
    </div>
  </section>`;

  const nLongNode = document.getElementById('nLong');
  if (nLongNode) nLongNode.innerHTML = renderRich(n.long || '-');

}

// --- 인라인 강조(**굵게**, *기울임*) 처리
function applyInlineMarks(html){
  html = html.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  html = html.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, function(_, pre, inner){
    return pre + '<i>' + inner + '</i>';
  });
  return html;
}

// --- 간단 마크업(#, ##, ###, >, * ) + 줄바꿈(\n, \n\n) 렌더링
function renderRich(text){
  var s = String(text||'').replace(/\r\n?/g,'\n');
  var lines = s.split('\n');
  var out = [];
  var inList = false;

  function flushList(){ if(inList){ out.push('</ul>'); inList=false; } }

  for(var i=0;i<lines.length;i++){
    var raw = lines[i];
    var empty = /^\s*$/.test(raw);
    var escd  = esc(raw);

    if(empty){ flushList(); continue; }

    if(/^###\s+/.test(raw)){ flushList(); out.push('<h4 style="font-weight:800;font-size:15px;margin:10px 0 4px;">'+ escd.replace(/^###\s+/, '') +'</h4>'); continue; }
    if(/^##\s+/.test(raw)){  flushList(); out.push('<h3 style="font-weight:850;font-size:16px;margin:12px 0 6px;">'+ escd.replace(/^##\s+/, '') +'</h3>'); continue; }
    if(/^#\s+/.test(raw)){   flushList(); out.push('<h2 style="font-weight:900;font-size:18px;margin:14px 0 8px;">'+ escd.replace(/^#\s+/, '') +'</h2>'); continue; }

    if(/^>\s+/.test(raw)){
      flushList();
      var q = applyInlineMarks(escd.replace(/^>\s+/, ''));
      out.push('<blockquote style="margin:8px 0;padding:8px 10px;border-left:3px solid rgba(122,155,255,.7);background:rgba(122,155,255,.06);border-radius:8px;">'+ q +'</blockquote>');
      continue;
    }

    if(/^\*\s+/.test(raw)){
      if(!inList){ out.push('<ul style="margin:6px 0 8px 18px;list-style:disc;">'); inList=true; }
      var li = applyInlineMarks(escd.replace(/^\*\s+/, ''));
      out.push('<li>'+ li +'</li>');
      continue;
    }

    flushList();
    out.push('<p style="margin:6px 0 6px;">'+ applyInlineMarks(escd) +'</p>');
  }
  flushList();
  return out.join('');
}


function renderHistory(c, view){
  view.innerHTML = `
    <div class="p12">
      <h4>전적</h4>
      <div class="grid3 mt8">
        <button class="kv-card" id="cardBattle" style="text-align:left;cursor:pointer">
          <div class="kv-label">배틀</div><div>${c.battle_count||0}</div>
          <div class="text-dim" style="font-size:12px;margin-top:4px">클릭하면 아래에 타임라인이 나와</div>
        </button>
        <button class="kv-card" id="cardEncounter" style="text-align:left;cursor:pointer">
          <div class="kv-label">조우</div><div>${c.encounter_count||0}</div>
          <div class="text-dim" style="font-size:12px;margin-top:4px">클릭하면 아래에 타임라인이 나와</div>
        </button>
        <button class="kv-card" id="cardExplore" style="text-align:left;cursor:pointer">
          <div class="kv-label">탐험</div><div>${c.explore_count||0}</div>
          <div class="text-dim" style="font-size:12px;margin-top:4px">클릭하면 아래에 타임라인이 나와</div>
        </button>
      </div>

      <div class="kv-card mt12">
        <div class="kv-label" id="tlTitle">상세 타임라인</div>
        <div id="timelineBox" class="col" style="gap:8px"></div>
        <div id="tlSentinel" style="height:1px"></div>
        <div id="tlEmpty" class="text-dim" style="margin-top:8px">상세 타임라인은 추후 추가될 예정이야.</div>
      </div>
    </div>
  `;

  const box   = view.querySelector('#timelineBox');
  const sent  = view.querySelector('#tlSentinel');
  const empty = view.querySelector('#tlEmpty');
  const setTitle = (m)=> view.querySelector('#tlTitle').textContent =
    (m==='battle'?'배틀 타임라인': m==='encounter'?'조우 타임라인':'탐험 타임라인');

  let mode = null;
  let busy = false;
  let done = false;

  let lastA=null, lastD=null, doneA=false, doneD=false;
  let lastE=null, doneE=false;

  const t = (ts)=> {
    try{
      if(!ts) return '';
      if (typeof ts.toDate === 'function') return ts.toDate(); // Firestore Timestamp 객체 처리
      if (typeof ts.toMillis === 'function') return new Date(ts.toMillis());
      if (typeof ts === 'number') return new Date(ts);
      return new Date(ts);
    }catch{ return new Date(); }
  };

  // /public/js/tabs/char.js
// ❗️ 이 함수 전체를 복사하여 기존 appendItems 함수를 덮어쓰세요.
function appendItems(items){
    if(items.length) empty.style.display = 'none';
    const frag = document.createDocumentFragment();
    items.forEach(it=>{
      let go = '#';
      let html = '';
      if(mode==='battle'){
        const isAttacker = it.attacker_char === `chars/${c.id}`;
        const opponentSnapshot = isAttacker ? it.defender_snapshot : it.attacker_snapshot;
        const myExp = isAttacker ? it.exp_char0 : it.exp_char1;

        let resultText, resultColor;
        if ((isAttacker && it.winner === 0) || (!isAttacker && it.winner === 1)) {
            resultText = '승리'; resultColor = '#3a8bff';
        } else if ((isAttacker && it.winner === 1) || (!isAttacker && it.winner === 0)) {
            resultText = '패배'; resultColor = '#ff425a';
        } else {
            resultText = '무승부'; resultColor = '#777';
        }
        
        const when = t(it.endedAt).toLocaleString();
        go = `#/battlelog/${it.id}`;
        html = `
          <div class="kv-card tl-go" data-go="${go}" style="border-left:3px solid ${resultColor}; padding: 10px; display: flex; align-items: center; gap: 12px;">
            <div style="flex-shrink: 0;">
                <img src="${esc(opponentSnapshot.thumb_url || '')}" onerror="this.style.display='none'" style="width: 48px; height: 48px; border-radius: 50%; object-fit: cover;">
            </div>
            <div style="flex-grow: 1; min-width: 0;">
                <div style="display: flex; align-items: center; gap: 8px;">
                    <strong style="color: ${resultColor}; font-size: 16px;">${resultText}</strong>
                    <span style="font-weight: 700;">vs ${esc(opponentSnapshot.name)}</span>
                </div>
                <div class="text-dim" style="font-size: 12px; margin-top: 4px;">
                    <span>${when}</span>
                    <span style="margin-left: 12px;">획득 EXP: <strong>+${esc(myExp)}</strong></span>
                </div>
            </div>
          </div>`;
      } else if(mode==='encounter'){
        // [수정] 올바른 조우 기록 템플릿
        const isA = it.a_char === `chars/${c.id}`;
        const opponentSnapshot = isA ? it.b_snapshot : it.a_snapshot;
        const myExp = isA ? it.exp_a : it.exp_b;
        const when = t(it.endedAt).toLocaleString();
        go = `#/encounter-log/${it.id}`;
        html = `
          <div class="kv-card tl-go" data-go="${go}" style="border-left:3px solid #a3e635; padding: 10px; display: flex; align-items: center; gap: 12px;">
            <div style="flex-shrink: 0;">
                <img src="${esc(opponentSnapshot.thumb_url || '')}" onerror="this.style.display='none'" style="width: 48px; height: 48px; border-radius: 50%; object-fit: cover;">
            </div>
            <div style="flex-grow: 1; min-width: 0;">
                <div style="display: flex; align-items: center; gap: 8px;">
                    <strong style="color: #a3e635; font-size: 16px;">조우</strong>
                    <span style="font-weight: 700;">with ${esc(opponentSnapshot.name)}</span>
                </div>
                <div class="text-dim" style="font-size: 12px; margin-top: 4px;">
                    <span>${when}</span>
                    <span style="margin-left: 12px;">획득 EXP: <strong>+${esc(myExp)}</strong></span>
                </div>
            </div>
          </div>`;
      } else { // 'explore'
        const when = t(it.endedAt || it.startedAt).toLocaleString();
        go = `#/explorelog/${it.id}`;
        html = `
          <div class="kv-card tl-go" data-go="${go}" 
               style="display:flex;align-items:center;gap:12px;padding:10px;border-left:3px solid #4aa3ff">
            <div style="flex:1;min-width:0">
              <div style="font-weight:800">
                ${esc(it.world_name || it.world_id || '월드')} / ${esc(it.site_name || it.site_id || '지역')}
              </div>
              <div class="text-dim" style="font-size:12px">${when}</div>
            </div>
            <div class="text-dim" style="font-size:12px">턴 ${esc(it.turn || 0)}</div>
          </div>`;
      }
      const wrap = document.createElement('div');
      wrap.innerHTML = html;
      const el = wrap.firstElementChild;
      el.addEventListener('click', ()=>{ location.hash = el.getAttribute('data-go'); });
      frag.appendChild(el);
    });
    box.appendChild(frag);
}

async function fetchNext(){
    if(busy || done || !mode) return;
    busy = true;
    const out = [];
    try{
      const charRef = `chars/${c.id}`;

      if(mode==='battle'){
        if(!doneA){
          const partsA = [ fx.where('attacker_char','==', charRef), fx.orderBy('endedAt','desc') ];
          if(lastA) partsA.push(startAfter(lastA));
          partsA.push(fx.limit(15));
          const qA = fx.query(fx.collection(db,'battle_logs'), ...partsA);
          // [수정] fx.getDocs -> getDocsFromServer: 항상 서버에서 최신 목록을 가져옵니다.
          const sA = await getDocsFromServer(qA);
          const arrA=[]; sA.forEach(d=>arrA.push({ id:d.id, ...d.data() }));
          if(arrA.length < 15) doneA = true;
          if(sA.docs.length) lastA = sA.docs[sA.docs.length-1];
          out.push(...arrA);
        }
        if(!doneD){
          const partsD = [ fx.where('defender_char','==', charRef), fx.orderBy('endedAt','desc') ];
          if(lastD) partsD.push(startAfter(lastD));
          partsD.push(fx.limit(15));
          const qD = fx.query(fx.collection(db,'battle_logs'), ...partsD);
          // [수정] fx.getDocs -> getDocsFromServer: 항상 서버에서 최신 목록을 가져옵니다.
          const sD = await getDocsFromServer(qD);
          const arrD=[]; sD.forEach(d=>arrD.push({ id:d.id, ...d.data() }));
          if(arrD.length < 15) doneD = true;
          if(sD.docs.length) lastD = sD.docs[sD.docs.length-1];
          out.push(...arrD);
        }
        out.sort((a,b)=>((b.endedAt?.toMillis?.()??0)-(a.endedAt?.toMillis?.()??0)));
        if(doneA && doneD && out.length===0) done = true;
      }
      else if(mode==='encounter'){ // <-- [수정] 기존 encounter 로직을 그대로 사용합니다.
        if(!doneA){
          const partsA = [ fx.where('a_char','==', charRef), fx.orderBy('endedAt','desc') ];
          if(lastA) partsA.push(startAfter(lastA));
          partsA.push(fx.limit(15));
          const qA = fx.query(fx.collection(db,'encounter_logs'), ...partsA);
          const sA = await getDocsFromServer(qA);
          const arrA=[]; sA.forEach(d=>arrA.push({ id:d.id, ...d.data() }));
          if(arrA.length < 15) doneA = true;
          if(sA.docs.length) lastA = sA.docs[sA.docs.length-1];
          out.push(...arrA);
        }
        if(!doneD){
          const partsB = [ fx.where('b_char','==', charRef), fx.orderBy('endedAt','desc') ];
          if(lastD) partsB.push(startAfter(lastD));
          partsB.push(fx.limit(15));
          const qB = fx.query(fx.collection(db,'encounter_logs'), ...partsB);
          const sB = await getDocsFromServer(qB);
          const arrB=[]; sB.forEach(d=>arrB.push({ id:d.id, ...d.data() }));
          if(arrB.length < 15) doneD = true;
          if(sB.docs.length) lastD = sB.docs[sB.docs.length-1];
          out.push(...arrB);
        }
        out.sort((a,b)=>((b.endedAt?.toMillis?.()??0)-(a.endedAt?.toMillis?.()??0)));
        if(doneA && doneD && out.length===0) done = true;
      }
      else if(mode==='explore'){
        if(!doneE){
          const parts = [ fx.orderBy('endedAt','desc') ];
          if(lastE) parts.push(startAfter(lastE));
          parts.push(fx.limit(15));
          const q = fx.query(
            fx.collection(db,'explore_runs'),
            fx.where('charRef','==', `chars/${c.id}`),
            ...parts
          );
          // [수정] fx.getDocs -> getDocsFromServer: 항상 서버에서 최신 목록을 가져옵니다.
          const s = await getDocsFromServer(q);
          const arr=[]; s.forEach(d=>arr.push({ id:d.id, ...d.data() }));
          if(arr.length < 15) doneE = true;
          if(s.docs.length) lastE = s.docs[s.docs.length-1];
          out.push(...arr);
          if(doneE && out.length===0) done = true;
        } else {
          done = true;
        }
      }

      appendItems(out);
    }catch(e){
      console.error('[timeline] fetch error', e);
    }finally{
      busy = false;
    }
  }

  function resetAndLoad(newMode){
    mode = newMode;
    setTitle(mode);
    box.innerHTML = '';
    empty.style.display = 'block'; // [수정] empty의 display를 block으로 초기화
    busy = false; done = false;
    lastA = lastD = lastE = null;
    doneA = doneD = doneE = false;
    fetchNext();
  }

  const io = new IntersectionObserver((entries)=>{
    entries.forEach((en)=>{
      if(en.isIntersecting) fetchNext();
    });
  }, { root: null, rootMargin: '600px 0px', threshold: 0 });
  io.observe(sent);

  view.querySelector('#cardBattle')?.addEventListener('click', ()=> resetAndLoad('battle'));
  view.querySelector('#cardEncounter')?.addEventListener('click', ()=> resetAndLoad('encounter'));
  view.querySelector('#cardExplore')?.addEventListener('click', ()=> resetAndLoad('explore'));
}


function closeMatchOverlay(){
  document.querySelector('.modal-wrap')?.remove();
}

function setMatchIntentAndGo(charId, mode){
  const payload = { charId, mode, ts: Date.now() };
  sessionStorage.setItem('toh.match.intent', JSON.stringify(payload));
  location.hash = mode === 'battle' ? '#/battle' : '#/encounter';
}


function showRelationDetailModal(myChar, otherChar, relation) {
  ensureModalCss(); // 모달 CSS가 없으면 주입 (adventure.js 등에서 가져옴)

  const modal = document.createElement('div');
  modal.className = 'modal-back';
  modal.style.zIndex = '10001';
  modal.innerHTML = `
    <div class="modal-card" style="max-width: 600px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 16px;">
        <div style="font-weight: 900; font-size: 18px;">관계 상세</div>
        <button class="btn ghost" id="mClose">닫기</button>
      </div>
      
      <div style="display: flex; justify-content: space-around; align-items: center; gap: 12px; margin-bottom: 16px;">
        <a href="#/char/${myChar.id}" style="text-decoration: none; color: inherit; text-align: center;">
          <img src="${esc(myChar.thumb_url)}" onerror="this.style.display='none'" style="width: 80px; height: 80px; border-radius: 50%; object-fit: cover; border: 2px solid #4aa3ff;">
          <div style="font-weight: 700; margin-top: 6px;">${esc(myChar.name)}</div>
        </a>
        <div style="font-size: 24px; color: #777;">🤝</div>
        <a href="#/char/${otherChar.id}" style="text-decoration: none; color: inherit; text-align: center;">
          <img src="${esc(otherChar.thumb_url)}" onerror="this.style.display='none'" style="width: 80px; height: 80px; border-radius: 50%; object-fit: cover; border: 2px solid #ccc;">
           <div style="font-weight: 700; margin-top: 6px;">${esc(otherChar.name)}</div>
        </a>
      </div>

      <div class="kv-card" style="padding: 12px;">
        <div class="kv-label">AI가 분석한 관계</div>
        <p style="white-space: pre-wrap; line-height: 1.6;">${esc(relation.note)}</p>
      </div>

      ${relation.lastBattleLogId ? `
        <a href="#/battlelog/${relation.lastBattleLogId}" class="btn" style="text-decoration: none; margin-top: 12px; text-align: center;">
          관계가 갱신된 배틀로그 보기
        </a>
      ` : ''}
    </div>
  `;

  const closeModal = () => modal.remove();
  modal.addEventListener('click', e => { if(e.target === modal) closeModal(); });
  modal.querySelector('#mClose').onclick = closeModal;
  
  // 모달 내 캐릭터 링크 클릭 시 모달이 닫히도록 설정
  modal.querySelectorAll('a').forEach(a => {
    a.addEventListener('click', closeModal);
  });

  document.body.appendChild(modal);
}


// 라우터 호환
export default showCharDetail;


