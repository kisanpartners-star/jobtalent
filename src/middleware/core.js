import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { ZodError } from 'zod';
import { env, UPLOAD_DIR } from '../config/env.js';
import { User } from '../models/index.js';
import { HttpError, safeFileName } from '../utils/helpers.js';

/* ---------- rate limits ---------- */
const limiter = (windowMs, max, message) => rateLimit({
  windowMs, max, standardHeaders: true, legacyHeaders: false,
  message: { error: message },
});
export const formLimiter = limiter(15 * 60 * 1000, 60, 'Too many submissions. Please try again in a few minutes.');
export const uploadLimiter = limiter(15 * 60 * 1000, 20, 'Too many uploads. Please try again later.');
export const loginLimiter = limiter(15 * 60 * 1000, 10, 'Too many login attempts. Please try again in 15 minutes.');
export const trackLimiter = limiter(60 * 1000, 120, 'Slow down.');

/* ---------- validation ---------- */
export const validate = (schema, where = 'body') => (req, _res, next) => {
  try { req[where] = schema.parse(req[where]); next(); } catch (e) { next(e); }
};

/* ---------- auth ---------- */
export const COOKIE = 'vbt_admin';
export function signToken(user) {
  return jwt.sign({ id: user._id, role: user.role }, env.jwtSecret, { expiresIn: `${env.sessionHours}h` });
}
export function setAuthCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: env.cookieSecure, maxAge: env.sessionHours * 3600 * 1000, path: '/',
  });
}
export const clearAuthCookie = (res) => res.clearCookie(COOKIE, { path: '/' });

export async function requireAuth(req, _res, next) {
  try {
    const token = req.cookies?.[COOKIE];
    if (!token) throw new HttpError(401, 'Please sign in.');
    let payload;
    try { payload = jwt.verify(token, env.jwtSecret); } catch { throw new HttpError(401, 'Session expired. Please sign in again.'); }
    const user = await User.findById(payload.id);
    if (!user || !user.active) throw new HttpError(401, 'Account unavailable.');
    req.user = user;
    next();
  } catch (e) { next(e); }
}

// Role matrix. Admin can do everything.
const ROLE_PERMS = {
  Admin: ['*'],
  Manager: ['dashboard', 'leads', 'analytics', 'cms', 'jobs', 'blog', 'export', 'notifications'],
  Recruiter: ['dashboard', 'leads', 'jobs', 'notifications'],
};
export const can = (user, perm) => {
  const base = ROLE_PERMS[user.role] || [];
  return base.includes('*') || base.includes(perm) || (user.permissions || []).includes(perm);
};
export const requirePerm = (perm) => (req, _res, next) =>
  can(req.user, perm) ? next() : next(new HttpError(403, 'You do not have permission to do that.'));
export const requireRole = (...roles) => (req, _res, next) =>
  roles.includes(req.user.role) ? next() : next(new HttpError(403, 'You do not have permission to do that.'));
export const permsFor = (user) => {
  const base = ROLE_PERMS[user.role] || [];
  return base.includes('*') ? ['*'] : [...new Set([...base, ...(user.permissions || [])])];
};

