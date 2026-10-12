import { Router } from 'express';
import { Lead, Session, PageView, TrackEvent, Job } from '../../models/index.js';
import { requirePerm } from '../../middleware/core.js';
import { wrap, dayRange, istStartOfDay, istEndOfDay } from '../../utils/helpers.js';
import { buildLeadQuery, followUpState } from '../../utils/leadQuery.js';
import { and, dayKeys, dayExpr, monthExpr, rowsToList, toMap } from './common.js';

const r = Router();
r.use(requirePerm('dashboard'));

const CLOSED = ['Converted', 'Rejected'];
const PROGRESSED = ['Contacted', 'Follow-up Scheduled', 'Follow-up Done', 'Interested', 'Converted'];

export function resolveRange(q) {
  const rg = dayRange(q.range || '30d', q.from, q.to) || dayRange('30d');
  // cap custom ranges at ~1 year to keep charts readable
  const max = 366 * 864e5;
  if (rg.to - rg.from > max) rg.from = new Date(rg.to - max);
  return rg;
}

r.get('/', wrap(async (req, res) => {
  const q = req.query;
  const { from, to } = resolveRange(q);
  const now = new Date();
  const todayRange = { $gte: istStartOfDay(now), $lte: istEndOfDay(now) };
  const demo = q.demo === 'true' ? { demo: true } : {};
  const inRange = { $gte: from, $lte: to };

  // lead filters (date, type, service, industry, city, status) all react
  const base = and(buildLeadQuery({ ...q, view: undefined }, { includeDrafts: true }), demo);
  const submitted = and(base, { isDraft: false });
  const open = { status: { $nin: CLOSED } };
  const byType = (t) => and(submitted, { type: t });

  const span = (to - from) / 864e5;
  const bucket = span > 92 ? 'month' : 'day';
  const dExpr = bucket === 'month' ? monthExpr('$at') : dayExpr('$at');
  const lExpr = bucket === 'month' ? monthExpr('$createdAt') : dayExpr('$createdAt');
  const trackMatch = { ...demo, at: inRange };

  const [
    pvTotal, sessionsTotal, uniqueAgg, todayUnique, newLeads, companyReq, candidateReg, enquiries, chatbot, converted, rejected, drafts,
    fuToday, fuOverdue, downloads, openJobs,
    visitSeries, sessionSeries, typeSeries, leadsBySource, leadsByStatus, topPages, trafficSources, devices,
    formStarts, uniqueVisitorsCount, progressed,
    latestLeads, upcoming, latestCandidates, recentDrafts,
  ] = await Promise.all([
    PageView.countDocuments({ ...demo, at: inRange }),
    Session.countDocuments({ ...demo, startedAt: inRange }),
    PageView.distinct('visitorId', { ...demo, at: inRange }).then((a) => a.length),
    PageView.distinct('visitorId', { ...demo, at: todayRange }).then((a) => a.length),
    Lead.countDocuments(submitted),
    Lead.countDocuments(byType('company')), Lead.countDocuments(byType('candidate')), Lead.countDocuments(byType('enquiry')), Lead.countDocuments(byType('chatbot')),
    Lead.countDocuments(and(submitted, { status: 'Converted' })), Lead.countDocuments(and(submitted, { status: 'Rejected' })),
    Lead.countDocuments(and(demo, { isDraft: true })),
    Lead.countDocuments(and(demo, { isDraft: false }, open, { nextFollowUpAt: todayRange })),
    Lead.countDocuments(and(demo, { isDraft: false }, open, { nextFollowUpAt: { $lt: istStartOfDay(now) } })),
    TrackEvent.countDocuments({ ...trackMatch, type: 'download' }),
    Job.countDocuments({ status: 'Open' }),

    PageView.aggregate([{ $match: trackMatch }, { $group: { _id: { d: dExpr }, views: { $sum: 1 }, u: { $addToSet: '$visitorId' } } }]),
    Session.aggregate([{ $match: { ...demo, startedAt: inRange } }, { $group: { _id: bucket === 'month' ? monthExpr('$startedAt') : dayExpr('$startedAt'), n: { $sum: 1 } } }]),
    Lead.aggregate([{ $match: submitted }, { $group: { _id: { d: lExpr, t: '$type' }, n: { $sum: 1 } } }]),
    Lead.aggregate([{ $match: submitted }, { $group: { _id: '$source', n: { $sum: 1 } } }, { $sort: { n: -1 } }]),
    Lead.aggregate([{ $match: base }, { $group: { _id: { $cond: ['$isDraft', 'Draft', '$status'] }, n: { $sum: 1 } } }, { $sort: { n: -1 } }]),
    PageView.aggregate([{ $match: trackMatch }, { $group: { _id: '$path', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 8 }]),
    Session.aggregate([{ $match: { ...demo, startedAt: inRange } }, { $group: { _id: '$source', n: { $sum: 1 } } }, { $sort: { n: -1 } }]),
    Session.aggregate([{ $match: { ...demo, startedAt: inRange } }, { $group: { _id: '$device', n: { $sum: 1 } } }, { $sort: { n: -1 } }]),

    TrackEvent.countDocuments({ ...trackMatch, type: 'form_start' }),
    PageView.distinct('visitorId', { ...demo, at: inRange }).then((a) => a.length),
    Lead.countDocuments(and(submitted, { status: { $in: PROGRESSED } })),

    Lead.find(submitted).select('-data -activity -notes -followUps -files').sort({ createdAt: -1 }).limit(8).lean(),
    Lead.find(and(demo, { isDraft: false }, open, { nextFollowUpAt: { $ne: null } })).select('name company type phone status nextFollowUpAt').sort({ nextFollowUpAt: 1 }).limit(8).lean(),
    Lead.find(and(submitted, { type: 'candidate' })).select('name phone role city experience status createdAt').sort({ createdAt: -1 }).limit(8).lean(),
    Lead.find(and(demo, { isDraft: true })).select('name company type phone draftStep updatedAt resumeCode').sort({ updatedAt: -1 }).limit(8).lean(),
  ]);

  // zero-filled series
  const keys = bucket === 'day' ? dayKeys(from, to) : (() => { const out = []; const d = new Date(from.getTime() + 5.5 * 3600e3); d.setUTCDate(1); const end = new Date(to.getTime() + 5.5 * 3600e3); while (d <= end && out.length < 14) { out.push(d.toISOString().slice(0, 7)); d.setUTCMonth(d.getUTCMonth() + 1); } return out; })();
  const vMap = Object.fromEntries(visitSeries.map((x) => [x._id.d, x]));
  const sMap = toMap(sessionSeries);
  const visitors = keys.map((k) => ({ date: k, visitors: sMap[k] || 0, unique: vMap[k]?.u.length || 0, pageViews: vMap[k]?.views || 0 }));
  const tMap = {};
  for (const x of typeSeries) { (tMap[x._id.d] ||= {})[x._id.t] = x.n; }
  const submissions = keys.map((k) => ({ date: k, company: tMap[k]?.company || 0, candidate: tMap[k]?.candidate || 0, enquiry: tMap[k]?.enquiry || 0, chatbot: tMap[k]?.chatbot || 0, total: Object.values(tMap[k] || {}).reduce((a, b) => a + b, 0) }));

  const dec = (l) => ({ ...l, followUp: followUpState(l.nextFollowUpAt) });
  res.json({
    range: { from, to, bucket },
    stats: {
      totalVisitors: sessionsTotal, uniqueVisitors: uniqueAgg, pageViews: pvTotal, todayVisitors: todayUnique,
      newLeads, companyRequests: companyReq, candidateRegistrations: candidateReg, enquiries, chatbotLeads: chatbot,
      draftsPending: drafts, followUpsToday: fuToday, followUpsOverdue: fuOverdue, converted, rejected, downloads, openJobs,
    },
    charts: {
      visitors, submissions,
      leadsBySource: rowsToList(leadsBySource), leadsByStatus: rowsToList(leadsByStatus),
      topPages: rowsToList(topPages), trafficSources: rowsToList(trafficSources), devices: rowsToList(devices),
      funnel: [
        { stage: 'Visitors', value: uniqueVisitorsCount }, { stage: 'Started a form', value: formStarts },
        { stage: 'Leads submitted', value: newLeads }, { stage: 'Contacted or later', value: progressed }, { stage: 'Converted', value: converted },
      ],
    },
    tables: { latestLeads: latestLeads.map(dec), upcomingFollowUps: upcoming.map(dec), latestCandidates, recentDrafts },
  });
}));

export default r;
