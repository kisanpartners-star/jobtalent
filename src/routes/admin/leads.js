import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import mongoose from 'mongoose';
import { z } from 'zod';
import { UPLOAD_DIR } from '../../config/env.js';
import { Lead, User, LEAD_STATUSES } from '../../models/index.js';
import { requirePerm, requireRole, validate } from '../../middleware/core.js';
import { wrap, HttpError, clean, pageParams, istStartOfDay } from '../../utils/helpers.js';
import { buildLeadQuery, buildSort, followUpState, VIEWS } from '../../utils/leadQuery.js';
import { sendExport, LEAD_COLUMNS, leadRow } from '../../utils/exporter.js';
import { logActivity, and } from './common.js';

const r = Router();
r.use(requirePerm('leads'));

const HEAVY = '-data -activity -notes -followUps';
const CLOSED = ['Converted', 'Rejected'];
const isId = (v) => mongoose.isValidObjectId(v);
const withState = (l) => ({ ...l, followUp: followUpState(l.nextFollowUpAt) });
const who = (req) => req.user.name;

async function names(ids) {
  const uniq = [...new Set(ids.filter(Boolean).map(String))];
  if (!uniq.length) return {};
  const us = await User.find({ _id: { $in: uniq } }).select('name').lean();
  return Object.fromEntries(us.map((u) => [String(u._id), u.name]));
}

async function load(id) {
  if (!isId(id)) throw new HttpError(404, 'Lead not found.');
  const lead = await Lead.findById(id);
  if (!lead) throw new HttpError(404, 'Lead not found.');
  return lead;
}

// recompute the earliest pending follow-up (or clear it)
function syncNext(lead) {
  const pending = (lead.followUps || []).filter((f) => !f.done).sort((a, b) => a.dueAt - b.dueAt);
  lead.nextFollowUpAt = CLOSED.includes(lead.status) || lead.isDraft ? null : pending[0]?.dueAt || null;
}

/* ---------- meta + counts (filters, tabs) ---------- */
r.get('/meta', wrap(async (_req, res) => {
  const base = { isDraft: false };
  const [services, industries, cities, sources, experiences, users] = await Promise.all([
    Lead.distinct('service', base), Lead.distinct('industry', base), Lead.distinct('city', base), Lead.distinct('source', {}), Lead.distinct('experience', base),
    User.find({ active: true }).select('name role').sort({ name: 1 }).lean(),
  ]);
  const f = (a) => a.filter(Boolean).sort();
  res.json({ statuses: LEAD_STATUSES, services: f(services), industries: f(industries), cities: f(cities), sources: f(sources), experiences: f(experiences), users: users.map((u) => ({ id: u._id, name: u.name, role: u.role })) });
}));

r.get('/counts', wrap(async (req, res) => {
  const keys = Object.keys(VIEWS);
  const demo = req.query.demo === 'true' ? { demo: true } : {};
  const out = {};
  await Promise.all(keys.map(async (k) => { out[k] = await Lead.countDocuments(and(VIEWS[k], demo)); }));
  res.json(out);
}));

/* ---------- list ---------- */
r.get('/', wrap(async (req, res) => {
  const { page, limit, skip } = pageParams(req.query, 20, 100);
  const filter = buildLeadQuery(req.query, { includeDrafts: req.query.view === 'draft' || req.query.view === 'all' || !!req.query.status });
  const [items, total] = await Promise.all([
    Lead.find(filter).select(HEAVY).sort(buildSort(req.query)).skip(skip).limit(limit).lean(),
    Lead.countDocuments(filter),
  ]);
  const nm = await names(items.map((l) => l.assignedTo));
  res.json({ items: items.map((l) => ({ ...withState(l), assignedName: nm[String(l.assignedTo)] || '' })), total, page, pages: Math.ceil(total / limit) || 1, limit });
}));

