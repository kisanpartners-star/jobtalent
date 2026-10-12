import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '../..');
export const UPLOAD_DIR = path.join(ROOT_DIR, 'uploads');

const isProd = process.env.NODE_ENV === 'production';

export const env = {
  isProd,
  port: Number(process.env.PORT ),
  mongoUri: process.env.MONGODB_URI ,
  clientOrigins: (process.env.CLIENT_ORIGINS || 'http://localhost:5173')
    .split(',').map((s) => s.trim()).filter(Boolean),
  siteUrl: (process.env.SITE_URL || 'http://localhost:5173').replace(/\/$/, ''),
  jwtSecret: process.env.JWT_SECRET || 'dev-only-secret-change-me',
  ipSalt: process.env.IP_HASH_SALT || 'dev-ip-salt',
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  sessionHours: Number(process.env.ADMIN_SESSION_HOURS || 8),
  admin: {
    email: (process.env.ADMIN_EMAIL || 'admin@vbtalentx.com').toLowerCase(),
    password: process.env.ADMIN_PASSWORD || 'VB@2026',
    name: process.env.ADMIN_NAME || 'VB TALENTX Admin',
  },
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'VB TALENTX <vbtalentx@gmail.com>',
    notifyTo: process.env.NOTIFY_EMAIL || '',
  },
};

if (isProd && (env.jwtSecret.startsWith('dev-only') || env.jwtSecret.startsWith('change-this'))) {
  console.warn('[security] JWT_SECRET is not set to a strong value. Set it in .env before going live.');
}
