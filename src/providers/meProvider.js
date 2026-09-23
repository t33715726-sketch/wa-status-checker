/* ============================================================
   ספק "מי שמר את המספר שלי".

   למה זה קיים כמתאם ולא כקוד ישיר
   ---------------------------------
   וואטסאפ לא חושפת בשום דרך מי שמר אותך. המידע הזה קיים אצל שירותי
   זיהוי שיחות שבנויים על ספרי טלפונים שמשתמשים העלו - Me הוא הבולט
   בישראל.

   ל-Me יש API רשמי (Me Business, me.app/join-api) אבל הוא נותן זיהוי
   מספרים, KYC ומניעת הונאות - לא "מי שמר אותי". הנתון הזה יושב
   באפליקציה הצרכנית שלהם.

   לכן כל הלוגיקה של המוצר - מסך טלפון, קוד חד-פעמי, הצלבה מול ספר
   הטלפונים, מיזוג עם מקור וואטסאפ ובניית ה-vcf - בנויה ומוכנה כאן,
   וההתחברות עצמה יושבת מאחורי הממשק הזה. ברגע שיש גישה מורשית,
   מגדירים את משתני הסביבה למטה וזהו. אין שינוי קוד בשום מקום אחר.

   מה שלא נמצא כאן בכוונה: לקוח שמפענח את ה-API הפרטי של Me. זו גישה
   למערכת של חברה אחרת בניגוד לתנאיה, והחשיפה המשפטית נופלת על בעל
   המוצר. ראה docs/DECISIONS.md.

   הממשק
   -----
   requestOtp(phone)             -> { challengeId, sentTo }
   verifyOtp(challengeId, code)  -> { token, expiresAt }
   fetchSavedMe(token)           -> [{ phone, name }]
   revoke(token)                 -> void
   ============================================================ */

import { config } from '../config.js';
import { logger } from '../logger.js';

/** שגיאה עם קוד שהלקוח יודע לתרגם להודעה בעברית */
export class ProviderError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.status = status || 0;
  }
}

const NOT_CONFIGURED = () =>
  new ProviderError(
    'ME_NOT_CONFIGURED',
    'החיבור לשירות זיהוי המספרים עדיין לא מוגדר. המסלול הזה יפעל ברגע שתהיה גישה מורשית.'
  );

/** מנרמל מספר לצורה בינלאומית בלי + ובלי תווים */
export function normalizeMsisdn(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = `${config.me.defaultCountry}${digits.slice(1)}`;
  if (digits.length < 8 || digits.length > 15) return '';
  return digits;
}

