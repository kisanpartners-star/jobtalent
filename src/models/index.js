import mongoose from 'mongoose';
const { Schema, model } = mongoose;
const Mixed = Schema.Types.Mixed;
const opts = { timestamps: true };

/* ---------- Users ---------- */
export const User = model('User', new Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ['Admin', 'Manager', 'Recruiter'], default: 'Recruiter' },
  permissions: [String],
  active: { type: Boolean, default: true },
  mustChangePassword: { type: Boolean, default: false },
  lastLoginAt: Date,
  prefs: { type: Mixed, default: { emailNotifications: true, notifyNewLead: true, notifyFollowups: true } },
}, opts));

/* ---------- Site settings (singleton) ---------- */
export const SiteSettings = model('SiteSettings', new Schema({
  key: { type: String, default: 'main', unique: true },
  company: Mixed,
  contact: Mixed,
  social: Mixed,
  branding: Mixed,
  content: Mixed,
  seoDefaults: Mixed,
  smtp: Mixed,
}, opts));

/* ---------- CMS collections ---------- */
export const HeroSlide = model('HeroSlide', new Schema({
  order: { type: Number, default: 0 },
  type: { type: String, enum: ['video', 'image'], default: 'image' },
  video: String, image: String,
  headline: String, sub: String,
  cta1Text: String, cta1Link: String, cta2Text: String, cta2Link: String,
  rotating: { type: Boolean, default: false },
  enabled: { type: Boolean, default: true },
}, opts));

const seoSub = { title: String, description: String, keywords: String, ogImage: String };
export const Service = model('Service', new Schema({
  slug: { type: String, unique: true, index: true },
  title: String, icon: String, short: String, description: String,
  whoFor: [String], included: [String], how: [String], industries: [String],
  faqs: [{ q: String, a: String }], seo: seoSub,
  order: { type: Number, default: 0 }, active: { type: Boolean, default: true },
}, opts));

export const Industry = model('Industry', new Schema({
  slug: { type: String, unique: true, index: true },
  title: String, icon: String, short: String, description: String,
  roles: [{ group: String, items: [String] }], services: [String],
  faqs: [{ q: String, a: String }], seo: seoSub,
  order: { type: Number, default: 0 }, active: { type: Boolean, default: true },
}, opts));

export const Leader = model('Leader', new Schema({
  slug: String, name: String, title: String, bio: String, quote: String, photo: String,
  order: { type: Number, default: 0 }, active: { type: Boolean, default: true },
}, opts));

export const Testimonial = model('Testimonial', new Schema({
  clientName: String, company: String, designation: String, text: String, photo: String,
  published: { type: Boolean, default: false }, order: { type: Number, default: 0 },
}, opts));

export const Announcement = model('Announcement', new Schema({
  title: String, text: String, image: String, link: String, linkText: String,
  placement: { type: String, enum: ['banner', 'popup', 'ticker', 'post'], default: 'banner' },
  startsAt: Date, endsAt: Date, active: { type: Boolean, default: true },
}, opts));

const jobSchema = new Schema({
  slug: { type: String, unique: true, index: true },
  title: { type: String, index: true }, location: { type: String, index: true },
  industry: { type: String, index: true }, type: { type: String, index: true },
  experience: String, salary: String, description: String,
  responsibilities: [String], requirements: [String],
  status: { type: String, enum: ['Open', 'Closed'], default: 'Open', index: true },
  demo: { type: Boolean, default: false },
}, opts);
jobSchema.index({ title: 'text', description: 'text', location: 'text' });
export const Job = model('Job', jobSchema);

export const BlogPost = model('BlogPost', new Schema({
  slug: { type: String, unique: true, index: true },
  title: String, excerpt: String, body: String, cover: String, tags: [String],
  status: { type: String, enum: ['Published', 'Draft'], default: 'Draft', index: true },
  publishedAt: Date, seo: seoSub,
}, opts));

export const FaqItem = model('FaqItem', new Schema({
  q: String, a: String, keywords: String, order: { type: Number, default: 0 }, active: { type: Boolean, default: true },
}, opts));

export const SeoPage = model('SeoPage', new Schema({
  path: { type: String, unique: true, index: true }, ...seoSub,
}, opts));

export const DocumentFile = model('DocumentFile', new Schema({
  key: { type: String, unique: true, enum: ['company-profile', 'visiting-card'] },
  label: String, path: String, fallbackPath: String, originalName: String, size: Number,
  downloads: { type: Number, default: 0 },
}, opts));

