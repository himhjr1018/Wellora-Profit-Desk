import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { db, getSettings, daysAgo, ROOT, EFF_STATUS } from './db.js';
import { orderEconomics } from './summary.js';
import { loadGroups, has } from './scope.js';

// Per-product tracker. Orders join a product by a keyword in the Shopify title, ad campaigns by a keyword in the campaign name.
// Anything with no match goes to "Unassigned", so the products always add up to the whole store.
const FILE = path.join(ROOT, 'data', 'product-groups.json');
export function saveGroups(j) {
  const products = (j.products || []).filter(p => p && p.name).map(p => ({
    name: String(p.name), titles: (p.titles || []).map(String).filter(Boolean), campaigns: (p.campaigns || []).map(String).filter(Boolean),
    cost: p.cost !== '' && p.cost !== null && p.cost !== undefined && Number.isFinite(Number(p.cost)) ? Number(p.cost) : null,
    rto: p.rto !== '' && p.rto !== null && p.rto !== undefined && Number.isFinite(Number(p.rto)) ? Number(p.rto) : null }));
  writeFileSync(FILE, JSON.stringify({ products }, null, 2));
}

export function productTracker({ days = 30, from: fromOpt = '', to: toOpt = '' } = {}) {
  const valid = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
  const from = valid(fromOpt) ? fromOpt : days > 0 ? daysAgo(days - 1) : '0000-00-00';
  const to = valid(toOpt) ? toOpt : '9999-12-31';
  const s = getSettings(), cfg = loadGroups();
  const costTable = Object.fromEntries(db.prepare('SELECT title, cost FROM products').all().map(p => [p.title, p.cost]));
  const groups = [...cfg.products.map(p => ({ ...p, key: p.name })), { name: 'Unassigned', key: '', titles: [], campaigns: [], cost: null }];
  const by = Object.fromEntries(groups.map(g => [g.name, { name: g.name, orders: 0, cancelled: 0, delivered: 0, rto: 0, transit: 0, sales: 0, adSpend: 0, adGst: 0, realised: 0, expected: 0, campaigns: [], titles: {} }]));
  const pick = (text, field) => groups.find(g => g.key && has(text, g[field])) || groups[groups.length - 1];

  const orders = db.prepare(`SELECT o.name, o.day, o.product, o.total, o.qty, o.payment, ${EFF_STATUS} AS status FROM orders o LEFT JOIN supplier_panel p ON p.order_name = o.name WHERE o.day >= ? AND o.day <= ?`).all(from, to);
  for (const o of orders) {
    const g = pick(o.product, 'titles'), r = by[g.name];
    r.orders++; r.titles[o.product] = (r.titles[o.product] || 0) + 1;
    if (o.status === 'cancelled') { r.cancelled++; continue; }
    r.sales += o.total;
    const e = orderEconomics(o, s, { [o.product]: g.cost ?? costTable[o.product] ?? s.default_cost }, g.rto != null ? { [o.product]: g.rto } : {});
    if (o.status === 'delivered') { r.delivered++; r.realised += e.profit; }
    else if (o.status === 'rto') { r.rto++; r.realised += e.profit; }
    else { r.transit++; r.expected += e.profit; }
  }
  const unlinked = [];
  for (const a of db.prepare('SELECT campaign, SUM(spend) spend FROM ad_spend WHERE day >= ? AND day <= ? GROUP BY campaign').all(from, to)) {
    const g = pick(a.campaign, 'campaigns');
    if (!g.key) { unlinked.push({ campaign: a.campaign, spend: a.spend, spendGst: a.spend * (1 + s.ad_gst / 100) }); continue; }   // not a product campaign (for example followers): left out of the product tracker
    const r = by[g.name];
    r.adSpend += a.spend; r.adGst += a.spend * s.ad_gst / 100; r.campaigns.push({ campaign: a.campaign, spend: a.spend });
  }
  const rows = Object.values(by).filter(r => r.name !== 'Unassigned' || r.orders || r.adSpend).map(r => {
    const active = r.orders - r.cancelled, adTotal = r.adSpend + (s.ad_gst_claim ? 0 : r.adGst), settled = r.delivered + r.rto;
    return { ...r, active, adTotal, rtoRate: settled ? r.rto / settled * 100 : null, cpa: active ? r.adSpend / active : null, roas: r.adSpend ? r.sales / r.adSpend : null,
      net: r.realised - adTotal, netIfDelivered: r.realised + r.expected - adTotal, titles: Object.entries(r.titles).map(([title, n]) => ({ title, orders: n })) };
  });
  const sum = f => rows.reduce((a, r) => a + r[f], 0);
  const total = Object.fromEntries(['orders', 'cancelled', 'delivered', 'rto', 'transit', 'sales', 'adSpend', 'adGst', 'adTotal', 'realised', 'expected', 'net', 'netIfDelivered'].map(f => [f, sum(f)]));
  return { from, to, rows, total, unlinked, gstClaim: !!s.ad_gst_claim, config: cfg };
}
