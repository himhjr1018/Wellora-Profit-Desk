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

export const db = new DatabaseSync(path.join(ROOT, 'data', 'dropship.db'));

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
  gateway_pct: 2,
  platform_pct: 0,
  ad_gst: 18,            // GST Meta adds on top of ad spend (set 0 if you claim it back as input credit)
  fixed_monthly: 3000,
  opening_balance: 0,
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