/* ---------- Leads (enquiries, company, candidate, chatbot, drafts) ---------- */
export const LEAD_STATUSES = ['Draft', 'New', 'Contacted', 'Follow-up Scheduled', 'Follow-up Done', 'Interested', 'Converted', 'Rejected', 'On Hold'];

const leadSchema = new Schema({
  type: { type: String, enum: ['enquiry', 'company', 'candidate', 'chatbot'], index: true },
  source: { type: String, index: true }, // website | enquiry-modal | contact | service-page | industry-page | chatbot | register | public-form | home-form
  status: { type: String, enum: LEAD_STATUSES, default: 'New', index: true },
  isDraft: { type: Boolean, default: false, index: true },
  draftStep: { type: Number, default: 0 },
  resumeCode: { type: String, index: true, sparse: true },
  name: { type: String, index: true }, phone: { type: String, index: true }, email: { type: String, index: true },
  company: { type: String, index: true }, city: { type: String, index: true }, role: { type: String, index: true },
  industry: { type: String, index: true }, service: { type: String, index: true },
  experience: { type: String, index: true },
  requirement: String,
  data: { type: Mixed, default: {} },
  files: [{ field: String, originalName: String, path: String, mime: String, size: Number, uploadedAt: Date }],
  jobId: { type: Schema.Types.ObjectId, ref: 'Job' }, jobTitle: String,
  consent: Boolean,
  assignedTo: { type: Schema.Types.ObjectId, ref: 'User' },
  rejectReason: String,
  nextFollowUpAt: { type: Date, index: true },
  followUps: [{ dueAt: Date, note: String, done: { type: Boolean, default: false }, doneAt: Date, createdBy: String, createdAt: { type: Date, default: Date.now } }],
  notes: [{ text: String, by: String, at: { type: Date, default: Date.now } }],
  activity: [{ kind: String, text: String, by: String, at: { type: Date, default: Date.now } }],
  submittedAt: Date,
  seen: { type: Boolean, default: false },
  demo: { type: Boolean, default: false, index: true },
}, opts);
leadSchema.index({ createdAt: -1 });
leadSchema.index({ name: 'text', phone: 'text', email: 'text', company: 'text', role: 'text', city: 'text' });
export const Lead = model('Lead', leadSchema);

/* ---------- Tracking ---------- */
export const Visitor = model('Visitor', new Schema({
  visitorId: { type: String, unique: true, index: true },
  firstSeen: Date, lastSeen: Date, visits: { type: Number, default: 1 }, demo: { type: Boolean, default: false },
}, { versionKey: false }));

export const Session = model('Session', new Schema({
  sessionId: { type: String, unique: true, index: true },
  visitorId: { type: String, index: true },
  startedAt: { type: Date, index: true }, lastAt: Date, pages: { type: Number, default: 1 },
  device: String, browser: String, os: String, country: String, city: String,
  referrer: String, source: String, ipHash: String, returning: Boolean,
  demo: { type: Boolean, default: false },
}, { versionKey: false }));

export const PageView = model('PageView', new Schema({
  visitorId: { type: String, index: true }, sessionId: { type: String, index: true },
  path: { type: String, index: true }, title: String, at: { type: Date, index: true },
  referrer: String, source: String, device: String, browser: String, country: String,
  demo: { type: Boolean, default: false },
}, { versionKey: false }));

export const TrackEvent = model('TrackEvent', new Schema({
  visitorId: { type: String, index: true }, sessionId: String,
  type: { type: String, index: true }, // cta_call | cta_whatsapp | cta_mail | cta_enquiry | download | chatbot_open | form_start | form_complete
  label: String, path: String, at: { type: Date, index: true },
  demo: { type: Boolean, default: false },
}, { versionKey: false }));

/* ---------- Notifications & activity ---------- */
export const Notification = model('Notification', new Schema({
  kind: { type: String, index: true }, // new_lead | new_candidate | new_chatbot | followup_due | followup_overdue
  title: String, body: String, link: String, leadId: Schema.Types.ObjectId,
  readBy: [{ type: Schema.Types.ObjectId }],
  key: { type: String, index: true },
}, opts));

export const ActivityLog = model('ActivityLog', new Schema({
  userId: Schema.Types.ObjectId, userName: String, action: String, target: String, detail: String, at: { type: Date, default: Date.now, index: true },
}, { versionKey: false }));
