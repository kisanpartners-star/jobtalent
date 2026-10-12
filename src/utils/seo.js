import fs from 'fs';
import path from 'path';
import { env, ROOT_DIR } from '../config/env.js';
import { Service, Industry, BlogPost, Job, SeoPage } from '../models/index.js';
import { getSettings } from './bootstrap.js';

const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const jsonLd = (o) => JSON.stringify(o).replace(/</g, '\\u003c');

const STATIC = {
  '/': {},
  '/about': { title: 'About VB TALENTX | Workforce Solutions Company in Bengaluru', description: 'Learn about VB TALENTX, a compliance-led workforce solutions company in Bengaluru: our story, mission, vision and values.' },
  '/leadership': { title: 'Leadership Team | VB TALENTX', description: 'Meet the founders of VB TALENTX Workforce Solutions: Bharath Kumar R A, Sampada Badachi and Ramesh S. Athani.' },
  '/services': { title: 'Staffing, Payroll & Compliance Services in Bengaluru | VB TALENTX', description: 'Seven workforce services: contract staffing, permanent recruitment, payroll, HR outsourcing, statutory compliance, facility management and RPO.' },
  '/industries': { title: 'Industries We Serve | Staffing in Karnataka | VB TALENTX', description: 'Manufacturing, automotive, electronics, engineering, warehousing & logistics, FMCG, e-commerce and IT & ITES workforce solutions.' },
  '/compliance': { title: 'Statutory Compliance PF ESI PT CLRA | VB TALENTX', description: 'How VB TALENTX approaches PF, ESI, Professional Tax and CLRA compliance with documented, auditable processes.' },
  '/how-we-work': { title: 'How We Work | Our 5-Step Process & Engagement Models | VB TALENTX', description: 'Our five-step process and flexible engagement models for contract staffing, permanent hiring, payroll, RPO and facility support.' },
  '/careers': { title: 'Careers & Jobs in Bengaluru | VB TALENTX', description: 'Browse current openings and register with VB TALENTX to find work in manufacturing, warehousing, engineering and corporate roles.' },
  '/blog': { title: 'Insights on PF, ESI, Payroll & Hiring | VB TALENTX Blog', description: 'Short, practical articles on statutory compliance, payroll and workforce management.' },
  '/contact': { title: 'Contact VB TALENTX | Manpower Supplier in Bengaluru', description: 'Contact VB TALENTX in Mahadevapura, Bengaluru by phone, WhatsApp, e-mail or enquiry form.' },
  '/register': { title: 'Register | Hire Talent or Find Work | VB TALENTX', description: 'Companies can request manpower and candidates can register for work with VB TALENTX.' },
  '/privacy-policy': { title: 'Privacy Policy | VB TALENTX', description: 'How VB TALENTX collects, uses and protects your information.' },
  '/terms': { title: 'Terms & Conditions | VB TALENTX', description: 'Terms for using the VB TALENTX website.' },
  '/public/hire-talent': { title: 'Find Skilled Talent | VB TALENTX', description: 'Submit your manpower requirement to VB TALENTX Workforce Solutions, Bengaluru.' },
  '/public/find-work': { title: 'Register for Work | VB TALENTX', description: 'Register your profile and resume with VB TALENTX to find work in Karnataka.' },
};

export async function resolveMeta(urlPath) {
  const p = (urlPath.replace(/\/+$/, '') || '/');
  const settings = await getSettings();
  const d = settings.seoDefaults || {};
  let meta = { title: d.title, description: d.description, keywords: d.keywords, image: settings.branding?.ogImage, type: 'website', ld: [] };
  const apply = (o = {}) => { for (const k of ['title', 'description', 'keywords']) if (o[k]) meta[k] = o[k]; if (o.ogImage) meta.image = o.ogImage; };

  if (STATIC[p]) apply(STATIC[p]);
  let m;
  if ((m = p.match(/^\/services\/([\w-]+)$/))) {
    const s = await Service.findOne({ slug: m[1] }).lean();
    if (s) {
      apply(s.seo); if (!s.seo?.title) meta.title = `${s.title} | VB TALENTX`; if (!s.seo?.description) meta.description = s.short;
      meta.ld.push({ '@context': 'https://schema.org', '@type': 'Service', name: s.title, description: s.short, provider: { '@type': 'Organization', name: settings.company?.name }, areaServed: 'Karnataka, India' });
    }
  } else if ((m = p.match(/^\/industries\/([\w-]+)$/))) {
    const s = await Industry.findOne({ slug: m[1] }).lean();
    if (s) { apply(s.seo); if (!s.seo?.title) meta.title = `${s.title} | VB TALENTX`; if (!s.seo?.description) meta.description = s.short; }
  } else if ((m = p.match(/^\/blog\/([\w-]+)$/))) {
    const b = await BlogPost.findOne({ slug: m[1], status: 'Published' }).lean();
    if (b) {
      apply(b.seo); if (!b.seo?.title) meta.title = `${b.title} | VB TALENTX`; if (!b.seo?.description) meta.description = b.excerpt;
      meta.type = 'article'; if (b.cover) meta.image = b.cover;
      meta.ld.push({ '@context': 'https://schema.org', '@type': 'Article', headline: b.title, datePublished: b.publishedAt, author: { '@type': 'Organization', name: settings.company?.name } });
    }
  } else if ((m = p.match(/^\/careers\/([\w-]+)$/))) {
    const j = await Job.findOne({ slug: m[1], status: 'Open' }).lean();
    if (j) {
      meta.title = `${j.title} in ${j.location} | VB TALENTX Careers`; meta.description = (j.description || '').slice(0, 160);
      meta.ld.push({ '@context': 'https://schema.org', '@type': 'JobPosting', title: j.title, description: j.description, datePosted: j.createdAt, employmentType: j.type, hiringOrganization: { '@type': 'Organization', name: settings.company?.name, sameAs: env.siteUrl }, jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: j.location, addressRegion: 'Karnataka', addressCountry: 'IN' } } });
    }
  }
  const override = await SeoPage.findOne({ path: p }).lean();
  if (override) apply(override);
  return { meta, settings, canonical: `${env.siteUrl}${p === '/' ? '' : p}` || env.siteUrl };
}

