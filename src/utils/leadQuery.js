import { escapeRegex, dayRange, istStartOfDay, istEndOfDay } from './helpers.js';
import mongoose from 'mongoose';

const oid = (v) => (mongoose.isValidObjectId(v) ? new mongoose.Types.ObjectId(v) : null);
const eq = (v) => String(v).slice(0, 120);
const rx = (v) => new RegExp(escapeRegex(String(v).slice(0, 80)), 'i');

export const VIEWS = {
  all: {},
  company: { type: 'company', isDraft: false },
  candidate: { type: 'candidate', isDraft: false },
  enquiry: { type: 'enquiry', isDraft: false },
  chatbot: { type: 'chatbot', isDraft: false },
  draft: { isDraft: true },
  'public-form': { source: 'public-form', isDraft: false },
};

/** Builds a MongoDB filter from request query params. Shared by list, export and dashboard. */
export function buildLeadQuery(q = {}, { includeDrafts = true } = {}) {
  const f = { ...(VIEWS[q.view] || {}) };
  if (!includeDrafts && f.isDraft === undefined && q.view !== 'draft') f.isDraft = false;
  if (q.view === undefined && q.type && VIEWS[q.type]) Object.assign(f, VIEWS[q.type]);

  const and = [];
  if (q.q) {
    const r = rx(q.q);
    and.push({ $or: [{ name: r }, { phone: r }, { email: r }, { company: r }, { role: r }, { city: r }, { resumeCode: r }] });
  }
  if (q.status) f.status = q.status === 'Draft' ? 'Draft' : eq(q.status);
  if (q.source) f.source = eq(q.source);
  if (q.service) f.service = rx(q.service);
  if (q.industry) f.industry = rx(q.industry);
  if (q.city) f.city = rx(q.city);
  if (q.experience) f.experience = rx(q.experience);
  if (q.name) f.name = rx(q.name);
  if (q.assignedTo) { const id = oid(q.assignedTo); if (id) f.assignedTo = id; else if (q.assignedTo === 'none') f.assignedTo = null; }
  if (q.job) { const id = oid(q.job); if (id) f.jobId = id; }
  if (q.demo === 'true') f.demo = true;

  const r = dayRange(q.range, q.from, q.to);
  if (r) f.createdAt = { $gte: r.from, $lte: r.to };

  const now = new Date();
  switch (q.followUp) {
    case 'today': f.nextFollowUpAt = { $gte: istStartOfDay(now), $lte: istEndOfDay(now) }; break;
    case 'overdue': f.nextFollowUpAt = { $lt: istStartOfDay(now) }; break;
    case 'upcoming': f.nextFollowUpAt = { $gt: istEndOfDay(now) }; break;
    case 'any': f.nextFollowUpAt = { $ne: null }; break;
    default: break;
  }
  if (q.fuFrom || q.fuTo) {
    f.nextFollowUpAt = { ...(f.nextFollowUpAt || {}), ...(q.fuFrom ? { $gte: istStartOfDay(new Date(q.fuFrom)) } : {}), ...(q.fuTo ? { $lte: istEndOfDay(new Date(q.fuTo)) } : {}) };
  }
  if (and.length) f.$and = and;
  return f;
}

const SORTS = { createdAt: 'createdAt', name: 'name', status: 'status', nextFollowUpAt: 'nextFollowUpAt', updatedAt: 'updatedAt', company: 'company', city: 'city' };
export function buildSort(q = {}) {
  const key = SORTS[q.sort] || 'createdAt';
  const dir = q.dir === 'asc' ? 1 : -1;
  return { [key]: dir, _id: -1 };
}

export function followUpState(nextAt, now = new Date()) {
  if (!nextAt) return null;
  const start = istStartOfDay(now).getTime();
  const end = istEndOfDay(now).getTime();
  const t = new Date(nextAt).getTime();
  if (t < start) return { tone: 'overdue', days: Math.ceil((start - t) / 864e5), label: '' };
  if (t <= end) return { tone: 'today', days: 0, label: 'Due today' };
  return { tone: 'upcoming', days: Math.ceil((t - end) / 864e5), label: '' };
}
