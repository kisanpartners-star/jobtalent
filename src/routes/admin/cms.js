import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import mongoose from 'mongoose';
import { UPLOAD_DIR } from '../../config/env.js';
import {
  SiteSettings, HeroSlide, Service, Industry, Leader, Testimonial, Announcement, Job, BlogPost, FaqItem, SeoPage, DocumentFile, Lead,
} from '../../models/index.js';
import { requirePerm, uploader, removeUpload } from '../../middleware/core.js';
import { wrap, HttpError, clean, cleanDeep, richHtml, makeSlug, pageParams, escapeRegex } from '../../utils/helpers.js';
import { getSettings } from '../../utils/bootstrap.js';
import { followUpState } from '../../utils/leadQuery.js';
import { logActivity } from './common.js';

const r = Router();

/* ---------- field sanitisers ---------- */
const safeUrl = (v) => { const s = clean(String(v ?? '')); return /^(https?:\/\/|\/|mailto:|tel:|#)/i.test(s) || s === '' ? s : ''; };
const T = {
  s: (max = 200) => (v) => clean(String(v ?? '')).slice(0, max),
  h: () => (v) => richHtml(String(v ?? '')).slice(0, 60000),
  n: () => (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; },
  b: () => (v) => v === true || v === 'true',
  u: () => (v) => safeUrl(v).slice(0, 500),
  d: () => (v) => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d; },
  a: (max = 200) => (v) => (Array.isArray(v) ? v : String(v ?? '').split('\n')).map((x) => clean(String(x))).filter(Boolean).slice(0, 60).map((x) => x.slice(0, max)),
  faqs: () => (v) => (Array.isArray(v) ? v : []).slice(0, 30).map((f) => ({ q: clean(String(f?.q ?? '')).slice(0, 300), a: clean(String(f?.a ?? '')).slice(0, 2000) })).filter((f) => f.q && f.a),
  seo: () => (v) => ({ title: clean(String(v?.title ?? '')).slice(0, 120), description: clean(String(v?.description ?? '')).slice(0, 320), keywords: clean(String(v?.keywords ?? '')).slice(0, 300), ogImage: safeUrl(v?.ogImage).slice(0, 500) }),
  roles: () => (v) => (Array.isArray(v) ? v : []).slice(0, 12).map((g) => ({ group: clean(String(g?.group ?? '')).slice(0, 80), items: (Array.isArray(g?.items) ? g.items : []).map((x) => clean(String(x))).filter(Boolean).slice(0, 40) })).filter((g) => g.group),
};
function pick(body, spec) {
  const out = {};
  for (const [k, fn] of Object.entries(spec)) if (body[k] !== undefined) out[k] = fn(body[k]);
  return out;
}

async function uniqueSlug(Model, base, excludeId) {
  const root = makeSlug(base) || 'item';
  let slug = root, i = 2;
  while (await Model.exists({ slug, ...(excludeId ? { _id: { $ne: excludeId } } : {}) })) slug = `${root}-${i++}`;
  return slug;
}

/**
 * Generic CRUD with whitelisted fields.
 * opts: spec, perm, sort, search[], slugFrom (field), required[], files[] (fields holding uploads to clean), beforeSave(doc, body, isNew)
 */
function crud(path_, Model, { spec, perm = 'cms', sort = { order: 1, createdAt: -1 }, search = [], slugFrom, required = [], files = [], label = 'Item', beforeSave, extraFilter } = {}) {
  const c = Router();
  c.use(requirePerm(perm));
  c.get('/', wrap(async (req, res) => {
    const { page, limit, skip } = pageParams(req.query, 100, 200);
    const f = { ...(extraFilter ? extraFilter(req) : {}) };
    if (req.query.q && search.length) { const rx = new RegExp(escapeRegex(String(req.query.q).slice(0, 60)), 'i'); f.$or = search.map((k) => ({ [k]: rx })); }
    if (req.query.status) f.status = String(req.query.status);
    const [items, total] = await Promise.all([Model.find(f).sort(sort).skip(skip).limit(limit).lean(), Model.countDocuments(f)]);
    res.json({ items, total, page, pages: Math.ceil(total / limit) || 1 });
  }));
  c.get('/:id', wrap(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, `${label} not found.`);
    const doc = await Model.findById(req.params.id).lean();
    if (!doc) throw new HttpError(404, `${label} not found.`);
    res.json(doc);
  }));
  const save = (isNew) => wrap(async (req, res) => {
    const data = pick(req.body || {}, spec);
    const missing = required.filter((k) => (isNew || data[k] !== undefined) && !String(data[k] ?? '').trim());
    if (missing.length) throw new HttpError(400, 'Please fill the required fields.', Object.fromEntries(missing.map((k) => [k, 'Required'])));
    let doc;
    if (isNew) {
      doc = new Model(data);
      if (Model.schema.path('order') && data.order === undefined) doc.order = (await Model.countDocuments()) + 1;
    } else {
      if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, `${label} not found.`);
      doc = await Model.findById(req.params.id);
      if (!doc) throw new HttpError(404, `${label} not found.`);
      for (const f of files) if (data[f] !== undefined && doc[f] && doc[f] !== data[f]) removeUpload(doc[f]);
      doc.set(data);
    }
    if (slugFrom && Model.schema.path('slug')) {
      const wanted = req.body?.slug ? makeSlug(req.body.slug) : '';
      if (isNew || wanted) { if (isNew || wanted !== doc.slug) doc.slug = await uniqueSlug(Model, wanted || doc[slugFrom], doc._id); }
      else if (!doc.slug) doc.slug = await uniqueSlug(Model, doc[slugFrom], doc._id);
    }
    if (beforeSave) await beforeSave(doc, req.body, isNew);
    await doc.save();
    logActivity(req, isNew ? `${label.toLowerCase()}-created` : `${label.toLowerCase()}-updated`, doc.title || doc.name || doc.clientName || doc.q || doc._id);
    res.status(isNew ? 201 : 200).json(doc.toObject());
  });
  c.post('/', save(true));
  c.put('/:id', save(false));
  c.patch('/:id', save(false));
  c.post('/reorder/all', wrap(async (req, res) => {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).filter((x) => mongoose.isValidObjectId(x)).slice(0, 500);
    await Promise.all(ids.map((id, i) => Model.updateOne({ _id: id }, { $set: { order: i + 1 } })));
    res.json({ ok: true });
  }));
  c.delete('/:id', wrap(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, `${label} not found.`);
    const doc = await Model.findByIdAndDelete(req.params.id);
    if (!doc) throw new HttpError(404, `${label} not found.`);
    files.forEach((f) => removeUpload(doc[f]));
    logActivity(req, `${label.toLowerCase()}-deleted`, doc.title || doc.name || doc.clientName || doc.q || doc._id);
    res.json({ ok: true });
  }));
  r.use(`/${path_}`, c);
  return c;
}

