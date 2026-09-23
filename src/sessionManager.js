import { config } from './config.js';
import { logger } from './logger.js';
import { WaSession } from './waSession.js';
import { MeSession } from './meSession.js';

/**
 * מנהל סשנים בזיכרון: תקרת מקביליות, פקיעה אוטומטית וניקוי ודאי.
 * אין כאן שום התמדה - ריסטארט של השרת מוחק הכול, וזו התנהגות רצויה.
 */
class SessionManager {
  constructor() {
    /** @type {Map<string, {session: WaSession, ip: string, createdAt: number, lastSeen: number}>} */
    this.sessions = new Map();
    this.sweeper = setInterval(() => this.sweep(), 15 * 1000);
    this.sweeper.unref?.();
  }

  get size() {
    return this.sessions.size;
  }

  atCapacity() {
    return this.sessions.size >= config.session.maxConcurrent;
  }

  /**
   * @param {Function} emit
   * @param {string} ip
   * @param {'wa'|'me'} kind איזה מקור נתונים הסשן הזה מייצג
   */
  create(emit, ip, kind = 'wa') {
    const session = kind === 'me' ? new MeSession(emit) : new WaSession(emit);
    this.sessions.set(session.id, {
      session,
      ip,
      createdAt: Date.now(),
      lastSeen: Date.now()
    });
    return session;
  }

  get(id) {
    const entry = this.sessions.get(id);
    if (!entry) return null;
    entry.lastSeen = Date.now();
    return entry.session;
  }

  /** מונע מאותו IP לפתוח עשרות חיבורי וואטסאפ במקביל */
  countByIp(ip) {
    let n = 0;
    for (const entry of this.sessions.values()) if (entry.ip === ip) n += 1;
    return n;
  }

  async destroy(id) {
    const entry = this.sessions.get(id);
    if (!entry) return;
    this.sessions.delete(id);
    try {
      await entry.session.destroy();
    } catch (err) {
      logger.warn({ err: err?.message }, 'session destroy failed');
    }
  }

  sweep() {
    const now = Date.now();
    for (const [id, entry] of this.sessions) {
      const idle = now - entry.lastSeen > config.session.idleTtlMs;
      const old = now - entry.createdAt > config.session.hardTtlMs;
      if (idle || old) {
        logger.info({ reason: idle ? 'idle' : 'max-age' }, 'sweeping session');
        this.destroy(id).catch(() => {});
      }
    }
  }

  async shutdown() {
    clearInterval(this.sweeper);
    const ids = [...this.sessions.keys()];
    await Promise.allSettled(ids.map((id) => this.destroy(id)));
  }
}

export const sessions = new SessionManager();
