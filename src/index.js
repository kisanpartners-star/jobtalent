import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import mongoose from 'mongoose';
import path from 'path';
import fs from 'fs';
import { pathToFileURL } from 'url';
import { env, UPLOAD_DIR, ROOT_DIR } from './config/env.js';
import { ensureDefaults } from './utils/bootstrap.js';
import { errorHandler, notFound } from './middleware/core.js';
import publicRoutes from './routes/public.js';
import { sitemapXml, robotsTxt, renderIndex, loadIndex } from './utils/seo.js';

const app = express();
app.set('trust proxy', 1);

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'img-src': ["'self'", 'data:', 'blob:', 'https:'],
      'media-src': ["'self'", 'blob:'],
      'frame-src': ["'self'", 'https://www.google.com', 'https://maps.google.com'],
      'script-src': ["'self'", "'unsafe-inline'"],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
      'connect-src': ["'self'"],
    },
  },
}));
app.use(cors({
  origin: (origin, cb) => (!origin || env.clientOrigins.includes(origin) ? cb(null, true) : cb(new Error('Origin not allowed'))),
  credentials: true,
}));
app.use(express.json({ limit: '200kb' }));
app.use(cookieParser());

// Public static assets only. resumes/ and documents/ are never exposed here.
for (const dir of ['branding', 'images', 'videos']) {
  app.use(`/uploads/${dir}`, express.static(path.join(UPLOAD_DIR, dir), { maxAge: env.isProd ? '7d' : 0, index: false, dotfiles: 'deny' }));
}

app.get('/api/health', (_req, res) => res.json({ ok: true, db: mongoose.connection.readyState === 1 }));
app.use('/api/public', publicRoutes);

// Optional admin module (shipped in the full package)
const adminEntry = path.join(ROOT_DIR, 'src', 'routes', 'admin', 'index.js');
if (fs.existsSync(adminEntry)) {
  const mod = await import(pathToFileURL(adminEntry).href);
  app.use('/api/admin', mod.default);
  console.log('[server] Admin module loaded');
}

app.get('/sitemap.xml', async (_req, res, next) => { try { res.type('application/xml').send(await sitemapXml()); } catch (e) { next(e); } });
app.get('/robots.txt', (_req, res) => res.type('text/plain').send(robotsTxt()));
app.use('/api', notFound);

// Production: serve the built client with server-injected SEO tags


const dist = path.join(ROOT_DIR, '..', 'client', 'dist');

if (fs.existsSync(path.join(dist, 'index.html'))) {
  loadIndex();

  app.use(express.static(dist, {
    index: false,
    maxAge: env.isProd ? '7d' : 0,
  }));

  app.get('*', async (req, res, next) => {
    try {
      const html = await renderIndex(req.path);

      if (html) {
        res.set('Cache-Control', 'no-cache');
        return res.type('html').send(html);
      }

      return res.sendFile(path.join(dist, 'index.html'));
    } catch (error) {
      next(error);
    }
  });
} else {
  console.error(`[server] Frontend index.html not found: ${dist}`);
}


app.use(notFound);
app.use(errorHandler);

async function start() {
  mongoose.set('strictQuery', true);
  try {
    await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 8000 });
  } catch (e) {
    console.error(`\n[db] Could not connect to MongoDB at ${env.mongoUri}\n     ${e.message}\n     Start MongoDB (or set MONGODB_URI to an Atlas / remote URL) and try again.\n`);
    process.exit(1);
  }
  console.log('[db] Connected');
  await ensureDefaults();
  if (fs.existsSync(adminEntry)) {
    const sched = await import(pathToFileURL(path.join(ROOT_DIR, 'src', 'routes', 'admin', 'scheduler.js')).href);
    sched.startScheduler();
  }
  app.listen(env.port, () => console.log(`[server] http://localhost:${env.port}  (${env.isProd ? 'production' : 'development'})`));
}
if (process.env.VBT_NO_LISTEN !== '1') start();
export default app;
