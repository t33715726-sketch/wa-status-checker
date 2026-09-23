import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { analyze, formatPhone, isPersonalJid, jidUser } from '../src/analyze.js';
import * as meProvider from '../src/providers/meProvider.js';

/* contacts.js הוא מודול דפדפן (IIFE שכותב ל-window). טוענים אותו כאן
   בתוך הקשר מבודד כדי לבדוק אותו בדיוק כפי שהוא רץ אצל המשתמש. */
const contactsSrc = fs.readFileSync(new URL('../public/contacts.js', import.meta.url), 'utf8');
const sandbox = { window: {}, TextEncoder };
vm.createContext(sandbox);
vm.runInContext(contactsSrc, sandbox);
const { phoneKeys, isSaved, parseContactsFile, buildVcf, sanitizePrefix } = sandbox.window.ContactBook;

/** בונה ספר טלפונים מרשימת מספרים */
const book = (numbers) => parseContactsFile(
  numbers.map((n) => `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:x\r\nTEL;TYPE=CELL:${n}\r\nEND:VCARD`).join('\r\n')
).set;

let pass = 0;
const t = (name, fn) => {
  fn();
  pass += 1;
  console.log(`  ✓ ${name}`);
};

/** גרסה אסינכרונית, לבדיקות שנוגעות בספק */
const ta = async (name, fn) => {
  await fn();
  pass += 1;
  console.log(`  ✓ ${name}`);
};

console.log('\nJID');
t('jidUser מנקה סיומת מכשיר', () => {
  assert.equal(jidUser('972501234567:12@s.whatsapp.net'), '972501234567');
});
t('קבוצות ורשימות תפוצה נפסלות', () => {
  assert.equal(isPersonalJid('123-456@g.us'), false);
  assert.equal(isPersonalJid('status@broadcast'), false);
  assert.equal(isPersonalJid('99999@lid'), false);
  assert.equal(isPersonalJid('972501234567@s.whatsapp.net'), true);
});

console.log('\nתצוגת מספר');
t('מספר ישראלי מוצג מקומית', () => {
  assert.equal(formatPhone('972501234567'), '050-123-4567');
});
t('מספר זר נשאר בינלאומי', () => {
  assert.equal(formatPhone('447700900123'), '+447700900123');
});

console.log('\nאנליזה');
t('שמור אצלך = לא ברשימה, לא שמור = ברשימה', () => {
  const contacts = new Map([
    ['972501111111@s.whatsapp.net', { id: '972501111111@s.whatsapp.net', name: 'אבא' }],
    ['972502222222@s.whatsapp.net', { id: '972502222222@s.whatsapp.net', notify: 'דני' }],
    ['972503333333@s.whatsapp.net', { id: '972503333333@s.whatsapp.net', notify: 'רינה' }]
  ]);
  const chats = new Map([
    ['972501111111@s.whatsapp.net', { id: '972501111111@s.whatsapp.net', conversationTimestamp: 100 }],
    ['972502222222@s.whatsapp.net', { id: '972502222222@s.whatsapp.net', conversationTimestamp: 200 }]
  ]);
  const incoming = new Set(['972502222222']);
  const { items, stats } = analyze({
    contacts,
    chats,
    incoming,
    meJid: '972509999999:3@s.whatsapp.net'
  });

  assert.equal(stats.savedContacts, 1);
  assert.equal(items.length, 2, 'דני מהשיחה + רינה מקבוצה');
  assert.equal(items[0].user, '972502222222');
  assert.equal(items[0].confidence, 'high');
  assert.equal(items[0].source, 'chat');
  assert.equal(items[1].source, 'contact');
  assert.equal(items[1].confidence, 'low');
});

t('המספר שלך אף פעם לא ברשימה', () => {
  const me = '972509999999';
  const contacts = new Map([[`${me}@s.whatsapp.net`, { id: `${me}@s.whatsapp.net`, notify: 'אני' }]]);
  const chats = new Map([[`${me}@s.whatsapp.net`, { id: `${me}@s.whatsapp.net` }]]);
  const { items } = analyze({ contacts, chats, incoming: new Set(), meJid: `${me}:5@s.whatsapp.net` });
  assert.equal(items.length, 0);
});

