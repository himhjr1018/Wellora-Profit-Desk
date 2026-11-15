import { db, daysAgo } from './db.js';

// Live order tracking from what Dropship India sends to Shopify.
// Shopify knows two things: the order was placed, and (once Dropship India dispatches it) a fulfilment with the
// courier and tracking number. "Confirmed" and "packed" happen inside Dropship India's own panel and are not sent
// to Shopify. Delivered and RTO come from your own marking, or from the app if it ever reports a delivery status.

export const AWAITING_ALERT_HOURS = 48;   // placed but not shipped for this long
export const TRANSIT_ALERT_DAYS = 7;      // shipped but not delivered for this long

export function listTracking({ days = 30, from: fromOpt = '', to: toOpt = '' } = {}) {
  const valid = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
  const from = valid(fromOpt) ? fromOpt : days > 0 ? daysAgo(days - 1) : '0000-00-00';
  const to = valid(toOpt) ? toOpt : '9999-12-31';
  const raw = db.prepare(`SELECT id, name, created_at, day, customer, phone, province, payment, total, status, courier, tracking_no, tracking_url, fulfilled_at, ship_status
    FROM orders WHERE day >= ? AND day <= ? ORDER BY created_at DESC`).all(from, to);
  const now = Date.now();

  const rows = raw.map(o => {
    const placed = Date.parse(o.created_at), sent = o.fulfilled_at ? Date.parse(o.fulfilled_at) : null;
    const stage = o.status === 'cancelled' ? 'cancelled' : o.status === 'delivered' ? 'delivered' : o.status === 'rto' ? 'rto'
      : (o.status === 'shipped' || sent) ? 'in_transit' : 'awaiting';
    const waitHours = stage === 'awaiting' ? (now - placed) / 36e5 : null;
    const dispatchHours = sent ? Math.max(0, (sent - placed) / 36e5) : null;
    const transitDays = stage === 'in_transit' && sent ? (now - sent) / 864e5 : null;
    const alerts = [];
    if (waitHours !== null && waitHours > AWAITING_ALERT_HOURS) alerts.push(`Not shipped after ${Math.floor(waitHours / 24)} days`);
    if (transitDays !== null && transitDays > TRANSIT_ALERT_DAYS) alerts.push(`Shipped ${Math.floor(transitDays)} days ago, not delivered`);
    if (o.ship_status === 'failure') alerts.push('Courier reported a delivery failure');
    if (o.ship_status === 'attempted_delivery') alerts.push('Courier attempted delivery');
    return { ...o, stage, waitHours, dispatchHours, transitDays, alerts };
  });

  const count = s => rows.filter(r => r.stage === s).length;
  const sentRows = rows.filter(r => r.dispatchHours !== null);
  const couriers = {};
  for (const r of rows) {
    if (!r.courier) continue;
    const c = (couriers[r.courier] ||= { courier: r.courier, shipped: 0, inTransit: 0, delivered: 0, rto: 0, dispatch: [], transit: [] });
    c.shipped++;
    if (r.stage === 'in_transit') { c.inTransit++; if (r.transitDays !== null) c.transit.push(r.transitDays); }
    if (r.stage === 'delivered') c.delivered++;
    if (r.stage === 'rto') c.rto++;
    if (r.dispatchHours !== null) c.dispatch.push(r.dispatchHours);
  }
  const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  return {
    rows,
    summary: {
      total: rows.length,
      awaiting: count('awaiting'), inTransit: count('in_transit'), delivered: count('delivered'), rto: count('rto'), cancelled: count('cancelled'),
      awaitingOld: rows.filter(r => r.stage === 'awaiting' && r.waitHours > AWAITING_ALERT_HOURS).length,
      transitOld: rows.filter(r => r.stage === 'in_transit' && r.transitDays > TRANSIT_ALERT_DAYS).length,
      avgDispatchHours: avg(sentRows.map(r => r.dispatchHours)),
      attention: rows.filter(r => r.alerts.length).length
    },
    couriers: Object.values(couriers).map(c => ({ courier: c.courier, shipped: c.shipped, inTransit: c.inTransit, delivered: c.delivered, rto: c.rto,
      avgDispatchHours: avg(c.dispatch), avgTransitDays: avg(c.transit) })).sort((a, b) => b.shipped - a.shipped),
    limits: { awaitingHours: AWAITING_ALERT_HOURS, transitDays: TRANSIT_ALERT_DAYS }
  };
}
