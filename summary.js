import { db, getSettings, daysAgo, todayIST, istDay, EFF_STATUS } from './db.js';
import { filterOrders, campaignWhere, scopeFor } from './scope.js';

function costMap() {
  const m = {};
  for (const p of db.prepare('SELECT title, cost FROM products').all()) m[p.title] = p.cost;
  return m;
}

// Money outcome of one order. Returns { profit, revenue, state }
//  delivered -> realised profit; rto -> realised loss; new/shipped -> expected profit (not realised); cancelled -> 0
export function orderEconomics(o, s, costs) {
  const net = s.price_incl_gst ? o.total * 100 / (100 + s.gst) : o.total;
  const unit = costs[o.product] ?? s.default_cost;
  const cod = o.payment === 'cod';
  const deliveredProfit =
    net - unit * (o.qty || 1) - s.ship
    - (cod ? s.cod_fee + o.total * s.cod_fee_pct / 100 : 0)
    - (cod ? 0 : o.total * s.gateway_pct / 100)
    - o.total * s.platform_pct / 100
    - s.pack;
  const rtoLoss = -(s.ship + s.return_ship + s.pack);

  if (o.status === 'delivered') return { profit: deliveredProfit, revenue: net, state: 'realised' };
  if (o.status === 'rto') return { profit: rtoLoss, revenue: 0, state: 'realised' };
  if (o.status === 'cancelled') return { profit: 0, revenue: 0, state: 'none' };
  // Not delivered or returned yet: show the plain profit this order makes once it is delivered (no RTO guess mixed in)
  return { profit: deliveredProfit, revenue: net, state: 'expected' };
}

export const STATUS_LABEL = { new: 'Placed', shipped: 'Shipped', delivered: 'Delivered', rto: 'RTO', cancelled: 'Cancelled' };

// One search box for the whole table. Every word typed must appear somewhere in the row:
// order, date, customer, phone, state, product, COD or prepaid, status, amount or profit: exactly the columns you see.
export function listOrders({ days = 30, status = '', q = '', from: fromOpt = '', to: toOpt = '', product = '' } = {}) {
  const s = getSettings(), costs = costMap();
  const valid = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
  const from = valid(fromOpt) ? fromOpt : days > 0 ? daysAgo(days - 1) : '0000-00-00';
  const to = valid(toOpt) ? toOpt : '9999-12-31';
  let rows = db.prepare(`SELECT o.*, ${EFF_STATUS} AS eff FROM orders o LEFT JOIN supplier_panel p ON p.order_name = o.name WHERE o.day >= ? AND o.day <= ? ORDER BY o.created_at DESC`).all(from, to)
    .map(o => { const x = { ...o, status: o.eff }; return { ...x, ...orderEconomics(x, s, costs) }; });
  rows = filterOrders(rows, product);
  if (status) rows = rows.filter(o => o.status === status);
  const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length) {
    rows = rows.filter(o => {
      const hay = [o.name, o.day, o.customer, o.phone, o.province, o.product, o.payment === 'cod' ? 'cod' : 'prepaid', STATUS_LABEL[o.status], o.status,
        Math.round(o.total), Math.round(o.profit)].join(' ').toLowerCase();
      return terms.every(w => hay.includes(w));
    });
  }
  return rows;
}