/* ---------- export (respects every filter, or an explicit id list) ---------- */
r.get('/export', requirePerm('export'), wrap(async (req, res) => {
  const filter = buildLeadQuery(req.query, { includeDrafts: true });
  const ids = String(req.query.ids || '').split(',').filter(isId);
  const f = ids.length ? and(filter, { _id: { $in: ids } }) : filter;
  const leads = await Lead.find(f).select('-activity -notes -followUps -data').sort(buildSort(req.query)).limit(20000).lean();
  const nm = await names(leads.map((l) => l.assignedTo));
  const view = req.query.view && VIEWS[req.query.view] ? req.query.view : 'all';
  const label = { all: 'Leads', company: 'Company-Requests', candidate: 'Candidates', enquiry: 'Enquiries', chatbot: 'Chatbot-Leads', draft: 'Drafts', 'public-form': 'Public-Form-Leads' }[view];
  logActivity(req, 'export', label, `${leads.length} rows`);
  await sendExport(res, {
    filename: `VB-TALENTX-${label}-${new Date().toISOString().slice(0, 10)}`, format: req.query.format === 'csv' ? 'csv' : 'xlsx',
    sheets: [{ name: label, columns: LEAD_COLUMNS, rows: leads.map((l) => leadRow(l, nm[String(l.assignedTo)])) }],
  });
}));

/* ---------- bulk ---------- */
const bulkSchema = z.object({
  ids: z.array(z.string()).min(1).max(500),
  action: z.enum(['status', 'assign', 'delete']),
  status: z.enum(LEAD_STATUSES).optional(), reason: z.string().max(300).optional(), assignedTo: z.string().nullable().optional(),
});
r.post('/bulk', validate(bulkSchema), wrap(async (req, res) => {
  const { ids, action } = req.body;
  const valid = ids.filter(isId);
  if (!valid.length) throw new HttpError(400, 'No valid records selected.');
  if (action === 'delete') {
    if (!['Admin', 'Manager'].includes(req.user.role)) throw new HttpError(403, 'Only managers and admins can delete.');
    const docs = await Lead.find({ _id: { $in: valid } }).select('files').lean();
    const { removeUpload } = await import('../../middleware/core.js');
    docs.forEach((d) => (d.files || []).forEach((f) => removeUpload(f.path)));
    const { deletedCount } = await Lead.deleteMany({ _id: { $in: valid } });
    logActivity(req, 'leads-deleted', `${deletedCount} records`);
    return res.json({ ok: true, count: deletedCount });
  }
  if (action === 'assign') {
    const to = req.body.assignedTo && isId(req.body.assignedTo) ? req.body.assignedTo : null;
    const u = to ? await User.findById(to).select('name') : null;
    await Lead.updateMany({ _id: { $in: valid } }, { $set: { assignedTo: to }, $push: { activity: { kind: 'assigned', text: u ? `Assigned to ${u.name}` : 'Unassigned', by: who(req), at: new Date() } } });
    logActivity(req, 'leads-assigned', `${valid.length} records`, u?.name || 'unassigned');
    return res.json({ ok: true, count: valid.length });
  }
  const status = req.body.status;
  if (!status || status === 'Draft') throw new HttpError(400, 'Choose a status.');
  if (status === 'Rejected' && !clean(req.body.reason || '')) throw new HttpError(400, 'Please enter a reason for rejection.', { reason: 'Required' });
  const leads = await Lead.find({ _id: { $in: valid }, isDraft: false });
  for (const l of leads) applyStatus(l, status, req.body.reason, who(req));
  await Promise.all(leads.map((l) => l.save()));
  logActivity(req, 'leads-status', `${leads.length} records`, status);
  res.json({ ok: true, count: leads.length });
}));

function applyStatus(lead, status, reason, by) {
  const prev = lead.status;
  lead.status = status;
  if (status === 'Rejected') lead.rejectReason = clean(reason || '').slice(0, 300);
  else if (prev === 'Rejected') lead.rejectReason = undefined;
  lead.activity.push({ kind: 'status', text: `Status changed: ${prev} → ${status}${status === 'Rejected' && reason ? ` (${clean(reason).slice(0, 120)})` : ''}`, by });
  syncNext(lead);
}

