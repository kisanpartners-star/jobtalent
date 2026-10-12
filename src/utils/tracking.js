import { z } from 'zod';
import { UAParser } from 'ua-parser-js';
import { isbot } from 'isbot';
import { env } from '../config/env.js';
import { Visitor, Session, PageView, TrackEvent } from '../models/index.js';
import { hashIp } from './helpers.js';

const id = z.string().regex(/^[a-zA-Z0-9_-]{8,64}$/);
export const pageviewSchema = z.object({
  visitorId: id, sessionId: id, path: z.string().max(300), title: z.string().max(200).optional(),
  referrer: z.string().max(500).optional(), utm: z.string().max(100).optional(),
});
export const eventSchema = z.object({
  visitorId: id, sessionId: id.optional(),
  type: z.enum(['cta_call', 'cta_whatsapp', 'cta_mail', 'cta_enquiry', 'download', 'chatbot_open', 'form_start', 'form_complete']),
  label: z.string().max(120).optional(), path: z.string().max(300).optional(),
});

const SEARCH = /(google|bing|yahoo|duckduckgo|baidu|ecosia)\./i;
const SOCIAL = /(facebook|instagram|linkedin|lnkd\.in|twitter|t\.co|x\.com|youtube|whatsapp|wa\.me)/i;

export function classifySource(referrer, utm, selfHost) {
  if (utm) return utm.toLowerCase();
  if (!referrer) return 'direct';
  try {
    const host = new URL(referrer).hostname;
    if (selfHost && host.includes(selfHost)) return 'direct';
    if (SEARCH.test(host)) return 'search';
    if (SOCIAL.test(host)) return 'social';
    return 'referral';
  } catch { return 'direct'; }
}

export const isBotRequest = (req) => isbot(req.get('user-agent') || '');
export const isAdminPath = (p) => /^\/admin(\/|$)/.test(p || '');

function deviceOf(req) {
  const ua = new UAParser(req.get('user-agent') || '').getResult();
  const t = ua.device.type;
  return { device: t === 'mobile' ? 'Mobile' : t === 'tablet' ? 'Tablet' : 'Desktop', browser: ua.browser.name || 'Other', os: ua.os.name || 'Other' };
}

const geo = (req) => ({
  country: req.get('cf-ipcountry') || req.get('x-vercel-ip-country') || req.get('x-country-code') || undefined,
  city: req.get('cf-ipcity') || req.get('x-vercel-ip-city') || undefined,
});

export async function recordPageview(req, body) {
  if (isBotRequest(req) || isAdminPath(body.path)) return { ignored: true };
  const now = new Date();
  const { device, browser, os } = deviceOf(req);
  const { country, city } = geo(req);
  const selfHost = (() => { try { return new URL(env.siteUrl).hostname; } catch { return ''; } })();
  const source = classifySource(body.referrer, body.utm, selfHost);

  const existingVisitor = await Visitor.findOneAndUpdate(
    { visitorId: body.visitorId },
    { $set: { lastSeen: now }, $setOnInsert: { firstSeen: now } },
    { upsert: true, new: false },
  );
  let session = await Session.findOne({ sessionId: body.sessionId });
  if (!session) {
    if (existingVisitor) await Visitor.updateOne({ visitorId: body.visitorId }, { $inc: { visits: 1 } });
    await Session.create({
      sessionId: body.sessionId, visitorId: body.visitorId, startedAt: now, lastAt: now, pages: 1, device, browser, os, country, city,
      referrer: body.referrer ? body.referrer.slice(0, 200) : '', source, ipHash: hashIp(req.ip, env.ipSalt), returning: !!existingVisitor,
    });
  } else {
    await Session.updateOne({ sessionId: body.sessionId }, { $set: { lastAt: now }, $inc: { pages: 1 } });
  }
  await PageView.create({ visitorId: body.visitorId, sessionId: body.sessionId, path: body.path, title: body.title, at: now, referrer: body.referrer?.slice(0, 200), source: session?.source || source, device, browser, country });
  return { ok: true };
}

export async function recordEvent(req, body) {
  if (isBotRequest(req) || isAdminPath(body.path)) return { ignored: true };
  await TrackEvent.create({ ...body, at: new Date() });
  return { ok: true };
}
