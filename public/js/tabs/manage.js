// /public/js/tabs/manage.js
// 관리자 도구: [메일 발송] / [검색] / [버전 관리] / [후원자 목록] / [서비스 점검] / [경제 관리] 탭 UI

import { auth, db, func, storage, sx, fx, httpsCallable, getDocFromServer } from '../api/firebase.js';
import { ensureAdmin, isAdminCached } from '../api/admin.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-functions.js';
import { showToast } from '../ui/toast.js';

function esc(s){return String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}

// 스타일을 한 번만 주입하여 중복을 방지합니다.
function stylesOnce(){
  if (document.getElementById('manage-style')) return;
  const css = `
    .manage-container { max-width: 920px; margin: 0 auto; padding: 12px; }
    .manage-card {
      background: var(--panel, #11151c);
      border: 1px solid var(--bd, #212a36);
      border-radius: 14px;
      padding: 16px;
      color: var(--text, #eef1f6);
    }
    .manage-tabs { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; border-bottom: 1px solid var(--bd); padding-bottom: 8px; }
    .manage-tab {
      padding: 8px 14px; cursor: pointer; border: none;
      background: transparent; color: var(--muted); font-size: 14px;
      border-bottom: 2px solid transparent;
    }
    .manage-tab.active { color: var(--pri1); border-bottom-color: var(--pri1); font-weight: 600; }

    .manage-grid2 { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
    .manage-grid3 { display:grid; grid-template-columns:repeat(auto-fill, minmax(200px, 1fr)); gap:12px; }
    @media (max-width: 640px) { .manage-grid2 { grid-template-columns: 1fr; } }
    
    .manage-col { display: flex; flex-direction: column; gap: 12px; }
    .manage-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }

    .manage-label { font-size:13px; color:var(--muted); min-width:100px; }
    .manage-input, .manage-textarea, .manage-select {
        flex: 1;
        background: var(--bg, #0c0f14) !important;
        color: var(--text, #eef1f6) !important;
        border: 1px solid var(--bd, #212a36) !important;
        border-radius: 10px !important;
        padding: 10px !important;
        font-size: 14px !important;
    }
    .manage-textarea { min-height:120px; resize:vertical; }
    .manage-hint { font-size:12px; color:var(--muted); }
    
    .manage-switch {
      position:relative; width:44px; height:24px; border-radius:999px; background:var(--chip);
      border:1px solid var(--bd); cursor:pointer; display:inline-block; vertical-align:middle;
    }
    .manage-switch[data-on="1"]{ background:var(--pri1); border-color:var(--pri1); }
    .manage-switch i{position:absolute; top:2px; left:2px; width:18px; height:18px; border-radius:50%; background:#fff; transition:left .15s}
    .manage-switch[data-on="1"] i{left:22px}
  `;
  const el = document.createElement('style');
  el.id = 'manage-style';
  el.textContent = css;
  document.head.appendChild(el);
}

function mainTpl(){
  return `
  <section class="manage-container">
    <div class="manage-card">
      <h3 style="margin:0 0 8px 0">관리 도구</h3>
      <div class="manage-tabs">
        <button class="manage-tab active" data-tab="send">메일 발송</button>
        <button class="manage-tab" data-tab="search">검색</button>
        <button class="manage-tab" data-tab="version">버전 관리</button>
        <button class="manage-tab" data-tab="supporter">후원자 설정</button>
        <button class="manage-tab" data-tab="supporter-list">후원자 목록</button>
        <button class="manage-tab" data-tab="maintenance">서비스 점검</button>
        <button class="manage-tab" data-tab="economy">경제 관리</button>
      </div>
      <div id="manage-tab-content"></div>
    </div>
  </section>
  `;
}

function sendTpl(){
  return `
  <div class="manage-col">
    <h4 style="margin-top:0">우편 발송</h4>
    <div class="manage-grid2">
        <input id="mail-target" class="manage-input" placeholder="UID 입력 (전체: all)">
        <select id="mail-kind" class="manage-select">
          <option value="notice">공지</option>
          <option value="warning">경고</option>
          <option value="general">일반(보상)</option>
        </select>
    </div>
    <input id="mail-title" class="manage-input" placeholder="제목 (최대 100자)" maxlength="100">
    <textarea id="mail-body" class="manage-textarea" placeholder="내용 (최대 1500자)" maxlength="1500"></textarea>

    <div class="manage-grid2">
        <div class="manage-col manage-card">
            <label class="manage-label">만료 시각 (일반 메일용)</label>
            <input id="mail-expire-dt" class="manage-input" type="datetime-local">
        </div>
        <div class="manage-col manage-card">
            <label class="manage-label">코인 보상</label>
            <input id="mail-coins" class="manage-input" type="number" min="0" value="0">
        </div>
    </div>
    
    <details class="manage-card">
        <summary style="cursor:pointer;">고급 보상 (아이템/뽑기권)</summary>
        <div class="manage-col" style="margin-top: 12px;">
            <label class="manage-label">아이템 JSON (선택)</label>
            <textarea id="mail-items" class="manage-textarea" rows="3" placeholder='[{"name":"포션","rarity":"normal","consumable":true,"count":2}]'></textarea>
            
            <div class="manage-row" style="margin-top: 12px;">
                <label class="manage-label">뽑기권</label>
                <span id="gacha-switch" class="manage-switch" data-on="1" role="switch"><i></i></span>
                <span class="manage-hint">켜면 AI 아이템 생성</span>
            </div>
            <div id="gacha-panel" class="manage-grid2">
                <input id="w-normal" type="number" class="manage-input" value="2" min="0" placeholder="Normal">
                <input id="w-rare"   type="number" class="manage-input" value="1" min="0" placeholder="Rare">
                <input id="w-epic"   type="number" class="manage-input" value="0" min="0" placeholder="Epic">
                <input id="w-legend" type="number" class="manage-input" value="0" min="0" placeholder="Legend">
                <input id="w-myth"   type="number" class="manage-input" value="0" min="0" placeholder="Myth">
                <input id="w-aether" type="number" class="manage-input" value="0" min="0" placeholder="Aether">
            </div>


            <div class="manage-col" style="margin-top: 12px; padding-top: 12px; border-top:1px dashed var(--bd);">
              <div class="manage-row">
                <label class="manage-label">복사 출처 UID</label>
                <input id="copy-src-uid" class="manage-input" placeholder="예: uAbCdEf123456">
              </div>
              <div class="manage-row">
                <label class="manage-label">출처 아이템 ID</label>
                <input id="copy-src-item" class="manage-input" placeholder="예: item_xxx, mail_xxx 등">
              </div>
              <div class="manage-row">
                <label class="manage-label">복사 개수</label>
                <input id="copy-count" type="number" min="1" value="1" class="manage-input">
              </div>
              <div class="manage-hint">
                ※ 둘 다 채우면 “아이템 JSON” 대신 이 아이템을 본떠서 새 ID로 지급해.  
                아이템 ID는 상단 <b>검색</b> 탭에서 유저 조회하면 ITEMS 리스트로 볼 수 있어. (관리자 화면 이미 있음) 
              </div>
            </div>

        </div>
    </details>
    
    <div class="manage-row" style="justify-content:flex-end">
        <span id="mail-send-status" class="manage-hint"></span>
        <button id="btn-send-mail" class="btn primary">발송</button>
    </div>
  </div>`;
}

