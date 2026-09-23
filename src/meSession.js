import { randomUUID } from 'node:crypto';

import { config } from './config.js';
import { logger } from './logger.js';
import { formatPhone } from './analyze.js';
import * as me from './providers/meProvider.js';

/**
 * סשן "מי שמר אותי".
 *
 * מדבר בדיוק אותה שפה כמו WaSession מול הלקוח - אותם אירועי state
 * ואותה צורת items - כדי שמסך התוצאות, ההצלבה מול ספר הטלפונים
 * והייצוא יהיו משותפים לשני המקורות בלי שום הסתעפות בממשק.
 *
 * מצבים: otp -> verifying -> fetching -> done
 *
 * מה לא נשמר כאן: רשימת המספרים משוחררת מיד אחרי השליחה ללקוח,
 * בדיוק כמו במסלול וואטסאפ. הטוקן מבוטל מול הספק בסיום.
 */
export class MeSession {
  /** @param {(event: string, payload?: any) => void} emit */
  constructor(emit) {
    this.id = randomUUID();
    this.source = 'me';
    this.emit = emit;
    this.createdAt = Date.now();
    this.state = 'idle';
    this.closed = false;
    this.finished = false;

    this.challengeId = null;
    this.token = null;
    this.phone = null;
    this.attempts = 0;

    this.stats = null;
    this.otpTimer = null;
  }

  clearTimers() {
    clearTimeout(this.otpTimer);
    this.otpTimer = null;
  }

  setState(state, payload) {
    if (this.closed) return;
    this.state = state;
    this.emit('state', { state, ...(payload || {}) });
  }

  /**
   * המשתמש מגיע עם טלפון וקוד שכבר קיבל מהבוט של Me.
   *
   * אנחנו לא שולחים קוד ולא מנפיקים אותו - המשתמש אימת את עצמו
   * ישירות מול Me, והקוד הוא שלו. השרת רק מציג אותו לספק ומבקש
   * את הרשימה. זה מקצר את המסלול ומוריד מאיתנו אחריות על שליחת
   * הודעות למספרים שאינם שלנו.
   */
  async start(phone, code) {
    if (!me.isConfigured()) {
      return this.fail('ME_NOT_CONFIGURED', 'מסלול זה עדיין לא זמין. בינתיים אפשר להשתמש בסריקת וואטסאפ.');
    }

    this.phone = me.normalizeMsisdn(phone);
    if (!this.phone) {
      return this.fail('BAD_PHONE', 'המספר לא תקין. בדוק ונסה שוב.');
    }

    const clean = String(code || '').replace(/\D/g, '');
    if (clean.length < 4 || clean.length > 8) {
      return this.setState('otp', { error: 'הקוד לא תקין. הוא בן 6 ספרות.' });
    }

    this.setState('verifying');

    try {
      const { token } = await me.verifyOtp(this.phone, clean);
      this.token = token;
    } catch (err) {
      const code2 = err?.code || 'ME_ERROR';
      if (code2 === 'BAD_CODE' || err?.status === 400 || err?.status === 401) {
        this.attempts += 1;
        if (this.attempts >= config.me.maxCodeAttempts) {
          return this.fail('TOO_MANY_ATTEMPTS', 'יותר מדי ניסיונות. התחל מחדש.');
        }
        return this.setState('otp', {
          error: 'הקוד לא התקבל. שלח Connectme לבוט שוב וקבל קוד חדש.'
        });
      }
      return this.fail(code2, err?.message || 'האימות נכשל. נסה שוב.');
    }

    await this.fetch();
  }

  /** שלב 3: משיכת הרשימה, שליחה ללקוח, וניקוי מיידי */
  async fetch() {
    if (this.finished || this.closed) return;
    this.setState('fetching');

    let rows = [];
    try {
      rows = await me.fetchSavedMe(this.token);
    } catch (err) {
      return this.fail(err?.code || 'ME_ERROR', err?.message || 'לא הצלחנו למשוך את הרשימה.');
    }

    this.finished = true;
    this.clearTimers();

    const mine = me.normalizeMsisdn(this.phone);
    const items = [];
    for (const row of rows) {
      if (!row.phone || row.phone === mine) continue;
      items.push({
        i: items.length,
        phone: `+${row.phone}`,
        display: formatPhone(row.phone),
        pushName: row.name || '',
        business: false,
        // הם שמרו אותך - זו בדיוק ההגדרה של הפער, ולכן ודאות מקסימלית
        wroteToYou: false,
        savedYou: true,
        confidence: 'high',
        source: 'me',
        lastAt: 0
      });
    }

    const stats = { savedYou: items.length, total: items.length, source: 'me' };
    this.stats = stats;

    // מבטלים את ההרשאה מול הספק לפני ששולחים - מרגע זה הטוקן מת
    await this.release();

    this.setState('done', { stats, items });
  }

  fail(code, message) {
    if (this.finished || this.closed) return;
    this.finished = true;
    this.clearTimers();
    this.emit('failed', { code, message });
    this.release().catch(() => {});
  }

  /** מבטל את הטוקן ומוחק אותו מהזיכרון */
  async release() {
    const token = this.token;
    this.token = null;
    this.challengeId = null;
    if (!token) return;
    try {
      await me.revoke(token);
    } catch (err) {
      logger.debug({ err: err?.message }, 'me token revoke failed');
    }
  }

  async destroy() {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    await this.release();
    this.phone = null;
    this.stats = null;
  }
}
