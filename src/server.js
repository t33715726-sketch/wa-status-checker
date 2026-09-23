import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { Server as SocketServer } from 'socket.io';

import { config } from './config.js';
import { logger } from './logger.js';
import { sessions } from './sessionManager.js';
import { recordScan } from './stats.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

const app = express();
app.set('trust proxy', config.trustProxy);
app.disable('x-powered-by');

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        'img-src': ["'self'", 'data:'],
        'font-src': ["'self'"],
        'connect-src': ["'self'"],
        'object-src': ["'none'"],
        'base-uri': ["'none'"],
        'frame-ancestors': ["'none'"],
        'form-action': ["'self'"],
        'upgrade-insecure-requests': []
      }
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'no-referrer' },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: false }
  })
);
app.use(compression());
app.use(express.json({ limit: '256kb' }));

const apiLimiter = rateLimit({
  windowMs: config.limits.apiWindowMs,
  max: config.limits.apiMax,
  standardHeaders: true,
  legacyHeaders: false
});

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, sessions: sessions.size, uptime: Math.round(process.uptime()) });
});

/*
 * אין כאן נקודת קצה לייצוא, וזה מכוון.
 *
 * הגרסה הראשונה בנתה את הקובץ בשרת. זו הייתה טעות: השרת לא יודע מי כבר
 * שמור אצל המשתמש, ולכן הקובץ הכיל אנשי קשר קיימים - והייבוא דרס להם
 * את השמות. עכשיו ההצלבה מול ספר הטלפונים והרכבת הקובץ קורות בדפדפן,
 * מול קובץ הייצוא שהמשתמש בוחר. ספר הטלפונים שלו לא עוזב את המכשיר,
 * והשרת לא מחזיק מספרי טלפון אחרי שליחת התוצאה.
 */

/** סיום יזום: המשתמש מבקש למחוק הכול עכשיו */
app.post('/api/end', apiLimiter, async (req, res) => {
  const { sessionId } = req.body || {};
  if (typeof sessionId === 'string') await sessions.destroy(sessionId);
  res.json({ ok: true });
});

app.use(
  express.static(publicDir, {
    maxAge: config.env === 'production' ? '1h' : 0,
    etag: true,
    index: 'index.html',
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    }
  })
);

app.use((_req, res) => res.status(404).json({ error: 'NOT_FOUND' }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  logger.error({ err: err?.message }, 'unhandled http error');
  res.status(500).json({ error: 'SERVER_ERROR' });
});

const server = http.createServer(app);
const io = new SocketServer(server, {
  cors: { origin: false },
  maxHttpBufferSize: 1e5,
  pingTimeout: 30000,
  connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000 }
});

const clientIp = (socket) => {
  const fwd = socket.handshake.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return socket.handshake.address || 'unknown';
};

const normalizePhone = (value) => {
  if (typeof value !== 'string') return null;
  let digits = value.replace(/\D/g, '');
  if (!digits) return null;
  // 05X... ישראלי -> 9725X...
  if (digits.startsWith('0')) digits = `972${digits.slice(1)}`;
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
};

io.on('connection', (socket) => {
  const ip = clientIp(socket);
  let boundId = null;

  const bind = (session) => {
    boundId = session.id;
    socket.join(session.id);
  };

  const emitterFor = (session) => (event, payload) => {
    if (event === 'state' || event === 'failed') session.snapshot = { event, payload };
    io.to(session.id).emit(event, payload);
    if (event === 'failed') {
      // שומרים את הסשן דקה כדי שדפדפן שהתנתק יקבל את ההודעה, ואז מוחקים
      setTimeout(() => sessions.destroy(session.id).catch(() => {}), 45_000).unref?.();
    }
  };

  socket.on('attach', ({ sessionId } = {}) => {
    const session = typeof sessionId === 'string' ? sessions.get(sessionId) : null;
    if (!session) return socket.emit('attach:failed');
    bind(session);
    socket.emit('session', { sessionId: session.id });
    if (session.snapshot) socket.emit(session.snapshot.event, session.snapshot.payload);
  });

  socket.on('start', async ({ phone } = {}) => {
    if (boundId) return;

    if (sessions.atCapacity()) {
      return socket.emit('failed', {
        code: 'BUSY',
        message: 'המערכת עמוסה כרגע. נסה שוב בעוד דקה.'
      });
    }
    if (sessions.countByIp(ip) >= 2) {
      return socket.emit('failed', {
        code: 'IP_LIMIT',
        message: 'כבר יש חיבור פעיל מהמכשיר הזה.'
      });
    }

    let session;
    try {
      session = sessions.create(() => {}, ip);
      session.emit = emitterFor(session);
      bind(session);
      socket.emit('session', { sessionId: session.id });
      await session.start(normalizePhone(phone));
    } catch (err) {
      logger.error({ err: err?.message }, 'session start failed');
      if (session) await sessions.destroy(session.id);
      socket.emit('failed', { code: 'START_FAILED', message: 'לא הצלחנו להתחיל. נסה שוב.' });
    }
  });

  socket.on('done', () => {
    const session = boundId ? sessions.get(boundId) : null;
    if (session?.stats) recordScan(session.stats);
  });

  socket.on('end', async () => {
    if (boundId) await sessions.destroy(boundId);
    boundId = null;
  });

  socket.on('disconnect', () => {
    // לא מוחקים מיד: משתמש בנייד עלול לעבור לוואטסאפ ולחזור.
    // ה-sweeper ימחק לפי idle TTL.
  });
});

server.listen(config.port, () => {
  logger.info({ port: config.port, env: config.env }, 'server listening');
});

const shutdown = async (signal) => {
  logger.info({ signal }, 'shutting down');
  server.close();
  io.close();
  await sessions.shutdown();
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error({ err: String(err) }, 'unhandledRejection'));
process.on('uncaughtException', (err) => logger.error({ err: err?.message }, 'uncaughtException'));
