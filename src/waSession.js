import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} from 'baileys';
import QRCode from 'qrcode';
import { randomUUID } from 'node:crypto';

import { config } from './config.js';
import { logger, waLogger } from './logger.js';
import { makeInMemoryAuthState } from './memoryAuthState.js';
import { analyze, isPersonalJid, jidUser } from './analyze.js';

const MAX_CONTACTS = 60000;
const MAX_CHATS = 20000;

let cachedVersion = null;
let cachedVersionAt = 0;

async function getWaVersion() {
  const fresh = Date.now() - cachedVersionAt < 60 * 60 * 1000;
  if (cachedVersion && fresh) return cachedVersion;
  try {
    // לא נותנים לבדיקת הגרסה לתקוע את הסשן - נופלים לגרסה המצורפת לספרייה
    const { version } = await Promise.race([
      fetchLatestBaileysVersion(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000))
    ]);
    cachedVersion = version;
    cachedVersionAt = Date.now();
  } catch (err) {
    logger.warn({ err: err?.message }, 'fetchLatestBaileysVersion failed, using bundled default');
  }
  return cachedVersion || undefined;
}

/**
 * סשן בודד: מחזיק חיבור וואטסאפ אחד, אוסף אנשי קשר ושיחות,
 * מחשב תוצאה, ואז מתנתק ומוחק את פרטי ההתחברות.
 */
export class WaSession {
  /**
   * @param {(event: string, payload?: any) => void} emit
   */
  constructor(emit) {
    this.id = randomUUID();
    this.emit = emit;
    this.createdAt = Date.now();
    this.state = 'idle';
    this.closed = false;

    this.contacts = new Map();
    this.chats = new Map();
    this.incoming = new Set();
    // שמות תצוגה שנאספים תוך כדי: pushName מהודעות נכנסות ושם השיחה.
    // בלי זה רוב הרשומות יוצאות עם מספר בלבד, וקשה לזהות מי זה.
    this.names = new Map();

    this.results = null;
    this.stats = null;

    this.auth = makeInMemoryAuthState();
    this.sock = null;
    this.restarts = 0;
    this.pairingPhone = null;
    this.pairingRequested = false;
    this.syncStartedAt = 0;
    this.lastEventAt = 0;
    this.syncTimer = null;
    this.qrTimer = null;
    this.handshakeTimer = null;
    this.finished = false;
  }

  clearTimers() {
    clearInterval(this.syncTimer);
    clearTimeout(this.qrTimer);
    clearTimeout(this.handshakeTimer);
    this.syncTimer = null;
    this.qrTimer = null;
    this.handshakeTimer = null;
  }

  setState(state, payload) {
    if (this.closed) return;
    if (state !== 'starting') {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
    this.state = state;
    this.emit('state', { state, ...(payload || {}) });
  }

  async start(pairingPhone) {
    this.pairingPhone = pairingPhone || null;
    await this.connect();

    // אם וואטסאפ לא החזיר קוד בכלל - כנראה בעיית רשת בצד השרת.
    // עדיף כישלון ברור מאשר גלגל שמסתובב לנצח.
    this.handshakeTimer = setTimeout(() => {
      if (!this.finished && this.state === 'starting') {
        this.fail('NO_HANDSHAKE', 'אין כרגע חיבור לשרתי וואטסאפ. נסה שוב בעוד רגע.');
      }
    }, config.session.handshakeMs);

    this.qrTimer = setTimeout(() => {
      if (!this.finished && ['starting', 'qr', 'pairing'].includes(this.state)) {
        this.fail('TIMEOUT_SCAN', 'לא התבצעה סריקה בזמן. אפשר להתחיל מחדש.');
      }
    }, config.session.qrWaitMs);
  }

  async connect() {
    const version = await getWaVersion();
    const { state } = this.auth;

    this.sock = makeWASocket({
      version,
      logger: waLogger,
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, waLogger)
      },
      browser: Browsers.macOS('Desktop'),
      syncFullHistory: config.sync.fullHistory,
      // לא מסמנים אונליין - המשתמש לא צריך שההתראות שלו יעברו לכאן
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      emitOwnEvents: false,
      shouldSyncHistoryMessage: () => true,
      getMessage: async () => undefined
    });

