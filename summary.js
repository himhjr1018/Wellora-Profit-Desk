import { db, getSettings, daysAgo, todayIST } from './db.js';

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
    - (cod ? s.cod_fee : 0)
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

export function listOrders({ days = 30, status = '', q = '' } = {}) {
  const s = getSettings(), costs = costMap();
  const from = days > 0 ? daysAgo(days - 1) : '0000-00-00';
  let rows = db.prepare('SELECT * FROM orders WHERE day >= ? ORDER BY created_at DESC').all(from);
  if (status) rows = rows.filter(o => o.status === status);
  if (q) { const t = q.toLowerCase(); rows = rows.filter(o => `${o.name} ${o.customer || ''} ${o.city} ${o.product}`.toLowerCase().includes(t)); }
  return rows.map(o => ({ ...o, ...orderEconomics(o, s, costs) }));
}

// Pass days for "last N days", or an explicit from/to (YYYY-MM-DD) for a custom window.
export function summary(days = 30, fromOpt = '', toOpt = '') {
  const s = getSettings(), costs = costMap();
  const valid = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
  const from = valid(fromOpt) ? fromOpt : days > 0 ? daysAgo(days - 1) : (db.prepare('SELECT MIN(day) d FROM orders').get().d || todayIST());
  const to = valid(toOpt) ? toOpt : todayIST();
  const span = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1);

  const orders = db.prepare('SELECT * FROM orders WHERE day >= ? AND day <= ?').all(from, to);
  const ads = db.prepare('SELECT day, SUM(spend) spend FROM ad_spend WHERE day >= ? AND day <= ? GROUP BY day').all(from, to);
  const adByDay = Object.fromEntries(ads.map(a => [a.day, a.spend]));   // as shown in Ads Manager, GST kept separate

  const counts = { new: 0, shipped: 0, delivered: 0, rto: 0, cancelled: 0 };
  const daily = {};
  const day = d => (daily[d] ||= { day: d, orders: 0, revenue: 0, gross: 0, ads: 0, adGst: 0 });
  let revenue = 0, gross = 0, expected = 0, sales = 0, codOrders = 0;

  for (const o of orders) {
    counts[o.status] = (counts[o.status] || 0) + 1;
    const e = orderEconomics(o, s, costs);
    const d = day(o.day);
    d.orders++;
    if (o.status !== 'cancelled') { sales += o.total; if (o.payment === 'cod') codOrders++; }
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
  const settled = counts.delivered + counts.rto;
  const placed = orders.length - counts.cancelled;

  // Bank
  const bank = db.prepare('SELECT type, category, SUM(amount) amt FROM bank_txns WHERE day >= ? AND day <= ? GROUP BY type, category ORDER BY amt DESC').all(from, to);
  const bIn = bank.filter(b => b.type === 'in').reduce((a, b) => a + b.amt, 0);
  const bOut = bank.filter(b => b.type === 'out').reduce((a, b) => a + b.amt, 0);
  const all = db.prepare("SELECT COALESCE(SUM(CASE WHEN type='in' THEN amount ELSE -amount END),0) bal FROM bank_txns").get().bal;

  return {
    from, to, span,
    kpi: {
      orders: orders.length, placed, sales,
      delivered: counts.delivered, rto: counts.rto,
      rtoRate: settled ? counts.rto / settled * 100 : 0,
      codShare: placed ? codOrders / placed * 100 : 0,
      revenue, gross, adSpend, adGst, fixed, net,
      expectedPending: expected,
      roas: adSpend ? sales / adSpend : 0,
      cpa: placed ? adSpend / placed : 0,
      profitPerOrder: placed ? net / placed : 0,
      bankBalance: s.opening_balance + all, bankIn: bIn, bankOut: bOut
    },
    counts,
    daily: Object.values(daily).sort((a, b) => a.day.localeCompare(b.day)),
    bankByCategory: bank
  };
}
