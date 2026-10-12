import { ActivityLog } from '../../models/index.js';

export const logActivity = (req, action, target = '', detail = '') =>
  ActivityLog.create({ userId: req.user?._id, userName: req.user?.name || 'system', action, target: String(target).slice(0, 200), detail: String(detail).slice(0, 400), at: new Date() }).catch(() => {});

export const IST_TZ = 'Asia/Kolkata';
export const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

// "YYYY-MM-DD" for a Date, in IST
export const istKey = (d) => new Date(new Date(d).getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);

/** Every IST day key between from and to (inclusive), used to zero-fill chart series. */
export function dayKeys(from, to, maxDays = 400) {
  const out = [];
  let t = new Date(istKey(from) + 'T00:00:00Z').getTime();
  const end = new Date(istKey(to) + 'T00:00:00Z').getTime();
  while (t <= end && out.length < maxDays) { out.push(new Date(t).toISOString().slice(0, 10)); t += 864e5; }
  return out;
}

export const dayExpr = (field = '$createdAt') => ({ $dateToString: { format: '%Y-%m-%d', date: field, timezone: IST_TZ } });
export const monthExpr = (field = '$createdAt') => ({ $dateToString: { format: '%Y-%m', date: field, timezone: IST_TZ } });
export const and = (...parts) => { const p = parts.filter((x) => x && Object.keys(x).length); return p.length ? (p.length === 1 ? p[0] : { $and: p }) : {}; };
export const toMap = (rows) => Object.fromEntries(rows.map((r) => [r._id ?? 'Unknown', r.n]));
export const rowsToList = (rows, limit) => rows.map((r) => ({ name: r._id || 'Unknown', value: r.n })).slice(0, limit);