function searchTpl(){
  return `
  <div class="manage-col">
    <h4 style="margin-top:0">캐릭터/유저 검색</h4>
    <div class="manage-grid2">
        <input id="q-char-id" class="manage-input" placeholder="캐릭터 ID">
        <button id="btn-q-char-id" class="btn">ID로 캐릭터 조회</button>
        <input id="q-char-name" class="manage-input" placeholder="캐릭터 이름 (정확히 일치)">
        <button id="btn-q-char-name" class="btn">이름으로 캐릭터 검색</button>
    </div>
    <div class="manage-row">
        <input id="q-user" class="manage-input" placeholder="유저 UID / 이메일 / 닉네임">
        <button id="btn-q-user" class="btn">유저 검색 및 자산 조회</button>
    </div>
    <pre id="search-result" class="manage-card" style="min-height:200px; white-space:pre-wrap; word-break:break-all;"></pre>
  </div>`;
}

function supporterTpl() {
  return `
  <div class="manage-col">
    <h4 style="margin-top:0">후원자 등급 및 이펙트 설정</h4>
    <div class="manage-hint">특정 유저에게 후원자 등급을 부여합니다. 등급에 따라 캐릭터 카드에 특별한 시각 효과가 적용됩니다. 등급을 '없음'으로 설정하면 효과가 제거됩니다.</div>
    <div class="manage-row">
      <input id="supporter-uid" class="manage-input" placeholder="대상 유저의 UID">
    </div>
    <div class="manage-row">
      <select id="supporter-tier" class="manage-select">
        <option value="">없음 (효과 제거)</option>
        <option value="nexus">Nexus Traveler (포탈 이펙트)</option>
        <option value="orbits">Orbits 이펙트</option>
        <option value="flame">불꽃 이펙트</option>
        <option value="galaxy">갤럭시 이펙트</option>
        <option value="forest">숲 이펙트</option>
        </select>
    </div>
    <div class="manage-row" style="justify-content:flex-end">
      <button id="btn-set-supporter" class="btn primary">설정 저장</button>
    </div>
  </div>`;
}

function versionTpl() {
  return `
  <div class="manage-col">
    <h4 style="margin-top:0">앱 버전 관리</h4>
    <div class="manage-hint">현재 앱의 최신 버전을 설정합니다. 구버전 사용자는 접속 시 강제 새로고침됩니다.</div>
    <div class="manage-row">
      <input id="app-version" class="manage-input" placeholder="예: 2025-09-22-a">
      <button id="btn-set-version" class="btn primary">버전 설정</button>
    </div>
  </div>`;
}

function supporterListTpl() {
  return `
  <div class="manage-col">
    <h4 style="margin-top:0">후원자 목록</h4>
    <div class="manage-hint">후원자 등급이 부여된 모든 유저를 표시합니다. UID를 클릭하면 복사됩니다.</div>
    <div id="supporter-user-list" class="manage-grid3" style="gap:12px; margin-top:12px;">
      <div class="manage-card text-dim">불러오는 중...</div>
    </div>
  </div>`;
}

function maintenanceTpl() {
  return `
  <div class="manage-col">
    <h4 style="margin-top:0">서비스 점검 설정</h4>
    <div id="maintenance-status" class="manage-hint">현재 상태를 불러오는 중...</div>
    
    <div class="manage-row">
      <label class="manage-label">점검 모드 활성화</label>
      <span id="maintenance-switch" class="manage-switch" data-on="0" role="switch"><i></i></span>
    </div>
    
    <div class="manage-row">
      <label class="manage-label">점검 안내 메시지</label>
      <textarea id="maintenance-message" class="manage-textarea" rows="3" placeholder="예: 서버 안정화 작업을 위해 점검 중입니다. (오후 2시 ~ 3시)"></textarea>
    </div>
    
    <div class="manage-row" style="justify-content:flex-end">
      <button id="btn-set-maintenance" class="btn primary">상태 저장</button>
    </div>
  </div>`;
}

