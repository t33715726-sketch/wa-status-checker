import pino from 'pino';
import { config } from './config.js';

/**
 * לוגר יישומי. חוק ברזל: לא כותבים ללוג מספרי טלפון, JIDים, שמות אנשי קשר
 * או תוכן הודעות. הרדקציה כאן היא רשת ביטחון, לא תחליף לזהירות.
 */
export const logger = pino({
  level: config.logLevel,
  redact: {
    paths: [
      'phone', 'phoneNumber', 'jid', 'id', 'number', 'name', 'notify',
      'pushName', 'contacts', 'chats', 'creds', 'qr', 'pairingCode',
      '*.phone', '*.jid', '*.number', '*.name', '*.notify', '*.pushName'
    ],
    censor: '[redacted]'
  },
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime
});

/** לוגר שקט עבור Baileys - הספרייה מדפיסה מזהים רגישים ברמות debug/trace */
export const waLogger = pino({ level: 'silent' });
