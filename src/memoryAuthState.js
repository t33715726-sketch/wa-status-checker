import { initAuthCreds, proto } from 'baileys';

/**
 * מצב אימות של WhatsApp בזיכרון בלבד.
 *
 * זו נקודת האבטחה הקריטית של המערכת: פרטי ההתחברות של המשתמש
 * (מפתחות Signal, credentials של המכשיר המקושר) לעולם לא נוגעים בדיסק,
 * לא נכתבים ללוג ולא עוברים למסד נתונים. הם חיים באובייקט אחד בזיכרון
 * התהליך, ונמחקים ברגע שהסריקה הסתיימה.
 */
export function makeInMemoryAuthState() {
  const creds = initAuthCreds();
  /** @type {Record<string, Record<string, any>>} */
  let store = Object.create(null);

  const state = {
    creds,
    keys: {
      get: (type, ids) => {
        const data = {};
        const bucket = store[type];
        if (!bucket) return data;
        for (const id of ids) {
          let value = bucket[id];
          if (value !== undefined) {
            if (type === 'app-state-sync-key') {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }
        }
        return data;
      },
      set: (data) => {
        for (const type of Object.keys(data)) {
          if (!store[type]) store[type] = Object.create(null);
          const bucket = data[type];
          for (const id of Object.keys(bucket)) {
            const value = bucket[id];
            if (value) store[type][id] = value;
            else delete store[type][id];
          }
        }
      },
      clear: () => {
        store = Object.create(null);
      }
    }
  };

  /** מחיקה אגרסיבית: דריסת מפתחות לפני שחרור ההפניה */
  const wipe = () => {
    for (const type of Object.keys(store)) {
      for (const id of Object.keys(store[type])) store[type][id] = null;
      delete store[type];
    }
    store = Object.create(null);
    for (const k of Object.keys(creds)) {
      try {
        creds[k] = null;
      } catch {
        /* שדות לקריאה בלבד - מתעלמים */
      }
    }
  };

  return {
    state,
    saveCreds: async () => {
      /* אין לאן לשמור - המצב כבר בזיכרון. הפונקציה קיימת לתאימות API. */
    },
    wipe
  };
}