t('אין כפילויות', () => {
  const jid = '972504444444@s.whatsapp.net';
  const contacts = new Map([[jid, { id: jid, notify: 'כפול' }]]);
  const chats = new Map([[jid, { id: jid, conversationTimestamp: 5 }]]);
  const { items } = analyze({ contacts, chats, incoming: new Set(['972504444444']), meJid: '1@s.whatsapp.net' });
  assert.equal(items.length, 1);
});

console.log('\nנרמול מספרים');
t('אותו אדם בשתי צורות = אותו מפתח', () => {
  const a = phoneKeys('050-123-4567');
  const b = phoneKeys('+972 50 123 4567');
  assert.ok(a.some((k) => b.includes(k)), 'חייבת להיות חפיפה בין הצורה המקומית לבינלאומית');
});
t('מספר קצר מדי נזרק', () => {
  // המערכים נוצרים בהקשר ה-vm, ולכן משווים אורך ולא זהות מבנה
  assert.equal(phoneKeys('12345').length, 0);
  assert.equal(phoneKeys('').length, 0);
  assert.equal(phoneKeys(null).length, 0);
});
t('isSaved מזהה חוצה-פורמטים', () => {
  const set = book(['050-123-4567']);
  assert.equal(isSaved(set, '+972501234567'), true);
  assert.equal(isSaved(set, '972501234567'), true);
  assert.equal(isSaved(set, '+972509999999'), false);
});

console.log('\nקריאת ספר הטלפונים');
t('קריאת vCard', () => {
  const vcf = [
    'BEGIN:VCARD', 'VERSION:3.0', 'FN:אבא',
    'TEL;TYPE=CELL:+972501111111', 'END:VCARD',
    'BEGIN:VCARD', 'VERSION:3.0', 'FN:אמא',
    'TEL;TYPE=CELL:050-222-2222', 'END:VCARD'
  ].join('\r\n');
  const { set, numbers } = parseContactsFile(vcf);
  assert.equal(numbers, 2);
  assert.equal(isSaved(set, '+972501111111'), true);
  assert.equal(isSaved(set, '+972502222222'), true);
});

t('קריאת CSV של גוגל, כולל כמה מספרים בתא אחד', () => {
  const csv = [
    'Name,Phone 1 - Type,Phone 1 - Value',
    'אבא,Mobile,+972501111111',
    '"כהן, דוד",Mobile,050-222-2222 ::: 03-9999999'
  ].join('\n');
  const { set } = parseContactsFile(csv);
  assert.equal(isSaved(set, '+972501111111'), true);
  assert.equal(isSaved(set, '+972502222222'), true);
  assert.equal(isSaved(set, '+97239999999'), true);
});

t('קובץ בלי מספרים מחזיר קבוצה ריקה', () => {
  // הדף חוסם המשך במצב הזה. קבוצת "שמורים" ריקה היא בדיוק התקלה
  // שגרמה לכל אנשי הקשר להיחשב לא-שמורים בגרסה הראשונה.
  const { set } = parseContactsFile('שלום, זה לא קובץ אנשי קשר');
  assert.equal(set.size, 0);
});

console.log('\nvCard לייצוא');
t('מספר שכבר שמור לא נכנס לקובץ', () => {
  const saved = book(['050-111-1111']);
  const out = buildVcf(
    [
      { phone: '+972501111111', display: '050-111-1111', pushName: 'אבא' },
      { phone: '+972502222222', display: '050-222-2222', pushName: 'דני' }
    ],
    'סטטוס',
    saved
  );
  assert.equal(out.cards, 1, 'רק דני נכנס');
  assert.equal(out.skipped, 1, 'אבא נזרק כי הוא כבר שמור');
  assert.equal(out.text.includes('+972501111111'), false, 'מספר שמור אסור שיופיע בקובץ');
  assert.match(out.text, /TEL;TYPE=CELL:\+972502222222/);
});

t('ספר טלפונים שמכיל את כולם מייצר קובץ ריק', () => {
  const saved = book(['+972501111111', '+972502222222']);
  const out = buildVcf(
    [
      { phone: '+972501111111', display: 'x' },
      { phone: '+972502222222', display: 'y' }
    ],
    '',
    saved
  );
  assert.equal(out.cards, 0);
  assert.equal(out.text, '');
});

