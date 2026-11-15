import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { db, ROOT, getSettings, setSettings, todayIST, daysAgo } from './db.js';
import { summary, listOrders } from './summary.js';
import { syncAll, connections, lastSyncs, loadDemo, clearDemo, metaApp, metaAuthUrl, metaFinishAuth, metaStatus, metaRedirect } from './sync.js';
import { randomBytes } from 'node:crypto';

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
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const validDay = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '') ? d : todayIST();

async function api(req, res, url) {
  const { pathname: p, searchParams: q } = url;
  const m = req.method;

  if (p === '/api/summary' && m === 'GET') return send(res, 200, summary(num(q.get('days') ?? 30), q.get('from') || '', q.get('to') || ''));

  if (p === '/api/orders' && m === 'GET')
    return send(res, 200, listOrders({ days: num(q.get('days') ?? 30), status: q.get('status') || '', q: q.get('q') || '', from: q.get('from') || '', to: q.get('to') || '' }));

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
    return send(res, 200, db.prepare('SELECT * FROM ad_spend WHERE day >= ? ORDER BY day DESC, spend DESC').all(from));
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

  // Supplier wallet: for now just the money you added, i.e. Bank entries that are Money out + category Supplier.
  // Charges and payouts on orders are not tracked here yet.
  if (p === '/api/supplier-wallet' && m === 'GET') {
    const r = db.prepare("SELECT COALESCE(SUM(amount),0) total, COUNT(*) n, MAX(day) last FROM bank_txns WHERE type='out' AND category='Supplier'").get();
    return send(res, 200, { balance: r.total, entries: r.n, last: r.last });
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
    const total = db.prepare(`SELECT ${agg} FROM ad_spend WHERE day >= ? AND day <= ?`).get(from, to);
    const campaigns = db.prepare(`SELECT campaign, ${agg}, COUNT(DISTINCT day) days FROM ad_spend WHERE day >= ? AND day <= ? GROUP BY campaign ORDER BY spend DESC`).all(from, to);
    const daily = db.prepare(`SELECT day, ${agg} FROM ad_spend WHERE day >= ? AND day <= ? GROUP BY day ORDER BY day`).all(from, to);
    const k = qFrom ? summary(0, qFrom, qTo).kpi : summary(d).kpi;
    // Spend stays exactly as Ads Manager shows it (so CPC, CPM and ROAS match Meta). GST is a separate column.
    const gst = getSettings().ad_gst;
    const withGst = r => { r.gst_amount = (r.spend || 0) * gst / 100; r.total_cost = (r.spend || 0) + r.gst_amount; return r; };
    withGst(total); campaigns.forEach(withGst); daily.forEach(withGst);
    return send(res, 200, { from, to, gst, total, campaigns, daily, blended: { sales: k.sales, orders: k.placed, roas: k.roas, cpa: k.cpa } });
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
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream' });
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
  syncAll();
  setInterval(syncAll, SYNC_MIN * 60 * 1000);
});
