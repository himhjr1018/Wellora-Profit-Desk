import { filterOrders } from './scope.js';
import { db, daysAgo } from './db.js';
import { checkPincode } from './pincodes.js';

// Basic fraud / risk check for COD orders. These are hints for who to call or WhatsApp before shipping.
// A flag is not proof of fraud: it can be a genuine repeat customer or a typing mistake.
// Each check adds points; "good" signs take points off. Levels: 1 low, 2-3 medium, 4 or more high.

const W = {
  history: 2, repeat24h: 2, oddName: 2, riskyCity: 1, bulk: 1,
  phoneBad: 3, phoneFake: 3, phoneShared: 3, phoneMissing: 2,
  addrShort: 1, addrOdd: 2, addrShared: 3, ipShared: 1, emailBad: 2, blocked: 5,
  trusted: -2, confirmed: -3, unreachable: 2, refused: 4
};

// ---------- normalising ----------
export function normPhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d;
}
export const normName = n => String(n || '').toLowerCase().replace(/[^a-z]/g, '');
export const normAddr = a => String(a || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const DISPOSABLE = new Set(['mailinator.com', 'tempmail.com', 'temp-mail.org', 'guerrillamail.com', '10minutemail.com', 'yopmail.com',
  'trashmail.com', 'sharklasers.com', 'getnada.com', 'dispostable.com', 'maildrop.cc', 'throwawaymail.com', 'fakeinbox.com', 'mohmal.com']);

// Only judges words written in English letters. Hindi, Marathi and other scripts have no a-e-i-o-u, and
// codes like Google plus codes (FFHJ+9PM) contain digits, so neither is treated as gibberish.
const looksOdd = text => {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).map(w => w.replace(/[.,;:()\-]+$/g, ''));
  return /([A-Za-z])\1{3,}/i.test(text) || words.some(w => /^[A-Za-z]{5,}$/.test(w) && !/[aeiouy]/i.test(w));
};
const oddName = name => {
  const n = (name || '').trim();
  if (!n) return false;
  const words = n.split(/\s+/);
  return words.length < 2 || n.length < 4 || /[0-9_@#$%^&*<>]/.test(n) || looksOdd(n);
};

const phoneFake = d => /^(\d)\1{9}$/.test(d) || ['1234567890', '0123456789', '9876543210', '9876501234', '9123456789'].includes(d)
  || new Set(d).size <= 2 || /^(\d\d)\1{4}$/.test(d);

// ---------- blocklist ----------
export const blocklist = () => db.prepare('SELECT * FROM blocklist ORDER BY id DESC').all();

// ---------- scoring ----------
export function riskByOrder() {
  const all = db.prepare(`SELECT id, customer, city, status, qty, created_at, zip, province, source, phone, email, address, ip, confirm FROM orders`).all();
  const blocks = blocklist();
  const bPhone = new Set(blocks.filter(b => b.kind === 'phone').map(b => b.value));
  const bAddr = new Set(blocks.filter(b => b.kind === 'address').map(b => b.value));
  const bName = new Set(blocks.filter(b => b.kind === 'name').map(b => b.value));

  const idx = { name: {}, phone: {}, addr: {}, ip: {}, city: {} };
  for (const o of all) {
    o._name = normName(o.customer); o._phone = normPhone(o.phone); o._addr = normAddr(o.address);
    if (o._name) (idx.name[o._name] ||= []).push(o);
    if (o._phone.length === 10) (idx.phone[o._phone] ||= []).push(o);
    if (o._addr.length >= 10) (idx.addr[o._addr] ||= []).push(o);
    if (o.ip) (idx.ip[o.ip] ||= []).push(o);
    const c = (o.city || '').trim().toLowerCase();
    if (c) { const s = (idx.city[c] ||= { n: 0, bad: 0 }); s.n++; if (o.status === 'cancelled' || o.status === 'rto') s.bad++; }
  }
  const isBad = x => x.status === 'cancelled' || x.status === 'rto';
  const out = {};

  for (const o of all) {
    const flags = [], good = []; let score = 0;
    const add = (text, w) => { flags.push(text); score += w; };
    const t = Date.parse(o.created_at);
    const sameName = (idx.name[o._name] || []).filter(x => x.id !== o.id);
    const samePhone = o._phone.length === 10 ? (idx.phone[o._phone] || []).filter(x => x.id !== o.id) : [];
    const same = [...new Map([...sameName, ...samePhone].map(x => [x.id, x])).values()];   // same person by name OR phone

    // history of the same person
    const bad = same.filter(isBad).length;
    if (bad) add(`Same customer has ${bad} other cancelled or returned order${bad > 1 ? 's' : ''}`, W.history);
    if (same.some(x => Math.abs(Date.parse(x.created_at) - t) <= 864e5)) add('Same customer ordered again within 24 hours', W.repeat24h);
    if (same.some(x => x.status === 'delivered') && !bad) { good.push('Earlier order from this customer was delivered'); score += W.trusted; }

    // phone
    if (!o._phone) { if (o.source === 'shopify') add('No phone number on the order', W.phoneMissing); }
    else if (!/^[6-9]\d{9}$/.test(o._phone)) add(`Phone ${o.phone} is not a valid Indian mobile number`, W.phoneBad);
    else if (phoneFake(o._phone)) add('Phone number looks fake (repeating or sequential digits)', W.phoneFake);
    const otherNames = new Set(samePhone.map(x => x._name).filter(n => n && n !== o._name));
    if (otherNames.size) add(`Same phone used with ${otherNames.size} other name${otherNames.size > 1 ? 's' : ''}`, W.phoneShared);

    // name
    if (oddName(o.customer)) add('Name looks unusual', W.oddName);

    // address
    const raw = (o.address || '').trim();
    if (o.source === 'shopify') {
      if (raw && raw.length < 12) add('Address is very short', W.addrShort);
      else if (raw && looksOdd(raw)) add('Address looks like gibberish', W.addrOdd);
    }
    const addrNames = new Set((o._addr.length >= 10 ? (idx.addr[o._addr] || []) : []).filter(x => x.id !== o.id).map(x => x._name).filter(n => n && n !== o._name));
    if (addrNames.size) add(`Same address used with ${addrNames.size} other name${addrNames.size > 1 ? 's' : ''}`, W.addrShared);

    // IP: many orders from one IP in 2 days. Weak, because mobile networks share IP addresses.
    if (o.ip) {
      const near = (idx.ip[o.ip] || []).filter(x => x.id !== o.id && Math.abs(Date.parse(x.created_at) - t) <= 2 * 864e5 && x._name !== o._name);
      if (near.length >= 2) add(`Same IP address used for ${near.length} other customers' orders in 2 days`, W.ipShared);
    }

    // email
    const em = (o.email || '').toLowerCase().trim();
    if (em && (DISPOSABLE.has(em.split('@')[1]) || /^(test|abc|xyz|asdf|qwerty|noemail|none|na|no)@/.test(em)))
      add('Email looks fake or disposable', W.emailBad);

    // city, quantity
    const cs = idx.city[(o.city || '').trim().toLowerCase()];
    if (cs && cs.n >= 5 && cs.bad / cs.n >= 0.35) add(`City has ${cs.bad} cancelled or returned of ${cs.n} orders`, W.riskyCity);
    if ((o.qty || 1) >= 3) add(`Large quantity (${o.qty} units)`, W.bulk);

    // pincode, state and city against the India Post directory
    for (const f of checkPincode(o)) add(f.text, f.weight);

    // blocklist
    if ((o._phone && bPhone.has(o._phone)) || (o._addr.length >= 10 && bAddr.has(o._addr)) || (o._name && bName.has(o._name)))
      add('Matches a customer you blocked', W.blocked);

    // your own confirmation call
    if (o.confirm === 'confirmed') { good.push('You confirmed this order with the customer'); score += W.confirmed; }
    else if (o.confirm === 'unreachable') add('Customer was not reachable when you called', W.unreachable);
    else if (o.confirm === 'refused') add('Customer refused when you called', W.refused);

    score = Math.max(0, score);
    out[o.id] = { score, level: score >= 4 ? 'high' : score >= 2 ? 'medium' : score >= 1 ? 'low' : 'none', flags, good };
  }
  return out;
}

// Orders with customer details and their risk, for the Risk tab
export function listRisk({ days = 30, from: fromOpt = '', to: toOpt = '', product = '' } = {}) {
  const valid = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
  const from = valid(fromOpt) ? fromOpt : days > 0 ? daysAgo(days - 1) : '0000-00-00';
  const to = valid(toOpt) ? toOpt : '9999-12-31';
  const rows = db.prepare(`SELECT id, name, day, created_at, customer, phone, email, address, city, zip, province, payment, total, status, confirm, ip, discount, product
    FROM orders WHERE day >= ? AND day <= ? ORDER BY created_at DESC`).all(from, to);
  const risk = riskByOrder();
  return filterOrders(rows, product).map(o => ({ ...o, risk: risk[o.id] }));
}

// Block a customer: the phone, the address and (if there is no phone) the name, so later orders match
export function blockOrder(orderId, note = '') {
  const o = db.prepare('SELECT customer, phone, address, name FROM orders WHERE id = ?').get(orderId);
  if (!o) return 0;
  const add = db.prepare('INSERT INTO blocklist(kind,value,label,note,created) VALUES(?,?,?,?,?)');
  const has = db.prepare('SELECT 1 FROM blocklist WHERE kind=? AND value=?');
  const now = new Date().toISOString(); let n = 0;
  const put = (kind, value, label) => { if (value && !has.get(kind, value)) { add.run(kind, value, label, note || `Blocked from order ${o.name}`, now); n++; } };
  const ph = normPhone(o.phone);
  if (ph.length === 10) put('phone', ph, o.phone);
  if (normAddr(o.address).length >= 10) put('address', normAddr(o.address), o.address);
  if (ph.length !== 10) put('name', normName(o.customer), o.customer);
  return n;
}

export function setConfirm(orderId, value) {
  if (!['', 'confirmed', 'unreachable', 'refused'].includes(value)) return false;
  db.prepare('UPDATE orders SET confirm=? WHERE id=?').run(value, orderId);
  return true;
}
