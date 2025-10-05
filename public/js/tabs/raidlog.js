// public/js/tabs/raidlog.js
import { db } from '../api/firebase.js';
import { showToast } from '../ui/toast.js';

/* ------------------------------
 * 유틸
 * ------------------------------ */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function parseLogId() {
  const m = location.hash.match(/^#\/raidlog\/([^/]+)$/);
  return m ? m[1] : null;
}
const rarityColors = {
  normal: '#c8d0dc', rare: '#cfe4ff', epic: '#e6dcff',
  legend: '#ffe9ad', myth: '#ffc9ce', aether: '#d6fff7'
};

/* ------------------------------
 * 토큰 → 리치텍스트 변환
 * ------------------------------ */
function renderRichLog(logText = '', party = []) {
  if (typeof logText !== 'string') logText = String(logText ?? '');
  // 1) 제목 추출 (첫 줄)
  const lines = logText.split('\n');
  let titleLine = (lines[0] || '').trim();
  // "[AI가 생성한 제목]" 또는 "배틀로그: 타이틀" 둘 다 지원
  if (titleLine.startsWith('배틀로그:')) titleLine = titleLine.replace(/^배틀로그:\s*/, '');
  titleLine = titleLine.replace(/^\[(.*)\]$/, '$1').trim();
  const body = lines.slice(1).join('\n');

  // 2) 본문 HTML로 파싱
  let html = esc(body);

  // --- 장면 전환 ---
  html = html.replace(/\[CUT\]/g, '<div class="cut-scene" aria-hidden="true"></div>');

  // --- SLOW ~ RESUME(구간 감싸기) ---
  html = html.replace(/\[SLOW\]([\s\S]*?)\[RESUME\]/g, (m, c) => `<span class="slow-motion">${esc(c)}</span>`);

  // --- SFX/VFX/HUD ---
  html = html.replace(/\[SFX\]([\s\S]*?)\[\/SFX\]/g, (m, c) => `<span class="sfx">${esc(c)}</span>`);
  html = html.replace(/\[VFX\]([\s\S]*?)\[\/VFX\]/g, (m, c) => `<span class="vfx">${esc(c)}</span>`);
  html = html.replace(/\[HUD\]([\s\S]*?)\[\/HUD\]/g, (m, c) => `<span class="hud">${esc(c)}</span>`);

  // --- 타임스탬프/심박/호흡 ---
  html = html.replace(/\[T\+(.*?)\]/g, (m, c) => `<span class="timestamp">${esc(c)}</span>`);
  html = html.replace(/\[HEART x (.*?)\]/g, (m, c) => `<span class="heart">${esc(c)} BPM</span>`);
  // [BREATH:상태] → 마커 엘리먼트 (단락 왼쪽 숨쉬는 보더 트리거)
  html = html.replace(/\[BREATH:([^\]]+)\]/g, (m, st) => `<i class="breath" data-state="${esc(st)}"></i>`);

  // --- 능력 **굵게** ---
  html = html.replace(/(?:`|'|")?\*\*([\s\S]*?)\*\*(?:`|'|")?/g, '<strong>$1</strong>');

  // --- 아이템 ---
  html = html.replace(/\[ITEM:(normal|rare|epic|legend|myth|aether)\]([\s\S]*?)\[\/ITEM\]/g, (m, r, n) => {
    const color = rarityColors[r.toLowerCase()] || '#ffffff';
    return `<strong class="item-highlight" data-rarity="${r}" style="color:${color}; text-shadow:0 0 6px ${color}80;">${esc(n)}</strong>`;
  });

  // --- 대사: [대화:이름]"대사" ---
  html = html.replace(/\[대화:([^\]]+)\]"([^"]*)"/g, (m, name, line) => {
    return `<span class="dlg"><span class="name-chip">${esc(name)}</span><span class="line">"${esc(line)}"</span></span>`;
  });

  // 3) 두 줄 개행 → 단락 카드 / 한 줄 개행 → <br>
  const paras = html.split(/\n{2,}/).map(s => `<div class="para">${s.replace(/\n/g, '<br>')}</div>`).join('');

  // 4) 최종 템플릿
  return {
    title: titleLine || '레이드 전투 기록',
    body: paras
  };
}

