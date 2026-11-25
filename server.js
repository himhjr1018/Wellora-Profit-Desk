import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { db, ROOT, getSettings, setSettings, todayIST, daysAgo } from './db.js';
import { summary, listOrders } from './summary.js';
import { syncAll, connections, lastSyncs, loadDemo, clearDemo, metaApp, metaAuthUrl, metaFinishAuth, metaStatus, metaRedirect } from './sync.js';
import { randomBytes } from 'node:crypto';
import { pincodeStatus } from './pincodes.js';
import { listRisk, setConfirm, blockOrder, blocklist, riskByOrder } from './risk.js';
import { buildXlsx } from './xlsx.js';
import { importSupplierCsv, statements, supplierOrders, deleteStatement, importPanel, panelRows, importWallet, walletTxns } from './supplier.js';
import { listTracking } from './tracking.js';
import { productTracker, saveGroups } from './products.js';
import { campaignWhere, loadGroups } from './scope.js';
import { healthCheck } from './health.js';

let metaState = null; // one-time value that ties the Meta login back to this app

const PORT = Number(process.env.PORT) || 3000;
const SYNC_MIN = Number(process.env.SYNC_MINUTES) || 30;
const PUB = path.join(ROOT, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const send = (res, code, data) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
};
const readBody = req => new Promise(resolve => {
  let b = '';
  req.on('data', c => (b += c));
  req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
});
// The Orders tab only needs these columns. Leaving out addresses, e-mails and refund data keeps the page small as orders grow.
const SLIM = ['id', 'name', 'day', 'created_at', 'customer', 'phone', 'province', 'product', 'payment', 'qty', 'total', 'status', 'manual', 'profit', 'revenue', 'state'];
const slim = rows => rows.map(o => Object.fromEntries(SLIM.map(k => [k, o[k]])));
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const validDay = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '') ? d : todayIST();

