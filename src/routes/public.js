import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import { z } from 'zod';
import { UPLOAD_DIR } from '../config/env.js';
import {
  SiteSettings, HeroSlide, Service, Industry, Leader, Testimonial, Announcement, Job, BlogPost, FaqItem, DocumentFile, Lead, TrackEvent,
} from '../models/index.js';
import { getSettings } from '../utils/bootstrap.js';
import { formLimiter, uploadLimiter, trackLimiter, validate, uploader, removeUpload } from '../middleware/core.js';
import { wrap, HttpError, escapeRegex, pageParams, richHtml } from '../utils/helpers.js';
import { enquirySchema, chatbotSchema, createSimpleLead, saveDraft } from '../utils/leads.js';
import { pageviewSchema, eventSchema, recordPageview, recordEvent } from '../utils/tracking.js';

const r = Router();

const stripSecrets = (s) => { const { smtp, ...rest } = s; return rest; };

/* ---------- site bootstrap: everything the public site needs in one call ---------- */
r.get('/bootstrap', wrap(async (_req, res) => {
  const now = new Date();
  const [settings, slides, services, industries, leaders, testimonials, announcements, faqs] = await Promise.all([
    getSettings(),
    HeroSlide.find({ enabled: true }).sort({ order: 1 }).lean(),
    Service.find({ active: true }).sort({ order: 1 }).lean(),
    Industry.find({ active: true }).sort({ order: 1 }).lean(),
    Leader.find({ active: true }).sort({ order: 1 }).lean(),
    Testimonial.find({ published: true }).sort({ order: 1 }).lean(),
    Announcement.find({ active: true, $and: [{ $or: [{ startsAt: null }, { startsAt: { $lte: now } }] }, { $or: [{ endsAt: null }, { endsAt: { $gte: now } }] }] }).sort({ createdAt: -1 }).lean(),
    FaqItem.find({ active: true }).sort({ order: 1 }).lean(),
  ]);
  const openJobs = await Job.countDocuments({ status: 'Open' });
  res.set('Cache-Control', 'no-cache');
  res.json({ settings: stripSecrets(settings), slides, services, industries, leaders, testimonials, announcements, faqs, openJobs });
}));

/* ---------- jobs ---------- */
r.get('/jobs', wrap(async (req, res) => {
  const { page, limit, skip } = pageParams(req.query, 12, 50);
  const q = { status: 'Open' };
  const { search, location, industry, type } = req.query;
  if (search) q.$or = [{ title: new RegExp(escapeRegex(String(search).slice(0, 60)), 'i') }, { description: new RegExp(escapeRegex(String(search).slice(0, 60)), 'i') }];
  if (location) q.location = new RegExp(`^${escapeRegex(String(location).slice(0, 60))}$`, 'i');
  if (industry) q.industry = String(industry).slice(0, 80);
  if (type) q.type = String(type).slice(0, 40);
  const [items, total, locations, industries, types] = await Promise.all([
    Job.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Job.countDocuments(q),
    Job.distinct('location', { status: 'Open' }), Job.distinct('industry', { status: 'Open' }), Job.distinct('type', { status: 'Open' }),
  ]);
  res.json({ items, total, page, pages: Math.ceil(total / limit), filters: { locations, industries, types } });
}));
r.get('/jobs/:slug', wrap(async (req, res) => {
  const job = await Job.findOne({ slug: req.params.slug, status: 'Open' }).lean();
  if (!job) throw new HttpError(404, 'This job is no longer available.');
  res.json(job);
}));

/* ---------- blog ---------- */
r.get('/blog', wrap(async (req, res) => {
  const { page, limit, skip } = pageParams(req.query, 9, 30);
  const q = { status: 'Published' };
  const [items, total] = await Promise.all([
    BlogPost.find(q).select('-body').sort({ publishedAt: -1 }).skip(skip).limit(limit).lean(), BlogPost.countDocuments(q),
  ]);
  res.json({ items, total, page, pages: Math.ceil(total / limit) });
}));
r.get('/blog/:slug', wrap(async (req, res) => {
  const post = await BlogPost.findOne({ slug: req.params.slug, status: 'Published' }).lean();
  if (!post) throw new HttpError(404, 'Article not found.');
  post.body = richHtml(post.body);
  res.json(post);
}));

/* ---------- forms: enquiry + chatbot ---------- */
r.post('/enquiry', formLimiter, validate(enquirySchema), wrap(async (req, res) => {
  if (req.body.website) return res.json({ ok: true }); // honeypot
  const lead = await createSimpleLead('enquiry', req.body);
  res.status(201).json({ ok: true, id: lead._id });
}));

