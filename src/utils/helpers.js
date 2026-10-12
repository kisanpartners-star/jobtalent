import crypto from 'crypto';
import path from 'path';
import sanitizeHtml from 'sanitize-html';
import slugify from 'slugify';

export const clean = (v) => (typeof v === 'string' ? sanitizeHtml(v, { allowedTags: [], allowedAttributes: {} }).trim() : v);

export function cleanDeep(obj, depth = 0) {
  if (depth > 6) return undefined;
  if (Array.isArray(obj)) return obj.slice(0, 200).map((v) => cleanDeep(v, depth + 1));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith('$') || k.includes('.')) continue; // block operator injection
      out[k] = cleanDeep(v, depth + 1);
    }
    return out;
  }
  return clean(obj);
}

export const richHtml = (html) => sanitizeHtml(html || '', {
  allowedTags: ['h2', 'h3', 'h4', 'p', 'ul', 'ol', 'li', 'strong', 'em', 'b', 'i', 'a', 'br', 'blockquote', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
  allowedAttributes: { a: ['href', 'target', 'rel'], img: ['src', 'alt', 'width', 'height'] },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
});

export const makeSlug = (s) => slugify(String(s || ''), { lower: true, strict: true }).slice(0, 80);
export const randomCode = (len = 8) => crypto.randomBytes(len).toString('base64url').replace(/[-_]/g, 'x').slice(0, len).toUpperCase();
export const hashIp = (ip, salt) => crypto.createHash('sha256').update(`${salt}:${ip || ''}`).digest('hex').slice(0, 24);
export const normalisePhone = (p) => String(p || '').replace(/[^\d+]/g, '');

export const safeFileName = (name) => path.basename(String(name || 'file')).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);

export function pageParams(q, defLimit = 20, max = 100) {
  const page = Math.max(1, parseInt(q.page) || 1);
  const limit = Math.min(max, Math.max(1, parseInt(q.limit) || defLimit));
  return { page, limit, skip: (page - 1) * limit };
}

export const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// All business reporting is in India Standard Time (UTC+05:30), independent of the server time zone.
const IST = 5.5 * 3600 * 1000;
export const IST_TZ = 'Asia/Kolkata';
export function istStartOfDay(d = new Date()) { const x = new Date(new Date(d).getTime() + IST); x.setUTCHours(0, 0, 0, 0); return new Date(x.getTime() - IST); }
export function istEndOfDay(d = new Date()) { return new Date(istStartOfDay(d).getTime() + 864e5 - 1); }
export function dayRange(range, from, to) {
  const now = new Date();
  switch (range) {
    case 'today': return { from: istStartOfDay(now), to: istEndOfDay(now) };
    case '7d': return { from: istStartOfDay(new Date(now - 6 * 864e5)), to: istEndOfDay(now) };
    case '30d': return { from: istStartOfDay(new Date(now - 29 * 864e5)), to: istEndOfDay(now) };
    case 'month': { const x = new Date(now.getTime() + IST); return { from: new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), 1) - IST), to: istEndOfDay(now) }; }
    case 'custom': if (from && to) { const f = new Date(from), t = new Date(to); if (!isNaN(f) && !isNaN(t)) return { from: istStartOfDay(f), to: istEndOfDay(t) }; } return null;
    default: return null;
  }
}

export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export class HttpError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}
