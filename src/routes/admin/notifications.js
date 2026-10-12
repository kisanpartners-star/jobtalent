import { Router } from 'express';
import mongoose from 'mongoose';
import { Notification, Lead, Job, BlogPost } from '../../models/index.js';
import { requirePerm, can } from '../../middleware/core.js';
import { wrap, escapeRegex } from '../../utils/helpers.js';

const r = Router();

const LEAD_KINDS = ['new_lead', 'new_candidate', 'new_chatbot'];
const FU_KINDS = ['followup_due', 'followup_overdue'];

function visibleKinds(user) {
  const p = user.prefs || {};
  return [...(p.notifyNewLead === false ? [] : LEAD_KINDS), ...(p.notifyFollowups === false ? [] : FU_KINDS)];
}

r.get('/notifications', requirePerm('notifications'), wrap(async (req, res) => {
  const kinds = visibleKinds(req.user);
  const limit = Math.min(50, parseInt(req.query.limit) || 20);
  const match = { kind: { $in: kinds } };
  const [items, unread] = await Promise.all([
    Notification.find(match).sort({ createdAt: -1 }).limit(limit).lean(),
    Notification.countDocuments({ ...match, readBy: { $ne: req.user._id } }),
  ]);
  res.set('Cache-Control', 'no-store');
  res.json({ unread, items: items.map(({ readBy, ...n }) => ({ ...n, read: readBy.some((x) => String(x) === String(req.user._id)) })) });
}));

r.post('/notifications/read-all', requirePerm('notifications'), wrap(async (req, res) => {
  await Notification.updateMany({ readBy: { $ne: req.user._id } }, { $addToSet: { readBy: req.user._id } });
  res.json({ ok: true });
}));

r.post('/notifications/:id/read', requirePerm('notifications'), wrap(async (req, res) => {
  if (mongoose.isValidObjectId(req.params.id)) await Notification.updateOne({ _id: req.params.id }, { $addToSet: { readBy: req.user._id } });
  res.json({ ok: true });
}));

/* ---------- global search (top bar) ---------- */
r.get('/search', wrap(async (req, res) => {
  const term = String(req.query.q || '').trim().slice(0, 60);
  if (term.length < 2) return res.json({ leads: [], jobs: [], posts: [] });
  const rx = new RegExp(escapeRegex(term), 'i');
  const [leads, jobs, posts] = await Promise.all([
    can(req.user, 'leads') ? Lead.find({ $or: [{ name: rx }, { phone: rx }, { email: rx }, { company: rx }, { resumeCode: rx }] }).select('name company type status isDraft phone').sort({ createdAt: -1 }).limit(6).lean() : [],
    can(req.user, 'jobs') ? Job.find({ $or: [{ title: rx }, { location: rx }] }).select('title location status').limit(4).lean() : [],
    can(req.user, 'blog') ? BlogPost.find({ title: rx }).select('title status').limit(4).lean() : [],
  ]);
  res.json({
    leads: leads.map((l) => ({ id: l._id, title: l.name || l.company, sub: `${l.isDraft ? 'Draft' : l.status} · ${l.type} · ${l.phone || ''}`, link: `/admin/leads/${l._id}` })),
    jobs: jobs.map((j) => ({ id: j._id, title: j.title, sub: `${j.status} · ${j.location || ''}`, link: `/admin/jobs` })),
    posts: posts.map((p) => ({ id: p._id, title: p.title, sub: p.status, link: `/admin/blog` })),
  });
}));

export default r;