/** קריאת HTTP עם תקרת זמן. לוג בלי מספרים ובלי טוקנים. */
async function call(pathTemplate, { method = 'POST', token, body } = {}) {
  if (!config.me.enabled || !config.me.baseUrl) throw NOT_CONFIGURED();

  const url = `${config.me.baseUrl.replace(/\/+$/, '')}/${String(pathTemplate).replace(/^\/+/, '')}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.me.timeoutMs);

  const headers = { Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (config.me.apiKey) headers[config.me.apiKeyHeader] = config.me.apiKey;
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      signal: controller.signal,
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (err) {
    logger.warn({ err: err?.message, path: pathTemplate }, 'me provider request failed');
    throw new ProviderError('ME_UNREACHABLE', 'אין כרגע מענה משירות זיהוי המספרים. נסה שוב בעוד רגע.');
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) {
    throw new ProviderError('ME_UNAUTHORIZED', 'ההרשאה לשירות פגה. צריך להתחיל את האימות מחדש.', res.status);
  }
  if (res.status === 429) {
    throw new ProviderError('ME_RATE_LIMITED', 'יותר מדי בקשות. המתן דקה ונסה שוב.', 429);
  }
  if (!res.ok) {
    logger.warn({ status: res.status, path: pathTemplate }, 'me provider returned error');
    throw new ProviderError('ME_ERROR', 'שירות זיהוי המספרים החזיר שגיאה. נסה שוב.', res.status);
  }

  try {
    return await res.json();
  } catch {
    throw new ProviderError('ME_BAD_RESPONSE', 'התקבלה תשובה לא צפויה מהשירות.');
  }
}

/**
 * שולח קוד חד-פעמי למשתמש, על מספרו שלו.
 * @param {string} phone
 */
export async function requestOtp(phone) {
  const msisdn = normalizeMsisdn(phone);
  if (!msisdn) throw new ProviderError('BAD_PHONE', 'המספר לא תקין. בדוק ונסה שוב.');

  const data = await call(config.me.paths.requestOtp, { body: { phone_number: msisdn } });

  const challengeId = data?.challenge_id || data?.challengeId || data?.id || msisdn;
  return { challengeId: String(challengeId), sentTo: msisdn };
}

/**
 * מאמת מול הספק את הקוד שהמשתמש קיבל מהבוט שלו, ומחזיר טוקן.
 * @param {string} phone מספר המשתמש
 * @param {string} code הקוד שהבוט שלח לו
 */
export async function verifyOtp(phone, code) {
  const clean = String(code || '').replace(/\D/g, '');
  if (clean.length < 4 || clean.length > 8) {
    throw new ProviderError('BAD_CODE', 'הקוד לא תקין. הוא בן 4 עד 8 ספרות.');
  }

  // המשתמש קיבל את הקוד מהבוט של הספק. מציגים טלפון+קוד ומבקשים הרשאה.
  const data = await call(config.me.paths.verifyOtp, {
    body: { phone_number: normalizeMsisdn(phone), activation_code: clean }
  });

  const token = data?.access_token || data?.token || data?.jwt;
  if (!token) throw new ProviderError('ME_BAD_RESPONSE', 'האימות לא החזיר הרשאה. נסה שוב.');

  const expiresIn = Number(data?.expires_in);
  return {
    token: String(token),
    expiresAt: Date.now() + (Number.isFinite(expiresIn) ? expiresIn * 1000 : 15 * 60 * 1000)
  };
}

/**
 * מושך את רשימת מי ששמר את המספר של המשתמש.
 *
 * מקבל כל אחת מהצורות הנפוצות ומחזיר צורה אחת: [{ phone, name }].
 * @param {string} token
 * @returns {Promise<Array<{phone: string, name: string}>>}
 */
export async function fetchSavedMe(token) {
  const out = [];
  const seen = new Set();
  let cursor = null;
  let pages = 0;

  do {
    const path = cursor
      ? `${config.me.paths.savedMe}?cursor=${encodeURIComponent(cursor)}`
      : config.me.paths.savedMe;

    const data = await call(path, { method: 'GET', token });
    const list = data?.results || data?.contacts || data?.items || (Array.isArray(data) ? data : []);

    for (const row of Array.isArray(list) ? list : []) {
      const phone = normalizeMsisdn(row?.phone_number || row?.phone || row?.msisdn);
      if (!phone || seen.has(phone)) continue;
      seen.add(phone);

      const raw = row?.name || row?.display_name || row?.full_name || '';
      const name = typeof raw === 'string' && raw.trim().length <= 80 ? raw.trim() : '';

      out.push({ phone, name });
      if (out.length >= config.me.maxResults) return out;
    }

    cursor = data?.next_cursor || data?.nextCursor || null;
    pages += 1;
  } while (cursor && pages < config.me.maxPages);

  return out;
}

/** מבטל את ההרשאה בצד השירות. כישלון כאן לא מפיל כלום. */
export async function revoke(token) {
  if (!token || !config.me.paths.revoke) return;
  try {
    await call(config.me.paths.revoke, { token });
  } catch (err) {
    logger.debug({ err: err?.message }, 'me revoke failed');
  }
}

/** האם המסלול בכלל זמין כרגע */
export function isConfigured() {
  return Boolean(config.me.enabled && config.me.baseUrl);
}
