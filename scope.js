import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './db.js';

// Product scope: lets every tab show one product (or all). Which orders and campaigns belong to a product comes from the keywords on the Products tab.
const FILE = path.join(ROOT, 'data', 'product-groups.json');
export const loadGroups = () => { try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return { products: [] }; } };
export const has = (text, words) => (words || []).some(w => w && String(text).toLowerCase().includes(String(w).toLowerCase()));
const firstMatch = (text, field) => loadGroups().products.find(g => has(text, g[field]));

// null = all products. Otherwise functions that say whether an order title or an ad campaign belongs to the chosen product.
export function scopeFor(name) {
  if (!name) return null;
  return {
    name,
    order: title => firstMatch(title, 'titles')?.name === name,
    campaign: c => firstMatch(c, 'campaigns')?.name === name
  };
}
// Supplier cost per unit for an order title: the cost set on its product (Products tab), if any
export const groupCost = title => firstMatch(title, 'titles')?.cost ?? null;
export const groupRto = title => firstMatch(title, 'titles')?.rto ?? null;
export const filterOrders = (rows, name, key = 'product') => { const sc = scopeFor(name); return sc ? rows.filter(o => sc.order(o[key])) : rows; };
// SQL for ad_spend rows of the chosen product (all products when none is chosen)
export function campaignWhere(name) {
  if (!name) return { sql: '', params: [] };
  const g = loadGroups().products.find(p => p.name === name), words = (g?.campaigns || []).filter(Boolean);
  if (!words.length) return { sql: ' AND 0', params: [] };
  const sc = scopeFor(name);
  return { sql: ' AND (' + words.map(() => 'campaign LIKE ?').join(' OR ') + ')', params: words.map(w => `%${w}%`), post: sc.campaign };
}
