import { config } from './config.js';
import { logger } from './logger.js';

/**
 * טלמטריה אנונימית, אופציונלית לחלוטין (STATS_ENABLED=false כברירת מחדל).
 *
 * נשלחות ספירות בלבד. לא מספרי טלפון, לא שמות, לא JIDים, לא IP.
 * אם השליחה נכשלת - שותקים. ניטור לעולם לא מפיל בקשה של משתמש.
 */
export function recordScan(stats) {
  if (!config.stats.enabled || !config.stats.url || !config.stats.key) return;

  const payload = {
    saved_contacts: Number(stats?.savedContacts) || 0,
    known_contacts: Number(stats?.knownContacts) || 0,
    chats: Number(stats?.chats) || 0,
    chat_gap: Number(stats?.chatGap) || 0,
    group_gap: Number(stats?.groupGap) || 0,
    total_gap: Number(stats?.total) || 0
  };

  const url = `${config.stats.url.replace(/\/+$/, '')}/rest/v1/${config.stats.table}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);

  fetch(url, {
    method: 'POST',
    signal: controller.signal,
    headers: {
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
      apikey: config.stats.key,
      Authorization: `Bearer ${config.stats.key}`
    },
    body: JSON.stringify(payload)
  })
    .catch((err) => logger.debug({ err: err?.message }, 'stats post failed'))
    .finally(() => clearTimeout(timer));
}
