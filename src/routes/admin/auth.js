import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { User } from '../../models/index.js';
import { loginLimiter, validate, signToken, setAuthCookie, clearAuthCookie, requireAuth, permsFor } from '../../middleware/core.js';
import { wrap, HttpError, clean } from '../../utils/helpers.js';
import { logActivity } from './common.js';

const r = Router();

export const publicUser = (u) => ({
  id: u._id, name: u.name, email: u.email, role: u.role, permissions: permsFor(u), mustChangePassword: !!u.mustChangePassword,
  prefs: u.prefs || {}, lastLoginAt: u.lastLoginAt,
});

const strong = z.string().min(8, 'Use at least 8 characters').max(100)
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), 'Include at least one letter and one number');

r.post('/login', loginLimiter, validate(z.object({ email: z.string().email().max(120), password: z.string().min(1).max(100) })), wrap(async (req, res) => {
  const user = await User.findOne({ email: req.body.email.toLowerCase() }).select('+passwordHash');
  const ok = user && user.active && (await bcrypt.compare(req.body.password, user.passwordHash));
  if (!ok) throw new HttpError(401, 'Incorrect e-mail or password.');
  user.lastLoginAt = new Date(); await user.save();
  setAuthCookie(res, signToken(user));
  req.user = user; logActivity(req, 'login', user.email);
  res.json({ user: publicUser(user) });
}));

r.post('/logout', (req, res) => { clearAuthCookie(res); res.json({ ok: true }); });

r.get('/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

r.post('/change-password', requireAuth, validate(z.object({ current: z.string().min(1).max(100), password: strong })), wrap(async (req, res) => {
  const user = await User.findById(req.user._id).select('+passwordHash');
  if (!(await bcrypt.compare(req.body.current, user.passwordHash))) throw new HttpError(400, 'Your current password is incorrect.', { current: 'Incorrect password' });
  if (req.body.current === req.body.password) throw new HttpError(400, 'Choose a password different from the current one.', { password: 'Must be different' });
  user.passwordHash = await bcrypt.hash(req.body.password, 12);
  user.mustChangePassword = false; await user.save();
  setAuthCookie(res, signToken(user)); logActivity(req, 'password-changed', user.email);
  res.json({ ok: true, user: publicUser(user) });
}));

r.put('/profile', requireAuth, validate(z.object({
  name: z.string().trim().min(2).max(80),
  prefs: z.object({ emailNotifications: z.boolean().optional(), notifyNewLead: z.boolean().optional(), notifyFollowups: z.boolean().optional() }).optional(),
})), wrap(async (req, res) => {
  const u = await User.findById(req.user._id);
  u.name = clean(req.body.name);
  if (req.body.prefs) u.prefs = { ...(u.prefs || {}), ...req.body.prefs };
  await u.save(); logActivity(req, 'profile-updated', u.email);
  res.json({ user: publicUser(u) });
}));

export default r;