/* ------------------------------
 * 메인 렌더
 * ------------------------------ */
export default async function mountRaidLogTab(root) {
  const logId = parseLogId();
  if (!logId) {
    showToast('로그 ID가 없어요.');
    root.innerHTML = `<section class="container"><p>유효하지 않은 경로입니다.</p></section>`;
    return;
  }

  // 데이터 로드
  const snap = await db.collection('raid_logs').doc(logId).get();
  if (!snap.exists) {
    showToast('전투 로그를 찾을 수 없어요.');
    root.innerHTML = `<section class="container"><p>전투 로그가 존재하지 않습니다.</p></section>`;
    return;
  }
  const log = snap.data() || {};
  const content = String(log.log ?? '');
  const raidName = String(log.raidName ?? '');
  const totalDamage = Number(log.totalDamage ?? 0);
  const contributions = Array.isArray(log.contributions) ? log.contributions : [];
  const party = Array.isArray(log.party) ? log.party : [];

  const { title, body } = renderRichLog(content, party);

  // 파티 기여도 매핑
  const contribMap = new Map(contributions.map(c => [c.charId, c]));
  const partyCards = party.map((c, idx) => {
    const cc = contribMap.get(c.id) || { contribution: 0, exp: 0 };
    const pct = totalDamage > 0 ? Math.round((cc.contribution / totalDamage) * 100) : 0;
    return `
      <div class="contrib-card">
        <img class="contrib-avatar" src="${esc(c.thumb_url || '')}" onerror="this.style.display='none'">
        <div class="contrib-info">
          <div class="contrib-name">${esc(c.name || `멤버${idx+1}`)}</div>
          <div class="contrib-bars">
            <div class="bar"><span style="width:${Math.min(100, pct)}%"></span></div>
          </div>
          <div class="contrib-meta">
            기여도 ${cc.contribution} • EXP ${cc.exp}
          </div>
        </div>
      </div>
    `;
  }).join('');

  // UI 렌더
  root.innerHTML = `
    <style>
      :root{
        --bg-0:#0e1116; --bg-1:#121624; --bg-2:#151b2a;
        --glass:rgba(255,255,255,0.06); --line:#2a2f36; --muted:#94a3b8;
        --fx-primary:#8ec5ff; --fx-accent:#a98bff; --fx-warm:#ffd166; --fx-pink:#ffb3db; --fx-aether:#d6fff7;
      }
      .container{max-width:960px;margin:0 auto;padding:20px}
      .header{display:flex;align-items:center;gap:12px;justify-content:space-between}
      .title{font-size:22px;font-weight:800;letter-spacing:.3px}
      .subtitle{font-size:13px;color:var(--muted)}

      .meta{margin-top:8px;display:flex;gap:12px;flex-wrap:wrap}
      .chip{font-size:12px;padding:6px 10px;border-radius:999px;background:linear-gradient(180deg, rgba(255,255,255,.08), rgba(255,255,255,.04));border:1px solid rgba(255,255,255,.08)}

      .contribution-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-top:12px}
      @media (max-width:560px){.contribution-grid{grid-template-columns:1fr}}
      .contrib-card{display:flex;gap:12px;background:var(--bg-2);padding:12px;border-radius:14px;border:1px solid #202635;box-shadow:0 8px 20px rgba(0,0,0,.2)}
      .contrib-avatar{width:52px;height:52px;border-radius:50%;object-fit:cover;background:#0e1116;flex-shrink:0}
      .contrib-info{flex:1;min-width:0}
      .contrib-name{font-weight:700;margin-bottom:6px}
      .contrib-bars .bar{height:7px;background:#0f1320;border-radius:7px;overflow:hidden;border:1px solid #263046}
      .contrib-bars .bar span{display:block;height:100%;background:linear-gradient(90deg, #79c9ff, #a58aff);box-shadow:0 0 10px rgba(142,197,255,.4) inset}
      .contrib-meta{margin-top:6px;font-size:12px;color:var(--muted)}

      .panel{margin-top:18px;padding:16px;border-radius:16px;background:
         radial-gradient(1200px 600px at 80% -20%, rgba(142,197,255,.10), transparent),
         radial-gradient(1000px 400px at 0% 0%, rgba(169,139,255,.10), transparent),
         linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,.02));
         border:1px solid rgba(255,255,255,.06);}

      /* ===== 리치 로그 ===== */
      .log-content{position:relative}
      .rt-controls{display:flex;justify-content:center;gap:12px;margin:6px 0 2px 0}

      .log-content .para{
        position:relative;margin:14px 0;padding:16px;border-radius:14px;
        background:linear-gradient(180deg, rgba(255,255,255,.035), rgba(255,255,255,.02));
        border:1px solid rgba(255,255,255,.06);
        box-shadow:0 6px 18px rgba(0,0,0,.20), inset 0 1px 0 rgba(255,255,255,.04);
        transition:transform .15s ease, box-shadow .15s ease;
      }
      .log-content .para:hover{transform:translateY(-1px);box-shadow:0 10px 26px rgba(0,0,0,.28), inset 0 1px 0 rgba(255,255,255,.05)}
      .log-content .para:last-child{margin-bottom:6px}

      /* 토큰 공통 */
      .sfx,.vfx,.hud,.timestamp,.heart,.breath{display:inline;font-size:.95em}
      .timestamp,.heart{font-family:'SF Mono','Roboto Mono',Menlo,monospace;color:#9ca3af}
      .timestamp::before{content:'T+';opacity:.7;margin-right:2px}

      /* SFX: 긴박한 효과음 */
      .sfx{font-weight:800;letter-spacing:.4px;display:inline-block;position:relative}
      .sfx{animation:sfx-thump .7s ease-out 1, sfx-shake .4s ease-in-out 1}
      @keyframes sfx-thump {0%{transform:scale(1);text-shadow:none}
        15%{transform:scale(1.06);text-shadow:0 0 18px rgba(255,255,255,.25), 0 0 32px rgba(142,197,255,.35)}
        100%{transform:scale(1);text-shadow:none}}
      @keyframes sfx-shake {0%,100%{transform:translateX(0)}25%{transform:translateX(-2px)}50%{transform:translateX(2px)}75%{transform:translateX(-1px)}}

      /* VFX: 네온 숨쉬기 */
      .vfx{font-weight:700;color:var(--fx-primary);text-shadow:0 0 10px rgba(142,197,255,.55),0 0 18px rgba(169,139,255,.35)}
      .vfx{animation:vfx-breathe 2.5s ease-in-out infinite}
      @keyframes vfx-breathe {0%,100%{filter:saturate(100%)}50%{filter:saturate(130%)}}

      /* HUD: 글라스 패널 */
      .hud{font-family:'SF Mono','Roboto Mono',Menlo,monospace;font-weight:700;color:#bdf7e6;
        background:linear-gradient(180deg, rgba(14,180,140,.18), rgba(14,180,140,.10));
        border:1px solid rgba(14,180,140,.35); padding:2px 7px;border-radius:7px;
        box-shadow:inset 0 1px 0 rgba(255,255,255,.15), 0 4px 14px rgba(14,180,140,.12)}
      .hud::before{content:'●';font-size:.6em;margin-right:6px;vertical-align:middle;opacity:.9}

      /* CUT: 글리치 라인 */
      .cut-scene{position:relative;text-align:center;margin:1.6em 0;height:1px;background:
        linear-gradient(90deg,transparent,rgba(255,255,255,.22),transparent)}
      .cut-scene::after{content:'';position:absolute;left:0;top:-1px;right:0;height:3px;
        background:linear-gradient(90deg,transparent,rgba(169,139,255,.55),transparent);
        animation:cut-glitch 900ms ease 1}
      @keyframes cut-glitch {0%{opacity:0;transform:translateX(-10%)}30%{opacity:1}100%{opacity:0;transform:translateX(10%)}}

      /* SLOW 모션 */
      .slow-motion{display:inline-block;filter:saturate(.85) contrast(.98) blur(.2px)}
      .slow-motion{animation:slowPulse 2.2s ease-in-out infinite}
      @keyframes slowPulse {0%,100%{opacity:1}50%{opacity:.85}}

      /* BREATH: 단락 왼쪽 숨쉬는 세로줄 */
      .para:has(.breath){border-image:linear-gradient(180deg, var(--fx-accent), transparent) 1}
      .breath{position:relative;padding:0 2px;color:#b9d3ff}
      .breath::before{content:'';position:absolute;left:-12px;top:-2px;bottom:-2px;width:2px;
        background:linear-gradient(180deg, rgba(169,139,255,.9), transparent);
        animation:breathe 2.8s ease-in-out infinite}
      @keyframes breathe {0%,100%{opacity:.35}50%{opacity:.8}}

      /* ITEM: 등급 하이라이트 */
      .item-highlight{font-weight:800;padding:0 .2em;border-radius:6px;background:linear-gradient(90deg, rgba(255,255,255,.09), rgba(255,255,255,.03));}

      /* 대사: 이름 칩 + 텍스트 */
      .dlg{display:inline-flex;align-items:center;gap:8px;padding:6px 10px;border-radius:10px;background:linear-gradient(180deg, rgba(255,255,255,.05), rgba(255,255,255,.03));border:1px solid rgba(255,255,255,.06)}
      .dlg .name-chip{font-weight:800;font-size:.9em;padding:2px 8px;border-radius:999px;background:linear-gradient(180deg, rgba(169,139,255,.25), rgba(169,139,255,.12));border:1px solid rgba(169,139,255,.45)}
      .dlg .line{font-weight:600}

      /* 효과 줄이기 */
      .log-content[data-reduced-motion="1"] *{animation:none!important;transition:none!important;filter:none!important;text-shadow:none!important}
    </style>

    <section class="container">
      <div class="header">
        <div>
          <div class="title">${esc(title)}</div>
          <div class="subtitle">${raidName ? esc(raidName) + ' · ' : ''}총 피해 ${totalDamage}</div>
        </div>
        <div class="meta">
          <span class="chip">파티 ${party.length}명</span>
          <span class="chip">기록 ID: ${esc(logId)}</span>
        </div>
      </div>

      <div class="panel">
        <h3 class="subtitle" style="font-size:14px">파티 기여도</h3>
        <div class="contribution-grid">${partyCards || '<div class="subtitle">파티 정보가 없습니다.</div>'}</div>
      </div>

      <div class="panel">
        <div class="rt-controls">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
            <input type="checkbox" id="rtReduceFx" style="accent-color:#7dd3fc">
            <span style="font-size:12px;color:var(--muted)">효과 줄이기</span>
          </label>
        </div>
        <h3 class="subtitle" style="font-size:14px">전투 기록</h3>
        <div class="log-content mt12" style="white-space:normal; line-height:1.7;">
          ${body}
        </div>
      </div>
    </section>
  `;

  // 접근성: 사용자 선호 반영 & 토글 연결
  const container = root.querySelector('.log-content');
  const reduceFx = root.querySelector('#rtReduceFx');
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    container.dataset.reducedMotion = '1';
    if (reduceFx) reduceFx.checked = true;
  }
  reduceFx?.addEventListener('change', () => {
    container.dataset.reducedMotion = reduceFx.checked ? '1' : '0';
  });
}