function economyTpl() {
  return `
  <div class="manage-col">
    <div class="manage-tabs" style="border-bottom:none; margin-bottom:0;">
        <button class="manage-tab active" data-subtab="company">주식회사 관리</button>
        <button class="manage-tab" data-subtab="event">개별 사건 관리</button>
        <button class="manage-tab" data-subtab="world-event">세계관 사건 관리</button>
        <button class="manage-tab" data-subtab="random-event">랜덤 사건 생성</button>
        <button class="manage-tab" data-subtab="auction-settle">경매 일괄 정산</button>
        <button class="manage-tab" data-subtab="raid-boss">레이드 보스 관리</button>
        <button class="manage-tab" data-subtab="emergency">일괄 폐지/가격상향</button>
    </div>
    <div id="economy-sub-content" class="manage-card" style="border-top-left-radius:0;"></div>
  </div>
  `;
}

function economyRaidBossTpl() {
  let skillInputs = '';
  for (let i = 1; i <= 4; i++) {
    skillInputs += `
      <div class="manage-card" style="padding: 10px;">
        <label class="manage-label">스킬 ${i}</label>
        <input id="raid-boss-skill-${i}-name" class="manage-input" placeholder="스킬 ${i} 이름">
        <textarea id="raid-boss-skill-${i}-desc" class="manage-textarea" rows="2" placeholder="스킬 ${i} 설명"></textarea>
      </div>
    `;
  }

  return `
    <h5 style="margin-top:0;">신규 레이드 보스 생성</h5>
    <div class="manage-hint">새로운 레이드 보스를 즉시 생성합니다. 기존에 진행 중인 레이드가 있다면 종료되고 보상이 지급됩니다.</div>
    <div class="manage-col" style="margin-top: 12px;">
      <input id="raid-boss-name" class="manage-input" placeholder="보스 이름 (예: 파멸의 군주, 모르고스)">
      <textarea id="raid-boss-desc" class="manage-textarea" rows="3" placeholder="보스 설명 (예: 차원의 틈새에서 나타난 고대의 존재...)"></textarea>
      
      <div class="manage-row">
        <label class="manage-label">보스 이미지 (1:1)</label>
        <input id="raid-boss-image" type="file" accept="image/*" class="manage-input">
      </div>

      <div class="manage-row">
        <label class="manage-label">총 HP</label>
        <input id="raid-boss-hp" type="number" min="100000" value="10000000" class="manage-input">
      </div>
      <div class="manage-row">
        <label class="manage-label">진행 기간 (일)</label>
        <input id="raid-boss-days" type="number" min="1" max="7" value="3" class="manage-input">
      </div>
      
      <h5 style="margin-top:12px; margin-bottom: 0;">보스 스킬 (4개 필수)</h5>
      <div class="manage-grid2">
        ${skillInputs}
      </div>

      <div class="manage-row" style="justify-content:flex-end; margin-top: 12px;">
        <button id="btn-create-raid-boss" class="btn primary">신규 보스 생성</button>
      </div>
    </div>
  `;
}


function economyCompanyTpl() {
  return `
    <h5 style="margin-top:0;">주식회사 목록</h5>
    <div id="stock-list" class="manage-col" style="max-height: 200px; overflow-y: auto; margin-bottom:12px;">
        <div class="manage-hint">불러오는 중...</div>
    </div>
    <h5 style="margin-top:0;">신규 주식회사 상장</h5>
    <div class="manage-col">
      <input id="stock-name" class="manage-input" placeholder="회사명 (예: 아르카 방위 산업)">
      <select id="stock-world" class="manage-select">
        <option value="">세계관 선택</option>
        </select>

      <select id="stock-type" class="manage-select">
          <option value="corporation">일반 기업</option>
          <option value="guild">길드</option>
      </select>
      <input id="stock-price" type="number" min="1" value="250" class="manage-input" placeholder="초기 가격 (1 이상)">
      <input id="stock-supply" type="number" min="1000" value="1000000" class="manage-input" placeholder="총 발행량 (기본 1,000,000)">
      <select id="stock-volatility" class="manage-select">
          <option value="low">변동성: 낮음</option>
          <option value="normal" selected>변동성: 보통</option>
          <option value="high">변동성: 높음</option>
      </select>
      <select id="stock-quality" class="manage-select">
        <option value="standard" selected>품질: 일반</option>
        <option value="bluechip">품질: 우량주(bluechip)</option>
        <option value="growth">품질: 성장주(growth)</option>
        <option value="speculative">품질: 투기주(speculative)</option>
      </select>

      <textarea id="stock-desc" class="manage-textarea" rows="2" placeholder="회사 설명"></textarea>
      <div class="manage-row" style="justify-content:flex-end">
          <button id="btn-create-stock" class="btn primary">상장</button>
      </div>
    </div>
  `;
}

function economyEventTpl() {
    return `
    <h5 style="margin-top:0;">개별 주식회사 사건 생성</h5>
    <div class="manage-col">
        <select id="event-stock" class="manage-select">
            <option value="">사건을 적용할 주식회사 선택</option>
        </select>
        <select id="event-impact" class="manage-select">
            <option value="positive">긍정적 사건</option>
            <option value="negative">부정적 사건</option>
        </select>
        <textarea id="event-premise" class="manage-textarea" rows="3" placeholder="사건의 전말 프롬프트 (예: 신기술 개발 성공, 대규모 계약 체결, 경쟁사 몰락 등)"></textarea>
        <div class="manage-row">
            <label class="manage-label">실행 시점</label>
            <input id="event-time" type="datetime-local" class="manage-input">
        </div>
        <div class="manage-row" style="justify-content:flex-end">
          <button id="btn-create-event" class="btn primary">사건 생성</button>
        </div>
    </div>
  `;
}
// [ADD] 일괄 정산 탭 HTML
function economyAuctionSettleTpl() {
  return `
    <h5 style="margin-top:0;">경매 일괄 정산</h5>
    <div class="manage-hint">마감 시간이 지났지만 아직 'active' 상태인 모든 경매를 찾아 정산 처리합니다. 유찰된 경매는 판매자에게 아이템이 반환됩니다.</div>
    <div class="manage-row" style="justify-content:flex-end; margin-top: 12px;">
      <button id="btn-settle-all-auctions" class="btn primary">일괄 정산 실행</button>
    </div>
  `;
}

