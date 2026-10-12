// Usage:
//   npm run seed              -> default content + admin (safe to re-run, never overwrites edits)
//   npm run seed:demo         -> adds clearly marked DEMO leads / visits / jobs for dashboard preview
//   npm run seed:wipe-demo    -> removes every demo record in one command
//   npm run create-admin      -> only creates / resets nothing, just ensures the admin from .env exists
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { ensureDefaults, ensureAdmin } from '../utils/bootstrap.js';
import { Lead, Job, Visitor, Session, PageView, TrackEvent } from '../models/index.js';
import { SAMPLE_JOBS } from './data.js';
import { makeSlug, randomCode } from '../utils/helpers.js';

const args = new Set(process.argv.slice(2));
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const daysAgo = (n, h = rnd(8, 19)) => { const d = new Date(Date.now() - n * 864e5); d.setHours(h, rnd(0, 59), 0, 0); return d; };

async function sampleJobs() {
  for (const j of SAMPLE_JOBS) {
    await Job.updateOne({ slug: makeSlug(`${j.title}-${j.location}`) }, { $setOnInsert: { ...j, slug: makeSlug(`${j.title}-${j.location}`), status: 'Open' } }, { upsert: true });
  }
}

async function demo() {
  await wipeDemo();
  const names = ['Demo Ravi Kumar', 'Demo Anitha S', 'Demo Manjunath', 'Demo Pooja R', 'Demo Imran Khan', 'Demo Latha N', 'Demo Suresh B', 'Demo Kavya M'];
  const companies = ['Demo Precision Works', 'Demo Logistics Hub', 'Demo Auto Components', 'Demo Foods Pvt Ltd', 'Demo Electronics Co'];
  const statuses = ['New', 'New', 'New', 'Contacted', 'Follow-up Scheduled', 'Interested', 'Converted', 'Rejected', 'On Hold'];
  const industries = ['Manufacturing', 'Automotive', 'Electronics', 'Warehousing & Logistics', 'FMCG', 'E-commerce', 'IT & ITES', 'Engineering'];
  const cities = ['Bengaluru', 'Hosur', 'Tumakuru', 'Mysuru', 'Hubballi'];
  const leads = [];
  for (let i = 0; i < 60; i++) {
    const type = pick(['enquiry', 'company', 'candidate', 'candidate', 'chatbot']);
    const at = daysAgo(rnd(0, 29));
    const status = pick(statuses);
    const l = {
      type, source: type === 'chatbot' ? 'chatbot' : pick(['website', 'register', 'public-form', 'contact', 'enquiry-modal']), status, isDraft: false, demo: true,
      name: pick(names), phone: `9${rnd(100000000, 999999999)}`, email: `demo${i}@example.com`, city: pick(cities), industry: pick(industries),
      company: type === 'company' ? pick(companies) : undefined, role: type === 'candidate' ? pick(['Machine Operator', 'Warehouse Associate', 'Quality Inspector', 'HR Executive']) : type === 'company' ? 'Helpers, operators' : undefined,
      experience: type === 'candidate' ? pick(['0-1 years', '1-3 years', '3-5 years', '5+ years']) : undefined,
      requirement: '[DEMO] Sample requirement text for dashboard preview.', data: { demo: true }, consent: true, submittedAt: at, createdAt: at, updatedAt: at,
      activity: [{ kind: 'created', text: '[DEMO] Lead created', by: 'system', at }],
    };
    if (['Follow-up Scheduled', 'Contacted'].includes(status)) {
      const due = new Date(Date.now() + rnd(-3, 5) * 864e5);
      l.followUps = [{ dueAt: due, note: '[DEMO] Call back', createdBy: 'demo' }]; l.nextFollowUpAt = due;
    }
    if (status === 'Rejected') l.rejectReason = 'Demo: not a fit';
    leads.push(l);
  }
  for (let i = 0; i < 6; i++) {
    const at = daysAgo(rnd(0, 6));
    leads.push({ type: pick(['company', 'candidate']), source: 'register', status: 'Draft', isDraft: true, draftStep: rnd(1, 3), resumeCode: `VB-DEMO${i}${randomCode(2)}`, name: pick(names), phone: `9${rnd(100000000, 999999999)}`, city: pick(cities), demo: true, data: { demo: true }, createdAt: at, updatedAt: at, activity: [{ kind: 'draft', text: '[DEMO] Draft started', by: 'system', at }] });
  }
  await Lead.collection.insertMany(leads.map((l) => ({ ...l, followUps: l.followUps || [], notes: [], files: [], seen: true })));

  const visitors = []; const sessions = []; const pvs = []; const events = [];
  const pages = ['/', '/', '/', '/services', '/services/contract-staffing', '/industries', '/about', '/careers', '/contact', '/register', '/compliance', '/blog'];
  for (let d = 0; d < 30; d++) {
    const n = rnd(6, 26);
    for (let v = 0; v < n; v++) {
      const vid = `demo-${d}-${v}-${randomCode(6)}`.toLowerCase(); const at = daysAgo(d);
      const device = pick(['Mobile', 'Mobile', 'Desktop', 'Tablet']); const source = pick(['direct', 'search', 'search', 'social', 'referral']);
      const sid = `${vid}-s`; const count = rnd(1, 5);
      visitors.push({ visitorId: vid, firstSeen: at, lastSeen: at, visits: 1, demo: true });
      sessions.push({ sessionId: sid, visitorId: vid, startedAt: at, lastAt: at, pages: count, device, browser: pick(['Chrome', 'Safari', 'Edge', 'Firefox']), os: pick(['Android', 'iOS', 'Windows', 'macOS']), country: 'IN', city: 'Bengaluru', source, returning: Math.random() < 0.25, demo: true });
      for (let p = 0; p < count; p++) pvs.push({ visitorId: vid, sessionId: sid, path: pick(pages), at: new Date(at.getTime() + p * 60000), source, device, demo: true });
      if (Math.random() < 0.25) events.push({ visitorId: vid, sessionId: sid, type: pick(['cta_call', 'cta_whatsapp', 'cta_mail', 'cta_enquiry', 'chatbot_open', 'form_start', 'form_start', 'form_complete']), at, demo: true });
    }
  }
  await Visitor.collection.insertMany(visitors); await Session.collection.insertMany(sessions);
  await PageView.collection.insertMany(pvs); await TrackEvent.collection.insertMany(events);
  console.log(`[demo] inserted ${leads.length} leads, ${visitors.length} visitors, ${pvs.length} page views`);
}

async function wipeDemo() {
  const r = await Promise.all([Lead.deleteMany({ demo: true }), Visitor.deleteMany({ demo: true }), Session.deleteMany({ demo: true }), PageView.deleteMany({ demo: true }), TrackEvent.deleteMany({ demo: true }), Job.deleteMany({ demo: true })]);
  console.log(`[demo] removed ${r.reduce((a, x) => a + x.deletedCount, 0)} demo records`);
}

await mongoose.connect(env.mongoUri);
if (args.has('--wipe-demo')) await wipeDemo();
else if (args.has('--admin-only')) { await ensureAdmin(); }
else {
  await ensureDefaults();
  await sampleJobs();
  if (args.has('--demo')) await demo();
  console.log('[seed] done');
}
await mongoose.disconnect();
