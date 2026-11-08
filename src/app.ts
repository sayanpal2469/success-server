import compression from 'compression';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import mongoose from 'mongoose';
import { pinoHttp } from 'pino-http';

import { env } from './config/env.js';
import { checkFileSig, PRIVATE_DIR, PUBLIC_DIR } from './lib/files.js';
import { logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { adminRouter } from './routes/admin/index.js';
import { authRouter } from './routes/auth.js';
import { publicRouter } from './routes/public.js';
import { studentRouter } from './routes/student/index.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);
  app.set('query parser', 'simple');

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(
    cors({
      // Browsers: only the admin panel, website and Expo web. The native app sends no Origin.
      origin: (origin, cb) => cb(null, !origin || env.CORS_ORIGINS.includes(origin)),
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      maxAge: 600,
    }),
  );
  app.use(compression());
  app.use(express.json({ limit: '2mb' }));
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/api/v1/health' }, customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info') }));

  app.get('/', (_req, res) => {
    res.type('text').send('Welcome to Success Tutorials');
  });

  app.get('/api/v1/health', (_req, res) => {
    res.json({ ok: mongoose.connection.readyState === 1, time: new Date() });
  });

  // API responses are per user / per origin: never let a CDN keep them (routes may loosen this).
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/public', publicRouter);
  app.use('/api/v1/student', studentRouter);
  app.use('/api/v1/admin', adminRouter);

  // Public files (photos, banners, course material): random names, cached for a year.
  app.use(
    '/uploads',
    express.static(PUBLIC_DIR, {
      immutable: true,
      maxAge: '365d',
      index: false,
      dotfiles: 'deny',
      // Same file for every site, so a CDN-cached copy must not carry one site's origin.
      setHeaders: (res) => res.set({ 'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': '*' }),
    }),
  );
  // Private files (admission documents): only with a signed link from an admin endpoint.
  app.get('/files/:name', (req, res) => {
    const { name } = req.params;
    if (!checkFileSig(name, req.query.exp as string | undefined, req.query.sig as string | undefined)) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'This link has expired' } });
      return;
    }
    res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    res.sendFile(name, { root: PRIVATE_DIR, dotfiles: 'deny' }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: { code: 'NOT_FOUND', message: 'File not found' } });
    });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
