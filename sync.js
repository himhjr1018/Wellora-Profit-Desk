import { db, istDay, daysAgo, todayIST } from './db.js';

const log = (source, ok, message) =>
  db.prepare('INSERT INTO sync_log(at, source, ok, message) VALUES(?,?,?,?)').run(new Date().toISOString(), source, ok ? 1 : 0, message);

const shopifyStore = () => (process.env.SHOPIFY_STORE || '').replace(/^https?:\/\//, '').replace(/\/$/, '');

// Dev Dashboard apps: exchange client ID + secret for a short-lived (about 24h) Admin API token.
// A static SHOPIFY_TOKEN (older custom apps) still works if you have one.
let cached = { token: null, exp: 0 };
async function shopifyToken() {
  if (process.env.SHOPIFY_TOKEN) return process.env.SHOPIFY_TOKEN;
  if (cached.token && Date.now() < cached.exp - 60_000) return cached.token;
  const res = await fetch(`https://${shopifyStore()}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET,
      grant_type: 'client_credentials'
    })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error(`Shopify token request failed (${res.status}): ${JSON.stringify(body).slice(0, 200)}`);
  cached = { token: body.access_token, exp: Date.now() + (body.expires_in || 86400) * 1000 };
  return cached.token;
}

// ---------- Meta token storage (set by the "Connect Meta" button, or META_TOKEN in .env) ----------
const kvGet = k => db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value;
const kvSet = (k, v) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));

export function metaToken() {
  const stored = kvGet('meta_token');
  if (stored) return { token: stored, exp: Number(kvGet('meta_token_exp')) || 0, from: 'button' };
  if (process.env.META_TOKEN) return { token: process.env.META_TOKEN, exp: 0, from: 'env' };
  return null;
}
export const metaApp = () => ({ id: process.env.META_APP_ID, secret: process.env.META_APP_SECRET });
export const metaRedirect = () => `http://localhost:${process.env.PORT || 3000}/auth/meta/callback`;

export function metaAuthUrl(state) {
  const { id } = metaApp();
  return `https://www.facebook.com/v21.0/dialog/oauth?client_id=${encodeURIComponent(id)}&redirect_uri=${encodeURIComponent(metaRedirect())}&scope=ads_read&state=${state}`;
}

// Exchange the login code for a long-lived (about 60 days) token and store it.
export async function metaFinishAuth(code) {
  const { id, secret } = metaApp();
  const get = async url => {
    const r = await fetch(url); const b = await r.json();
    if (!r.ok) throw new Error(b.error?.message || `Meta ${r.status}`);
    return b;
  };
  const short = await get(`https://graph.facebook.com/v21.0/oauth/access_token?client_id=${id}&redirect_uri=${encodeURIComponent(metaRedirect())}&client_secret=${secret}&code=${encodeURIComponent(code)}`);
  const long = await get(`https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${id}&client_secret=${secret}&fb_exchange_token=${short.access_token}`);
  kvSet('meta_token', long.access_token);
  kvSet('meta_token_exp', Date.now() + (long.expires_in || 5184000) * 1000);
}

export function metaStatus() {
  const t = metaToken();
  const app = metaApp();
  return {
    configured: !!(app.id && app.secret),
    connected: !!(t && process.env.META_AD_ACCOUNT_ID),
    expiresAt: t?.exp || null,
    expired: !!(t && t.exp && t.exp < Date.now()),
    hasAccount: !!process.env.META_AD_ACCOUNT_ID
  };
}

export const connections = () => ({
  shopify: !!(process.env.SHOPIFY_STORE && (process.env.SHOPIFY_TOKEN || (process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET))),
  meta: metaStatus().connected
});

// ---------- Shopify ----------
function mapOrder(o) {
  const gateways = (o.payment_gateway_names || []).join(' ').toLowerCase();
  const tags = (o.tags || '').toLowerCase();
  let status = 'new';
  if (o.cancelled_at) status = 'cancelled';
  else if (/\brto\b/.test(tags)) status = 'rto';
  else if (/\bdelivered\b/.test(tags)) status = 'delivered';
  else if (o.fulfillment_status === 'fulfilled') status = 'shipped';
  const items = o.line_items || [];
  return {
    id: 'shopify:' + o.id,
    name: o.name,
    created_at: o.created_at,
    day: istDay(o.created_at),
    city: o.shipping_address?.city || '',
    phone: o.shipping_address?.phone || o.phone || o.customer?.phone || o.billing_address?.phone || '',
    email: o.email || o.customer?.email || '',
    address: [o.shipping_address?.address1, o.shipping_address?.address2].filter(Boolean).join(', '),
    ip: o.browser_ip || '',
    discount: (o.discount_codes || []).map(c => c.code).filter(Boolean).join(', '),
    zip: String(o.shipping_address?.zip || '').replace(/\s+/g, ''),
    province: o.shipping_address?.province || '',
    customer: [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(' ').trim()
      || o.shipping_address?.name || o.billing_address?.name || '',
    total: parseFloat(o.total_price) || 0,
    payment: /cod|cash on delivery/.test(gateways) ? 'cod' : 'prepaid',
    product: items[0]?.title || 'Unknown',
    qty: items.reduce((a, i) => a + (i.quantity || 0), 0) || 1,
    status
  };
}

export async function syncShopify() {
  const store = shopifyStore();
  const token = await shopifyToken();
  const since = new Date(Date.now() - 90 * 864e5).toISOString();
  let url = `https://${store}/admin/api/2024-10/orders.json?status=any&limit=250&created_at_min=${encodeURIComponent(since)}`;
  const up = db.prepare(`
    INSERT INTO orders(id,name,created_at,day,city,total,payment,product,qty,status,manual,source,customer,zip,province,phone,email,address,ip,discount)
    VALUES(?,?,?,?,?,?,?,?,?,?,0,'shopify',?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      zip=COALESCE(NULLIF(excluded.zip,''), orders.zip), province=COALESCE(NULLIF(excluded.province,''), orders.province),
      phone=COALESCE(NULLIF(excluded.phone,''), orders.phone), email=COALESCE(NULLIF(excluded.email,''), orders.email),
      address=COALESCE(NULLIF(excluded.address,''), orders.address), ip=COALESCE(NULLIF(excluded.ip,''), orders.ip),
      discount=COALESCE(NULLIF(excluded.discount,''), orders.discount),
      total=excluded.total, payment=excluded.payment, product=excluded.product, qty=excluded.qty, city=excluded.city,
      customer=COALESCE(NULLIF(excluded.customer,''), orders.customer),
      status=CASE WHEN orders.manual=1 THEN orders.status ELSE excluded.status END`);
  let n = 0;
  while (url) {
    const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
    if (!res.ok) throw new Error(`Shopify ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const { orders } = await res.json();
    for (const raw of orders) {
      const o = mapOrder(raw);
      up.run(o.id, o.name, o.created_at, o.day, o.city, o.total, o.payment, o.product, o.qty, o.status, o.customer, o.zip, o.province, o.phone, o.email, o.address, o.ip, o.discount);
      n++;
    }
    const next = (res.headers.get('link') || '').match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }
  return n;
}

// ---------- Meta Ads ----------
export async function syncMeta() {
  const id = process.env.META_AD_ACCOUNT_ID.replace(/^act_/, '');
  const t = metaToken();
  if (t.exp && t.exp < Date.now()) throw new Error('Meta login expired. Click "Connect Meta" in Settings to reconnect.');
  const range = JSON.stringify({ since: daysAgo(30), until: todayIST() });
  let url = `https://graph.facebook.com/v21.0/act_${id}/insights?level=campaign&fields=campaign_name,spend&time_increment=1&limit=500`
    + `&time_range=${encodeURIComponent(range)}&access_token=${encodeURIComponent(t.token)}`;
  const up = db.prepare(`INSERT INTO ad_spend(day,campaign,spend,source) VALUES(?,?,?,'meta')
    ON CONFLICT(day,campaign) DO UPDATE SET spend=excluded.spend, source='meta'`);
  let n = 0;
  while (url) {
    const res = await fetch(url);
    const body = await res.json();
    if (!res.ok) throw new Error(`Meta ${res.status}: ${body.error?.message || 'request failed'}`);
    for (const r of body.data || []) { up.run(r.date_start, r.campaign_name, parseFloat(r.spend) || 0); n++; }
    url = body.paging?.next || null;
  }
  return n;
}

let running = false;
export async function syncAll() {
  if (running) return { skipped: 'already running' };
  running = true;
  const result = {};
  try {
    const c = connections();
    for (const [name, fn] of [['shopify', syncShopify], ['meta', syncMeta]]) {
      if (!c[name]) { result[name] = 'not connected'; continue; }
      try { const n = await fn(); result[name] = `${n} rows`; log(name, true, `${n} rows`); }
      catch (e) { result[name] = 'error: ' + e.message; log(name, false, e.message); }
    }
  } finally { running = false; }
  return result;
}

export function lastSyncs() {
  return db.prepare(`SELECT source, at, ok, message FROM sync_log WHERE id IN (SELECT MAX(id) FROM sync_log GROUP BY source)`).all();
}

// ---------- Demo data ----------
export function loadDemo() {
  clearDemo();
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const products = [['Posture Corrector Belt', 899, 260], ['LED Galaxy Projector', 1299, 420], ['Magnetic Phone Holder', 599, 150], ['Portable Neck Fan', 999, 340]];
  const cities = ['Mumbai', 'Delhi', 'Bengaluru', 'Jaipur', 'Lucknow', 'Patna', 'Pune', 'Indore', 'Kolkata', 'Hyderabad'];
  const insO = db.prepare(`INSERT INTO orders(id,name,created_at,day,city,total,payment,product,qty,status,manual,source) VALUES(?,?,?,?,?,?,?,?,1,?,0,'demo')`);
  const insA = db.prepare(`INSERT OR REPLACE INTO ad_spend(day,campaign,spend,source) VALUES(?,?,?,'demo')`);
  const insB = db.prepare(`INSERT INTO bank_txns(day,type,amount,category,note,source) VALUES(?,?,?,?,?,'demo')`);
  for (const [t, , c] of products) db.prepare('INSERT OR IGNORE INTO products(title,cost) VALUES(?,?)').run(t, c);

  let seq = 1001;
  for (let i = 59; i >= 0; i--) {
    const day = daysAgo(i);
    const n = Math.round(rnd(7, 16));
    let adTotal = 0;
    for (let k = 0; k < n; k++) {
      const [title, price] = pick(products);
      const cod = Math.random() < 0.7;
      const rtoP = cod ? 0.27 : 0.03;
      let status;
      if (i < 3) status = Math.random() < 0.5 ? 'new' : 'shipped';
      else if (i < 7) status = Math.random() < 0.4 ? 'shipped' : (Math.random() < rtoP ? 'rto' : 'delivered');
      else status = Math.random() < 0.015 ? 'cancelled' : (Math.random() < rtoP ? 'rto' : 'delivered');
      const created = new Date(`${day}T${String(Math.floor(rnd(8, 23))).padStart(2, '0')}:${String(Math.floor(rnd(0, 59))).padStart(2, '0')}:00+05:30`).toISOString();
      insO.run('demo:' + seq, '#' + seq, created, day, pick(cities), price, cod ? 'cod' : 'prepaid', title, status);
      seq++;
    }
    adTotal = n * rnd(170, 260);
    insA.run(day, 'Prospecting | Broad', Math.round(adTotal * 0.65));
    insA.run(day, 'Retargeting | 7d', Math.round(adTotal * 0.35));
  }
  insB.run(daysAgo(59), 'in', 50000, 'Owner capital', 'Opening capital');
  for (let w = 8; w >= 0; w--) {
    const d = daysAgo(w * 7 + 1);
    insB.run(d, 'in', Math.round(rnd(22000, 34000)), 'COD remittance', 'Courier weekly COD remittance');
    insB.run(d, 'in', Math.round(rnd(8000, 14000)), 'Gateway payout', 'Razorpay settlement');
    insB.run(d, 'out', Math.round(rnd(12000, 18000)), 'Supplier', 'Supplier payment');
    insB.run(d, 'out', Math.round(rnd(14000, 20000)), 'Ads', 'Meta Ads card charge');
    insB.run(d, 'out', Math.round(rnd(6000, 9000)), 'Courier', 'Shipping and RTO charges');
  }
  insB.run(daysAgo(30), 'out', 3000, 'Tools', 'Shopify plan and apps');
}

export function clearDemo() {
  db.exec(`DELETE FROM orders WHERE source='demo'; DELETE FROM ad_spend WHERE source='demo'; DELETE FROM bank_txns WHERE source='demo';`);
}