t('נבנה vCard תקין עם תחילית', () => {
  const out = buildVcf(
    [{ phone: '+972501234567', display: '050-123-4567', pushName: 'דני' }],
    'סטטוס',
    book(['050-999-9999'])
  );
  assert.match(out.text, /BEGIN:VCARD/);
  assert.match(out.text, /VERSION:3\.0/);
  assert.match(out.text, /FN:סטטוס דני/);
  assert.match(out.text, /TEL;TYPE=CELL:\+972501234567/);
  assert.match(out.text, /END:VCARD/);
  // בלי BOM: אנשי הקשר של גוגל נכשלים בייבוא אם BEGIN:VCARD אינו התו הראשון
  assert.notEqual(out.text.charCodeAt(0), 0xfeff, 'אסור BOM');
  assert.ok(out.text.startsWith('BEGIN:VCARD'), 'הקובץ מתחיל ישירות ב-BEGIN:VCARD');
  assert.match(out.text, /^CATEGORIES:סטטוס\r$/m, 'תווית קבוצתית לסינון ומחיקה');
});

t('הזרקת שורות לא אפשרית', () => {
  const evil = 'דני\r\nEND:VCARD\r\nBEGIN:VCARD\r\nFN:פישינג';
  const out = buildVcf([{ phone: '+972501234567', display: 'x', pushName: evil }], '', new Set());
  // רק שורה שמתחילה ב-BEGIN/END היא הוראה אמיתית. טקסט מוברח הוא רק טקסט.
  assert.equal((out.text.match(/^BEGIN:VCARD\r$/gm) || []).length, 1);
  assert.equal((out.text.match(/^END:VCARD\r$/gm) || []).length, 1);
  const unfolded = out.text.replace(/\r\n /g, '');
  assert.match(unfolded, /FN:דני\\nEND:VCARD\\nBEGIN:VCARD\\nFN:פישינג/);
});

t('שורה ארוכה מקופלת לפי התקן', () => {
  const long = 'א'.repeat(60);
  const out = buildVcf([{ phone: '+972501234567', display: 'x', pushName: long }], '', new Set());
  const lines = out.text.split('\r\n');
  for (const line of lines) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 76, `שורה ארוכה מדי: ${line.length}`);
  }
  assert.ok(out.text.replace(/\r\n /g, '').includes(`FN:${long}`), 'הפרישה מחזירה את השם המלא');
});

t('מספר לא תקין נזרק', () => {
  const out = buildVcf([{ phone: 'not-a-number', display: 'x' }], '', new Set());
  assert.equal(out.cards, 0);
  assert.equal(out.text.includes('BEGIN:VCARD'), false);
});

t('תחילית מנוקה ומוגבלת באורך', () => {
  assert.equal(sanitizePrefix('  a\nb  '), 'a b');
  assert.equal(sanitizePrefix('x'.repeat(50)).length, 20);
});

console.log('\nמסלול Me');
t('נרמול מספר לצורה בינלאומית', () => {
  assert.equal(meProvider.normalizeMsisdn('050-123-4567'), '972501234567');
  assert.equal(meProvider.normalizeMsisdn('+972 50 123 4567'), '972501234567');
  assert.equal(meProvider.normalizeMsisdn('00972501234567'), '972501234567');
  assert.equal(meProvider.normalizeMsisdn('123'), '');
  assert.equal(meProvider.normalizeMsisdn(''), '');
});

t('המסלול כבוי כברירת מחדל', () => {
  // בלי ME_ENABLED ו-ME_API_BASE הדף לא מציע את המסלול בכלל
  assert.equal(meProvider.isConfigured(), false);
});

await ta('בלי הגדרה הספק נכשל בקוד ברור ולא בשקט', async () => {
  await assert.rejects(
    () => meProvider.requestOtp('0501234567'),
    (err) => err.code === 'ME_NOT_CONFIGURED'
  );
  await assert.rejects(
    () => meProvider.fetchSavedMe('tok'),
    (err) => err.code === 'ME_NOT_CONFIGURED'
  );
});

await ta('מספר לא תקין נעצר לפני שיוצאת בקשה', async () => {
  await assert.rejects(() => meProvider.requestOtp('12'), (err) => err.code === 'BAD_PHONE');
});

console.log(`\n${pass} בדיקות עברו\n`);