/* ---------- uploads ---------- */
const IMAGE = { mimes: ['image/jpeg', 'image/png', 'image/webp'], exts: ['.jpg', '.jpeg', '.png', '.webp'], max: 5 * 1024 * 1024 };
const DOC = { mimes: ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'], exts: ['.pdf', '.doc', '.docx'], max: 5 * 1024 * 1024 };
const VIDEO = { mimes: ['video/mp4'], exts: ['.mp4'], max: 15 * 1024 * 1024 };
const FAVICON = { mimes: [...IMAGE.mimes, 'image/x-icon', 'image/vnd.microsoft.icon'], exts: [...IMAGE.exts, '.ico'], max: 1024 * 1024 };

export const UPLOAD_KINDS = {
  image: { ...IMAGE, dir: 'images' },
  branding: { ...FAVICON, dir: 'branding' },
  video: { ...VIDEO, dir: 'videos' },
  resume: { ...DOC, dir: 'resumes' },
  candidatePhoto: { ...IMAGE, dir: 'resumes' }, // private
  document: { mimes: ['application/pdf'], exts: ['.pdf'], max: 10 * 1024 * 1024, dir: 'documents' },
};

// verify magic bytes after save so a renamed file cannot slip through
function sniff(buf, ext) {
  const hex = buf.subarray(0, 12).toString('hex');
  if (['.jpg', '.jpeg'].includes(ext)) return hex.startsWith('ffd8ff');
  if (ext === '.png') return hex.startsWith('89504e47');
  if (ext === '.webp') return buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP';
  if (ext === '.pdf') return buf.subarray(0, 4).toString() === '%PDF';
  if (ext === '.docx') return hex.startsWith('504b0304');
  if (ext === '.doc') return hex.startsWith('d0cf11e0');
  if (ext === '.mp4') return buf.subarray(4, 8).toString() === 'ftyp';
  if (ext === '.ico') return hex.startsWith('00000100');
  return false;
}

export function uploader(kind, field = 'file') {
  const cfg = UPLOAD_KINDS[kind];
  const dir = path.join(UPLOAD_DIR, cfg.dir);
  fs.mkdirSync(dir, { recursive: true });
  const m = multer({
    limits: { fileSize: cfg.max, files: 1 },
    storage: multer.diskStorage({
      destination: dir,
      filename: (_req, file, cb) => {
        const ext = path.extname(safeFileName(file.originalname)).toLowerCase();
        cb(null, `${Date.now()}-${crypto.randomBytes(10).toString('hex')}${ext}`);
      },
    }),
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (!cfg.mimes.includes(file.mimetype) || !cfg.exts.includes(ext)) {
        return cb(new HttpError(400, `Unsupported file type. Allowed: ${cfg.exts.join(', ')}`));
      }
      cb(null, true);
    },
  }).single(field);
  return (req, res, next) => m(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return next(new HttpError(400, `File too large. Maximum ${Math.round(cfg.max / 1048576)} MB.`));
      return next(err);
    }
    if (req.file) {
      const ext = path.extname(req.file.filename).toLowerCase();
      const head = Buffer.alloc(16);
      const fd = fs.openSync(req.file.path, 'r'); fs.readSync(fd, head, 0, 16, 0); fs.closeSync(fd);
      if (!sniff(head, ext)) { fs.unlink(req.file.path, () => {}); return next(new HttpError(400, 'File content does not match its type.')); }
      req.file.publicPath = `/uploads/${cfg.dir}/${req.file.filename}`;
      req.file.relPath = `${cfg.dir}/${req.file.filename}`;
    }
    next();
  });
}

// delete a previously stored upload (only inside UPLOAD_DIR, never the bundled defaults)
export function removeUpload(p) {
  if (!p || typeof p !== 'string') return;
  const rel = p.replace(/^\/?uploads\//, '');
  const abs = path.resolve(UPLOAD_DIR, rel);
  if (!abs.startsWith(UPLOAD_DIR + path.sep)) return;
  if (/(^|\/)(hero-2|hero-3|hero-4|hero-poster|about|contact|bharath|sampada|ramesh|logo-light|logo-dark|favicon|hero-placeholder)\./.test(rel) || rel.includes('-fallback')) return;
  fs.unlink(abs, () => {});
}

/* ---------- errors ---------- */
export function notFound(_req, _res, next) { next(new HttpError(404, 'Not found')); }
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, _req, res, _next) {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'Please check the highlighted fields.', fields: Object.fromEntries(err.issues.map((i) => [i.path.join('.'), i.message])) });
  }
  if (err?.name === 'CastError') return res.status(400).json({ error: 'Invalid identifier.' });
  if (err?.code === 11000) return res.status(409).json({ error: 'That value already exists.' });
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 && env.isProd ? 'Something went wrong. Please try again.' : err.message, ...(err.details ? { fields: err.details } : {}) });
}