export function orgLd(settings) {
  const c = settings.contact || {}; const co = settings.company || {};
  return [
    { '@context': 'https://schema.org', '@type': 'Organization', name: co.name, url: env.siteUrl, logo: `${env.siteUrl}${settings.branding?.logoLight || ''}`, email: c.email, telephone: c.phones?.[0], sameAs: Object.values(settings.social || {}).filter(Boolean) },
    { '@context': 'https://schema.org', '@type': 'LocalBusiness', name: co.name, image: `${env.siteUrl}${settings.branding?.ogImage || ''}`, url: env.siteUrl, telephone: c.phones?.[0], email: c.email, openingHours: 'Mo-Sa 09:30-18:30',
      address: { '@type': 'PostalAddress', streetAddress: 'No. 9/24, 4th Cross, Kanaka Layout, Garudacharpalya, Mahadevapura Post', addressLocality: 'Bengaluru', addressRegion: 'Karnataka', postalCode: '560048', addressCountry: 'IN' },
      geo: c.lat ? { '@type': 'GeoCoordinates', latitude: c.lat, longitude: c.lng } : undefined },
  ];
}

export function headHtml({ meta, settings, canonical }) {
  const img = meta.image ? (meta.image.startsWith('http') ? meta.image : `${env.siteUrl}${meta.image}`) : '';
  const tags = [
    `<title>${esc(meta.title)}</title>`,
    `<meta name="description" content="${esc(meta.description)}" />`,
    meta.keywords ? `<meta name="keywords" content="${esc(meta.keywords)}" />` : '',
    `<link rel="canonical" href="${esc(canonical)}" />`,
    `<meta property="og:site_name" content="${esc(settings.company?.shortName || 'VB TALENTX')}" />`,
    `<meta property="og:type" content="${meta.type}" />`,
    `<meta property="og:title" content="${esc(meta.title)}" />`,
    `<meta property="og:description" content="${esc(meta.description)}" />`,
    `<meta property="og:url" content="${esc(canonical)}" />`,
    img ? `<meta property="og:image" content="${esc(img)}" />` : '',
    `<meta name="twitter:card" content="summary_large_image" />`,
    ...[...orgLd(settings), ...meta.ld].map((o) => `<script type="application/ld+json">${jsonLd(o)}</script>`),
  ];
  return tags.filter(Boolean).join('\n    ');
}

/* ---------- serve client build with injected head ---------- */
let indexCache = null;
export function loadIndex() {
  const file = path.join(ROOT_DIR, '..', 'client', 'dist', 'index.html');
  if (!fs.existsSync(file)) return null;
  indexCache = fs.readFileSync(file, 'utf8');
  return indexCache;
}
export async function renderIndex(urlPath) {
  const html = indexCache || loadIndex();
  if (!html) return null;
  const data = await resolveMeta(urlPath);
  const cleaned = html.replace(/<title>[\s\S]*?<\/title>/i, '').replace(/<meta name="description"[^>]*>/i, '');
  return cleaned.replace('<!--SEO_HEAD-->', headHtml(data));
}

/* ---------- sitemap / robots ---------- */
export async function sitemapXml() {
  const [services, industries, blog, jobs] = await Promise.all([
    Service.find({ active: true }).select('slug updatedAt').lean(), Industry.find({ active: true }).select('slug updatedAt').lean(),
    BlogPost.find({ status: 'Published' }).select('slug updatedAt').lean(), Job.find({ status: 'Open' }).select('slug updatedAt').lean(),
  ]);
  const urls = [
    ...['/', '/about', '/leadership', '/services', '/industries', '/compliance', '/how-we-work', '/careers', '/blog', '/contact', '/register', '/privacy-policy', '/terms'].map((u) => ({ loc: u, pr: u === '/' ? '1.0' : '0.8' })),
    ...services.map((s) => ({ loc: `/services/${s.slug}`, d: s.updatedAt, pr: '0.8' })),
    ...industries.map((s) => ({ loc: `/industries/${s.slug}`, d: s.updatedAt, pr: '0.7' })),
    ...blog.map((s) => ({ loc: `/blog/${s.slug}`, d: s.updatedAt, pr: '0.6' })),
    ...jobs.map((s) => ({ loc: `/careers/${s.slug}`, d: s.updatedAt, pr: '0.6' })),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${env.siteUrl}${u.loc === '/' ? '' : u.loc}</loc>${u.d ? `<lastmod>${new Date(u.d).toISOString()}</lastmod>` : ''}<priority>${u.pr}</priority></url>`).join('\n')}\n</urlset>`;
}
export const robotsTxt = () => `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nDisallow: /public/\n\nSitemap: ${env.siteUrl}/sitemap.xml\n`;
