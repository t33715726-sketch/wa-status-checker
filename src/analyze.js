/**
 * הלוגיקה של המוצר.
 *
 * הרעיון: פרטיות הסטטוס בוואטסאפ מוגדרת לרוב כ"אנשי הקשר שלי".
 * כלומר מי שרואה את הסטטוס שלך הוא מי שאתה שמרת ביומן שלך - לא מי ששמר אותך.
 * מכאן שכל אדם שמנהל איתך שיחה אישית ואינו שמור אצלך הוא בדיוק
 * הפער: הוא מכיר אותך, יש לו את המספר שלך, והוא לא רואה את הסטטוס שלך.
 *
 * מקורות המידע (כולם מגיעים מסנכרון וואטסאפ, בזיכרון בלבד):
 *  - contacts: לכל איש קשר יש name (השם מיומן הטלפון שלך) ו-notify (שם התצוגה שלו).
 *              קיום name פירושו ששמרת אותו. קיום notify בלבד פירושו שלא.
 *  - chats:    רשימת השיחות, כולל חותמת זמן אחרונה.
 *  - messages: משמש רק כדי לסמן "הוא כתב לך" = ודאות גבוהה.
 */

const PERSONAL_SUFFIX = '@s.whatsapp.net';
const IGNORED_SUFFIXES = ['@g.us', '@broadcast', '@newsletter', '@lid', '@bot'];

/** מוציא את החלק המספרי של ה-JID, בלי סיומות מכשיר (":12") */
export function jidUser(jid) {
  if (typeof jid !== 'string') return '';
  const at = jid.indexOf('@');
  const user = at === -1 ? jid : jid.slice(0, at);
  const colon = user.indexOf(':');
  return colon === -1 ? user : user.slice(0, colon);
}

export function normalizeJid(jid) {
  if (typeof jid !== 'string' || !jid.includes('@')) return '';
  const user = jidUser(jid);
  const domain = jid.slice(jid.indexOf('@'));
  if (!/^\d{6,20}$/.test(user)) return '';
  return `${user}${domain}`;
}

export function isPersonalJid(jid) {
  if (typeof jid !== 'string') return false;
  if (IGNORED_SUFFIXES.some((s) => jid.endsWith(s))) return false;
  return jid.endsWith(PERSONAL_SUFFIX) && /^\d{6,20}$/.test(jidUser(jid));
}

/** תצוגה ידידותית: מספרים ישראליים בפורמט מקומי, השאר בינלאומי */
export function formatPhone(digits) {
  if (!digits) return '';
  if (digits.startsWith('972') && digits.length === 12) {
    const local = `0${digits.slice(3)}`;
    return `${local.slice(0, 3)}-${local.slice(3, 6)}-${local.slice(6)}`;
  }
  if (digits.startsWith('972') && digits.length === 11) {
    const local = `0${digits.slice(3)}`;
    return `${local.slice(0, 2)}-${local.slice(2, 5)}-${local.slice(5)}`;
  }
  return `+${digits}`;
}

const cleanName = (v) => {
  if (typeof v !== 'string') return '';
  const t = v.trim();
  if (!t || t.length > 80) return '';
  return t;
};

/**
 * @param {object} input
 * @param {Map<string, object>} input.contacts  jid -> contact
 * @param {Map<string, object>} input.chats     jid -> chat
 * @param {Set<string>} input.incoming          jidים ששלחו לך הודעה
 * @param {string} input.meJid                  ה-JID שלך
 */
export function analyze({ contacts, chats, incoming, meJid }) {
  const me = jidUser(meJid || '');

  /** jidים ששמרת ביומן הטלפון */
  const saved = new Set();
  for (const [jid, c] of contacts) {
    if (cleanName(c?.name)) saved.add(jidUser(jid));
  }

  const seen = new Set();
  const results = [];

  const push = (jid, { source, lastAt }) => {
    const user = jidUser(jid);
    if (!user || user === me || seen.has(user)) return;
    if (saved.has(user)) return;
    seen.add(user);

    const contact = contacts.get(`${user}${PERSONAL_SUFFIX}`) || contacts.get(jid) || {};
    const pushName = cleanName(contact.notify) || cleanName(contact.verifiedName);
    const wroteToYou = incoming.has(user);

    results.push({
      user,
      phone: `+${user}`,
      display: formatPhone(user),
      pushName,
      business: Boolean(cleanName(contact.verifiedName)),
      wroteToYou,
      source,
      lastAt: lastAt || 0,
      confidence: source === 'chat' ? (wroteToYou ? 'high' : 'medium') : 'low'
    });
  };

  // 1. שיחות אישיות - הקבוצה הוודאית
  for (const [jid, chat] of chats) {
    if (!isPersonalJid(jid)) continue;
    const ts = Number(chat?.conversationTimestamp || chat?.lastMessageRecvTimestamp || 0);
    push(jid, { source: 'chat', lastAt: ts > 1e12 ? Math.floor(ts / 1000) : ts });
  }

  // 2. מי שכתב לך אבל השיחה לא הופיעה בסנכרון
  for (const user of incoming) {
    push(`${user}${PERSONAL_SUFFIX}`, { source: 'chat', lastAt: 0 });
  }

  // 3. מוכרים לוואטסאפ ולא שמורים - בדרך כלל מקבוצות משותפות. ודאות נמוכה.
  for (const [jid, c] of contacts) {
    if (!isPersonalJid(jid)) continue;
    if (!cleanName(c?.notify) && !cleanName(c?.verifiedName)) continue;
    push(jid, { source: 'contact', lastAt: 0 });
  }

  const rank = { high: 0, medium: 1, low: 2 };
  results.sort((a, b) => {
    if (rank[a.confidence] !== rank[b.confidence]) return rank[a.confidence] - rank[b.confidence];
    if (b.lastAt !== a.lastAt) return b.lastAt - a.lastAt;
    return a.user.localeCompare(b.user);
  });

  return {
    items: results,
    stats: {
      savedContacts: saved.size,
      knownContacts: contacts.size,
      chats: chats.size,
      chatGap: results.filter((r) => r.source === 'chat').length,
      groupGap: results.filter((r) => r.source === 'contact').length,
      total: results.length
    }
  };
}
