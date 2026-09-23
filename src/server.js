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
import { isConfigured as meConfigured, normalizeMsisdn } from './providers/meProvider.js';

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

/**
 * אילו מקורות נתונים זמינים בשרת הזה.
 * הדף בונה לפי זה את מסך בחירת המקור, במקום להציג מסלול שלא יעבוד.
 */
app.get('/api/sources', apiLimiter, (_req, res) => {
  res.json({ whatsapp: true, me: meConfigured() });
});

app.get('/healthz', apiLimiter, (_req, res) => {
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

/**
 * ה-IP של הלקוח, לפי אותה מדיניות שאקספרס משתמש בה.
 *
 * הערך השמאלי ב-X-Forwarded-For נשלט במלואו על ידי הלקוח. קריאה שלו
 * פירושה שכל handshake יכול להציג IP אחר, וכל הגבלה לפי IP מתאפסת.
 * סופרים מהסוף: המזהה שהפרוקסי שלנו הוסיף הוא האחרון.
 */
const clientIp = (socket) => {
  // TRUST_PROXY=0 פירושו שאין פרוקסי, ולכן ה-header כולו חסר ערך
  if (config.trustProxy <= 0) return socket.handshake.address || 'unknown';

  const fwd = socket.handshake.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) {
    const chain = fwd.split(',').map((v) => v.trim()).filter(Boolean);
    const idx = chain.length - config.trustProxy;
    // רק אם השרשרת ארוכה מספיק. שרשרת קצרה מהצפוי פירושה שהבקשה
    // לא עברה בפרוקסי שלנו, ולכן כל ערך בה נשלט על ידי הלקוח -
    // נפילה חזרה אליו מאפסת כל הגבלה לפי IP.
    if (idx >= 0 && chain[idx]) return chain[idx];
  }
  return socket.handshake.address || 'unknown';
};

/**
 * הגבלת קצב לאירועי סוקט. socket.io לא עובר במידלוור של אקספרס,
 * ולכן express-rate-limit לא נוגע בו בכלל.
 */
const startHits = new Map();

const tooManyStarts = (ip) => {
  const now = Date.now();
  const win = config.limits.startWindowMs;
  const hits = (startHits.get(ip) || []).filter((t) => now - t < win);
  if (hits.length >= config.limits.startMax) {
    startHits.set(ip, hits);
    return true;
  }
  hits.push(now);
  startHits.set(ip, hits);
  return false;
};

// ניקוי תקופתי כדי שהמפה לא תגדל בלי גבול
setInterval(() => {
  const now = Date.now();
  for (const [ip, hits] of startHits) {
    const live = hits.filter((t) => now - t < config.limits.startWindowMs);
    if (live.length) startHits.set(ip, live);
    else startHits.delete(ip);
  }
}, 60_000).unref?.();

/**
 * הגבלה לכל מספר יעד, בנפרד מהגבלת ה-IP.
 * בלעדיה אפשר להפציץ קורבן ב-SMS על חשבון בעל המוצר.
 */
const otpHits = new Map();

const OTP_MAP_CAP = 50_000;

const tooManyOtps = (phone) => {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  // תקרה קשיחה: מפתח לכל מספר יעד חי יממה, ובלעדיה המפה גדלה בלי גבול
  if (!otpHits.has(phone) && otpHits.size >= OTP_MAP_CAP) return true;
  const hits = (otpHits.get(phone) || []).filter((t) => now - t < day);
  if (hits.length >= config.me.maxOtpPerPhone) {
    otpHits.set(phone, hits);
    return true;
  }
  hits.push(now);
  otpHits.set(phone, hits);
  return false;
};

setInterval(() => {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  for (const [phone, hits] of otpHits) {
    const live = hits.filter((t) => now - t < day);
    if (live.length) otpHits.set(phone, live);
    else otpHits.delete(phone);
  }
}, 10 * 60_000).unref?.();

/**
 * מנרמל אחד לכל המערכת.
 *
 * שני מנרמלים שונים פירושם שהמפתח שנספר בהגבלת הקצב אינו הערך
 * שנשלח בפועל: "00501234567" ו-"501234567" מגיעים לאותו טלפון
 * ומקבלים שתי מכסות נפרדות.
 */
const normalizePhone = (value) => normalizeMsisdn(value) || null;

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
    // אחרון: משתמש לא שורף מהמכסה שלו בגלל עומס בשרת
    if (tooManyStarts(ip)) {
      return socket.emit('failed', {
        code: 'RATE_LIMITED',
        message: 'יותר מדי ניסיונות מהמכשיר הזה. המתן כמה דקות ונסה שוב.'
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

  socket.on('me:start', async ({ phone } = {}) => {
    if (boundId) return;

    if (!meConfigured()) {
      return socket.emit('failed', {
        code: 'ME_NOT_CONFIGURED',
        message: 'מסלול זה עדיין לא זמין. בינתיים אפשר להשתמש בסריקת וואטסאפ.'
      });
    }
    // ולידציה לפני כל מונה, כדי שמספר שגוי לא ישרוף מכסה
    const target = normalizePhone(phone);
    if (!target) {
      return socket.emit('failed', { code: 'BAD_PHONE', message: 'המספר לא תקין. בדוק ונסה שוב.' });
    }
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
    if (tooManyStarts(ip)) {
      return socket.emit('failed', {
        code: 'RATE_LIMITED',
        message: 'יותר מדי ניסיונות מהמכשיר הזה. המתן כמה דקות ונסה שוב.'
      });
    }
    // הגבלה לכל מספר יעד: ה-OTP נשלח לטלפון של מישהו, לא של השולח
    if (tooManyOtps(target)) {
      return socket.emit('failed', {
        code: 'OTP_LIMIT',
        message: 'נשלחו כבר מספר קודים למספר הזה היום. נסה שוב מחר.'
      });
    }

    let session;
    try {
      session = sessions.create(() => {}, ip, 'me');
      session.emit = emitterFor(session);
      bind(session);
      socket.emit('session', { sessionId: session.id, source: 'me' });
      await session.start(target);
    } catch (err) {
      logger.error({ err: err?.message }, 'me session start failed');
      if (session) await sessions.destroy(session.id);
      socket.emit('failed', { code: 'START_FAILED', message: 'לא הצלחנו להתחיל. נסה שוב.' });
    }
  });

  socket.on('me:verify', async ({ code } = {}) => {
    const session = boundId ? sessions.get(boundId) : null;
    if (!session || session.source !== 'me') return;
    try {
      await session.verify(code);
    } catch (err) {
      logger.error({ err: err?.message }, 'me verify failed');
      socket.emit('failed', { code: 'VERIFY_FAILED', message: 'האימות נכשל. נסה שוב.' });
      // לא משאירים סשן עם טוקן חי תלוי באוויר עד ה-sweeper
      await sessions.destroy(boundId).catch(() => {});
      boundId = null;
    }
  });

  socket.on('done', () => {
    const session = boundId ? sessions.get(boundId) : null;
    if (session?.stats) recordScan(session.stats);
  });

  /** סיום מקור אחד כדי לפנות מקום למקור השני באותו ביקור */
  socket.on('release', async () => {
    if (boundId) await sessions.destroy(boundId);
    boundId = null;
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