/* ---------- single record ---------- */
r.get('/:id', wrap(async (req, res) => {
  const lead = await load(req.params.id);
  if (!lead.seen) { lead.seen = true; await lead.save(); }
  const o = lead.toObject();
  o.followUps = (o.followUps || []).map((f) => ({ ...f, state: f.done ? null : followUpState(f.dueAt) })).sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
  o.notes = (o.notes || []).sort((a, b) => new Date(b.at) - new Date(a.at));
  o.activity = (o.activity || []).sort((a, b) => new Date(b.at) - new Date(a.at));
  o.files = (o.files || []).map((f) => ({ field: f.field, originalName: f.originalName, mime: f.mime, size: f.size, uploadedAt: f.uploadedAt }));
  const nm = await names([o.assignedTo]);
  res.json({ ...withState(o), assignedName: nm[String(o.assignedTo)] || '' });
}));

const editSchema = z.object({
  name: z.string().trim().max(120).optional(), phone: z.string().trim().max(30).optional(), email: z.string().trim().max(120).optional(),
  company: z.string().trim().max(160).optional(), city: z.string().trim().max(80).optional(), role: z.string().trim().max(120).optional(),
  industry: z.string().trim().max(100).optional(), service: z.string().trim().max(100).optional(), experience: z.string().trim().max(60).optional(),
  requirement: z.string().trim().max(2000).optional(),
});
r.patch('/:id', validate(editSchema), wrap(async (req, res) => {
  const lead = await load(req.params.id);
  const changed = [];
  for (const [k, v] of Object.entries(req.body)) { const c = clean(v); if (lead[k] !== c) { lead[k] = c || undefined; changed.push(k); } }
  if (changed.length) lead.activity.push({ kind: 'edit', text: `Details edited (${changed.join(', ')})`, by: who(req) });
  await lead.save(); res.json({ ok: true });
}));

r.post('/:id/status', validate(z.object({ status: z.enum(LEAD_STATUSES), reason: z.string().max(300).optional() })), wrap(async (req, res) => {
  const lead = await load(req.params.id);
  if (lead.isDraft) throw new HttpError(400, 'This is an unsubmitted draft. Its status cannot be changed.');
  if (req.body.status === 'Draft') throw new HttpError(400, 'Choose a valid status.');
  if (req.body.status === 'Rejected' && !clean(req.body.reason || '')) throw new HttpError(400, 'Please enter a reason for rejection.', { reason: 'Required' });
  applyStatus(lead, req.body.status, req.body.reason, who(req));
  await lead.save(); logActivity(req, 'lead-status', lead.name || lead.company, req.body.status);
  res.json({ ok: true, status: lead.status });
}));

r.post('/:id/assign', validate(z.object({ assignedTo: z.string().nullable() })), wrap(async (req, res) => {
  const lead = await load(req.params.id);
  const to = req.body.assignedTo && isId(req.body.assignedTo) ? req.body.assignedTo : null;
  const u = to ? await User.findById(to).select('name') : null;
  lead.assignedTo = to || undefined;
  lead.activity.push({ kind: 'assigned', text: u ? `Assigned to ${u.name}` : 'Unassigned', by: who(req) });
  await lead.save(); res.json({ ok: true, assignedName: u?.name || '' });
}));

r.post('/:id/notes', validate(z.object({ text: z.string().trim().min(1).max(2000) })), wrap(async (req, res) => {
  const lead = await load(req.params.id);
  lead.notes.push({ text: clean(req.body.text), by: who(req) });
  lead.activity.push({ kind: 'note', text: 'Note added', by: who(req) });
  await lead.save(); res.status(201).json({ ok: true });
}));

