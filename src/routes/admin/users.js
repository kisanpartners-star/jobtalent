import { Router } from 'express';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { z } from 'zod';
import { User, ActivityLog, SiteSettings } from '../../models/index.js';
import { requireRole, validate } from '../../middleware/core.js';
import { wrap, HttpError, clean, pageParams, escapeRegex } from '../../utils/helpers.js';
import { getSettings } from '../../utils/bootstrap.js';
import { sendMail } from '../../utils/notify.js';
import { logActivity } from './common.js';

const r = Router();
r.use(requireRole('Admin'));

export const ALL_PERMS = ['dashboard', 'leads', 'analytics', 'cms', 'jobs', 'blog', 'export', 'notifications'];
const strong = z.string().min(8, 'Use at least 8 characters').max(100).refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), 'Include a letter and a number');
const base = {
  name: z.string().trim().min(2).max(80), role: z.enum(['Admin', 'Manager', 'Recruiter']),
  permissions: z.array(z.enum(ALL_PERMS)).max(20).default([]), active: z.boolean().default(true),
};
const view = (u) => ({ id: u._id, name: u.name, email: u.email, role: u.role, permissions: u.permissions || [], active: u.active, lastLoginAt: u.lastLoginAt, createdAt: u.createdAt, mustChangePassword: u.mustChangePassword });

r.get('/users', wrap(async (_req, res) => { res.json({ items: (await User.find().sort({ createdAt: 1 }).lean()).map(view), allPermissions: ALL_PERMS }); }));

r.post('/users', validate(z.object({ ...base, email: z.string().email().max(120), password: strong })), wrap(async (req, res) => {
  const b = req.body;
  const u = await User.create({ name: clean(b.name), email: b.email.toLowerCase(), role: b.role, permissions: b.permissions, active: b.active, passwordHash: await bcrypt.hash(b.password, 12), mustChangePassword: true });
  logActivity(req, 'user-created', u.email, u.role); res.status(201).json(view(u));
}));

async function guardLastAdmin(target, next) {
  const losing = target.role === 'Admin' && target.active && (next.role !== 'Admin' || next.active === false);
  if (losing && (await User.countDocuments({ role: 'Admin', active: true })) <= 1) throw new HttpError(400, 'There must be at least one active admin.');
}

r.put('/users/:id', validate(z.object({ ...base, password: strong.optional().or(z.literal('')) })), wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, 'User not found.');
  const u = await User.findById(req.params.id);
  if (!u) throw new HttpError(404, 'User not found.');
  if (String(u._id) === String(req.user._id) && (req.body.active === false || req.body.role !== 'Admin')) throw new HttpError(400, 'You cannot demote or deactivate your own account.');
  await guardLastAdmin(u, req.body);
  u.name = clean(req.body.name); u.role = req.body.role; u.permissions = req.body.permissions; u.active = req.body.active;
  if (req.body.password) { u.passwordHash = await bcrypt.hash(req.body.password, 12); u.mustChangePassword = true; }
  await u.save(); logActivity(req, 'user-updated', u.email, `${u.role}${req.body.password ? ', password reset' : ''}`);
  res.json(view(u));
}));

r.delete('/users/:id', wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, 'User not found.');
  const u = await User.findById(req.params.id);
  if (!u) throw new HttpError(404, 'User not found.');
  if (String(u._id) === String(req.user._id)) throw new HttpError(400, 'You cannot delete your own account.');
  await guardLastAdmin(u, { role: 'x', active: false });
  await u.deleteOne(); logActivity(req, 'user-deleted', u.email); res.json({ ok: true });
}));

/* ---------- activity log ---------- */
r.get('/activity', wrap(async (req, res) => {
  const { page, limit, skip } = pageParams(req.query, 30, 100);
  const f = {};
  if (req.query.q) { const rx = new RegExp(escapeRegex(String(req.query.q).slice(0, 60)), 'i'); f.$or = [{ userName: rx }, { action: rx }, { target: rx }, { detail: rx }]; }
  const [items, total] = await Promise.all([ActivityLog.find(f).sort({ at: -1 }).skip(skip).limit(limit).lean(), ActivityLog.countDocuments(f)]);
  res.json({ items, total, page, pages: Math.ceil(total / limit) || 1 });
}));

/* ---------- SMTP / e-mail settings (password is never sent back) ---------- */
const MASK = '••••••••';
r.get('/smtp', wrap(async (_req, res) => {
  const s = (await getSettings()).smtp || {};
  res.json({ enabled: !!s.enabled, host: s.host || '', port: s.port || 587, user: s.user || '', pass: s.pass ? MASK : '', from: s.from || '', notifyTo: s.notifyTo || '' });
}));
r.put('/smtp', validate(z.object({
  enabled: z.boolean(), host: z.string().trim().max(200).default(''), port: z.coerce.number().int().min(1).max(65535).default(587),
  user: z.string().trim().max(200).default(''), pass: z.string().max(200).default(''), from: z.string().trim().max(200).default(''), notifyTo: z.string().trim().max(400).default(''),
})), wrap(async (req, res) => {
  const b = req.body;
  if (b.enabled && (!b.host || !b.notifyTo)) throw new HttpError(400, 'Enter the SMTP host and a notification e-mail address.', { host: b.host ? '' : 'Required', notifyTo: b.notifyTo ? '' : 'Required' });
  const cur = (await getSettings()).smtp || {};
  const next = { ...b, pass: b.pass === MASK ? cur.pass || '' : b.pass };
  await SiteSettings.updateOne({ key: 'main' }, { $set: { smtp: next } }); logActivity(req, 'smtp-updated', b.enabled ? 'enabled' : 'disabled');
  res.json({ ok: true });
}));
r.post('/smtp/test', wrap(async (_req, res) => {
  const ok = await sendMail('VB TALENTX test e-mail', 'If you can read this, your e-mail notification settings work.');
  if (!ok) throw new HttpError(400, 'The test e-mail could not be sent. Check the host, port, user, password and recipient.');
  res.json({ ok: true });
}));

export default r;
