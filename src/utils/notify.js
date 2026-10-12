import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { Notification, SiteSettings } from '../models/index.js';

let cached = { key: '', tx: null };

async function transport() {
  const s = (await SiteSettings.findOne({ key: 'main' }).lean())?.smtp || {};
  const host = s.enabled ? s.host : env.smtp.host;
  if (!host) return null;
  const cfg = s.enabled
    ? { host: s.host, port: Number(s.port || 587), user: s.user, pass: s.pass, from: s.from, to: s.notifyTo }
    : { host: env.smtp.host, port: env.smtp.port, user: env.smtp.user, pass: env.smtp.pass, from: env.smtp.from, to: env.smtp.notifyTo };
  const key = JSON.stringify(cfg);
  if (cached.key !== key) {
    cached = { key, cfg, tx: nodemailer.createTransport({ host: cfg.host, port: cfg.port, secure: cfg.port === 465, auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined }) };
  }
  return cached;
}

export async function sendMail(subject, text) {
  try {
    const t = await transport();
    if (!t?.cfg?.to) return false;
    await t.tx.sendMail({ from: t.cfg.from, to: t.cfg.to, subject, text });
    return true;
  } catch (e) {
    console.warn('[mail] could not send:', e.message);
    return false;
  }
}

// key makes a notification idempotent (e.g. one "follow-up due" per lead per day)
export async function notify({ kind, title, body = '', link = '', leadId, key, email = true }) {
  try {
    if (key && (await Notification.exists({ key }))) return null;
    const n = await Notification.create({ kind, title, body, link, leadId, key });
    if (email) sendMail(`[VB TALENTX] ${title}`, `${title}\n\n${body}\n\n${env.siteUrl}${link}`).catch(() => {});
    return n;
  } catch (e) {
    if (e.code !== 11000) console.warn('[notify]', e.message);
    return null;
  }
}
