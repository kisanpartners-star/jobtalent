import { Router } from 'express';
import { Session, PageView, TrackEvent } from '../../models/index.js';
import { requirePerm } from '../../middleware/core.js';
import { wrap, escapeRegex } from '../../utils/helpers.js';
import { sendExport } from '../../utils/exporter.js';
import { resolveRange } from './dashboard.js';
import { dayKeys, dayExpr, pct, rowsToList, logActivity } from './common.js';

const r = Router();
r.use(requirePerm('analytics'));

const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

async function compute(q) {
  const { from, to } = resolveRange(q);
  const demo = q.demo === 'true' ? { demo: true } : {};
  const inR = { $gte: from, $lte: to };
  const page = q.page ? String(q.page).slice(0, 200) : '';
  const pvMatch = { ...demo, at: inR, ...(page ? { path: new RegExp(`^${escapeRegex(page)}`) } : {}) };
  const sMatch = { ...demo, startedAt: inR };
  const eMatch = { ...demo, at: inR };

  // when a page filter is on, session metrics are limited to sessions that viewed it
  let sessionIds = null;
  if (page) sessionIds = await PageView.distinct('sessionId', pvMatch);
  const sFilter = sessionIds ? { ...sMatch, sessionId: { $in: sessionIds } } : sMatch;

  const [pageViews, uniqueVisitors, sessions, returning, pagesAgg, series, topPages, referrers, sources, devices, browsers, oses, countries, cities, events, formEvents, downloads, allPages] = await Promise.all([
    PageView.countDocuments(pvMatch),
    PageView.distinct('visitorId', pvMatch).then((a) => a.length),
    Session.countDocuments(sFilter),
    Session.countDocuments({ ...sFilter, returning: true }),
    Session.aggregate([{ $match: sFilter }, { $group: { _id: null, pages: { $sum: '$pages' }, n: { $sum: 1 }, bounced: { $sum: { $cond: [{ $lte: ['$pages', 1] }, 1, 0] } } } }]),
    PageView.aggregate([{ $match: pvMatch }, { $group: { _id: dayExpr('$at'), views: { $sum: 1 }, u: { $addToSet: '$visitorId' } } }]),
    PageView.aggregate([{ $match: pvMatch }, { $group: { _id: '$path', views: { $sum: 1 }, u: { $addToSet: '$visitorId' } } }, { $sort: { views: -1 } }, { $limit: 15 }]),
    Session.aggregate([{ $match: { ...sFilter, referrer: { $nin: ['', null] } } }, { $group: { _id: '$referrer', n: { $sum: 1 } } }, { $limit: 500 }]),
    Session.aggregate([{ $match: sFilter }, { $group: { _id: '$source', n: { $sum: 1 } } }, { $sort: { n: -1 } }]),
    Session.aggregate([{ $match: sFilter }, { $group: { _id: '$device', n: { $sum: 1 } } }, { $sort: { n: -1 } }]),
    Session.aggregate([{ $match: sFilter }, { $group: { _id: '$browser', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 8 }]),
    Session.aggregate([{ $match: sFilter }, { $group: { _id: '$os', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 8 }]),
    Session.aggregate([{ $match: { ...sFilter, country: { $nin: ['', null] } } }, { $group: { _id: '$country', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 10 }]),
    Session.aggregate([{ $match: { ...sFilter, city: { $nin: ['', null] } } }, { $group: { _id: '$city', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 10 }]),
    TrackEvent.aggregate([{ $match: { ...eMatch, type: { $in: ['cta_call', 'cta_whatsapp', 'cta_mail', 'cta_enquiry', 'chatbot_open'] } } }, { $group: { _id: '$type', n: { $sum: 1 } } }]),
    TrackEvent.aggregate([{ $match: { ...eMatch, type: { $in: ['form_start', 'form_complete'] } } }, { $group: { _id: { t: '$type', l: '$label' }, n: { $sum: 1 } } }]),
    TrackEvent.aggregate([{ $match: { ...eMatch, type: 'download' } }, { $group: { _id: '$label', n: { $sum: 1 } } }, { $sort: { n: -1 } }]),
    PageView.distinct('path', { ...demo, at: inR }),
  ]);

  const refMap = {};
  for (const x of referrers) { const h = host(x._id); if (h) refMap[h] = (refMap[h] || 0) + x.n; }
  const refList = Object.entries(refMap).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value).slice(0, 10);

  const keys = dayKeys(from, to);
  const sm = Object.fromEntries(series.map((x) => [x._id, x]));
  const daily = keys.map((k) => ({ date: k, pageViews: sm[k]?.views || 0, unique: sm[k]?.u.length || 0 }));

  const ev = Object.fromEntries(events.map((e) => [e._id, e.n]));
  const forms = {};
  for (const f of formEvents) { const k = f._id.l || 'form'; (forms[k] ||= { form: k, started: 0, completed: 0 })[f._id.t === 'form_start' ? 'started' : 'completed'] += f.n; }
  const formRows = Object.values(forms).map((f) => ({ ...f, rate: pct(f.completed, f.started) }));
  const totS = formRows.reduce((a, b) => a + b.started, 0), totC = formRows.reduce((a, b) => a + b.completed, 0);

  const pa = pagesAgg[0] || { pages: 0, n: 0, bounced: 0 };
  return {
    range: { from, to }, pagesAvailable: allPages.sort(),
    totals: {
      uniqueVisitors, returningVisitors: returning, newVisitors: Math.max(0, sessions - returning), pageViews, sessions,
      pagesPerSession: pa.n ? Math.round((pa.pages / pa.n) * 10) / 10 : 0, bounceRate: pct(pa.bounced, pa.n),
    },
    daily,
    topPages: topPages.map((p) => ({ path: p._id, views: p.views, unique: p.u.length })),
    referrers: refList, sources: rowsToList(sources), devices: rowsToList(devices), browsers: rowsToList(browsers), os: rowsToList(oses),
    countries: rowsToList(countries), cities: rowsToList(cities),
    ctas: { call: ev.cta_call || 0, whatsapp: ev.cta_whatsapp || 0, email: ev.cta_mail || 0, enquiry: ev.cta_enquiry || 0, chatbot: ev.chatbot_open || 0 },
    forms: { rows: formRows, started: totS, completed: totC, rate: pct(totC, totS) },
    downloads: rowsToList(downloads),
  };
}

r.get('/', wrap(async (req, res) => { res.json(await compute(req.query)); }));

r.get('/export', requirePerm('export'), wrap(async (req, res) => {
  const d = await compute(req.query);
  const what = req.query.what || 'all';
  const all = {
    summary: { name: 'Summary', columns: [{ header: 'Metric', key: 'k', width: 28 }, { header: 'Value', key: 'v', width: 16 }], rows: [
      ...Object.entries(d.totals).map(([k, v]) => ({ k: k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()), v })),
      { k: 'CTA: call clicks', v: d.ctas.call }, { k: 'CTA: WhatsApp clicks', v: d.ctas.whatsapp }, { k: 'CTA: e-mail clicks', v: d.ctas.email }, { k: 'CTA: enquiry clicks', v: d.ctas.enquiry }, { k: 'Chatbot opens', v: d.ctas.chatbot },
      { k: 'Form starts', v: d.forms.started }, { k: 'Form completions', v: d.forms.completed }, { k: 'Form completion rate %', v: d.forms.rate },
    ] },
    daily: { name: 'Daily', columns: [{ header: 'Date', key: 'date' }, { header: 'Page views', key: 'pageViews' }, { header: 'Unique visitors', key: 'unique' }], rows: d.daily },
    pages: { name: 'Top pages', columns: [{ header: 'Page', key: 'path', width: 40 }, { header: 'Views', key: 'views' }, { header: 'Unique visitors', key: 'unique' }], rows: d.topPages },
    sources: { name: 'Sources', columns: [{ header: 'Source', key: 'name', width: 28 }, { header: 'Sessions', key: 'value' }], rows: [...d.sources, ...d.referrers.map((x) => ({ name: `ref: ${x.name}`, value: x.value }))] },
    devices: { name: 'Devices', columns: [{ header: 'Device / browser', key: 'name', width: 28 }, { header: 'Sessions', key: 'value' }], rows: [...d.devices, ...d.browsers.map((x) => ({ name: `browser: ${x.name}`, value: x.value }))] },
    locations: { name: 'Locations', columns: [{ header: 'Location', key: 'name', width: 28 }, { header: 'Sessions', key: 'value' }], rows: [...d.countries.map((x) => ({ name: `country: ${x.name}`, value: x.value })), ...d.cities] },
    downloads: { name: 'Downloads', columns: [{ header: 'Document', key: 'name', width: 28 }, { header: 'Downloads', key: 'value' }], rows: d.downloads },
  };
  const sets = what === 'downloads' ? [all.downloads] : what === 'visitors' ? [all.summary, all.daily, all.pages] : Object.values(all);
  logActivity(req, 'export', `Analytics (${what})`);
  await sendExport(res, { filename: `VB-TALENTX-Analytics-${what}-${new Date().toISOString().slice(0, 10)}`, format: req.query.format === 'csv' ? 'csv' : 'xlsx', sheets: sets });
}));

export default r;