function economyEmergencyTpl() {
  return `
    <h5 style="margin-top:0;">전 종목 일괄 상장 폐지 & 환불</h5>
    <div class="manage-hint">모든 상장 종목을 폐지하고 보유자에게 환불합니다. 되돌릴 수 없습니다.</div>
    <div class="manage-col">
      <select id="refund-mode" class="manage-select">
        <option value="current">현재가로 환불</option>
        <option value="fixed" selected>고정가로 환불</option>
      </select>
      <input id="refund-fixed" type="number" min="1" value="250" class="manage-input" placeholder="고정 환불가(주당)">
      <div class="manage-row" style="justify-content:flex-end">
        <button id="btn-nuke-stocks" class="btn danger">전체 상장 폐지 실행</button>
      </div>
    </div>
  `;
}

function economyRandomEventTpl() {
  return `
    <h5 style="margin-top:0;">랜덤 주식회사 사건 생성</h5>
    <div class="manage-hint">버튼을 클릭하면 상장된 모든 주식회사 중 하나를 무작위로 선택하여, 긍정 또는 부정 사건을 즉시 생성하고 오늘 날짜의 이벤트 목록에 추가합니다.</div>
    <div class="manage-col" style="margin-top: 12px;">
      <div class="manage-row" style="justify-content:flex-end">
        <button id="btn-create-random-event" class="btn primary">랜덤 사건 즉시 생성</button>
      </div>
    </div>
  `;
}

async function bindRandomEventEvents() {
    const btn = document.getElementById('btn-create-random-event');
    if (!btn) return;

    btn.addEventListener('click', async () => {
        if (!confirm('정말로 무작위 사건을 생성하시겠습니까? 이 작업은 즉시 반영됩니다.')) return;

        btn.disabled = true;
        btn.textContent = '생성 중...';
        try {
            const createRandomEventFn = httpsCallable(func, 'adminCreateRandomEvent');
            const res = await createRandomEventFn();
            const d = res?.data || {};
            showToast(d.message || '랜덤 사건이 생성되었습니다.');
        } catch (e) {
            showToast(`실패: ${e.message}`);
        } finally {
            btn.disabled = false;
            btn.textContent = '랜덤 사건 즉시 생성';
        }
    });
}