/* ---------- uploads (images, hero video) ---------- */
const up = (kind) => [requirePerm('cms'), uploader(kind), (req, res, next) => (req.file ? res.status(201).json({ url: req.file.publicPath, name: req.file.originalname, size: req.file.size }) : next(new HttpError(400, 'No file received.')))];
r.post('/uploads/image', ...up('image'));
r.post('/uploads/video', ...up('video'));
// blog / jobs managers may also upload images
r.post('/uploads/blog-image', requirePerm('blog'), uploader('image'), (req, res, next) => (req.file ? res.status(201).json({ url: req.file.publicPath }) : next(new HttpError(400, 'No file received.'))));

/* ---------- resources ---------- */
crud('hero', HeroSlide, {
  label: 'Slide', files: ['image', 'video'], sort: { order: 1 }, required: ['headline'],
  spec: { type: T.s(10), video: T.u(), image: T.u(), headline: T.s(160), sub: T.s(400), cta1Text: T.s(40), cta1Link: T.u(), cta2Text: T.s(40), cta2Link: T.u(), rotating: T.b(), enabled: T.b(), order: T.n() },
  beforeSave: (d) => { if (!['video', 'image'].includes(d.type)) d.type = 'image'; },
});
const faqs = T.faqs();
crud('services', Service, {
  label: 'Service', slugFrom: 'title', required: ['title'], search: ['title'],
  spec: { title: T.s(120), icon: T.s(40), short: T.s(300), description: T.s(4000), whoFor: T.a(), included: T.a(), how: T.a(), industries: T.a(), faqs, seo: T.seo(), order: T.n(), active: T.b() },
});
crud('industries', Industry, {
  label: 'Industry', slugFrom: 'title', required: ['title'], search: ['title'],
  spec: { title: T.s(120), icon: T.s(40), short: T.s(300), description: T.s(4000), roles: T.roles(), services: T.a(), faqs, seo: T.seo(), order: T.n(), active: T.b() },
});
crud('leaders', Leader, {
  label: 'Leader', files: ['photo'], required: ['name'],
  spec: { name: T.s(100), title: T.s(120), bio: T.s(3000), quote: T.s(500), photo: T.u(), order: T.n(), active: T.b() },
  beforeSave: async (d) => { if (!d.slug) d.slug = await uniqueSlug(Leader, d.name, d._id); },
});
crud('testimonials', Testimonial, {
  label: 'Testimonial', files: ['photo'], required: ['clientName', 'text'],
  spec: { clientName: T.s(100), company: T.s(120), designation: T.s(100), text: T.s(1200), photo: T.u(), published: T.b(), order: T.n() },
});
crud('announcements', Announcement, {
  label: 'Announcement', files: ['image'], sort: { createdAt: -1 }, required: ['title'],
  spec: { title: T.s(160), text: T.s(800), image: T.u(), link: T.u(), linkText: T.s(40), placement: T.s(10), startsAt: T.d(), endsAt: T.d(), active: T.b() },
  beforeSave: (d) => { if (!['banner', 'popup', 'ticker', 'post'].includes(d.placement)) d.placement = 'banner'; },
});
crud('faqs', FaqItem, { label: 'FAQ', required: ['q', 'a'], search: ['q', 'a'], spec: { q: T.s(300), a: T.s(2000), keywords: T.s(300), order: T.n(), active: T.b() } });