r.post('/chatbot-lead', formLimiter, validate(chatbotSchema), wrap(async (req, res) => {
  if (req.body.website) return res.json({ ok: true });
  const lead = await createSimpleLead('chatbot', req.body);
  res.status(201).json({ ok: true, id: lead._id });
}));

/* ---------- forms: multi-step with drafts ---------- */
const kindParam = (req, _res, next) => (['company', 'candidate'].includes(req.params.kind) ? next() : next(new HttpError(404, 'Unknown form')));
const draftBody = z.object({ code: z.string().max(30).optional(), step: z.coerce.number().int().min(0).max(4).default(0), data: z.record(z.any()).default({}), source: z.enum(['register', 'public-form']).default('register') });

r.post('/forms/:kind/draft', formLimiter, kindParam, validate(draftBody), wrap(async (req, res) => {
  const lead = await saveDraft(req.params.kind, req.body);
  res.json({ ok: true, code: lead.resumeCode, step: lead.draftStep, savedAt: lead.updatedAt });
}));

r.post('/forms/:kind/submit', formLimiter, kindParam, validate(draftBody), wrap(async (req, res) => {
  const lead = await saveDraft(req.params.kind, req.body, { submit: true });
  res.status(201).json({ ok: true, code: lead.resumeCode });
}));

r.get('/forms/:kind/draft/:code', formLimiter, kindParam, wrap(async (req, res) => {
  const lead = await Lead.findOne({ resumeCode: String(req.params.code).toUpperCase(), type: req.params.kind }).lean();
  if (!lead) throw new HttpError(404, 'We could not find that resume code.');
  if (!lead.isDraft) throw new HttpError(409, 'This application has already been submitted.');
  res.json({ code: lead.resumeCode, step: lead.draftStep, data: lead.data, files: (lead.files || []).map((f) => ({ field: f.field, originalName: f.originalName, size: f.size })) });
}));

// Candidate uploads (private, never public). A draft is created on the fly if none exists.
async function candidateUpload(field, req, res) {
  if (!req.file) throw new HttpError(400, 'No file received.');
  try {
    let lead = req.body.code ? await Lead.findOne({ resumeCode: String(req.body.code).toUpperCase(), type: 'candidate', isDraft: true }) : null;
    if (req.body.code && !lead) throw new HttpError(404, 'Draft not found.');
    if (!lead) {
      const created = await saveDraft('candidate', { step: 0, data: {}, source: req.body.source === 'public-form' ? 'public-form' : 'register' });
      lead = await Lead.findById(created._id);
    }
    const old = lead.files.find((f) => f.field === field);
    if (old) removeUpload(old.path);
    lead.files = lead.files.filter((f) => f.field !== field);
    lead.files.push({ field, originalName: path.basename(req.file.originalname).slice(0, 120), path: req.file.relPath, mime: req.file.mimetype, size: req.file.size, uploadedAt: new Date() });
    await lead.save();
    res.json({ ok: true, code: lead.resumeCode, file: { field, originalName: req.file.originalname, size: req.file.size } });
  } catch (e) { removeUpload(req.file.relPath); throw e; }
}
r.post('/forms/candidate/resume', uploadLimiter, uploader('resume'), wrap((req, res) => candidateUpload('resume', req, res)));
r.post('/forms/candidate/photo', uploadLimiter, uploader('candidatePhoto'), wrap((req, res) => candidateUpload('photo', req, res)));

/* ---------- downloads ---------- */
r.get('/download/:key', wrap(async (req, res) => {
  const doc = await DocumentFile.findOne({ key: req.params.key });
  if (!doc) throw new HttpError(404, 'File not found.');
  const rel = doc.path && fs.existsSync(path.join(UPLOAD_DIR, doc.path)) ? doc.path : doc.fallbackPath;
  const abs = path.resolve(UPLOAD_DIR, rel || '');
  if (!abs.startsWith(UPLOAD_DIR + path.sep) || !fs.existsSync(abs)) throw new HttpError(404, 'File not available yet.');
  doc.downloads += 1; await doc.save();
  const vid = String(req.query.v || '').slice(0, 64);
  TrackEvent.create({ type: 'download', label: doc.key, visitorId: vid || 'unknown', at: new Date() }).catch(() => {});
  const nice = doc.key === 'company-profile' ? 'VB-TALENTX-Company-Profile.pdf' : 'VB-TALENTX-Visiting-Card-Bharath-Kumar-R-A.pdf';
  res.download(abs, nice);
}));

/* ---------- tracking ---------- */
r.post('/track/pageview', trackLimiter, validate(pageviewSchema), wrap(async (req, res) => { res.json(await recordPageview(req, req.body)); }));
r.post('/track/event', trackLimiter, validate(eventSchema), wrap(async (req, res) => { res.json(await recordEvent(req, req.body)); }));

export default r;