// Pass days for "last N days", or an explicit from/to (YYYY-MM-DD) for a custom window.
export function summary(days = 30, fromOpt = '', toOpt = '', product = '') {
  const s = getSettings(), costs = costMap();
  const valid = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
  // The first day with any order or ad spend. A "last 30 days" view never starts before this,
  // so days before the store existed are not counted (matters for fixed costs and the chart).
  const firstData = db.prepare(`SELECT MIN(d) d FROM (SELECT MIN(day) d FROM orders UNION ALL SELECT MIN(day) d FROM ad_spend)`).get().d || todayIST();
  let from = valid(fromOpt) ? fromOpt : days > 0 ? daysAgo(days - 1) : firstData;
  const to = valid(toOpt) ? toOpt : todayIST();
  if (from < firstData && firstData <= to) from = firstData;   // not before the store had any data (a day picked earlier than that stays as picked)
  const span = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1);

  const orders = db.prepare(`SELECT o.*, ${EFF_STATUS} AS eff, p.status AS panel_status FROM orders o LEFT JOIN supplier_panel p ON p.order_name = o.name WHERE o.day >= ? AND o.day <= ?`).all(from, to).map(o => ({ ...o, status: o.eff })).filter(o => !product || scopeFor(product).order(o.product));
  const cw = campaignWhere(product);
  const ads = db.prepare('SELECT day, SUM(spend) spend FROM ad_spend WHERE day >= ? AND day <= ?' + cw.sql + ' GROUP BY day').all(from, to, ...cw.params);
  const adByDay = Object.fromEntries(ads.map(a => [a.day, a.spend]));   // as shown in Ads Manager, GST kept separate

  const counts = { new: 0, shipped: 0, delivered: 0, rto: 0, cancelled: 0 };
  const daily = {};
  const day = d => (daily[d] ||= { day: d, orders: 0, revenue: 0, gross: 0, ads: 0, adGst: 0, salesProj: 0 });
  let revenue = 0, gross = 0, expected = 0, sales = 0, codOrders = 0;
  let salesIfDelivered = 0, salesDelivered = 0, rtoValue = 0;   // product sales (order totals) under the two views
  const statusValue = {}, byPayment = { cod: 0, prepaid: 0 }, byProduct = {};   // breakdowns of ALL orders, cancelled included

  for (const o of orders) {
    counts[o.status] = (counts[o.status] || 0) + 1;
    const e = orderEconomics(o, s, costs);
    const d = day(o.day);
    d.orders++;
    if (o.status !== 'cancelled') { sales += o.total; if (o.payment === 'cod') codOrders++; }
    statusValue[o.status] = (statusValue[o.status] || 0) + o.total;
    byPayment[o.payment] = (byPayment[o.payment] || 0) + 1;
    const bp = (byProduct[o.product] ||= { product: o.product, orders: 0, value: 0 });
    bp.orders++; bp.value += o.total;
    if (o.status === 'delivered') salesDelivered += o.total;
    if (o.status === 'rto') rtoValue += o.total;
    if (o.status !== 'cancelled' && o.status !== 'rto') { salesIfDelivered += o.total; d.salesProj += o.total; }   // Placed + Shipped + Delivered
    if (e.state === 'realised') { revenue += e.revenue; gross += e.profit; d.revenue += e.revenue; d.gross += e.profit; }
    else if (e.state === 'expected') expected += e.profit;
  }

  // Fill every day in range so the chart has no gaps
  for (let i = 0; i < span; i++) day(new Date(Date.parse(from) + i * 864e5).toISOString().slice(0, 10));
  let adSpend = 0;
  for (const [d, v] of Object.entries(adByDay)) { day(d).ads = v; day(d).adGst = v * s.ad_gst / 100; adSpend += v; }
  const adGst = adSpend * s.ad_gst / 100;

  const fixed = s.fixed_monthly / 30 * span;
  const net = gross - adSpend - adGst - fixed;
  // where the shipped orders are, according to Dropship India's panel
  const shipDetail = { out_for_delivery: 0, undelivered: 0, in_transit: 0 };
  for (const o of orders) if (o.status === 'shipped') { if (o.panel_status === 'OUT_FOR_DELIVERY') shipDetail.out_for_delivery++; else if (o.panel_status === 'UNDELIVERED') shipDetail.undelivered++; else shipDetail.in_transit++; }
  const settled = counts.delivered + counts.rto;
  const placed = orders.length - counts.cancelled;

  // Bank
  const bank = db.prepare('SELECT type, category, SUM(amount) amt FROM bank_txns WHERE day >= ? AND day <= ? GROUP BY type, category ORDER BY amt DESC').all(from, to);
  const bIn = bank.filter(b => b.type === 'in').reduce((a, b) => a + b.amt, 0);
  const bOut = bank.filter(b => b.type === 'out').reduce((a, b) => a + b.amt, 0);
  const all = db.prepare("SELECT COALESCE(SUM(CASE WHEN type='in' THEN amount ELSE -amount END),0) bal FROM bank_txns").get().bal;


  // Sales exactly the way Shopify's Sales report counts them:
  //   Gross sales = the products on each order, before discounts, on the day the order was placed
  //   Discounts   = taken off on the same day
  //   Returns     = every refund (a cancelled order that was refunded, or a return), on the day the refund was made
  //   Total sales = gross sales - discounts - returns
  // An earlier day never changes: if an order placed yesterday is cancelled and refunded today, today shows the deduction.
  const orderRows = filterOrders(db.prepare('SELECT id, name, day, created_at, status, total, gross_items, discounts, refunds_json, cancelled_at, cancel_reason, product FROM orders').all(), product);
  const dayMap = {};
  for (let i = 0; i < span; i++) dayMap[new Date(Date.parse(from) + i * 864e5).toISOString().slice(0, 10)] = { placed: 0, gross: 0, discounts: 0, returns: 0, returnOrders: 0 };
  const returnsList = [];
  for (const o of orderRows) {
    const disc = Number(o.discounts) || 0, gross = Number(o.gross_items) || o.total + disc;   // these two columns are stored as text
    const x = dayMap[o.day];
    if (x) { x.placed++; x.gross += gross; x.discounts += disc; }
    let refunds = []; try { refunds = JSON.parse(o.refunds_json || '[]'); } catch { /* none */ }
    // A cancel you set by hand on the Orders tab has no refund in Shopify, so it comes off on the day the order was placed
    if (!refunds.length && o.status === 'cancelled' && !o.cancelled_at) refunds = [{ at: o.created_at, amount: o.total }];
    for (const r of refunds) {
      const rd = istDay(r.at), y = dayMap[rd];
      if (y && r.amount > 0) { y.returns += r.amount; y.returnOrders++; returnsList.push({ name: o.name, placedDay: o.day, refundDay: rd, reason: o.cancel_reason || (o.status === 'cancelled' ? 'other' : 'return'), total: r.amount, cancelled: o.status === 'cancelled' }); }
    }
  }
  const sumOf = f => Object.values(dayMap).reduce((a, x) => a + x[f], 0);
  const byDay = Object.entries(dayMap).map(([day, x]) => ({ day, ...x, net: x.gross - x.discounts - x.returns })).reverse();   // newest day first
  // cancelled in Shopify but no refund record: Shopify's Sales report does not take these off
  const noRefund = orderRows.filter(o => o.status === 'cancelled' && o.cancelled_at && !(JSON.parse(o.refunds_json || '[]')).length)
    .filter(o => { const cd = istDay(o.cancelled_at); return cd >= from && cd <= to; });
  const cancelReasons = {};
  for (const r of returnsList.filter(r => r.cancelled)) { const k = r.reason || 'other'; (cancelReasons[k] ||= { orders: 0, value: 0 }); cancelReasons[k].orders++; cancelReasons[k].value += r.total; }
  const salesGross = sumOf('gross'), salesDiscounts = sumOf('discounts'), salesReturns = sumOf('returns');
  const shopifySales = {
    byDay, gross: salesGross, discounts: salesDiscounts, returns: salesReturns, net: salesGross - salesDiscounts - salesReturns, grossOrders: sumOf('placed'),
    returnOrders: returnsList.length, returnsFromEarlier: returnsList.filter(r => r.placedDay < from).length,
    byReason: cancelReasons,
    noRefund: { orders: noRefund.length, value: noRefund.reduce((a, o) => a + o.total, 0) },
    list: returnsList.sort((a, b) => b.refundDay.localeCompare(a.refundDay)).slice(0, 100)
  };

  return {
    from, to, span,
    kpi: {
      orders: orders.length, placed, sales,
      delivered: counts.delivered, rto: counts.rto,
      rtoRate: settled ? counts.rto / settled * 100 : 0,
      codShare: placed ? codOrders / placed * 100 : 0,
      revenue, gross, adSpend, adGst, fixed, net,
      expectedPending: expected,
      salesIfDelivered, salesDelivered, rtoValue,
      netIfDelivered: net + expected,    // net profit if every Placed and Shipped order ends up delivered
      settled,
      roas: adSpend ? sales / adSpend : 0,
      cpa: placed ? adSpend / placed : 0,
      profitPerOrder: placed ? net / placed : 0,
      bankBalance: s.opening_balance + all, bankIn: bIn, bankOut: bOut
    },
    counts, statusValue, byPayment, shipDetail,
    byProduct: Object.values(byProduct).sort((a, b) => b.orders - a.orders),
    daily: Object.values(daily).sort((a, b) => a.day.localeCompare(b.day)),
    bankByCategory: bank,
    shopifySales
  };
}