    this.setState(this.state === 'idle' ? 'starting' : this.state);
    this.bind();
  }

  bind() {
    const sock = this.sock;

    sock.ev.on('creds.update', () => {
      /* המצב בזיכרון מתעדכן במקום - אין שמירה לדיסק */
    });

    sock.ev.on('connection.update', (update) => {
      this.onConnectionUpdate(update).catch((err) => {
        logger.error({ err: err?.message }, 'connection update handler failed');
      });
    });

    sock.ev.on('messaging-history.set', (payload) => {
      this.touch();
      this.mergeContacts(payload?.contacts);
      this.mergeChats(payload?.chats);
      this.mergeMessages(payload?.messages);
      const progress = Number(payload?.progress);
      this.emit('sync', {
        contacts: this.contacts.size,
        chats: this.chats.size,
        progress: Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : null
      });
      if (payload?.isLatest) this.finishSoon(1500);
    });

    sock.ev.on('contacts.upsert', (contacts) => {
      this.touch();
      this.mergeContacts(contacts);
    });

    sock.ev.on('contacts.update', (contacts) => {
      this.touch();
      this.mergeContacts(contacts, true);
    });

    sock.ev.on('chats.upsert', (chats) => {
      this.touch();
      this.mergeChats(chats);
    });

    sock.ev.on('messages.upsert', ({ messages }) => {
      this.touch();
      this.mergeMessages(messages);
    });
  }

  touch() {
    this.lastEventAt = Date.now();
  }

  /** שומר שם תצוגה ראשון שנראה עבור מספר. לא דורס שם קיים. */
  rememberName(jid, name) {
    if (typeof name !== 'string') return;
    const clean = name.trim();
    if (!clean || clean.length > 80) return;
    const user = jidUser(jid);
    if (!user || this.names.has(user)) return;
    if (this.names.size >= MAX_CONTACTS) return;
    this.names.set(user, clean);
  }

  mergeContacts(list, partial = false) {
    if (!Array.isArray(list)) return;
    for (const c of list) {
      const jid = c?.id;
      if (typeof jid !== 'string' || !jid.includes('@')) continue;
      if (this.contacts.size >= MAX_CONTACTS && !this.contacts.has(jid)) continue;
      const prev = this.contacts.get(jid);
      if (prev && partial) {
        this.contacts.set(jid, { ...prev, ...c });
      } else if (prev) {
        // לא דורסים שם מיומן הטלפון בעדכון חלקי שאין בו שם
        this.contacts.set(jid, { ...prev, ...c, name: c.name ?? prev.name });
      } else {
        this.contacts.set(jid, c);
      }
    }
  }

  mergeChats(list) {
    if (!Array.isArray(list)) return;
    for (const chat of list) {
      const jid = chat?.id;
      if (typeof jid !== 'string' || !isPersonalJid(jid)) continue;
      if (this.chats.size >= MAX_CHATS && !this.chats.has(jid)) continue;
      const prev = this.chats.get(jid);
      this.chats.set(jid, prev ? { ...prev, ...chat } : chat);
      this.rememberName(jid, chat?.name);
    }
  }

  mergeMessages(list) {
    if (!Array.isArray(list)) return;
    for (const msg of list) {
      const key = msg?.key;
      if (!key || key.fromMe) continue;
      const jid = key.remoteJid;
      if (!isPersonalJid(jid)) continue;
      if (this.incoming.size >= MAX_CHATS) break;
      this.incoming.add(jidUser(jid));
      this.rememberName(jid, msg?.pushName || msg?.verifiedBizName);
    }
  }

  async onConnectionUpdate(update) {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !this.finished) {
      if (this.pairingPhone && !this.pairingRequested) {
        this.pairingRequested = true;
        try {
          const code = await this.sock.requestPairingCode(this.pairingPhone);
          this.setState('pairing', { code: String(code).toUpperCase() });
        } catch (err) {
          logger.warn({ err: err?.message }, 'pairing code request failed');
          this.pairingPhone = null;
          this.pairingRequested = false;
          const dataUrl = await QRCode.toDataURL(qr, { margin: 1, scale: 6 });
          this.setState('qr', { qr: dataUrl });
        }
      } else if (!this.pairingPhone) {
        const dataUrl = await QRCode.toDataURL(qr, { margin: 1, scale: 6 });
        this.setState('qr', { qr: dataUrl });
      }
    }

    if (connection === 'open') {
      clearTimeout(this.qrTimer);
      this.qrTimer = null;
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
      this.syncStartedAt = Date.now();
      this.touch();
      this.setState('syncing');
      this.startSyncWatchdog();
    }

    if (connection === 'close') {
      const status = lastDisconnect?.error?.output?.statusCode;

      if (this.finished || this.closed) return;

      if (status === DisconnectReason.restartRequired && this.restarts < 2) {
        this.restarts += 1;
        await this.connect();
        return;
      }

      if (status === DisconnectReason.loggedOut) {
        this.fail('LOGGED_OUT', 'החיבור נותק מהטלפון. אפשר להתחיל מחדש.');
        return;
      }

      if (this.state === 'syncing' && this.contacts.size > 0) {
        // נותק אחרי שכבר קיבלנו מידע - מסיימים עם מה שיש
        await this.finish();
        return;
      }

      this.fail('CONNECTION_CLOSED', 'החיבור נסגר. אפשר לנסות שוב.');
    }
  }

  startSyncWatchdog() {
    clearInterval(this.syncTimer);
    this.syncTimer = setInterval(() => {
      if (this.finished || this.closed) return;
      const now = Date.now();
      const elapsed = now - this.syncStartedAt;
      const quiet = now - this.lastEventAt;
      if (elapsed > config.sync.timeoutMs) return void this.finish();
      if (elapsed > config.sync.minMs && quiet > config.sync.quietMs) return void this.finish();
    }, 1000);
  }

  finishSoon(ms) {
    if (this.finished) return;
    setTimeout(() => {
      if (!this.finished) this.finish();
    }, ms);
  }

  async finish() {
    if (this.finished || this.closed) return;
    this.finished = true;
    this.clearTimers();

    const meJid = this.sock?.user?.id || '';
    const { items, stats } = analyze({
      contacts: this.contacts,
      chats: this.chats,
      incoming: this.incoming,
      names: this.names,
      meJid
    });

    this.stats = stats;

    // מנתקים מיד: מרגע זה המכשיר המקושר מבוטל בצד וואטסאפ
    await this.disconnect(true);

    // אין יותר צורך בגלם - משחררים זיכרון ומצמצמים חשיפה
    this.contacts.clear();
    this.chats.clear();
    this.incoming.clear();
    this.names.clear();

    // ההצלבה והייצוא קורים בדפדפן. השרת לא שומר את המספרים אחרי השליחה.
    this.results = null;

    this.setState('done', {
      stats,
      items: items.map((r, i) => ({
        i,
        phone: r.phone,
        display: r.display,
        pushName: r.pushName,
        business: r.business,
        wroteToYou: r.wroteToYou,
        confidence: r.confidence,
        source: r.source,
        lastAt: r.lastAt
      }))
    });
  }

  fail(code, message) {
    if (this.finished || this.closed) return;
    this.finished = true;
    this.clearTimers();
    this.emit('failed', { code, message });
    this.disconnect(false).catch(() => {});
  }

  /** @param {boolean} logout האם לבטל את קישור המכשיר בצד וואטסאפ */
  async disconnect(logout) {
    const sock = this.sock;
    this.sock = null;
    if (!sock) return;
    try {
      if (logout) await sock.logout();
    } catch {
      /* גם אם ההתנתקות המסודרת נכשלה, המפתחות נמחקים למטה */
    }
    try {
      sock.ev.removeAllListeners?.();
      sock.end?.(undefined);
    } catch {
      /* ignore */
    }
    this.auth.wipe();
  }

  async destroy() {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    await this.disconnect(!this.finished);
    this.contacts.clear();
    this.chats.clear();
    this.incoming.clear();
    this.results = null;
    this.stats = null;
  }
}
