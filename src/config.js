/**
 * הגדרות מרכזיות. כל ערך ניתן לדריסה במשתני סביבה.
 * אין כאן סודות - רק פרמטרים תפעוליים.
 */

const int = (v, d) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};

const bool = (v, d) => {
  if (v === undefined || v === null || v === '') return d;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};

export const config = {
  env: process.env.NODE_ENV || 'production',
  port: int(process.env.PORT, 8080),

  // Railway/פרוקסי: מספר שכבות הפרוקסי שסומכים עליהן לצורך זיהוי IP
  trustProxy: int(process.env.TRUST_PROXY, 1),

  session: {
    // כמה זמן סשן חי בלי פעילות לפני מחיקה מוחלטת מהזיכרון
    idleTtlMs: int(process.env.SESSION_IDLE_TTL_MS, 10 * 60 * 1000),
    // תקרה קשיחה לחיי סשן
    hardTtlMs: int(process.env.SESSION_HARD_TTL_MS, 20 * 60 * 1000),
    // תקרת סשנים מקבילים בשרת - הגנה מפני מיצוי זיכרון
    maxConcurrent: int(process.env.MAX_CONCURRENT_SESSIONS, 40),
    // כמה זמן מחכים לסריקת ה-QR לפני ויתור
    qrWaitMs: int(process.env.QR_WAIT_MS, 3 * 60 * 1000),
    // כמה זמן מחכים שוואטסאפ בכלל יחזיר קוד (בעיית רשת בצד השרת)
    handshakeMs: int(process.env.HANDSHAKE_MS, 25 * 1000)
  },

  sync: {
    // סנכרון היסטוריה מלאה - איטי ויקר בזיכרון. ברירת מחדל: כבוי
    fullHistory: bool(process.env.WA_FULL_HISTORY, false),
    // תקרת זמן לסנכרון אחרי חיבור מוצלח
    timeoutMs: int(process.env.SYNC_TIMEOUT_MS, 90 * 1000),
    // כמה זמן בלי אירוע חדש נחשב "הסתיים"
    quietMs: int(process.env.SYNC_QUIET_MS, 9 * 1000),
    // מינימום זמן סנכרון לפני שמותר לסיים בשקט
    minMs: int(process.env.SYNC_MIN_MS, 6 * 1000)
  },

  limits: {
    // יצירת סשנים לכל IP
    startWindowMs: int(process.env.START_WINDOW_MS, 15 * 60 * 1000),
    startMax: int(process.env.START_MAX, 12),
    // בקשות API כלליות
    apiWindowMs: int(process.env.API_WINDOW_MS, 60 * 1000),
    apiMax: int(process.env.API_MAX, 60),
    // תקרת אנשי קשר בייצוא אחד
    maxExport: int(process.env.MAX_EXPORT, 3000)
  },

  // טלמטריה אנונימית (ספירות בלבד, בלי מספרים ובלי שמות). כבוי כברירת מחדל.
  stats: {
    enabled: bool(process.env.STATS_ENABLED, false),
    url: process.env.SUPABASE_URL || '',
    key: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    table: process.env.STATS_TABLE || 'scan_events'
  },

  logLevel: process.env.LOG_LEVEL || 'info'
};
