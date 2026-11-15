import { db, getSettings, daysAgo, todayIST } from './db.js';
import { checkPincode } from './pincodes.js';

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

// ---------- Basic fraud / risk check ----------
// Hints for deciding which COD orders to confirm before shipping. A flag is not proof of fraud.
// Uses only what is stored: customer name, city, quantity, time and the outcome of the customer's other orders.
const WEIGHTS = { history: 2, repeat24h: 2, oddName: 2, riskyCity: 1, bulk: 1 };

function oddName(name) {
  const n = (name || '').trim();
  if (!n) return false;
  const words = n.split(/\s+/);
  return words.length < 2 || n.length < 4 || /[0-9_@#$%^&*<>]/.test(n) || /(.)\1{3,}/i.test(n)
    || words.some(w => w.length >= 4 && /^[^aeiouy]+$/i.test(w));
}

export function riskByOrder() {
  const all = db.prepare('SELECT id, customer, city, status, qty, created_at, zip, province, source FROM orders').all();
  const byCust = {}, byCity = {};
  for (const o of all) {
    const k = (o.customer || '').trim().toLowerCase();
    if (k) (byCust[k] ||= []).push(o);
    const c = (o.city || '').trim().toLowerCase();
    if (c) { const s = (byCity[c] ||= { n: 0, bad: 0 }); s.n++; if (o.status === 'cancelled' || o.status === 'rto') s.bad++; }
  }
  const out = {};
  for (const o of all) {
    const flags = []; let score = 0;
    const k = (o.customer || '').trim().toLowerCase();
    const others = k ? byCust[k].filter(x => x.id !== o.id) : [];
    const bad = others.filter(x => x.status === 'cancelled' || x.status === 'rto').length;
    if (bad) { flags.push(`Same customer has ${bad} other cancelled or returned order${bad > 1 ? 's' : ''}`); score += WEIGHTS.history; }
    const t = Date.parse(o.created_at);
    if (others.some(x => Math.abs(Date.parse(x.created_at) - t) <= 864e5)) { flags.push('Same customer ordered again within 24 hours'); score += WEIGHTS.repeat24h; }
    if (oddName(o.customer)) { flags.push('Name looks unusual'); score += WEIGHTS.oddName; }
    const cs = byCity[(o.city || '').trim().toLowerCase()];
    if (cs && cs.n >= 5 && cs.bad / cs.n >= 0.35) { flags.push(`City has ${cs.bad} cancelled or returned of ${cs.n} orders`); score += WEIGHTS.riskyCity; }
    if ((o.qty || 1) >= 3) { flags.push(`Large quantity (${o.qty} units)`); score += WEIGHTS.bulk; }
    for (const f of checkPincode(o)) { flags.push(f.text); score += f.weight; }   // pincode, state and city against India Post
    out[o.id] = { score, level: score >= 4 ? 'high' : score >= 2 ? 'medium' : score >= 1 ? 'low' : 'none', flags };
  }
  return out;
}

export function listOrders({ days = 30, status = '', q = '', from: fromOpt = '', to: toOpt = '' } = {}) {
  const s = getSettings(), costs = costMap();
  const valid = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
  const from = valid(fromOpt) ? fromOpt : days > 0 ? daysAgo(days - 1) : '0000-00-00';
  const to = valid(toOpt) ? toOpt : '9999-12-31';
  let rows = db.prepare('SELECT * FROM orders WHERE day >= ? AND day <= ? ORDER BY created_at DESC').all(from, to);
  if (status) rows = rows.filter(o => o.status === status);
  if (q) { const t = q.toLowerCase(); rows = rows.filter(o => `${o.name} ${o.customer || ''} ${o.city} ${o.product}`.toLowerCase().includes(t)); }
  const risk = riskByOrder();
  return rows.map(o => ({ ...o, ...orderEconomics(o, s, costs), risk: risk[o.id] }));
}

// Pass days for "last N days", or an explicit from/to (YYYY-MM-DD) for a custom window.
export function summary(days = 30, fromOpt = '', toOpt = '') {
  const s = getSettings(), costs = costMap();
  const valid = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
  // The first day with any order or ad spend. A "last 30 days" view never starts before this,
  // so days before the store existed are not counted (matters for fixed costs and the chart).
  const firstData = db.prepare(`SELECT MIN(d) d FROM (SELECT MIN(day) d FROM orders UNION ALL SELECT MIN(day) d FROM ad_spend)`).get().d || todayIST();
  let from = valid(fromOpt) ? fromOpt : days > 0 ? daysAgo(days - 1) : firstData;
  const to = valid(toOpt) ? toOpt : todayIST();
  if (from < firstData && firstData <= to) from = firstData;   // not before the store had any data (a day picked earlier than that stays as picked)
  const span = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1);

  const orders = db.prepare('SELECT * FROM orders WHERE day >= ? AND day <= ?').all(from, to);
  const ads = db.prepare('SELECT day, SUM(spend) spend FROM ad_spend WHERE day >= ? AND day <= ? GROUP BY day').all(from, to);
  const adByDay = Object.fromEntries(ads.map(a => [a.day, a.spend]));   // as shown in Ads Manager, GST kept separate

  const counts = { new: 0, shipped: 0, delivered: 0, rto: 0, cancelled: 0 };
  const daily = {};
  const day = d => (daily[d] ||= { day: d, orders: 0, revenue: 0, gross: 0, ads: 0, adGst: 0 });
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
    if (o.status !== 'cancelled' && o.status !== 'rto') salesIfDelivered += o.total;   // Placed + Shipped + Delivered
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
      salesIfDelivered, salesDelivered, rtoValue,
      netIfDelivered: net + expected,    // net profit if every Placed and Shipped order ends up delivered
      settled,
      roas: adSpend ? sales / adSpend : 0,
      cpa: placed ? adSpend / placed : 0,
      profitPerOrder: placed ? net / placed : 0,
      bankBalance: s.opening_balance + all, bankIn: bIn, bankOut: bOut
    },
    counts, statusValue, byPayment,
    byProduct: Object.values(byProduct).sort((a, b) => b.orders - a.orders),
    daily: Object.values(daily).sort((a, b) => a.day.localeCompare(b.day)),
    bankByCategory: bank
  };
}
