// /public/js/tabs/mystocks.js (전체 교체)
import { db, fx, auth } from '../api/firebase.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));

export async function renderMyStocks(container){
  container.innerHTML = `
    <style>
      .tbl { width:100%; border-collapse: collapse; }
      .tbl th, .tbl td { padding:8px; border-bottom:1px solid var(--bd); font-size:12px; text-align:right; }
      .tbl th { text-align:center; font-weight:800; }
      .tbl td:first-child, .tbl th:first-child { text-align:left; }
      .pl-pos { color:#ff6b6b; font-weight:700; }
      .pl-neg { color:#5b7cff; font-weight:700; }
    </style>
    <div class="kv-card" style="margin-bottom:8px">
      <div style="font-weight:900">내 주식</div>
      <div class="text-dim" style="font-size:12px">보유 종목 / 평단 / 평가손익(%)</div>
    </div>
    <div id="mytbl"></div>
  `;

  const uid = auth.currentUser?.uid;
  if (!uid) {
    container.querySelector('#mytbl').innerHTML = `<div class="text-dim">로그인이 필요합니다.</div>`;
    return;
  }

  const tblBox = container.querySelector('#mytbl');

  // 상태: 포지션 + 실시간 가격/이름 맵 + 언섭 관리
  const state = {
    positions: [],                          // [{id, quantity, average_buy_price, ...}]
    prices: new Map(),                      // stockId -> current_price
    names: new Map(),                       // stockId -> name
    unsubs: new Map(),                      // stockId -> unsubscribe fn
    portUnsub: null
  };

  // 표 렌더링
  function renderTable(){
    const rows = state.positions.map(p => {
      const id = p.stock_id || p.id;
      const name = state.names.get(id) ?? (p.stock_id || p.id);
      const qty  = Number(p.quantity || 0);
      const avg  = Number(p.average_buy_price || 0);
      const cur  = Number(state.prices.get(id) || 0);
      const val  = qty * cur;
      const cost = qty * avg;
      const pl   = val - cost;
      const plPct= cost>0 ? ((pl/cost)*100).toFixed(2) : '0.00';
      const cls  = pl >= 0 ? 'pl-pos' : 'pl-neg';
      return { id, name, qty, avg, cur, val, cost, pl, plPct, cls };
    });

    let totalValue = 0, totalCost = 0;
    const trs = rows.map(r => {
      totalValue += r.val;
      totalCost  += r.cost;
      return `
        <tr>
          <td>${esc(r.name)}</td>
          <td>${r.qty.toLocaleString()}</td>
          <td>${r.avg.toLocaleString()}</td>
          <td>${r.cur.toLocaleString()}</td>
          <td>${r.val.toLocaleString()}</td>
          <td class="${r.cls}">${r.pl>=0?'+':''}${r.pl.toLocaleString()} (${r.plPct}%)</td>
        </tr>
      `;
    }).join('');

    const totalPl = totalValue - totalCost;
    const totalPct = totalCost>0 ? ((totalPl/totalCost)*100).toFixed(2) : '0.00';
    const totalCls = totalPl >= 0 ? 'pl-pos' : 'pl-neg';

    tblBox.innerHTML = `
      <table class="tbl">
        <thead>
          <tr>
            <th>종목</th><th>수량</th><th>평단가</th><th>현재가</th><th>평가</th><th>손익</th>
          </tr>
        </thead>
        <tbody>${trs || ''}</tbody>
        <tfoot>
          <tr>
            <td style="text-align:right" colspan="4"><b>합계</b></td>
            <td><b>${totalValue.toLocaleString()}</b></td>
            <td class="${totalCls}"><b>${totalPl>=0?'+':''}${totalPl.toLocaleString()} (${totalPct}%)</b></td>
          </tr>
        </tfoot>
      </table>
    `;
  }

  // 개별 종목 실시간 구독 설정/정리
  function ensureStockListener(stockId){
    if (state.unsubs.has(stockId)) return; // 이미 있음
    const ref = fx.doc(db, 'stocks', stockId);
    const unsub = fx.onSnapshot(ref, snap => {
      if (!snap.exists()) return;
      const d = snap.data();
      state.prices.set(stockId, Number(d.current_price || 0));
      state.names.set(stockId, String(d.name || stockId));
      renderTable(); // 가격이 변할 때마다 표 즉시 갱신
    });
    state.unsubs.set(stockId, unsub);
  }
  function cleanupRemovedListeners(currentIds){
    for (const [id, unsub] of state.unsubs.entries()) {
      if (!currentIds.includes(id)) {
        try { unsub(); } catch(e){}
        state.unsubs.delete(id);
        state.prices.delete(id);
        state.names.delete(id);
      }
    }
  }

  // 내 포트폴리오 실시간 구독
  const q = fx.collection(db, `users/${uid}/portfolio`);
  state.portUnsub = fx.onSnapshot(q, (snap) => {
    state.positions = snap.docs.map(d => ({ id:d.id, ...d.data() }));
    const ids = state.positions.map(p => p.stock_id || p.id);
    ids.forEach(ensureStockListener);
    cleanupRemovedListeners(ids);
    renderTable(); // 수량/평단 변경 시에도 즉시 갱신
  });

  // 페이지 이동시 정리
  container.closest('#view').__cleanup = () => {
    if (state.portUnsub) try { state.portUnsub(); } catch(e){}
    for (const unsub of state.unsubs.values()) { try { unsub(); } catch(e){} }
    state.unsubs.clear();
  };
}