const jobs = crud('jobs', Job, {
  label: 'Job', perm: 'jobs', slugFrom: 'title', sort: { createdAt: -1 }, required: ['title', 'location'], search: ['title', 'location', 'industry'],
  spec: { title: T.s(140), location: T.s(100), industry: T.s(100), type: T.s(40), experience: T.s(60), salary: T.s(80), description: T.s(5000), responsibilities: T.a(300), requirements: T.a(300), status: T.s(10) },
  beforeSave: (d) => { if (!['Open', 'Closed'].includes(d.status)) d.status = 'Open'; },
});
// applicants per job + counts
jobs.get('/:id/applicants', wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, 'Job not found.');
  const items = await Lead.find({ jobId: req.params.id, isDraft: false }).select('name phone email city experience status createdAt nextFollowUpAt').sort({ createdAt: -1 }).limit(500).lean();
  res.json({ items: items.map((l) => ({ ...l, followUp: followUpState(l.nextFollowUpAt) })) });
}));
r.get('/job-counts', requirePerm('jobs'), wrap(async (_req, res) => {
  const rows = await Lead.aggregate([{ $match: { jobId: { $ne: null }, isDraft: false } }, { $group: { _id: '$jobId', n: { $sum: 1 } } }]);
  res.json(Object.fromEntries(rows.map((x) => [String(x._id), x.n])));
}));

crud('blog', BlogPost, {
  label: 'Article', perm: 'blog', slugFrom: 'title', files: ['cover'], sort: { createdAt: -1 }, required: ['title'], search: ['title', 'excerpt'],
  spec: { title: T.s(160), excerpt: T.s(400), body: T.h(), cover: T.u(), tags: T.a(40), status: T.s(10), seo: T.seo(), publishedAt: T.d() },
  beforeSave: (d) => {
    if (!['Published', 'Draft'].includes(d.status)) d.status = 'Draft';
    if (d.status === 'Published' && !d.publishedAt) d.publishedAt = new Date();
  },
});

/* ---------- SEO per page ---------- */
const seoRouter = Router();
seoRouter.use(requirePerm('cms'));
seoRouter.get('/', wrap(async (_req, res) => {
  const [pages, s] = await Promise.all([SeoPage.find().sort({ path: 1 }).lean(), getSettings()]);
  res.json({ pages, defaults: s.seoDefaults || {} });
}));
const seoSpec = { title: T.s(120), description: T.s(320), keywords: T.s(300), ogImage: T.u() };
seoRouter.put('/page', wrap(async (req, res) => {
  const p = '/' + String(req.body?.path || '').trim().replace(/^\/+|\/+$/g, '');
  if (!/^\/[\w\-/]*$/.test(p)) throw new HttpError(400, 'Enter a valid page path, like /about.', { path: 'Invalid path' });
  const doc = await SeoPage.findOneAndUpdate({ path: p }, { $set: pick(req.body, seoSpec) }, { upsert: true, new: true, setDefaultsOnInsert: true });
  logActivity(req, 'seo-updated', p); res.json(doc);
}));
seoRouter.delete('/page/:id', wrap(async (req, res) => { await SeoPage.findByIdAndDelete(req.params.id); res.json({ ok: true }); }));
r.use('/seo', seoRouter);

/* ---------- site settings (contact, company, branding, social, page text, seo defaults) ---------- */
const settingsRouter = Router();
settingsRouter.use(requirePerm('cms'));
settingsRouter.get('/', wrap(async (_req, res) => { const { smtp, ...rest } = await getSettings(); res.json(rest); }));