function economyWorldEventTpl() {
    return `
    <h5 style="margin-top:0;">세계관 전체 사건 생성</h5>
    <div class="manage-col">
        <select id="world-event-world" class="manage-select">
            <option value="">사건을 적용할 세계관 선택</option>
        </select>
        <textarea id="world-event-premise" class="manage-textarea" rows="3" placeholder="사건의 전말 프롬프트 (예: [아르카]에 정체불명의 역병이 창궐하여 대도시가 봉쇄됨)"></textarea>
        <div class="manage-row">
            <label class="manage-label">실행 시점</label>
            <input id="world-event-time" type="datetime-local" class="manage-input">
        </div>
        <div class="manage-row" style="justify-content:flex-end">
          <button id="btn-create-world-event" class="btn primary">세계관 사건 생성</button>
        </div>
    </div>
  `;
}
// [ADD] 일괄 정산 이벤트 바인딩
async function bindAuctionSettleEvents() {
  const btn = document.getElementById('btn-settle-all-auctions');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    if (!confirm('완료된 모든 경매를 정산하시겠습니까? 이 작업은 되돌릴 수 없습니다.')) return;

    btn.disabled = true;
    btn.textContent = '정산 중...';
    try {
      const fn = httpsCallable(func, 'adminSettleAllEndedAuctions');
      const res = await fn();
      const d = res?.data || {};
      showToast(`정산 완료: 총 ${d.settledCount || 0}건의 경매를 처리했습니다.`);
    } catch (e) {
      showToast(`일괄 정산 실패: ${e.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = '일괄 정산 실행';
    }
  });
}


async function bindEmergencyEvents() {
  const modeEl = document.getElementById('refund-mode');
  const fixedEl = document.getElementById('refund-fixed');
  const btn = document.getElementById('btn-nuke-stocks');

  btn.addEventListener('click', async () => {
    const mode = modeEl.value;
    const fixed = Number(fixedEl.value);
    if (mode === 'fixed' && (!fixed || fixed <= 0)) return showToast('고정 환불가를 제대로 입력해줘.');

    if (!confirm('정말로 모든 주식을 상장 폐지하고 환불할까? 되돌릴 수 없어.')) return;

    btn.disabled = true; btn.textContent = '처리 중...';
    try {
      const fn = httpsCallable(func, 'adminDelistAllAndRefund');
      const res = await fn({ refund_mode: mode, fixed_price: fixed });
      const d = res?.data || {};
      showToast(`완료: 종목 ${d.stocks||0}개 폐지, ${ (d.users||0) }명에게 ${ (d.paid||0).toLocaleString() }코인 환불`);
    } catch (e) {
      showToast(`실패: ${e.message}`);
    } finally {
      btn.disabled = false; btn.textContent = '전체 상장 폐지 실행';
    }
  });
}

export async function showManage(){
  stylesOnce();
  const root = document.getElementById('view');

  if (!isAdminCached()){
    try { await ensureAdmin(); } catch {}
  }
  if (!isAdminCached()){
    root.innerHTML = `<section class="manage-container"><div class="manage-card">관리자만 접근할 수 있습니다.</div></section>`;
    return;
  }

  root.innerHTML = mainTpl();

  const tabsWrap = root.querySelector('.manage-tabs');
  const contentWrap = root.querySelector('#manage-tab-content');

  const renderTabContent = (tabId) => {
    contentWrap.innerHTML = '';
    if (tabId === 'send') {
        contentWrap.innerHTML = sendTpl();
        bindSendEvents();
    } else if (tabId === 'search') {
        contentWrap.innerHTML = searchTpl();
        bindSearchEvents();
    } else if (tabId === 'version') {
        contentWrap.innerHTML = versionTpl();
        bindVersionEvents();
    } else if (tabId === 'supporter') {
        contentWrap.innerHTML = supporterTpl();
        bindSupporterEvents();
    } else if (tabId === 'supporter-list') {
        contentWrap.innerHTML = supporterListTpl();
        bindSupporterListEvents();
    } else if (tabId === 'maintenance') {
        contentWrap.innerHTML = maintenanceTpl();
        bindMaintenanceEvents();
    } else if (tabId === 'economy') {
        contentWrap.innerHTML = economyTpl();
        bindEconomyEvents();
    }
  };

  tabsWrap.addEventListener('click', (e)=>{
    const t = e.target;
    if (!(t instanceof HTMLElement) || !t.classList.contains('manage-tab')) return;
    
    tabsWrap.querySelectorAll('.manage-tab').forEach(b => b.classList.remove('active'));
    t.classList.add('active');
    renderTabContent(t.dataset.tab);
  });
  
  renderTabContent('send');
}

function bindSendEvents() {
    const $switch = document.getElementById('gacha-switch');
    const $panel  = document.getElementById('gacha-panel');
    const setSwitch = (on)=>{
      $switch.dataset.on = on ? '1' : '0';
      $panel.style.display = on ? '' : 'none';
    };
    setSwitch(true);
    $switch.addEventListener('click', ()=> setSwitch($switch.dataset.on!=='1'));

    document.getElementById('btn-send-mail').addEventListener('click', async () => {
        const payload = {
            target: document.getElementById('mail-target').value.trim(),
            title: document.getElementById('mail-title').value.trim(),
            body: document.getElementById('mail-body').value.trim(),
            kind: document.getElementById('mail-kind').value,
            attachments: {}
        };
        if (!payload.target || !payload.title || !payload.body) return showToast('대상, 제목, 내용은 필수입니다.');

        if (payload.kind === 'general') {
            const dt = document.getElementById('mail-expire-dt').value;
            if (dt) payload.expiresAt = new Date(dt).getTime();
            
            payload.attachments.coins = Number(document.getElementById('mail-coins').value || 0);
            
            const rawItems = document.getElementById('mail-items').value.trim();
            if(rawItems) {
                try {
                    payload.attachments.items = JSON.parse(rawItems);
                } catch (e) { return showToast('아이템 JSON 형식이 올바르지 않습니다.'); }
            }
            // [추가] copyFrom 입력값이 있으면 첨부
            const srcUid  = document.getElementById('copy-src-uid')?.value.trim();
            const srcItem = document.getElementById('copy-src-item')?.value.trim();
            const cnt     = Number(document.getElementById('copy-count')?.value || 1);
            if (srcUid && srcItem) {
              payload.attachments.copyFrom = { uid: srcUid, itemId: srcItem, count: Math.max(1, Math.floor(cnt||1)) };
            }

            if ($switch.dataset.on === '1') {
                const weights = {
                    normal: Number(document.getElementById('w-normal').value || 0),
                    rare:   Number(document.getElementById('w-rare').value   || 0),
                    epic:   Number(document.getElementById('w-epic').value   || 0),
                    legend: Number(document.getElementById('w-legend').value || 0),
                    myth:   Number(document.getElementById('w-myth').value   || 0),
                    aether: Number(document.getElementById('w-aether').value || 0),
                };
                if (Object.values(weights).some(v => v > 0)) {
                    payload.attachments.ticket = { weights };
                }
            }
        }
        
        const btn = document.getElementById('btn-send-mail');
        const statusEl = document.getElementById('mail-send-status');
        btn.disabled = true;
        statusEl.textContent = '발송 중...';
        
        try {
            const sendMail = httpsCallable(func, 'sendMail');
            const result = await sendMail(payload);
            statusEl.textContent = `발송 완료: ${result.data.sentCount}건`;
            showToast('메일 발송 완료!');
        } catch (e) {
            statusEl.textContent = `발송 실패: ${e.message}`;
            showToast(`발송 실패: ${e.message}`);
        } finally {
            btn.disabled = false;
        }
    });
}

function bindSearchEvents() {
    const call = (name)=> httpsCallable(func, name);
    const $res = document.getElementById('search-result');

    document.getElementById('btn-q-char-id').addEventListener('click', async ()=>{
      const id = document.getElementById('q-char-id').value.trim();
      if(!id) return $res.textContent = 'ID를 입력해줘';
      try {
        const r = await call('adminGetCharById')({ id });
        $res.textContent = JSON.stringify(r.data, null, 2);
      } catch(e){ $res.textContent = '오류: ' + (e?.message||e); }
    });

    document.getElementById('btn-q-char-name').addEventListener('click', async ()=>{
      const name = document.getElementById('q-char-name').value.trim();
      if(!name) return $res.textContent = '이름을 입력해줘';
      try {
        const r = await call('adminSearchCharsByName')({ name, limit:20 });
        $res.textContent = JSON.stringify(r.data, null, 2);
      } catch(e){ $res.textContent = '오류: ' + (e?.message||e); }
    });

    document.getElementById('btn-q-user').addEventListener('click', async ()=>{
      const q = document.getElementById('q-user').value.trim();
      if(!q) return $res.textContent = '검색어를 입력해줘';
      try {
        const r1 = await call('adminFindUser')({ q });
        if(!r1.data?.ok || !r1.data?.users?.length) return $res.textContent = '유저 없음';
        const u = r1.data.users[0];
        const r2 = await call('adminListAssets')({ uid: u.uid });
        $res.textContent = `USER\n${JSON.stringify(u, null, 2)}\n\nCHARACTERS\n${JSON.stringify(r2.data?.chars||[], null, 2)}\n\nITEMS\n${JSON.stringify(r2.data?.items||[], null, 2)}`;
      } catch(e){ $res.textContent = '오류: ' + (e?.message||e); }
    });
}

function bindVersionEvents() {
    const btn = document.getElementById('btn-set-version');
    btn.addEventListener('click', async () => {
        const versionInput = document.getElementById('app-version');
        const version = versionInput.value.trim();
        if (!version) {
            showToast('버전 문자열을 입력해주세요.');
            return;
        }

        btn.disabled = true;
        btn.textContent = '설정 중...';
        
        try {
            const setAppVersion = httpsCallable(func, 'setAppVersion');
            const result = await setAppVersion({ version });
            if (result.data.ok) {
                showToast(`앱 버전이 ${version}으로 설정되었습니다.`);
                versionInput.value = '';
            } else {
                throw new Error('서버에서 버전 설정에 실패했습니다.');
            }
        } catch (e) {
            showToast(`버전 설정 실패: ${e.message}`);
        } finally {
            btn.disabled = false;
            btn.textContent = '버전 설정';
        }
    });
}

function bindSupporterEvents() {
    const btn = document.getElementById('btn-set-supporter');
    btn.addEventListener('click', async () => {
        const targetUid = document.getElementById('supporter-uid').value.trim();
        const tier = document.getElementById('supporter-tier').value;

        if (!targetUid) {
            showToast('대상 유저의 UID를 입력해주세요.');
            return;
        }

        btn.disabled = true;
        btn.textContent = '설정 중...';
        
        try {
            const setSupporterTier = httpsCallable(func, 'adminSetSupporterTier');
            const result = await setSupporterTier({ targetUid, tier });
            if (result.data.ok) {
                showToast(`[${targetUid}] 유저의 후원자 등급을 '${tier || '없음'}'으로 설정했습니다.`);
            } else {
                throw new Error('서버에서 설정에 실패했습니다.');
            }
        } catch (e) {
            showToast(`설정 실패: ${e.message}`);
        } finally {
            btn.disabled = false;
            btn.textContent = '설정 저장';
        }
    });
}

function bindSupporterListEvents() {
  const listContainer = document.getElementById('supporter-user-list');
  if (!listContainer) return;

  const loadSupporterUsers = async () => {
    try {
      const getSupporterUsers = httpsCallable(func, 'adminGetSupporterUsers');
      const result = await getSupporterUsers();
      
      const users = result.data.users || [];

      if (users.length === 0) {
        listContainer.innerHTML = `<div class="manage-card text-dim">후원자 등급이 부여된 유저가 없습니다.</div>`;
        return;
      }

      listContainer.innerHTML = users.map(u => `
        <div class="manage-card" style="display: flex; flex-direction: column; gap: 8px; padding: 10px;">
          <div class="manage-row">
            <img src="${u.avatarURL || ''}" onerror="this.style.display='none'" style="width: 40px; height: 40px; border-radius: 50%; object-fit: cover; background: #111;">
            <div style="font-weight: 700;">${esc(u.nickname)}</div>
          </div>
          <div class="manage-hint" style="font-size: 11px; cursor: pointer;" data-uid="${esc(u.uid)}">
            UID: ${esc(u.uid)}
          </div>
          <div class="chip" style="align-self: flex-start;">${esc(u.supporter_tier)}</div>
        </div>
      `).join('');

      listContainer.querySelectorAll('[data-uid]').forEach(el => {
        el.addEventListener('click', () => {
          navigator.clipboard.writeText(el.dataset.uid);
          showToast('UID가 복사되었습니다.');
        });
      });

    } catch (e) {
      console.error("후원자 목록 로딩 실패:", e);
      listContainer.innerHTML = `<div class="manage-card error" style="color: #ef4444;">목록을 불러오는 중 오류가 발생했습니다: ${esc(e.message)}</div>`;
    }
  };

  loadSupporterUsers();
}

function bindMaintenanceEvents() {
    const statusEl = document.getElementById('maintenance-status');
    const switchEl = document.getElementById('maintenance-switch');
    const messageEl = document.getElementById('maintenance-message');
    const btn = document.getElementById('btn-set-maintenance');

    const statusRef = fx.doc(db, 'configs/app_status');
    fx.getDoc(statusRef).then(snap => {
        if (snap.exists()) {
            const data = snap.data();
            const enabled = data.isMaintenance === true;
            statusEl.textContent = `현재 상태: ${enabled ? '점검 중' : '정상 운영 중'}`;
            switchEl.dataset.on = enabled ? '1' : '0';
            messageEl.value = data.message || '';
        } else {
            statusEl.textContent = '현재 상태: 정상 운영 중 (설정 없음)';
        }
    });

    switchEl.addEventListener('click', () => {
        switchEl.dataset.on = switchEl.dataset.on === '1' ? '0' : '1';
    });

    btn.addEventListener('click', async () => {
        const enabled = switchEl.dataset.on === '1';
        const message = messageEl.value.trim();

        if (enabled && !message) {
            showToast('점검 모드 활성화 시 안내 메시지는 필수입니다.');
            return;
        }

        btn.disabled = true;
        btn.textContent = '저장 중...';

        try {
            const setMaintenanceStatus = httpsCallable(func, 'setMaintenanceStatus');
            await setMaintenanceStatus({ enabled, message });
            showToast('서비스 점검 상태가 성공적으로 업데이트되었습니다.');
            statusEl.textContent = `현재 상태: ${enabled ? '점검 중' : '정상 운영 중'}`;
        } catch (e) {
            showToast(`상태 업데이트 실패: ${e.message}`);
        } finally {
            btn.disabled = false;
            btn.textContent = '상태 저장';
        }
    });
}

function bindEconomyEvents() {
    const content = document.getElementById('economy-sub-content');
    const tabs = document.querySelectorAll('#manage-tab-content .manage-tab[data-subtab]');

    const renderSubTab = (subTabId) => {
        content.innerHTML = '';
        if (subTabId === 'company') {
            content.innerHTML = economyCompanyTpl();
            bindCompanyEvents();
        } else if (subTabId === 'event') {
            content.innerHTML = economyEventTpl();
            bindEventEvents();
        } else if (subTabId === 'emergency') {
            content.innerHTML = economyEmergencyTpl();
            bindEmergencyEvents();
        } else if (subTabId === 'auction-settle') { // [ADD]
            content.innerHTML = economyAuctionSettleTpl();
            bindAuctionSettleEvents();
        } else if (subTabId === 'world-event') {
            content.innerHTML = economyWorldEventTpl();
            bindWorldEventEvents();
        } else if (subTabId === 'random-event') { // 이 부분을 추가합니다.
            content.innerHTML = economyRandomEventTpl();
            bindRandomEventEvents();
        } else if (subTabId === 'raid-boss') { // 이 부분을 추가합니다.
            content.innerHTML = economyRaidBossTpl();
            bindRaidBossEvents();
        }
    };

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            renderSubTab(tab.dataset.subtab);
        });
    });

    renderSubTab('company');
}

async function bindCompanyEvents() {
    const worldSelect = document.getElementById('stock-world');
    const stockListEl = document.getElementById('stock-list');
    const btnCreate = document.getElementById('btn-create-stock');

    const loadData = async () => {
        // Load worlds (static assets → Firestore fallback)
        try {
          const res = await fetch('/assets/worlds.json', { cache: 'no-store' });
          if (!res.ok) throw new Error('assets fetch failed');
          const data = await res.json();
          const worlds = Array.isArray(data?.worlds) ? data.worlds : [];
          worldSelect.innerHTML = `<option value="">세계관 선택</option>` +
            worlds.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join('');
        } catch (e) {
          try {
            const worldsSnap = await fx.getDoc(fx.doc(db, 'configs', 'worlds'));
            if (worldsSnap.exists()) {
              const worlds = worldsSnap.data().worlds || [];
              worldSelect.innerHTML = `<option value="">세계관 선택</option>` +
                worlds.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join('');
            } else {
              worldSelect.innerHTML = `<option value="">세계관 데이터 없음</option>`;
            }
          } catch (err) {
            worldSelect.innerHTML = `<option value="">세계관 로드 실패</option>`;
          }
        }


        // Load stocks
        const stockSnap = await fx.getDocs(fx.query(fx.collection(db, 'stocks'), fx.orderBy('name')));
        if (stockSnap.empty) {
            stockListEl.innerHTML = `<div class="manage-hint">상장된 주식회사가 없습니다.</div>`;
        } else {
            stockListEl.innerHTML = stockSnap.docs.map(doc => {
                const stock = doc.data();
                return `<div class="manage-card" style="font-size:12px;"><b>${esc(stock.name)}</b> (${esc(stock.world_name || stock.world_id)}) - 현재가: ${stock.current_price}</div>`;
            }).join('');
        }
    };

    btnCreate.addEventListener('click', async (e) => {
        const btn = e.target;
        btn.disabled = true;
        try {
            const payload = {
                name: document.getElementById('stock-name').value,
                world_id: document.getElementById('stock-world').value,
                world_name: document.getElementById('stock-world').options[document.getElementById('stock-world').selectedIndex].text,
                type: document.getElementById('stock-type').value,
                initial_price: Number(document.getElementById('stock-price').value),
                volatility: document.getElementById('stock-volatility').value,
                description: document.getElementById('stock-desc').value,
                quality: document.getElementById('stock-quality').value,
                total_supply: Number(document.getElementById('stock-supply').value) // [추가]
            };
            if (!payload.name || !payload.world_id || !payload.initial_price) throw new Error("회사명, 세계관, 초기 가격은 필수입니다.");

            const createStockFn = httpsCallable(func, 'adminCreateStock');
            await createStockFn(payload);
            showToast('주식회사 상장 완료!');
            await loadData(); // 목록 새로고침
        } catch (err) {
            showToast(`상장 실패: ${err.message}`);
        } finally {
            btn.disabled = false;
        }
    });
    
    await loadData();
}


// /public/js/tabs/manage.js

async function bindEventEvents() {
    const eventStockSelect = document.getElementById('event-stock');
    const stockSnap = await fx.getDocs(fx.query(fx.collection(db, 'stocks'), fx.orderBy('name')));
    if (!stockSnap.empty) {
        eventStockSelect.innerHTML += stockSnap.docs.map(doc => `<option value="${doc.id}">${doc.data().name}</option>`).join('');
    }

    document.getElementById('btn-create-event').addEventListener('click', async (e) => {
        const btn = e.target;
        btn.disabled = true;
        try {
            const dtValue = document.getElementById('event-time').value;
            const hhmm = dtValue ? dtValue.split('T')[1] : '';
            const [hh, mm] = hhmm ? hhmm.split(':').map(Number) : [null, null];
            const trigger_minute = (hh == null || mm == null) ? null : (hh * 60 + mm);

            const payload = {
                stock_id: document.getElementById('event-stock').value,
                potential_impact: document.getElementById('event-impact').value,
                premise: document.getElementById('event-premise').value,
                trigger_minute: trigger_minute
            };

            if (!payload.stock_id || !payload.premise || payload.trigger_minute === null) {
                throw new Error("모든 필드를 채워주세요.");
            }
            const createEventFn = httpsCallable(func, 'adminCreateManualEvent');
            await createEventFn(payload);
            showToast('수동 사건이 성공적으로 생성되었습니다.');
        } catch (err) {
            showToast(`사건 생성 실패: ${err.message}`);
        } finally {
            btn.disabled = false;
        }
    });
}

async function bindWorldEventEvents() {
    const worldSelect = document.getElementById('world-event-world');
     try {
  const res = await fetch('/assets/worlds.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('assets fetch failed');
  const data = await res.json();
  const worlds = Array.isArray(data?.worlds) ? data.worlds : [];
  worldSelect.innerHTML = `<option value="">세계관 선택</option>` +
    worlds.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join('');
} catch (e) {
  try {
    const worldsSnap = await fx.getDoc(fx.doc(db, 'configs', 'worlds'));
    if (worldsSnap.exists()) {
      const worlds = worldsSnap.data().worlds || [];
      worldSelect.innerHTML = `<option value="">세계관 선택</option>` +
        worlds.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join('');
    } else {
      worldSelect.innerHTML = `<option value="">세계관 데이터 없음</option>`;
    }
  } catch (err) {
    worldSelect.innerHTML = `<option value="">세계관 로드 실패</option>`;
  }
}


    document.getElementById('btn-create-world-event').addEventListener('click', async (e) => {
        const btn = e.target;
        btn.disabled = true;
        try {
            const dtValue = document.getElementById('world-event-time').value;
            const payload = {
                world_id: document.getElementById('world-event-world').value,
                premise: document.getElementById('world-event-premise').value,
                trigger_time: dtValue ? new Date(dtValue).toISOString() : null
            };
             if (!payload.world_id || !payload.premise || !payload.trigger_time) {
                throw new Error("모든 필드를 채워주세요.");
            }
            // 서버 함수 호출
             const createWorldEvent = httpsCallable(func, 'adminCreateWorldEvent');
               await createWorldEvent(payload);
               showToast('세계관 사건이 등록됐어!');
        } catch (err) {
            showToast(`사건 생성 실패: ${err.message}`);
        } finally {
            btn.disabled = false;
        }
    });
}

async function bindRaidBossEvents() {
    const btn = document.getElementById('btn-create-raid-boss');
    if (!btn) return;

    btn.addEventListener('click', async () => {
        const skills = [];
        for (let i = 1; i <= 4; i++) {
            const name = document.getElementById(`raid-boss-skill-${i}-name`).value.trim();
            const desc = document.getElementById(`raid-boss-skill-${i}-desc`).value.trim();
            if (!name || !desc) {
                showToast(`스킬 ${i}의 이름과 설명을 모두 입력해주세요.`);
                return;
            }
            skills.push({ name, description: desc });
        }

        const payload = {
            name: document.getElementById('raid-boss-name').value.trim(),
            description: document.getElementById('raid-boss-desc').value.trim(),
            totalHp: Number(document.getElementById('raid-boss-hp').value),
            durationDays: Number(document.getElementById('raid-boss-days').value),
            skills: skills,
            imageUrl: '' // 이미지 URL은 업로드 후 채워짐
        };

        if (!payload.name || !payload.description || payload.totalHp <= 0 || payload.durationDays <= 0) {
            showToast('모든 필드를 올바르게 입력해주세요.');
            return;
        }
        
        if (!confirm(`정말로 '${payload.name}' 보스를 생성하시겠습니까?`)) return;

        btn.disabled = true;
        btn.textContent = '생성 중...';

        try {
            // 이미지 업로드
            const fileInput = document.getElementById('raid-boss-image');
            const file = fileInput.files[0];
            if (file) {
                const adminUid = auth.currentUser.uid;
                const randomId = fx.doc(fx.collection(db, 'raids')).id;
                // ▼▼▼ [수정된 부분] ▼▼▼
                const storageRef = sx.ref(storage, `raid_boss_images/${adminUid}/${randomId}.webp`);
                // ▲▲▲ [수정된 부분] ▲▲▲
                
                // 1:1 리사이징
                const bmp = await createImageBitmap(file);
                const side = Math.min(bmp.width, bmp.height);
                const cropX = (bmp.width - side) / 2;
                const cropY = (bmp.height - side) / 2;
                const canvas = document.createElement('canvas');
                canvas.width = 512;
                canvas.height = 512;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(bmp, cropX, cropY, side, side, 0, 0, 512, 512);
                const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.9));

                await sx.uploadBytes(storageRef, blob);
                payload.imageUrl = await sx.getDownloadURL(storageRef);
            }

            const setupFn = httpsCallable(func, 'adminSetupNewRaidBoss');
            const res = await setupFn(payload);
            const d = res?.data || {};
            showToast(`신규 레이드 보스(ID: ${d.bossId})가 생성되었습니다.`);

        } catch (e) {
            showToast(`실패: ${e.message}`);
        } finally {
            btn.disabled = false;
            btn.textContent = '신규 보스 생성';
        }
    });
}


export const showAdmin = showManage;
export default showManage;