async function api(req, res, url) {
  const { pathname: p, searchParams: q } = url;
  const m = req.method;

  if (p === '/api/summary' && m === 'GET') return send(res, 200, summary(num(q.get('days') ?? 30), q.get('from') || '', q.get('to') || '', q.get('product') || ''));

  if (p === '/api/health' && m === 'GET') return send(res, 200, healthCheck());
  if (p === '/api/orders' && m === 'GET')
    return send(res, 200, slim(listOrders({ days: num(q.get('days') ?? 30), status: q.get('status') || '', q: q.get('q') || '', from: q.get('from') || '', to: q.get('to') || '', product: q.get('product') || '' })));

  // Excel export of the orders currently shown (same filters as the Orders tab)
  if (p === '/api/orders/export' && m === 'GET') {
    const rows = listOrders({ days: num(q.get('days') ?? 30), status: q.get('status') || '', q: q.get('q') || '', from: q.get('from') || '', to: q.get('to') || '', product: q.get('product') || '' });
    const STATUS = { new: 'Placed', shipped: 'Shipped', delivered: 'Delivered', rto: 'RTO', cancelled: 'Cancelled' };
    const buf = buildXlsx({
      sheet: 'Orders',
      headers: ['Order', 'Date', 'Customer', 'Contact number', 'State', 'Product', 'Payment', 'Amount (₹)', 'Status', 'Profit (₹)', 'Profit basis'],
      widths: [12, 12, 24, 18, 22, 40, 10, 13, 12, 13, 14],
      money: [7, 9],
      rows: rows.map(o => [o.name, o.day, o.customer || '', o.phone || '', o.province || '', o.product, o.payment === 'cod' ? 'COD' : 'Prepaid',
        Math.round(o.total * 100) / 100, STATUS[o.status] || o.status, Math.round(o.profit * 100) / 100,
        o.state === 'expected' ? 'If delivered' : o.state === 'realised' ? 'Final' : 'Cancelled'])
    });
    const range = q.get('from') && q.get('to') ? (q.get('from') === q.get('to') ? q.get('from') : `${q.get('from')}_to_${q.get('to')}`) : num(q.get('days') ?? 30) > 0 ? `last-${num(q.get('days') ?? 30)}-days` : 'all-time';
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="wellora-orders-${range}.xlsx"`,
      'Content-Length': buf.length
    });
    return res.end(buf);
  }

  let mm;
  if ((mm = p.match(/^\/api\/orders\/(.+)$/)) && m === 'PATCH') {
    const { status } = await readBody(req);
    if (!['new', 'shipped', 'delivered', 'rto', 'cancelled'].includes(status)) return send(res, 400, { error: 'bad status' });
    db.prepare('UPDATE orders SET status=?, manual=1 WHERE id=?').run(status, decodeURIComponent(mm[1]));
    return send(res, 200, { ok: true });
  }
  if (p === '/api/orders' && m === 'POST') {
    const b = await readBody(req);
    const id = 'manual:' + Date.now();
    db.prepare(`INSERT INTO orders(id,name,created_at,day,city,total,payment,product,qty,status,manual,source) VALUES(?,?,?,?,?,?,?,?,?,?,1,'manual')`)
      .run(id, b.name || '#' + id.slice(-5), new Date().toISOString(), validDay(b.day), b.city || '', num(b.total), b.payment === 'prepaid' ? 'prepaid' : 'cod', b.product || 'Unknown', Math.max(1, num(b.qty) || 1), b.status || 'new');
    return send(res, 200, { ok: true });
  }

  if (p === '/api/settings' && m === 'GET') return send(res, 200, getSettings());
  if (p === '/api/settings' && m === 'PUT') { setSettings(await readBody(req)); return send(res, 200, getSettings()); }

  if (p === '/api/products' && m === 'GET') {
    const s = getSettings();
    const rows = db.prepare(`SELECT o.product title, COUNT(*) orders, p.cost FROM orders o LEFT JOIN products p ON p.title=o.product GROUP BY o.product ORDER BY orders DESC`).all();
    return send(res, 200, rows.map(r => ({ ...r, cost: r.cost ?? null, effective: r.cost ?? s.default_cost })));
  }
  if (p === '/api/products' && m === 'PUT') {
    const { title, cost } = await readBody(req);
    if (cost === null || cost === '') db.prepare('DELETE FROM products WHERE title=?').run(title);
    else db.prepare('INSERT INTO products(title,cost) VALUES(?,?) ON CONFLICT(title) DO UPDATE SET cost=excluded.cost').run(title, num(cost));
    return send(res, 200, { ok: true });
  }

  if (p === '/api/ads' && m === 'GET') {
    const days = num(q.get('days') ?? 30);
    const from = days > 0 ? new Date(Date.now() - (days - 1) * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) : '0000-00-00';
    const cw = campaignWhere(q.get('product') || '');
    return send(res, 200, db.prepare('SELECT * FROM ad_spend WHERE day >= ?' + cw.sql + ' ORDER BY day DESC, spend DESC').all(from, ...cw.params));
  }
  if (p === '/api/ads' && m === 'POST') {
    const b = await readBody(req);
    db.prepare(`INSERT INTO ad_spend(day,campaign,spend,source) VALUES(?,?,?,'manual') ON CONFLICT(day,campaign) DO UPDATE SET spend=excluded.spend`)
      .run(validDay(b.day), b.campaign || 'Manual entry', num(b.spend));
    return send(res, 200, { ok: true });
  }
  // Prepaid Meta wallet: bank entries marked "Money out" + category "Ads" are recharges.
  // Meta's own daily deductions are never entered in the bank, they are the spend in the Meta data (plus GST).
  if (p === '/api/meta-funds' && m === 'GET') {
    const s = getSettings(), mul = 1 + s.ad_gst / 100;
    const rec = db.prepare("SELECT COALESCE(SUM(amount),0) total, COUNT(*) n, MAX(day) last FROM bank_txns WHERE type='out' AND category='Ads'").get();
    const metaSpend = db.prepare("SELECT COALESCE(SUM(spend),0) a FROM ad_spend WHERE COALESCE(source,'') != 'manual'").get().a;
    const recent = db.prepare("SELECT COALESCE(SUM(spend),0) a FROM ad_spend WHERE COALESCE(source,'') != 'manual' AND day >= ?").get(daysAgo(6)).a;
    const used = metaSpend * mul, balance = s.meta_opening_balance + rec.total - used, perDay = recent * mul / 7;
    return send(res, 200, { opening: s.meta_opening_balance, recharged: rec.total, recharges: rec.n, lastRecharge: rec.last, used, balance, perDay,
      daysLeft: perDay > 0 ? Math.max(0, balance) / perDay : null, gst: s.ad_gst });
  }

  // Match the dashboard's Meta balance to the figure shown in Meta billing ("available after your next balance payment").
  if (p === '/api/meta-funds/match' && m === 'POST') {
    const b = await readBody(req), actual = Number(b.actual);
    if (!Number.isFinite(actual)) return send(res, 400, { ok: false, error: 'Send {"actual": number}.' });
    const s = getSettings(), mul = 1 + s.ad_gst / 100;
    const rec = db.prepare("SELECT COALESCE(SUM(amount),0) total FROM bank_txns WHERE type='out' AND category='Ads'").get().total;
    const spent = db.prepare("SELECT COALESCE(SUM(spend),0) a FROM ad_spend WHERE COALESCE(source,'') != 'manual'").get().a;
    const opening = actual - rec + spent * mul;
    setSettings({ meta_opening_balance: opening.toFixed(2) });
    return send(res, 200, { ok: true, opening, balance: actual });
  }

  // Supplier wallet: for now just the money you added, i.e. Bank entries that are Money out + category Supplier.
  // Charges and payouts on orders are not tracked here yet.
  if (p === '/api/supplier-wallet' && m === 'GET') {
    const st = getSettings();
    const r = db.prepare("SELECT COALESCE(SUM(amount),0) total, COUNT(*) n, MAX(day) last FROM bank_txns WHERE type='out' AND category='Supplier'").get();
    const manual = db.prepare('SELECT COALESCE(SUM(amount),0) total, COUNT(*) n FROM supplier_charges').get();
    const stm = db.prepare('SELECT COALESCE(SUM(final),0) total, COUNT(*) n FROM supplier_statements').get();
    const latest = db.prepare('SELECT date, hold_current, hold_prev FROM supplier_statements ORDER BY date DESC, id DESC LIMIT 1').get() || null;
    // Optional: take the RTO charge off automatically, only for RTO orders that no payout statement already covers
    const rto = db.prepare("SELECT COUNT(*) n FROM orders WHERE status = 'rto' AND name NOT IN (SELECT order_name FROM supplier_orders)").get().n;
    const autoOn = st.supplier_auto_rto === 1;
    const rtoCharges = autoOn ? rto * st.supplier_rto_charge : 0;
    return send(res, 200, { added: r.total, entries: r.n, last: r.last, manualCharges: manual.total, manualCount: manual.n,
      statementsNet: stm.total, statementsCount: stm.n, latestStatement: latest,
      autoOn, rtoOrders: rto, rtoRate: st.supplier_rto_charge, rtoCharges, adjust: st.supplier_adjust,
      balance: r.total + stm.total - manual.total - rtoCharges + st.supplier_adjust,
      balanceBeforeAdjust: r.total + stm.total - manual.total - rtoCharges,
      snapshot: db.prepare('SELECT * FROM supplier_snapshots ORDER BY day DESC, id DESC LIMIT 1').get() || null,
      received: db.prepare("SELECT COALESCE(SUM(amount),0) a FROM bank_txns WHERE type='in' AND category='Supplier payout'").get().a });
  }
  // ---- Supplier payout statements (the CSV from Dropship India) ----
  if (p === '/api/supplier/import' && m === 'POST') {
    const b = await readBody(req);
    if (!b.text || typeof b.text !== 'string') return send(res, 400, { ok: false, error: 'No file content received.' });
    try { return send(res, 200, importSupplierCsv(b.text, String(b.name || ''))); }
    catch (e) { return send(res, 500, { ok: false, error: e.message }); }
  }
  if (p === '/api/supplier/panel-sync' && m === 'POST') {
    const b = await readBody(req);
    try { return send(res, 200, { ok: true, ...importPanel(b.rows) }); }
    catch (e) { return send(res, 400, { ok: false, error: e.message }); }
  }
  if (p === '/api/supplier/wallet-sync' && m === 'POST') {
    try { return send(res, 200, importWallet(await readBody(req))); }
    catch (e) { return send(res, 400, { ok: false, error: e.message }); }
  }
  if (p === '/api/supplier/wallet-txns' && m === 'GET') return send(res, 200, walletTxns());
  if (p === '/api/supplier/panel' && m === 'GET') return send(res, 200, panelRows());
  if (p === '/api/supplier/statements' && m === 'GET') return send(res, 200, statements());
  if (p === '/api/supplier/orders' && m === 'GET') return send(res, 200, supplierOrders());
  if ((mm = p.match(/^\/api\/supplier\/statements\/(\d+)$/)) && m === 'DELETE') { deleteStatement(Number(mm[1])); return send(res, 200, { ok: true }); }
  if (p === '/api/supplier-snapshots' && m === 'GET') return send(res, 200, db.prepare('SELECT * FROM supplier_snapshots ORDER BY day DESC, id DESC').all());
  if (p === '/api/supplier-snapshots' && m === 'POST') {
    const b = await readBody(req);
    const f = v => (v === '' || v === null || v === undefined ? null : Number(v));
    if (![b.balance, b.outstanding, b.payments, b.withdrawn].some(v => f(v) !== null && Number.isFinite(f(v)))) return send(res, 400, { error: 'enter at least one number' });
    db.prepare('INSERT INTO supplier_snapshots(day,balance,outstanding,payments,withdrawn,note,created) VALUES(?,?,?,?,?,?,?)')
      .run(validDay(b.day), f(b.balance), f(b.outstanding), f(b.payments), f(b.withdrawn), String(b.note || '').slice(0, 200), new Date().toISOString());
    return send(res, 200, { ok: true });
  }
  if ((mm = p.match(/^\/api\/supplier-snapshots\/(\d+)$/)) && m === 'DELETE') { db.prepare('DELETE FROM supplier_snapshots WHERE id=?').run(Number(mm[1])); return send(res, 200, { ok: true }); }
  if (p === '/api/supplier-charges' && m === 'GET') return send(res, 200, db.prepare('SELECT * FROM supplier_charges ORDER BY day DESC, id DESC').all());
  if (p === '/api/supplier-charges' && m === 'POST') {
    const b = await readBody(req);
    const TYPES = ['RTO charge', 'Product cost', 'COD fee', 'Other charge'];
    if (!(num(b.amount) > 0)) return send(res, 400, { error: 'amount must be above 0' });
    db.prepare('INSERT INTO supplier_charges(day,type,amount,orderRef,note,created) VALUES(?,?,?,?,?,?)')
      .run(validDay(b.day), TYPES.includes(b.type) ? b.type : 'Other charge', num(b.amount), String(b.orderRef || '').slice(0, 40), String(b.note || '').slice(0, 200), new Date().toISOString());
    return send(res, 200, { ok: true });
  }
  if ((mm = p.match(/^\/api\/supplier-charges\/(\d+)$/)) && m === 'DELETE') {
    db.prepare('DELETE FROM supplier_charges WHERE id=?').run(Number(mm[1]));
    return send(res, 200, { ok: true });
  }

  if (p === '/api/meta' && m === 'GET') {
    const d = num(q.get('days') ?? 30);
    // Either ?days=N, or an explicit ?from=YYYY-MM-DD&to=YYYY-MM-DD window (used by the day pickers)
    const ok = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
    const qFrom = ok(q.get('from')) ? q.get('from') : '', qTo = ok(q.get('to')) ? q.get('to') : '';
    const from = qFrom || (d > 0 ? new Date(Date.now() - (d - 1) * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) : '0000-00-00');
    const to = qTo || '9999-12-31';
    // spend_i / spend_c / spend_p = spend only on rows that have impressions / clicks / purchase data,
    // so a ratio never mixes in days where that metric was not imported.
    const agg = `SUM(spend) spend, SUM(impressions) impressions, SUM(clicks) clicks, SUM(reach) reach, SUM(purchases) purchases, SUM(purchase_value) value,
      SUM(CASE WHEN impressions IS NOT NULL THEN spend END) spend_i, SUM(CASE WHEN clicks IS NOT NULL THEN spend END) spend_c,
      SUM(CASE WHEN purchase_value IS NOT NULL THEN spend END) spend_v, SUM(CASE WHEN purchases IS NOT NULL THEN spend END) spend_p`;
    const product = q.get('product') || '', cw = campaignWhere(product);
    const total = db.prepare(`SELECT ${agg} FROM ad_spend WHERE day >= ? AND day <= ?${cw.sql}`).get(from, to, ...cw.params);
    const campaigns = db.prepare(`SELECT campaign, ${agg}, COUNT(DISTINCT day) days FROM ad_spend WHERE day >= ? AND day <= ?${cw.sql} GROUP BY campaign ORDER BY spend DESC`).all(from, to, ...cw.params);
    const daily = db.prepare(`SELECT day, ${agg} FROM ad_spend WHERE day >= ? AND day <= ?${cw.sql} GROUP BY day ORDER BY day`).all(from, to, ...cw.params);
    const k = qFrom ? summary(0, qFrom, qTo, product).kpi : summary(d, '', '', product).kpi;
    // Spend stays exactly as Ads Manager shows it (so CPC, CPM and ROAS match Meta). GST is a separate column.
    const gst = getSettings().ad_gst;
    const withGst = r => { r.gst_amount = (r.spend || 0) * gst / 100; r.total_cost = (r.spend || 0) + r.gst_amount; return r; };
    withGst(total); campaigns.forEach(withGst); daily.forEach(withGst);
    return send(res, 200, { from, to, gst, gstClaim: getSettings().ad_gst_claim === 1, total, campaigns, daily, blended: { sales: k.sales, orders: k.placed, roas: k.roas, cpa: k.cpa } });
  }
  if (p === '/api/ads/import' && m === 'POST') {
    const { rows } = await readBody(req);
    if (!Array.isArray(rows)) return send(res, 400, { error: 'no rows' });
    const st = db.prepare(`INSERT INTO ad_spend(day,campaign,spend,source,impressions,clicks,reach,purchases,purchase_value) VALUES(?,?,?,'csv',?,?,?,?,?)
      ON CONFLICT(day,campaign) DO UPDATE SET spend=excluded.spend, source='csv',
        impressions=COALESCE(excluded.impressions, ad_spend.impressions), clicks=COALESCE(excluded.clicks, ad_spend.clicks),
        reach=COALESCE(excluded.reach, ad_spend.reach), purchases=COALESCE(excluded.purchases, ad_spend.purchases),
        purchase_value=COALESCE(excluded.purchase_value, ad_spend.purchase_value)`);
    const opt = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
    let n = 0;
    db.exec('BEGIN');
    try {
      for (const r of rows) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(r.day || '') || !(num(r.spend) >= 0)) continue;
        st.run(r.day, String(r.campaign || 'Meta CSV import').slice(0, 200), num(r.spend), opt(r.impressions), opt(r.clicks), opt(r.reach), opt(r.purchases), opt(r.purchase_value)); n++;
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return send(res, 200, { imported: n });
  }
  if (p === '/api/ads' && m === 'DELETE') {
    db.prepare('DELETE FROM ad_spend WHERE day=? AND campaign=?').run(q.get('day'), q.get('campaign'));
    return send(res, 200, { ok: true });
  }

  if (p === '/api/bank' && m === 'GET') {
    const days = num(q.get('days') ?? 30);
    const ok = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
    const from = ok(q.get('from')) ? q.get('from') : days > 0 ? new Date(Date.now() - (days - 1) * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) : '0000-00-00';
    const to = ok(q.get('to')) ? q.get('to') : '9999-12-31';
    return send(res, 200, db.prepare('SELECT * FROM bank_txns WHERE day >= ? AND day <= ? ORDER BY day DESC, id DESC').all(from, to));
  }
  if (p === '/api/bank' && m === 'POST') {
    const b = await readBody(req);
    if (!(num(b.amount) > 0)) return send(res, 400, { error: 'amount must be above 0' });
    db.prepare(`INSERT INTO bank_txns(day,type,amount,category,note,source) VALUES(?,?,?,?,?,'manual')`)
      .run(validDay(b.day), b.type === 'in' ? 'in' : 'out', num(b.amount), b.category || 'Other', b.note || '');
    return send(res, 200, { ok: true });
  }
  if ((mm = p.match(/^\/api\/bank\/(\d+)$/)) && m === 'DELETE') {
    db.prepare('DELETE FROM bank_txns WHERE id=?').run(Number(mm[1]));
    return send(res, 200, { ok: true });
  }

  // ---- Live tracking: placed, dispatched by Dropship India (courier and tracking number), delivered, returned ----
  if (p === '/api/tracking' && m === 'GET')
    return send(res, 200, listTracking({ days: num(q.get('days') ?? 30), from: q.get('from') || '', to: q.get('to') || '', product: q.get('product') || '' }));

  // ---- Products tab ----
  if (p === '/api/products-tracker' && m === 'GET')
    return send(res, 200, productTracker({ days: num(q.get('days') ?? 30), from: q.get('from') || '', to: q.get('to') || '' }));
  if (p === '/api/products-tracker/config' && m === 'GET') return send(res, 200, loadGroups());
  if (p === '/api/products-tracker/config' && m === 'PUT') { saveGroups(await readBody(req)); return send(res, 200, { ok: true }); }

  // Excel export of the Live tracking rows currently shown (same stage chip and search as the tab)
  if (p === '/api/tracking/export' && m === 'GET') {
    const STAGE = { awaiting: 'Placed', in_transit: 'Shipped', out_for_delivery: 'Out for delivery', undelivered: 'Undelivered', delivered: 'Delivered', rto: 'RTO', cancelled: 'Cancelled' };
    const stage = q.get('stage') || '', terms = String(q.get('q') || '').toLowerCase().split(/\s+/).filter(Boolean);
    const rows = listTracking({ days: num(q.get('days') ?? 30), from: q.get('from') || '', to: q.get('to') || '', product: q.get('product') || '' }).rows
      .filter(o => (!stage || (stage === 'attention' ? o.alerts.length : o.stage === stage))
        && terms.every(w => [o.name, o.customer, o.phone, o.province, o.courier, o.tracking_no, STAGE[o.stage]].join(' ').toLowerCase().includes(w)));
    const ist = iso => iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    const buf = buildXlsx({
      sheet: 'Live tracking',
      headers: ['Order', 'Placed', 'Customer', 'Contact number', 'State', 'Payment', 'Amount (₹)', 'Stage', 'Dropship India status', 'Status date', 'Courier', 'Tracking number', 'Shipped after (hours)', 'Alert'],
      widths: [12, 20, 24, 16, 22, 10, 12, 16, 24, 20, 18, 22, 14, 44],
      money: [6],
      rows: rows.map(o => [o.name, ist(o.created_at), o.customer || '', o.phone || '', o.province || '', o.payment === 'cod' ? 'COD' : 'Prepaid',
        Math.round(o.total * 100) / 100, STAGE[o.stage], (o.panel_status || '').replace(/_/g, ' ').toLowerCase(), ist(o.panel_at), o.courier || '', o.tracking_no || '',
        o.dispatchHours === null ? '' : Math.round(o.dispatchHours * 10) / 10, o.alerts.join('; ')])
    });
    const range = q.get('from') && q.get('to') ? (q.get('from') === q.get('to') ? q.get('from') : `${q.get('from')}_to_${q.get('to')}`) : num(q.get('days') ?? 30) > 0 ? `last-${num(q.get('days') ?? 30)}-days` : 'all-time';
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="wellora-live-tracking-${range}.xlsx"`,
      'Content-Length': buf.length
    });
    return res.end(buf);
  }

  // ---- Risk tab ----
  if (p === '/api/risk' && m === 'GET')
    return send(res, 200, listRisk({ days: num(q.get('days') ?? 30), from: q.get('from') || '', to: q.get('to') || '', product: q.get('product') || '' }));
  if (p === '/api/risk/confirm' && m === 'POST') {
    const b = await readBody(req);
    return send(res, setConfirm(String(b.id || ''), b.value ?? '') ? 200 : 400, { ok: true });
  }
  if (p === '/api/risk/block' && m === 'POST') {
    const b = await readBody(req);
    return send(res, 200, { added: blockOrder(String(b.id || ''), String(b.note || '')) });
  }
  if (p === '/api/blocklist' && m === 'GET') return send(res, 200, blocklist());
  if ((mm = p.match(/^\/api\/blocklist\/(\d+)$/)) && m === 'DELETE') {
    db.prepare('DELETE FROM blocklist WHERE id=?').run(Number(mm[1]));
    return send(res, 200, { ok: true });
  }
  if (p === '/api/pincode-status') return send(res, 200, pincodeStatus());
  if (p === '/api/status') return send(res, 200, { connections: connections(), meta: { ...metaStatus(), redirectUri: metaRedirect() }, syncs: lastSyncs(), syncMinutes: SYNC_MIN });
  if (p === '/api/sync' && m === 'POST') return send(res, 200, await syncAll());
  if (p === '/api/demo' && m === 'POST') { loadDemo(); return send(res, 200, { ok: true }); }
  if (p === '/api/demo' && m === 'DELETE') { clearDemo(); return send(res, 200, { ok: true }); }

  return send(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/auth/meta/start') {
      if (!(metaApp().id && metaApp().secret)) { res.writeHead(302, { Location: '/#settings' }); return res.end(); }
      metaState = randomBytes(16).toString('hex');
      res.writeHead(302, { Location: metaAuthUrl(metaState) });
      return res.end();
    }
    if (url.pathname === '/auth/meta/callback') {
      const code = url.searchParams.get('code');
      const ok = code && metaState && url.searchParams.get('state') === metaState;
      metaState = null;
      let msg = '';
      if (!ok) msg = url.searchParams.get('error_description') || 'Login was cancelled or could not be verified.';
      else { try { await metaFinishAuth(code); syncAll(); } catch (e) { msg = e.message; } }
      res.writeHead(302, { Location: '/#settings' + (msg ? '?meta_error=' + encodeURIComponent(msg) : '') });
      return res.end();
    }
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    let f = url.pathname === '/' ? '/index.html' : url.pathname;
    const full = path.normalize(path.join(PUB, f));
    if (!full.startsWith(PUB)) { res.writeHead(403); return res.end(); }
    const data = await readFile(full);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch (e) {
    if (e.code === 'ENOENT') { res.writeHead(404); return res.end('Not found'); }
    console.error(e);
    send(res, 500, { error: e.message });
  }
});

// Bound to localhost only: this app holds your business data and API tokens.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Wellora Profit Desk running at http://localhost:${PORT}`);
  const c = connections();
  console.log(`Shopify: ${c.shopify ? 'connected' : 'not connected'} | Meta Ads: ${c.meta ? 'connected' : 'not connected'} | auto-sync every ${SYNC_MIN} min`);
  setTimeout(() => { try { riskByOrder(); } catch { /* warm the pincode list so the Risk tab opens fast */ } }, 3000);
  syncAll();
  setInterval(syncAll, SYNC_MIN * 60 * 1000);
});
