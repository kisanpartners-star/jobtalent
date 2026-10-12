import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';
import { User, SiteSettings, HeroSlide, Service, Industry, Leader, FaqItem, BlogPost, DocumentFile } from '../models/index.js';
import * as D from '../seed/data.js';

export async function getSettings() {
  let s = await SiteSettings.findOne({ key: 'main' }).lean();
  if (!s) { await ensureSettings(); s = await SiteSettings.findOne({ key: 'main' }).lean(); }
  return s;
}

async function ensureSettings() {
  if (await SiteSettings.exists({ key: 'main' })) return;
  await SiteSettings.create({
    key: 'main',
    company: D.COMPANY,
    contact: D.CONTACT,
    social: D.SOCIAL,
    branding: { logoLight: '/uploads/branding/logo-light.png', logoDark: '/uploads/branding/logo-dark.png', favicon: '/uploads/branding/favicon.png', ogImage: '/uploads/images/hero-2.webp', aboutImage: '/uploads/images/about.webp', contactImage: '/uploads/images/contact.webp' },
    content: { ...D.CONTENT, homeFaqs: D.HOME_FAQS },
    seoDefaults: {
      title: 'VB TALENTX | Contract Staffing & Workforce Solutions in Bengaluru',
      description: 'VB TALENTX is a compliance-led workforce solutions company in Bengaluru offering contract staffing, recruitment, payroll, HR outsourcing, statutory compliance, facility management and RPO.',
      keywords: 'contract staffing company in Bengaluru, manpower supplier Bengaluru, payroll outsourcing Karnataka, HR outsourcing Bengaluru, recruitment agency Bengaluru, RPO services India',
      pages: {},
    },
    smtp: { enabled: false, host: '', port: 587, user: '', pass: '', from: env.smtp.from, notifyTo: env.smtp.notifyTo },
  });
}

export async function ensureAdmin() {
  const exists = await User.exists({ email: env.admin.email });
  if (exists) return false;
  const passwordHash = await bcrypt.hash(env.admin.password, 12);
  await User.create({ name: env.admin.name, email: env.admin.email, passwordHash, role: 'Admin', mustChangePassword: true });
  console.log(`[seed] Admin created: ${env.admin.email} (change the password after first login)`);
  return true;
}

// Idempotent: only fills collections that are empty, never overwrites admin edits.
export async function ensureDefaults() {
  await ensureSettings();
  if (!(await HeroSlide.countDocuments())) await HeroSlide.insertMany(D.HERO_SLIDES);
  if (!(await Service.countDocuments())) await Service.insertMany(D.SERVICES.map((s) => ({ ...s, faqs: s.faqs })));
  if (!(await Industry.countDocuments())) await Industry.insertMany(D.INDUSTRIES);
  if (!(await Leader.countDocuments())) await Leader.insertMany(D.LEADERS);
  if (!(await FaqItem.countDocuments())) await FaqItem.insertMany(D.FAQS);
  if (!(await BlogPost.countDocuments())) {
    const base = Date.now();
    await BlogPost.insertMany(D.BLOG.map((b, i) => ({
      ...b, status: 'Published', publishedAt: new Date(base - i * 86400000),
      seo: { title: `${b.title} | VB TALENTX`, description: b.excerpt, keywords: b.tags.join(', ') },
    })));
  }
  const docs = [
    { key: 'company-profile', label: 'Company Profile', fallbackPath: 'documents/company-profile-fallback.pdf' },
    { key: 'visiting-card', label: 'Visiting Card (Bharath Kumar R A)', fallbackPath: 'documents/visiting-card-fallback.pdf' },
  ];
  for (const d of docs) await DocumentFile.updateOne({ key: d.key }, { $setOnInsert: d }, { upsert: true });
  await ensureAdmin();
}
