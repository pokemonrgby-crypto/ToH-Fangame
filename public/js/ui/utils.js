// /public/js/ui/utils.js
export function esc(s){
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

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
    alpha: { 
      bg: 'linear-gradient(145deg, #1d2b64 0%, #000000 74%)', 
      border: '#7dd3fc', 
      text: '#ffffff', 
      label: '알파' 
    },
    omega: { 
      bg: 'radial-gradient(ellipse at bottom, #1b2735 0%, #090a0f 100%)', 
      border: 'linear-gradient(160deg, #FFFFFF 0%, #F0F0F0 50%, #E0E0E0 100%)', 
      text: '#000000',
      label: '오메가' 
    },
  };
  return map[(r || '').toLowerCase()] || map.normal;
}

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

export function ensureItemCss() {
  if (document.getElementById('toh-item-css')) return;
  const st = document.createElement('style');
  st.id = 'toh-item-css';
  st.textContent = `
  .shine-effect { position: relative; overflow: hidden; }
  .shine-effect::after { content: ''; position: absolute; top: -50%; left: -50%; width: 200%; height: 200%; background: linear-gradient(to right, rgba(255,255,255,0) 0%, rgba(255,255,255,0.3) 50%, rgba(255,255,255,0) 100%); transform: rotate(30deg); animation: shine 3s infinite ease-in-out; pointer-events: none; }
  @keyframes shine { 0% { transform: translateX(-75%) translateY(-25%) rotate(30deg); } 100% { transform: translateX(75%) translateY(25%) rotate(30deg); } }
  .item-card { transition: box-shadow .18s ease, transform .18s ease, filter .18s ease; will-change: transform, box-shadow; outline: none; }
  .kv-card.item-card{ border:1px solid #273247; border-radius:12px; background:rgba(255,255,255,.03); padding:10px; }
  .kv-card.rarity-aether, .item.rarity-aether { position: relative; overflow: hidden; border: 1px solid #fff; }
  .kv-card.rarity-aether::before, .item.rarity-aether::before { content: ''; position: absolute; inset: 0; background: linear-gradient(120deg, #ff375f, #ff9f0a, #ffd60a, #34c759, #00c7be, #0a84ff, #5e5ce6, #ff2d55, #ff375f); background-size: 300% 300%; filter: saturate(120%); animation: aetherFlow 8s linear infinite; z-index: 0; }
  .kv-card.rarity-aether::after, .item.rarity-aether::after { content: ''; position: absolute; inset: 0; background: rgba(15,16,20,.65); z-index: 1; }
  .kv-card.rarity-aether > *, .item.rarity-aether > * { position: relative; z-index: 2; }
  @keyframes aetherFlow { 0% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } 100% { background-position: 0% 50%; } }
  @media (prefers-reduced-motion: reduce){ .kv-card.rarity-aether::before, .item.rarity-aether::before { animation: none; } }
  .item-card:hover, .item-card:focus-visible { transform: translateY(-2px); box-shadow: 0 6px 18px rgba(0,0,0,.35); filter: brightness(1.05); }`;
  document.head.appendChild(st);
}


// [추가] 시간 포맷 함수
export function prettyTime(ts){
  function fmt(ms){
    if (!ms) return '-';
    const d = new Date(ms);
    const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), dd = String(d.getDate()).padStart(2,'0');
    const hh = String(d.getHours()).padStart(2,'0'), mm = String(d.getMinutes()).padStart(2,'0');
    return `${y}-${m}-${dd} ${hh}:${mm}`;
  }
  if (!ts) return '-';
  if (typeof ts === 'number') return fmt(ts);
  if (typeof ts === 'string') return fmt(Number(ts)); // 혹시 문자열 타임스탬프면 숫자로
  if (typeof ts?.toMillis === 'function') return fmt(ts.toMillis());
  const sec = (ts?._seconds ?? ts?.seconds);
  const nano = (ts?._nanoseconds ?? ts?.nanoseconds ?? 0);
  if (sec != null) return fmt(sec * 1000 + Math.floor(nano/1e6));
  return '-';
}

