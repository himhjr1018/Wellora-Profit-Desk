import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));

// Minimal .env loader (no dependencies)
export function loadEnv() {
  const f = path.join(ROOT, '.env');
  if (!existsSync(f)) return;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
loadEnv();

export const db = new DatabaseSync(process.env.DB_FILE || path.join(ROOT, 'data', 'dropship.db'));   // DB_FILE lets a test run use a copy

db.exec(`
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  name TEXT,
  created_at TEXT,
  day TEXT,
  city TEXT,
  total REAL,
  payment TEXT,          -- cod | prepaid
  product TEXT,
  qty INTEGER DEFAULT 1,
  status TEXT DEFAULT 'new', -- new | shipped | delivered | rto | cancelled
  manual INTEGER DEFAULT 0,  -- 1 once you set the status by hand; sync will not overwrite it
  source TEXT
);
CREATE INDEX IF NOT EXISTS orders_day ON orders(day);

CREATE TABLE IF NOT EXISTS ad_spend (
  day TEXT,
  campaign TEXT,
  spend REAL,
  source TEXT,
  PRIMARY KEY (day, campaign)
);

CREATE TABLE IF NOT EXISTS bank_txns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT,
  type TEXT,             -- in | out
  amount REAL,
  category TEXT,
  note TEXT,
  source TEXT
);
CREATE INDEX IF NOT EXISTS bank_day ON bank_txns(day);

CREATE TABLE IF NOT EXISTS products (
  title TEXT PRIMARY KEY,
  cost REAL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT,
  source TEXT,
  ok INTEGER,
  message TEXT
);
`);

try { db.exec('ALTER TABLE orders ADD COLUMN customer TEXT'); } catch { /* already there */ }
// Customer details used by the Risk tab, and your confirmation outcome ('', confirmed, unreachable, refused)
for (const c of ['zip', 'province', 'phone', 'email', 'address', 'ip', 'discount', 'confirm', 'fulfilled_at', 'courier', 'tracking_no', 'tracking_url', 'ship_status', 'cancelled_at', 'cancel_reason', 'gross_items', 'discounts', 'refunds_json']) { try { db.exec(`ALTER TABLE orders ADD COLUMN ${c} TEXT`); } catch { /* already there */ } }
db.exec(`CREATE TABLE IF NOT EXISTS supplier_charges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT,
  type TEXT,      -- RTO charge | Product cost | COD fee | Other charge
  amount REAL,
  orderRef TEXT,  -- optional order number
  note TEXT,
  created TEXT
)`);
// Numbers copied from the supplier's own Wallet page, with the date you copied them
db.exec(`CREATE TABLE IF NOT EXISTS supplier_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT,
  balance REAL,       -- Current Balance
  outstanding REAL,   -- Outstanding: COD collected minus logistics charges, owed to you but not in the wallet yet
  payments REAL,      -- Payments Till Date
  withdrawn REAL,     -- Withdrawn Till Date
  note TEXT,
  created TEXT
)`);
// Payout statements from the supplier (the CSV you upload) and the orders listed in them
db.exec(`CREATE TABLE IF NOT EXISTS supplier_statements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT UNIQUE,      -- same file uploaded twice is ignored
  name TEXT,
  date TEXT,
  base REAL,             -- base payout (negative = money taken from the wallet)
  hold_current REAL,     -- amount held for open orders
  hold_prev REAL,        -- hold before this statement
  hold_diff REAL,
  extra_hold REAL,
  final REAL,            -- final adjusted payout: what this statement adds to (+) or takes from (-) the wallet
  orders INTEGER,
  created TEXT
)`);
db.exec(`CREATE TABLE IF NOT EXISTS supplier_orders (
  order_name TEXT PRIMARY KEY,
  supplier_order_id TEXT, created_at TEXT, status_date TEXT, qty INTEGER, product TEXT, sku TEXT, status TEXT,
  amount REAL, cod_charges REAL, ds_margin REAL, rto_penalty REAL, rvp_penalty REAL,
  customer TEXT, city TEXT, state TEXT, pin TEXT, statement_id INTEGER
)`);
// Live status of every order as read from the Dropship India seller panel (refreshed each time the panel is read)
db.exec(`CREATE TABLE IF NOT EXISTS supplier_panel (
  order_name TEXT PRIMARY KEY,   -- Shopify order name, e.g. #W1001045
  supplier_order_id TEXT, shopify_no TEXT, status TEXT, status_at TEXT, awb TEXT, risk TEXT, address TEXT, synced_at TEXT
)`);
// Wallet transactions as listed on the Dropship India Wallet page (recharges and daily payouts)
db.exec(`CREATE TABLE IF NOT EXISTS supplier_wallet_txns (
  at TEXT, kind TEXT, description TEXT, status TEXT, amount REAL, synced_at TEXT,
  PRIMARY KEY (at, description, amount)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS blocklist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT,      -- phone | address | name
  value TEXT,     -- normalised value that is matched against new orders
  label TEXT,     -- what you see in the list
  note TEXT,
  created TEXT
)`);

// Extra Meta metrics (added later, so migrate existing databases)
for (const c of ['impressions', 'clicks', 'reach', 'purchases', 'purchase_value']) {
  try { db.exec(`ALTER TABLE ad_spend ADD COLUMN ${c} REAL`); } catch { /* already there */ }
}

export const DEFAULTS = {
  default_cost: 350,     // supplier cost per unit when a product has no cost set
  gst: 18,
  price_incl_gst: 1,
  ship: 70,
  return_ship: 70,
  pack: 15,
  cod_fee: 30,
  cod_fee_pct: 0,        // COD charge as a percent of the order amount (Dropship India charges 1%), added to the fixed COD fee
  msg_fee: 0,            // WhatsApp message cost per order (₹), counted on every order that is not cancelled
  gateway_pct: 2,
  platform_pct: 0,
  ad_gst_claim: 0,       // 1 = the GST charged on ads comes back as tax credit, so it is not counted as a cost in profit (Meta wallet still pays it)
  ad_gst: 18,            // GST Meta adds on top of ad spend (set 0 if you claim it back as input credit)
  fixed_monthly: 3000,
  opening_balance: 0,
  supplier_auto_rto: 0,      // 1 = also take the RTO charge off automatically for every order marked RTO (0 = only the charges you enter)
  supplier_rto_charge: 70,   // what the supplier takes from your wallet for each RTO (returned) order
  supplier_adjust: 0,        // other supplier wallet changes you want counted (add or subtract), e.g. to match the supplier panel
  meta_opening_balance: 0, // money already sitting in your Meta ad account before you started tracking recharges
  expected_rto: 25       // no longer used (kept so older saved settings still load)
};

export function getSettings() {
  const out = { ...DEFAULTS };
  for (const r of db.prepare('SELECT key, value FROM settings').all()) {
    if (r.key in DEFAULTS) out[r.key] = Number(r.value);
  }
  return out;
}

export function setSettings(obj) {
  const st = db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  for (const [k, v] of Object.entries(obj)) {
    if (k in DEFAULTS && Number.isFinite(Number(v))) st.run(k, String(Number(v)));
  }
}

export const istDay = d => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
export const todayIST = () => istDay(Date.now());
export const daysAgo = n => istDay(Date.now() - n * 864e5);

// An order the supplier will never ship (cancelled, not to be fulfilled, failed to sync) counts as cancelled in profit, order counts and tracking.
// Shopify's own Sales report is not changed by this: it still follows Shopify's refunds.
export const EFF_STATUS = `CASE WHEN o.status IN ('new','shipped') AND p.status IN ('NOT_TO_BE_FULFILLED','CANCELLED_BY_DROPSHIPPER','CANCELLED_BY_CUSTOMER','FAILED_TO_SYNC') THEN 'cancelled' ELSE o.status END`;
