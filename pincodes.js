import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './db.js';

// Checks an order's pincode, state and city against the India Post "All India Pincode Directory"
// (data.gov.in, Government Open Data License). Put the CSV at data/pincodes.csv. Without it, these checks are skipped.
const FILE = process.env.PINCODE_FILE || path.join(ROOT, 'data', 'pincodes.csv');

const norm = s => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z]/g, '');

// Old and new names for the same place, so a different spelling is not flagged as a mismatch
const STATE_ALIAS = { orissa: 'odisha', uttaranchal: 'uttarakhand', pondicherry: 'puducherry', nctofdelhi: 'delhi', newdelhi: 'delhi',
  jammuandkashmir: 'jammuandkashmir', ladakh: 'jammuandkashmir', damananddiu: 'dadraandnagarhavelianddamananddiu',
  dadraandnagarhaveli: 'dadraandnagarhavelianddamananddiu', dadraandnagarhavelianddamananddiu: 'dadraandnagarhavelianddamananddiu',
  andhrapradesh: 'andhrapradesh', telangana: 'telangana' };
const stateKey = s => { const n = norm(s); return STATE_ALIAS[n] || n; };

const CITY_ALIAS = { gurgaon: 'gurugram', bangalore: 'bengaluru', bombay: 'mumbai', calcutta: 'kolkata', madras: 'chennai',
  allahabad: 'prayagraj', banaras: 'varanasi', benares: 'varanasi', cochin: 'kochi', trivandrum: 'thiruvananthapuram',
  mysore: 'mysuru', baroda: 'vadodara', poona: 'pune', belgaum: 'belagavi', mangalore: 'mangaluru', gauhati: 'guwahati',
  vizag: 'visakhapatnam', noida: 'gautambuddhanagar', greaternoida: 'gautambuddhanagar', ghaziabad: 'ghaziabad' };
const cityKey = s => { const n = norm(s); return CITY_ALIAS[n] || n; };

function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); if (row.some(x => x.trim())) rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  row.push(cur); if (row.some(x => x.trim())) rows.push(row);
  return rows;
}

// Number of differing digits between two pincodes: a one-digit typo is the most likely mistake
const digitDiff = (a, b) => [...a].reduce((n, ch, i) => n + (ch !== b[i]), 0);

function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

// Does the order's city plausibly refer to one of the places of this pincode? Tolerates spelling variants
// (Niyauj / Niauj), a name with extra words, and a place that starts the same way (Jalorjalor / Jalore).
function cityMatches(c, e) {
  if (c.length < 3) return true;
  for (const p of e.places) {
    if (!p) continue;
    if (p.includes(c) || (p.length >= 4 && c.includes(p))) return true;
    if (c.length >= 5 && p.length >= 5 && editDistance(c, p) <= 2) return true;
    let k = 0; while (k < c.length && k < p.length && c[k] === p[k]) k++;
    if (k >= 5) return true;
  }
  return false;
}

let cache = { mtime: 0, map: null, rows: 0 };

export function directory() {
  if (!existsSync(FILE)) return { loaded: false, rows: 0, map: null };
  const m = statSync(FILE).mtimeMs;
  if (cache.map && cache.mtime === m) return { loaded: true, rows: cache.rows, map: cache.map };
  const all = parseCsv(readFileSync(FILE, 'utf8'));
  const head = (all[0] || []).map(h => norm(h));
  const col = (...names) => { for (const n of names) { const i = head.findIndex(h => h === n || h.includes(n)); if (i >= 0) return i; } return -1; };
  const iPin = col('pincode'), iOff = col('officename'), iDel = col('delivery'), iDist = col('districtname', 'district'),
    iState = col('statename', 'state'), iDiv = col('divisionname'), iTaluk = col('taluk'), iReg = col('regionname');
  if (iPin < 0 || iState < 0) return { loaded: false, rows: 0, map: null, error: 'Unrecognised pincode file: needs pincode and state columns' };
  const map = new Map();
  for (const r of all.slice(1)) {
    const pin = String(r[iPin] || '').replace(/\D/g, '');
    if (pin.length !== 6) continue;
    const e = map.get(pin) || { states: new Set(), places: new Set(), delivery: false, state: '' };
    e.states.add(stateKey(r[iState])); e.state = e.state || r[iState];
    for (const i of [iOff, iDist, iDiv, iTaluk, iReg]) if (i >= 0 && r[i]) e.places.add(cityKey(r[i].replace(/\b(B\.?O|S\.?O|H\.?O|G\.?P\.?O)\b\.?/gi, '')));
    if (iDel < 0 || /^deliver/i.test((r[iDel] || '').trim())) e.delivery = true;
    map.set(pin, e);
  }
  cache = { mtime: m, map, rows: all.length - 1 };
  return { loaded: true, rows: cache.rows, map };
}

// Returns a list of { text, weight } problems with an order's pincode, state and city.
// Format checks always run; directory checks run only when data/pincodes.csv is present.
export function checkPincode({ zip, province, city, source }) {
  const flags = [];
  const z = String(zip || '').replace(/\s+/g, '');
  if (!z) { if (source === 'shopify') flags.push({ text: 'No pincode on the order', weight: 2 }); return flags; }
  if (!/^[1-9]\d{5}$/.test(z)) { flags.push({ text: `Pincode ${z} is not a valid 6-digit Indian pincode`, weight: 4 }); return flags; }
  const dir = directory();
  if (!dir.loaded) return flags;
  const e = dir.map.get(z);
  if (!e) {
    // Suggest pincodes in the same state whose area matches the order's city, closest number first (likely a typo)
    const c = cityKey(city), sk = stateKey(province);
    const guess = city ? [...dir.map].filter(([, v]) => (!province || v.states.has(sk)) && cityMatches(c, v))
      .map(([p]) => p).sort((a, b) => digitDiff(a, z) - digitDiff(b, z) || Math.abs(a - z) - Math.abs(b - z)).slice(0, 2) : [];
    flags.push({ text: `Pincode ${z} is not in the India Post directory${guess.length ? `. Did the customer mean ${guess.join(' or ')}?` : ''}`, weight: 4 });
    return flags;
  }
  const stateOk = !province || e.states.has(stateKey(province));
  if (!stateOk) flags.push({ text: `Pincode ${z} belongs to ${e.state}, but the order says ${province}`, weight: 3 });
  if (city && !cityMatches(cityKey(city), e)) flags.push({ text: `City "${city}" does not match the area of pincode ${z}`, weight: 1 });
  if (!e.delivery) flags.push({ text: `India Post lists no delivery office for ${z}`, weight: 1 });
  return flags;
}

export const pincodeStatus = () => { const d = directory(); return { loaded: d.loaded, rows: d.rows, error: d.error || null, file: FILE }; };