/* ---------- follow-ups ---------- */
const PRESET_DAYS = { tomorrow: 1, '3days': 3, '1week': 7, '2weeks': 14, '1month': 30 };
const fuSchema = z.object({ preset: z.enum(['tomorrow', '3days', '1week', '2weeks', '1month', 'custom']).default('custom'), dueAt: z.string().optional(), note: z.string().max(500).optional() });
r.post('/:id/followups', validate(fuSchema), wrap(async (req, res) => {
  const lead = await load(req.params.id);
  if (lead.isDraft) throw new HttpError(400, 'Follow-ups can be scheduled once the form is submitted.');
  let due;
  if (req.body.preset !== 'custom') due = new Date(istStartOfDay(new Date()).getTime() + PRESET_DAYS[req.body.preset] * 864e5 + 10 * 3600e3); // 10:00 IST
  else { due = new Date(req.body.dueAt || ''); if (isNaN(due)) throw new HttpError(400, 'Choose a valid date and time.', { dueAt: 'Required' }); }
  lead.followUps.push({ dueAt: due, note: clean(req.body.note || ''), createdBy: who(req) });
  lead.activity.push({ kind: 'followup', text: `Follow-up scheduled for ${due.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })}${req.body.note ? `: ${clean(req.body.note).slice(0, 100)}` : ''}`, by: who(req) });
  if (['New', 'Contacted', 'Follow-up Done', 'Interested', 'On Hold'].includes(lead.status)) lead.status = 'Follow-up Scheduled';
  syncNext(lead); await lead.save();
  res.status(201).json({ ok: true, nextFollowUpAt: lead.nextFollowUpAt });
}));

r.post('/:id/followups/:fid/done', validate(z.object({ note: z.string().max(500).optional() })), wrap(async (req, res) => {
  const lead = await load(req.params.id);
  const f = lead.followUps.id(req.params.fid);
  if (!f) throw new HttpError(404, 'Follow-up not found.');
  f.done = true; f.doneAt = new Date();
  if (req.body.note) f.note = [f.note, `Outcome: ${clean(req.body.note)}`].filter(Boolean).join(' | ');
  lead.activity.push({ kind: 'followup-done', text: `Follow-up done${req.body.note ? `: ${clean(req.body.note).slice(0, 100)}` : ''}`, by: who(req) });
  if (!CLOSED.includes(lead.status) && !lead.followUps.some((x) => !x.done)) lead.status = 'Follow-up Done';
  syncNext(lead); await lead.save();
  res.json({ ok: true, status: lead.status, nextFollowUpAt: lead.nextFollowUpAt });
}));

r.delete('/:id/followups/:fid', wrap(async (req, res) => {
  const lead = await load(req.params.id);
  const f = lead.followUps.id(req.params.fid);
  if (!f) throw new HttpError(404, 'Follow-up not found.');
  lead.followUps.pull(f._id); lead.activity.push({ kind: 'followup-removed', text: 'Follow-up removed', by: who(req) });
  syncNext(lead); await lead.save(); res.json({ ok: true });
}));

/* ---------- private files (résumé, photo): authenticated only ---------- */
r.get('/:id/files/:field', wrap(async (req, res) => {
  const lead = await load(req.params.id);
  const f = lead.files.find((x) => x.field === req.params.field);
  if (!f) throw new HttpError(404, 'File not found.');
  const abs = path.resolve(UPLOAD_DIR, f.path);
  if (!abs.startsWith(path.join(UPLOAD_DIR, 'resumes') + path.sep) || !fs.existsSync(abs)) throw new HttpError(404, 'File not found.');
  res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  if (req.query.download) return res.download(abs, f.originalName || path.basename(abs));
  res.type(f.mime || 'application/octet-stream'); res.set('Content-Disposition', `inline; filename="${encodeURIComponent(f.originalName || 'file')}"`);
  fs.createReadStream(abs).pipe(res);
}));

r.delete('/:id', requireRole('Admin', 'Manager'), wrap(async (req, res) => {
  const lead = await load(req.params.id);
  const { removeUpload } = await import('../../middleware/core.js');
  (lead.files || []).forEach((f) => removeUpload(f.path));
  await lead.deleteOne(); logActivity(req, 'lead-deleted', lead.name || lead.company || lead._id);
  res.json({ ok: true });
}));

export default r;
