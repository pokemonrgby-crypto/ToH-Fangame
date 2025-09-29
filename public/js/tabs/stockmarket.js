// /public/js/tabs/stockmarket.js (전체 교체)
import { db, fx, auth, func } from '../api/firebase.js';
import { httpsCallable } from '[https://www.gstatic.com/firebasejs/10.12.3/firebase-functions.js](https://www.gstatic.com/firebasejs/10.12.3/firebase-functions.js)';
import { showToast } from '../ui/toast.js';

const call = (name)=> httpsCallable(func, name);
const esc = s => String(s ?? '').replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));

// 오늘 00:00 KST의 UTC 타임스탬프(ms)
function kstStartOfTodayUtcMs(){
  const now = new Date();
  const kstNowMs = now.getTime() + 9*60*60*1000; // UTC→KST
  const kst = new Date(kstNowMs);
  kst.setHours(0,0,0,0);                          // KST 자정
  return kst.getTime() - 9*60*60*1000;            // 다시 UTC로 환산
}

// price_history에서 금일 시가 찾기 (없으면 합리적 대안)
function getTodayOpenFromHistory(history, currentPrice){
  const startKst = kstStartOfTodayUtcMs();
  const arr = Array.isArray(history) ? history : [];
  const todays = arr.filter(p => Date.parse(p.date) >= startKst)
                    .sort((a,b) => Date.parse(a.date) - Date.parse(b.date));
  if (todays.length) return Number(todays[0].price);

  const last24h = arr.filter(p => (Date.now() - Date.parse(p.date)) <= 24*60*60*1000)
                     .sort((a,b) => Date.parse(a.date) - Date.parse(b.date));
  if (last24h.length) return Number(last24h[0].price);

  return Number(arr[0]?.price ?? currentPrice ?? 0);
}