const SECTIONS = {
  company: { name: T.s(160), shortName: T.s(60), tagline: T.s(160), cin: T.s(40), gstin: T.s(40), website: T.s(120) },
  contact: { phones: T.a(30), whatsapp: T.s(20), email: T.s(120), address: T.s(300), lat: T.n(), lng: T.n(), mapEmbed: T.u(), officeHours: T.s(120) },
  social: { linkedin: T.u(), facebook: T.u(), instagram: T.u(), twitter: T.u(), youtube: T.u() },
  seoDefaults: { title: T.s(120), description: T.s(320), keywords: T.s(300) },
};
settingsRouter.put('/content', wrap(async (req, res) => {
  // page headings / text blocks: only keys that already exist in the content tree can be edited
  const cur = (await getSettings()).content || {};
  const $set = {};
  for (const [k, v] of Object.entries(cleanDeep(req.body || {}))) if (k in cur && !k.startsWith('$')) $set[`content.${k}`] = v;
  if (!Object.keys($set).length) throw new HttpError(400, 'Nothing to update.');
  await SiteSettings.updateOne({ key: 'main' }, { $set }); logActivity(req, 'content-updated', Object.keys($set).join(', '));
  res.json({ ok: true });
}));
settingsRouter.put('/:section', wrap(async (req, res) => {
  const spec = SECTIONS[req.params.section];
  if (!spec) throw new HttpError(404, 'Unknown settings section.');
  const data = pick(req.body || {}, spec);
  if (req.params.section === 'contact' && data.phones && !data.phones.length) throw new HttpError(400, 'Add at least one phone number.', { phones: 'Required' });
  if (req.params.section === 'contact' && data.email && !/^\S+@\S+\.\S+$/.test(data.email)) throw new HttpError(400, 'Enter a valid e-mail address.', { email: 'Invalid e-mail' });
  const $set = Object.fromEntries(Object.entries(data).map(([k, v]) => [`${req.params.section}.${k}`, v]));
  await SiteSettings.updateOne({ key: 'main' }, { $set }); logActivity(req, `${req.params.section}-updated`);
  res.json({ ok: true });
}));

const SLOTS = ['logoLight', 'logoDark', 'favicon', 'ogImage', 'aboutImage', 'contactImage'];
settingsRouter.post('/branding/:slot', (req, res, next) => (SLOTS.includes(req.params.slot) ? next() : next(new HttpError(404, 'Unknown branding slot.'))),
  (req, res, next) => uploader(req.params.slot === 'favicon' ? 'branding' : 'image')(req, res, next),
  wrap(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'No file received.');
    const cur = (await getSettings()).branding || {};
    await SiteSettings.updateOne({ key: 'main' }, { $set: { [`branding.${req.params.slot}`]: req.file.publicPath } });
    if (cur[req.params.slot] && cur[req.params.slot] !== req.file.publicPath) removeUpload(cur[req.params.slot]);
    logActivity(req, 'branding-updated', req.params.slot);
    res.status(201).json({ url: req.file.publicPath });
  }));
r.use('/settings', settingsRouter);

/* ---------- documents (company profile, visiting card) ---------- */
const docs = Router();
docs.use(requirePerm('cms'));
docs.get('/', wrap(async (_req, res) => {
  const items = await DocumentFile.find().sort({ key: 1 }).lean();
  res.json({ items: items.map((d) => ({ key: d.key, label: d.label, originalName: d.originalName, size: d.size, downloads: d.downloads, custom: !!d.path && fs.existsSync(path.join(UPLOAD_DIR, d.path)), updatedAt: d.updatedAt })) });
}));
docs.post('/:key', (req, res, next) => (['company-profile', 'visiting-card'].includes(req.params.key) ? next() : next(new HttpError(404, 'Unknown document.'))), uploader('document'), wrap(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'No file received.');
  const d = await DocumentFile.findOne({ key: req.params.key });
  if (d.path) removeUpload(d.path);
  d.path = req.file.relPath; d.originalName = path.basename(req.file.originalname).slice(0, 120); d.size = req.file.size; await d.save();
  logActivity(req, 'document-replaced', d.key, d.originalName);
  res.status(201).json({ ok: true });
}));
docs.delete('/:key', wrap(async (req, res) => {
  const d = await DocumentFile.findOne({ key: req.params.key });
  if (!d) throw new HttpError(404, 'Document not found.');
  removeUpload(d.path); d.path = undefined; d.originalName = undefined; d.size = undefined; await d.save();
  logActivity(req, 'document-reverted', d.key); res.json({ ok: true });
}));
// authenticated preview of the currently active file (custom upload or bundled fallback)
docs.get('/:key/file', wrap(async (req, res) => {
  const d = await DocumentFile.findOne({ key: req.params.key });
  if (!d) throw new HttpError(404, 'Document not found.');
  const rel = d.path && fs.existsSync(path.join(UPLOAD_DIR, d.path)) ? d.path : d.fallbackPath;
  const abs = path.resolve(UPLOAD_DIR, rel || '');
  if (!abs.startsWith(UPLOAD_DIR + path.sep) || !fs.existsSync(abs)) throw new HttpError(404, 'File not available.');
  res.type('application/pdf'); fs.createReadStream(abs).pipe(res);
}));
r.use('/documents', docs);

export default r;
