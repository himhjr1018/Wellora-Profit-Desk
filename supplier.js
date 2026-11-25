import { createHash } from 'node:crypto';
import { db, todayIST, getSettings, setSettings } from './db.js';

// Reads the payout CSV that Dropship India gives you: a table of orders, then a "PAYOUT CALCULATION BREAKDOWN".
// Orders it reports as RTO or delivered are marked that way in the dashboard, and the payout lands in the supplier wallet.

function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  row.push(cur); rows.push(row);
  return rows;
}
const num = v => { const n = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : 0; };
// "13-11-2026 07:36:10" (India time) -> ISO timestamp
const when = s => { const m = String(s || '').trim().match(/^(\d{2})-(\d{2})-(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/); return m ? `${m[3]}-${m[2]}-${m[1]}T${m[4] || '00'}:${m[5] || '00'}:${m[6] || '00'}+05:30` : ''; };

export function mapStatus(s) {
  const t = String(s || '').toLowerCase().trim();
  if (/\b(rto|rvp)\b|return/.test(t)) return 'rto';
  if (/\bdelivered\b/.test(t) && !/not\s+delivered|undelivered/.test(t)) return 'delivered';   // "Out For Delivery" and "Undelivered" are not delivered
  if (/cancel/.test(t)) return 'cancelled';
  return null;   // anything else (in transit, out for delivery, picked up...) is only recorded, never used to change an order
}

export function parseSupplierCsv(text) {
  const rows = parseCsv(text);
  const hi = rows.findIndex(r => r.some(c => /^order id$/i.test(c.trim())) && r.some(c => /^order name$/i.test(c.trim())));
  if (hi < 0) return { error: 'This does not look like the supplier payout file: no "Order id" and "Order name" columns found.' };
  const head = rows[hi].map(c => c.trim().toLowerCase());
  const col = name => head.indexOf(name);
  const C = { id: col('order id'), name: col('order name'), created: col('order creation date'), sdate: col('status date'), qty: col('quantity'), product: col('product name'),
    sku: col('sku'), status: col('order status'), amount: col('order amount'), cod: col('cod charges'), margin: col('ds margin'), rto: col('rto penalty'), rvp: col('rvp penalty'),
    customer: col('customer name'), city: col('city'), state: col('state'), pin: col('pin code') };
  const orders = []; let i = hi + 1;
  for (; i < rows.length; i++) {
    const r = rows[i];
    if (r.every(c => !c.trim()) || String(r[0]).trim().startsWith('***')) break;
    const g = k => (C[k] >= 0 ? String(r[C[k]] ?? '').trim() : '');
    if (!g('name')) continue;
    orders.push({ supplier_order_id: g('id'), order_name: g('name'), created_at: when(g('created')), status_date: when(g('sdate')), qty: Math.max(1, num(g('qty'))), product: g('product'), sku: g('sku'),
      status: g('status'), amount: num(g('amount')), cod_charges: num(g('cod')), ds_margin: num(g('margin')), rto_penalty: num(g('rto')), rvp_penalty: num(g('rvp')),
      customer: g('customer'), city: g('city'), state: g('state'), pin: g('pin') });
  }
  // the breakdown block: "label,value" lines
  const sum = { base: 0, hold_current: 0, hold_prev: 0, hold_diff: 0, extra_hold: 0, final: 0 }, seen = {};
  const set = (key, v) => { if (!(key in seen)) { sum[key] = v; seen[key] = true; } };
  for (; i < rows.length; i++) {
    const label = String(rows[i][0] || '').trim().toLowerCase(), val = rows[i][1];
    if (!label || val === undefined || String(val).trim() === '') continue;
    if (label.includes('base payout')) set('base', num(val));
    else if (label.includes('current open orders hold')) set('hold_current', num(val));
    else if (label.includes('previous wallet hold')) set('hold_prev', num(val));
    else if (label.includes('hold amount difference')) set('hold_diff', num(val));
    else if (label.includes('extra hold')) set('extra_hold', num(val));
    else if (label.includes('final adjusted payout')) set('final', num(val));
  }
  if (!('final' in seen)) return { error: 'The payout breakdown ("Final Adjusted Payout") was not found in this file.' };
  return { orders, summary: sum };
}

export function importSupplierCsv(text, fileName = '') {
  const parsed = parseSupplierCsv(text);
  if (parsed.error) return { ok: false, error: parsed.error };
  const hash = createHash('sha1').update(text).digest('hex');
  if (db.prepare('SELECT 1 FROM supplier_statements WHERE hash = ?').get(hash)) return { ok: true, duplicate: true, message: 'This exact file was already imported, so nothing changed.' };

  const dm = String(fileName).match(/(\d{2})-(\d{2})-(\d{4})/);
  const date = dm ? `${dm[3]}-${dm[2]}-${dm[1]}` : todayIST();
  const s = parsed.summary;
  const result = { ok: true, duplicate: false, orders: parsed.orders.length, byStatus: {}, marked: { rto: 0, delivered: 0, cancelled: 0 }, alreadyCorrect: 0, notFound: [], unknownStatuses: [] };

  db.exec('BEGIN');
  try {
    const st = db.prepare('INSERT INTO supplier_statements(hash,name,date,base,hold_current,hold_prev,hold_diff,extra_hold,final,orders,created) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(hash, fileName || 'payout.csv', date, s.base, s.hold_current, s.hold_prev, s.hold_diff, s.extra_hold, s.final, parsed.orders.length, new Date().toISOString());
    const sid = Number(st.lastInsertRowid); result.statementId = sid;
    const up = db.prepare(`INSERT OR REPLACE INTO supplier_orders(order_name,supplier_order_id,created_at,status_date,qty,product,sku,status,amount,cod_charges,ds_margin,rto_penalty,rvp_penalty,customer,city,state,pin,statement_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const find = db.prepare("SELECT id, status FROM orders WHERE name = ? AND source = 'shopify'");
    const setStatus = db.prepare('UPDATE orders SET status = ?, manual = 1 WHERE id = ?');   // manual = 1 so the next Shopify sync does not overwrite it
    for (const o of parsed.orders) {
      up.run(o.order_name, o.supplier_order_id, o.created_at, o.status_date, o.qty, o.product, o.sku, o.status, o.amount, o.cod_charges, o.ds_margin, o.rto_penalty, o.rvp_penalty, o.customer, o.city, o.state, o.pin, sid);
      result.byStatus[o.status || 'unknown'] = (result.byStatus[o.status || 'unknown'] || 0) + 1;
      const mapped = mapStatus(o.status);
      const ord = find.get(o.order_name);
      if (!ord) { result.notFound.push(o.order_name); continue; }
      if (!mapped) { if (!result.unknownStatuses.includes(o.status)) result.unknownStatuses.push(o.status); continue; }
      if (ord.status === mapped) { result.alreadyCorrect++; continue; }
      setStatus.run(mapped, ord.id); result.marked[mapped]++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  // what the supplier's own numbers say about your Settings
  const pen = parsed.orders.filter(o => o.rto_penalty > 0 || o.rvp_penalty > 0);
  result.insight = {
    avgRtoPenalty: pen.length ? pen.reduce((a, o) => a + o.rto_penalty + o.rvp_penalty, 0) / pen.length : null,
    supplierPrice: parsed.orders.length ? parsed.orders.reduce((a, o) => a + (o.amount - o.ds_margin) / o.qty, 0) / parsed.orders.length : null
  };
  result.summary = s;
  return result;
}

export const statements = () => db.prepare('SELECT * FROM supplier_statements ORDER BY date DESC, id DESC').all();

export function supplierOrders() {
  return db.prepare(`SELECT s.*, o.status AS dashboard_status, o.id AS dashboard_id, st.date AS statement_date
    FROM supplier_orders s LEFT JOIN orders o ON o.name = s.order_name AND o.source = 'shopify' LEFT JOIN supplier_statements st ON st.id = s.statement_id
    ORDER BY s.status_date DESC, s.order_name DESC`).all();
}

export function deleteStatement(id) {
  db.prepare('DELETE FROM supplier_orders WHERE statement_id = ?').run(id);
  db.prepare('DELETE FROM supplier_statements WHERE id = ?').run(id);
}

// ---- Live read of the Dropship India seller panel ----
// rows: [supplierOrderId, shopifyNo, status, statusISO, awb, risk, address]. Shopify order name = '#W100' + shopifyNo.
export function importPanel(rows) {
  if (!Array.isArray(rows)) throw new Error('No rows received.');
  const now = new Date().toISOString();
  const res = { received: rows.length, matched: 0, notFound: [], marked: { delivered: 0, rto: 0 }, byStatus: {}, syncedAt: now };
  const up = db.prepare('INSERT OR REPLACE INTO supplier_panel(order_name,supplier_order_id,shopify_no,status,status_at,awb,risk,address,synced_at) VALUES(?,?,?,?,?,?,?,?,?)');
  const find = db.prepare("SELECT id, status FROM orders WHERE name = ? AND source = 'shopify'");
  const setStatus = db.prepare('UPDATE orders SET status = ?, manual = 1 WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const [sid, shop, status, at, awb, risk, addr] = r.map(x => String(x ?? ''));
      if (!shop || !status) continue;
      const name = '#W100' + shop;
      res.byStatus[status] = (res.byStatus[status] || 0) + 1;
      up.run(name, sid, shop, status, at, awb, risk, addr, now);
      const ord = find.get(name);
      if (!ord) { res.notFound.push(name); continue; }
      res.matched++;
      const mapped = mapStatus(status.replace(/_/g, ' '));
      if ((mapped === 'delivered' || mapped === 'rto') && ord.status !== mapped) { setStatus.run(mapped, ord.id); res.marked[mapped]++; }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return res;
}
export const panelRows = () => db.prepare('SELECT * FROM supplier_panel ORDER BY status_at DESC').all();

// ---- Wallet page of the Dropship India panel ----
// b: { balance, outstanding, payments, withdrawn, txns: [{at (ISO), description, status, amount}] }
// Saves the panel's own numbers as a snapshot, keeps the transaction list, and calibrates the wallet balance to the panel's Current Balance.
export function importWallet(b) {
  const num = v => (v === null || v === undefined || v === '' ? null : Number(v));
  if (!Number.isFinite(num(b.balance))) throw new Error('Current balance missing.');
  const now = new Date().toISOString(), day = todayIST();
  const ins = db.prepare('INSERT OR IGNORE INTO supplier_wallet_txns(at,kind,description,status,amount,synced_at) VALUES(?,?,?,?,?,?)');
  let added = 0;
  for (const t of (b.txns || [])) {
    const kind = /recharge/i.test(t.description) ? 'recharge' : /payout/i.test(t.description) ? 'payout' : 'other';
    added += Number(ins.run(String(t.at), kind, String(t.description), String(t.status || ''), Math.abs(Number(t.amount)), now).changes);   // the panel may show a debit as a negative number; store amounts as positive so one payout is never listed twice
  }
  db.prepare('INSERT INTO supplier_snapshots(day,balance,outstanding,payments,withdrawn,note,created) VALUES(?,?,?,?,?,?,?)')
    .run(day, num(b.balance), num(b.outstanding), num(b.payments), num(b.withdrawn), 'Read from the Dropship India Wallet page', now);
  // same formula as the Supplier tab's wallet
  const st = getSettings();
  const added$ = db.prepare("SELECT COALESCE(SUM(amount),0) t FROM bank_txns WHERE type='out' AND category='Supplier'").get().t;
  const stm = db.prepare('SELECT COALESCE(SUM(final),0) t FROM supplier_statements').get().t;
  const manual = db.prepare('SELECT COALESCE(SUM(amount),0) t FROM supplier_charges').get().t;
  const rto = db.prepare("SELECT COUNT(*) n FROM orders WHERE status = 'rto' AND name NOT IN (SELECT order_name FROM supplier_orders)").get().n;
  const rtoCharges = st.supplier_auto_rto === 1 ? rto * st.supplier_rto_charge : 0;
  const before = added$ + stm - manual - rtoCharges;
  const adjust = num(b.balance) - before;
  setSettings({ supplier_adjust: adjust.toFixed(2) });
  return { ok: true, balance: num(b.balance), outstanding: num(b.outstanding), newTransactions: added, adjust };
}
export const walletTxns = () => db.prepare('SELECT * FROM supplier_wallet_txns ORDER BY at DESC').all();