export async function renderStocks(container){
  container.innerHTML = `
    <style>
      .stock-row {
        padding: 10px; border: 1px solid var(--bd); border-radius: 12px;
        margin-bottom: 8px; cursor: pointer; transition: background .2s, border-radius .2s;
      }
      .stock-row:hover { background: rgba(255,255,255,0.04); }
      .stock-row .price { font-size: 16px; font-weight: 800; }
      .stock-row .change { font-size: 12px; font-weight: 700; }
      .stock-row .change.up { color: #ff6b6b; }
      .stock-row .change.down { color: #5b7cff; }
      .stock-detail {
        display: none;
        padding: 12px; margin-top: -8px; margin-bottom: 8px;
        background: rgba(0,0,0,0.15); 
        border: 1px solid var(--bd);
        border-top: none;
        border-bottom-left-radius: 12px;
        border-bottom-right-radius: 12px;
      }
      .stock-row.active { 
        background: rgba(255,255,255,0.06); 
        border-bottom-color: transparent; 
        border-bottom-left-radius:0; 
        border-bottom-right-radius:0;
      }
      .stock-row.active + .stock-detail { display: block; }
      .btn-range.active {
        background: var(--pri1);
        color: white;
        border-color: var(--pri1);
      }
    </style>
    <div class="kv-card" style="margin-bottom:8px">
      <div class="row" style="gap:8px;align-items:center">
        <div style="font-weight:900">주식 시장</div>
        <div class="text-dim" style="font-size:12px">1분 주기 업데이트 / 거래 수수료 1%</div>
      </div>
    </div>
    <div id="stock-list-container"></div>
  `;

  const listContainer = container.querySelector('#stock-list-container');
  let activeChart = null;
  let eventListenerAttached = false;

  const q = fx.query(
  fx.collection(db, 'stocks'),
  fx.where('status', '==', 'listed'),
  fx.orderBy('name'),
  fx.limit(50)
);

  
  const unsub = fx.onSnapshot(q, (snap) => {
    const me = auth.currentUser?.uid;
    const stocks = snap.docs.map(d => {
      const data = d.data();
      return { id: d.id, ...data, isSubscribed: me && Array.isArray(data.subscribers) && data.subscribers.includes(me) };
    });
    
    updateStockList(stocks);

    if (!eventListenerAttached) {
      attachEventListeners();
      eventListenerAttached = true;
    }
  });

  function updateStockList(stocks) {
  // 현재 화면의 순서와 새 데이터의 순서가 같은 경우엔 가격/등락 텍스트만 업데이트한다.
  const rows = Array.from(listContainer.querySelectorAll('.stock-row'));
  const currIds = rows.map(r => r.dataset.id);
  const newIds  = stocks.map(s => s.id);

  const sameOrder = currIds.length === newIds.length && currIds.every((id, i) => id === newIds[i]);

  if (sameOrder && rows.length) {
    // 빠른 경로: DOM 구조 유지 → 텍스트만 갱신 (차트/열림 상태 유지)
    stocks.forEach((s, i) => {
      const row = rows[i];
      const price = Number(s.current_price || 0);
      const history = Array.isArray(s.price_history) ? s.price_history : [];
      const todayOpen = getTodayOpenFromHistory(history, price);
      const change = Number(price) - Number(todayOpen);
      const changePct = todayOpen > 0 ? (change / todayOpen * 100).toFixed(2) : '0.00';

      row.dataset.open = todayOpen;

      const priceEl = row.querySelector('.price');
      const changeEl = row.querySelector('.change');
      const supplyEl = row.querySelector('.supply'); // [추가]
      if (priceEl)  priceEl.textContent = price.toLocaleString();
      if (changeEl) {
        changeEl.textContent = `${change > 0 ? '▲' : (change < 0 ? '▼' : '—')} ${Math.abs(change).toLocaleString()} (${changePct}%)`;
        changeEl.classList.toggle('up',   change > 0);
        changeEl.classList.toggle('down', change < 0);
      }
      // [추가] 유통량/발행량 업데이트
      if (supplyEl) {
        const circulating = Number(s.circulating_supply || 0).toLocaleString();
        const total = Number(s.total_supply || 0).toLocaleString();
        supplyEl.textContent = `유통량: ${circulating} / ${total}`;
      }
    });
    return;
  }

  // 순서가 달라졌거나 처음 렌더: 기존 방식으로 생성 (디테일은 클릭 시 채움)
  const activeId = listContainer.querySelector('.stock-row.active')?.dataset.id;

  listContainer.innerHTML = stocks.map(s => {
    const price = Number(s.current_price || 0);
    const history = Array.isArray(s.price_history) ? s.price_history : [];
    const todayOpen = getTodayOpenFromHistory(history, price);
    const change = Number(price) - Number(todayOpen);
    const changePct = todayOpen > 0 ? (change / todayOpen * 100).toFixed(2) : '0.00';
    const changeClass = change > 0 ? 'up' : change < 0 ? 'down' : '';
    const changeIcon = change > 0 ? '▲' : change < 0 ? '▼' : '—';
    const circulating = Number(s.circulating_supply || 0).toLocaleString();
    const total = Number(s.total_supply || 0).toLocaleString();

    return `
      <div class="stock-row ${s.id === activeId ? 'active' : ''}" data-id="${s.id}" data-open="${todayOpen}">
        <div class="row">
          <div>
            <div style="font-weight:700;">${esc(s.name || s.id)}</div>
            <div class="text-dim supply" style="font-size:12px;">유통량: ${circulating} / ${total}</div>
          </div>
          <div style="flex:1;"></div>
          <div style="text-align:right">
            <div class="price">${price.toLocaleString()}</div>
            <div class="change ${changeClass}">${changeIcon} ${Math.abs(change).toLocaleString()} (${changePct}%)</div>
          </div>
        </div>
      </div>
      <div class="stock-detail" id="detail-${s.id}"></div>
    `;
  }).join('');
}

  
  function attachEventListeners() {
    listContainer.addEventListener('click', async (e) => {
      const row = e.target.closest('.stock-row');
      const btn = e.target.closest('button[data-act]');

      if (btn) {
        e.stopPropagation();
        await handleActionClick(btn);
      } else if (row) {
        toggleDetailView(row);
      }
    });
  }

  async function handleActionClick(btn) {
    const act = btn.dataset.act;
    const id = btn.dataset.id;
    const detailView = btn.closest('.stock-detail');
    const actionButtons = detailView.querySelectorAll('button[data-act]');
    actionButtons.forEach(b => b.disabled = true);
    
    try {
      if (act === 'sub') {
        const want = !btn.textContent.includes('취소');
        await call('subscribeToStock')({ stockId: id, subscribe: want });
        showToast(`구독 정보가 변경되었습니다.`);
      } else if (act === 'buy' || act === 'sell') {
        const qtyInput = detailView.querySelector(`#stock-qty-${id}`);
        const qty = Math.floor(Number(qtyInput.value || '0'));
        if (qty <= 0) { showToast('수량을 정확히 입력해주세요.'); return; }
        if (act === 'buy') {
          await call('buyStock')({ stockId: id, quantity: qty });
          showToast(`${qty}주 매수 완료!`);
        } else {
          await call('sellStock')({ stockId: id, quantity: qty });
          showToast(`${qty}주 매도 완료!`);
        }
        qtyInput.value = '';
      }
    } catch (err) {
      showToast(err.message || '오류가 발생했습니다.');
    } finally {
      actionButtons.forEach(b => b.disabled = false);
    }
  }

  async function toggleDetailView(row, forceOpen = false) {
    const stockId = row.dataset.id;
    const detailView = listContainer.querySelector(`#detail-${stockId}`);
    const currentlyActive = listContainer.querySelector('.stock-row.active');

    if (currentlyActive && currentlyActive !== row) {
      currentlyActive.classList.remove('active');
      const oldDetail = listContainer.querySelector(`#detail-${currentlyActive.dataset.id}`);
      if(oldDetail) oldDetail.innerHTML = '';
    }

    const shouldOpen = forceOpen || !row.classList.contains('active');
    
    if (activeChart) {
      activeChart.destroy();
      activeChart = null;
    }

    if (shouldOpen) {
      row.classList.add('active');
      const me = auth.currentUser?.uid;
      
      // 주식 정보와 내 보유량 정보를 동시에 가져옴
      const [docSnap, portfolioSnap] = await Promise.all([
        fx.getDoc(fx.doc(db, 'stocks', stockId)),
        me ? fx.getDoc(fx.doc(db, `users/${me}/portfolio/${stockId}`)) : Promise.resolve(null)
      ]);

      if (!docSnap.exists()) return;
      const stock = docSnap.data();
      const heldQty = portfolioSnap?.exists() ? portfolioSnap.data().quantity : 0;
      const isSubscribed = me && Array.isArray(stock.subscribers) && stock.subscribers.includes(me);

      // ★ 안전장치: 서버 히스토리 늦을 때 current_price를 마지막 점으로 보정
      const fullHistory = Array.isArray(stock.price_history) ? [...stock.price_history] : [];
      if (!fullHistory.length || Number(fullHistory[fullHistory.length-1].price) !== Number(stock.current_price)) {
        fullHistory.push({ date: new Date().toISOString(), price: Number(stock.current_price || 0) });
      }

      // 금일 시가 (차트 색 결정에 사용)
      const todayOpen = getTodayOpenFromHistory(fullHistory, Number(stock.current_price || 0));

      detailView.innerHTML = `
        <div class="row" style="gap:4px; margin-bottom: 8px;">
            <button class="btn xs ghost btn-range" data-range="1H">1H</button>
            <button class="btn xs ghost btn-range" data-range="6H">6H</button>
        </div>
        <div style="height: 120px; position: relative;">
          <canvas id="chart-${stockId}"></canvas>
        </div>
        <div class="text-dim" style="font-size:12px;margin:8px 0">${esc(stock.description || '')}</div>
        
        <div class="kv-card" style="padding: 8px; margin-bottom: 8px;">
          <div class="row" style="justify-content: space-between; align-items: center;">
            <div class="text-dim" style="font-size: 12px;">보유: ${Number(heldQty||0).toLocaleString()}주</div>
            <input type="number" id="stock-qty-${stockId}" class="input" placeholder="수량 입력" inputmode="numeric" min="1" step="1" style="width: 100px; text-align: right;">
          </div>
        </div>

        <div class="row" style="gap:8px; justify-content:flex-end;">
          <button class="btn xs" data-act="sub" data-id="${stockId}">${isSubscribed ? '구독취소' : '속보구독'}</button>
          <button class="btn xs" data-act="buy" data-id="${stockId}">매수</button>
          <button class="btn xs" data-act="sell" data-id="${stockId}">매도</button>
        </div>
      `;
      
      detailView.querySelectorAll('button[data-range]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          detailView.querySelectorAll('button[data-range]').forEach(b => b.classList.remove('active'));
          e.currentTarget.classList.add('active');
          displayChart(stockId, fullHistory, e.currentTarget.dataset.range, todayOpen);
        });
      });
      
      // 초기 차트
      detailView.querySelector('button[data-range="1H"]').click();

    } else {
      row.classList.remove('active');
      detailView.innerHTML = '';
    }
  }
  
  function processHistoryForChart(history, range) {
    if (!history || history.length < 1) return [];

    const duration = (range === '1H' ? 60 : 360) * 60 * 1000;
    const endTime = Date.now();
    const startTime = endTime - duration;

    // 1. 타임스탬프 기준으로 기록을 정렬합니다.
    const sortedHistory = history
        .map(p => ({ time: new Date(p.date).getTime(), price: Number(p.price) }))
        .sort((a, b) => a.time - b.time);
    
    // 2. 선택된 시간 범위(예: 최근 1시간) 내의 데이터만 필터링합니다.
    const dataInRange = sortedHistory.filter(p => p.time >= startTime && p.time <= endTime);

    // 3. 그래프가 화면 왼쪽 끝에서 시작되도록, 시간 범위 바로 이전의 마지막 데이터를 찾아 맨 앞에 추가합니다.
    const lastPointBeforeRange = sortedHistory.filter(p => p.time < startTime).pop();
    if (lastPointBeforeRange) {
        dataInRange.unshift(lastPointBeforeRange);
    }

    // 4. toggleDetailView 함수에서 현재 가격을 마지막 데이터로 이미 추가했으므로,
    //    여기서는 포맷만 맞춰서 반환합니다. 이로써 불필요한 보간 로직이 제거되고 정확성이 향상됩니다.
    return dataInRange.map(p => ({ x: p.time, y: p.price }));
  }

  function displayChart(stockId, fullHistory, range, todayOpen) {
    if (activeChart) { activeChart.destroy(); activeChart = null; }
    const processedData = processHistoryForChart(fullHistory, range);
    renderChart(stockId, processedData, range, todayOpen);
  }

  function renderChart(stockId, data, range, todayOpen) {
    const ctx = document.getElementById(`chart-${stockId}`);
    if (!ctx || !data.length) return;
    
    const lastPrice = data[data.length - 1]?.y || 0;

    // 금일 시가 기준으로 색 결정
    const isUpDay = Number(todayOpen || 0) > 0 ? (lastPrice >= Number(todayOpen)) : true;
    const upColor   = 'rgba(255, 107, 107, 0.8)'; // 빨강
    const downColor = 'rgba(91, 124, 255, 0.8)';   // 파랑
    const borderColor = isUpDay ? upColor : downColor;
    
    const prices = data.map(p => p.y);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const padding = (maxPrice - minPrice) * 0.1 || 5;

    // Chart.js 전역에 로드되어 있다고 가정
    activeChart = new Chart(ctx, {
      type: 'line',
      data: { 
        datasets: [{
          label: '가격', data, borderColor, borderWidth: 2, pointRadius: 0, tension: 0.1,
          backgroundColor: (context) => {
            const gradient = context.chart.ctx.createLinearGradient(0, 0, 0, context.chart.height);
            gradient.addColorStop(0, `${borderColor.slice(0, -4)}0.3)`);
            gradient.addColorStop(1, `${borderColor.slice(0, -4)}0)`);
            return gradient;
          },
          fill: true,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: {
          x: { 
            type: 'timeseries',
            time: {
              unit: range === '1H' ? 'minute' : 'hour',
              stepSize: range === '1H' ? 10 : 1,
              displayFormats: { minute: 'HH:mm', hour: 'HH:mm' }
            },
            ticks: { font: { size: 10 }, maxRotation: 0 },
            grid: { display: false }, 
            border: { display: false } 
          },
          y: { 
            min: Math.max(0, Math.floor(minPrice - padding)),
            max: Math.ceil(maxPrice + padding),
            ticks: { font: { size: 10 } }, 
            grid: { color: 'rgba(255,255,255,0.1)' }, 
            border: { display: false } 
          }
        },
        plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false } }
      }
    });
  }

  container.closest('#view').__cleanup = () => {
    if (unsub) unsub();
    if (activeChart) activeChart.destroy();
  };
}
