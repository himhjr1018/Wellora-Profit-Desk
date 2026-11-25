import { db, getSettings, todayIST } from './db.js';
import { groupCost } from './scope.js';

// Data checks: places where the dashboard and its sources disagree, and how fresh each source is.
export function healthCheck() {
  const s = getSettings(), now = Date.now(), checks = [];
  const age = iso => iso ? (now - Date.parse(iso)) / 36e5 : null;
  const ago = h => h === null ? 'never' : h < 1 ? Math.round(h * 60) + ' min ago' : h < 48 ? Math.round(h) + ' hours ago' : Math.round(h / 24) + ' days ago';

  // 1. Freshness of each source
  const shop = db.prepare("SELECT MAX(at) a FROM sync_log WHERE source='shopify' AND ok=1").get().a;
  const panel = db.prepare('SELECT MAX(synced_at) a FROM supplier_panel').get().a;
  const wallet = db.prepare('SELECT MAX(created) a FROM supplier_snapshots').get().a;
  const metaDay = db.prepare("SELECT MAX(day) d FROM ad_spend WHERE COALESCE(source,'') != 'manual'").get().d;
  const fresh = (name, iso, limitH) => ({ level: age(iso) !== null && age(iso) <= limitH ? 'ok' : 'warn', title: name, detail: 'Last updated ' + ago(age(iso)) });
  checks.push(fresh('Shopify orders', shop, 1));
  checks.push(fresh('Dropship India orders', panel, 30));
  checks.push(fresh('Dropship India wallet', wallet, 30));
  checks.push({ level: metaDay === todayIST() ? 'ok' : 'warn', title: 'Meta ad spend', detail: metaDay ? 'Latest day imported: ' + metaDay : 'No Meta data yet' });

  // 2. Dashboard status vs Dropship India status
  const rows = db.prepare(`SELECT o.name, o.status, o.total, p.status ps FROM orders o LEFT JOIN supplier_panel p ON p.order_name = o.name`).all();
  const bad = rows.filter(o => (o.status === 'delivered' && o.ps && o.ps !== 'DELIVERED') || (o.status === 'rto' && o.ps && o.ps !== 'RTO'));
  checks.push({ level: bad.length ? 'warn' : 'ok', title: 'Delivered and RTO match Dropship India',
    detail: bad.length ? `${bad.length} order${bad.length === 1 ? ' is' : 's are'} marked differently here than in Dropship India` : 'Every delivered and RTO order agrees with the supplier panel',
    items: bad.map(o => `${o.name}: here ${o.status}, supplier ${o.ps.replace(/_/g, ' ').toLowerCase()}`) });
  const missing = rows.filter(o => !o.ps && o.status !== 'cancelled' && o.status !== 'new');
  checks.push({ level: missing.length ? 'warn' : 'ok', title: 'Shipped orders known to Dropship India',
    detail: missing.length ? `${missing.length} shipped order${missing.length === 1 ? ' is' : 's are'} not in the last panel read` : 'All shipped orders appear in the supplier panel',
    items: missing.map(o => o.name) });

  // 3. Supplier wallet vs the panel's own number
  const snap = db.prepare('SELECT balance, day FROM supplier_snapshots ORDER BY id DESC LIMIT 1').get();
  if (snap && snap.balance !== null) {
    const added = db.prepare("SELECT COALESCE(SUM(amount),0) t FROM bank_txns WHERE type='out' AND category='Supplier'").get().t;
    const stm = db.prepare('SELECT COALESCE(SUM(final),0) t FROM supplier_statements').get().t;
    const man = db.prepare('SELECT COALESCE(SUM(amount),0) t FROM supplier_charges').get().t;
    const mine = added + stm - man + s.supplier_adjust, diff = mine - snap.balance;
    checks.push({ level: Math.abs(diff) < 1 ? 'ok' : 'warn', title: 'Supplier wallet matches Dropship India',
      detail: Math.abs(diff) < 1 ? 'Dashboard wallet equals the panel balance' : `Dashboard wallet is ₹${Math.abs(diff).toFixed(2)} ${diff > 0 ? 'higher' : 'lower'} than the panel (${snap.day}). A payout CSV may be missing` });
    if (snap.balance < 0) checks.push({ level: 'warn', title: 'Supplier wallet is negative', detail: `-₹${Math.abs(snap.balance).toFixed(2)}. Recharge it so orders keep being processed` });
  }

  // 4. Costs: orders using the default cost because the product has none
  const costed = new Set(db.prepare('SELECT title FROM products').all().map(p => p.title));
  const noCost = db.prepare("SELECT product, COUNT(*) n FROM orders WHERE status != 'cancelled' GROUP BY product").all().filter(p => !costed.has(p.product) && groupCost(p.product) === null);
  checks.push({ level: noCost.length ? 'warn' : 'ok', title: 'Every product has a cost', detail: noCost.length ? `${noCost.length} product${noCost.length === 1 ? '' : 's'} use the default ₹${s.default_cost} per unit. Set the real cost on the Products tab so profit is right` : 'All products have their own cost',
    items: noCost.map(p => `${p.product}: ${p.n} orders`) });

  return { at: new Date().toISOString(), warnings: checks.filter(c => c.level === 'warn').length, checks };
}
