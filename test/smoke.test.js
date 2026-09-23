import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { analyze, formatPhone, isPersonalJid, jidUser } from '../src/analyze.js';
import * as meProvider from '../src/providers/meProvider.js';

/* contacts.js הוא מודול דפדפן (IIFE שכותב ל-window). טוענים אותו כאן
   בתוך הקשר מבודד כדי לבדוק אותו בדיוק כפי שהוא רץ אצל המשתמש. */
const contactsSrc = fs.readFileSync(new URL('../public/contacts.js', import.meta.url), 'utf8');
const lpnSrc = fs.readFileSync(new URL('../public/vendor/libphonenumber.js', import.meta.url), 'utf8');
const sandbox = { TextEncoder };
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);
// הדף טוען את המנתח לפני contacts.js, וכך גם כאן
vm.runInContext(lpnSrc, sandbox);
vm.runInContext(contactsSrc, sandbox);
const { phoneKeys, isSaved, parseContactsFile, buildVcf, sanitizePrefix, unfold } = sandbox.window.ContactBook;

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

console.log('\nפרסור עמיד - הממצאים שאהרן מצא');
t('item1.TEL מאייפון/גוגל נקרא (תווית מותאמת)', () => {
  // הצורה הזו היא ייצוא רגיל של איש קשר עם תווית מותאמת.
  // רג'קס שדורש שורה שמתחילה ב-TEL מפספס אותה, והאדם הזה - שכבר
  // שמור - נכתב לקובץ ונדרס בייבוא. זה היה הבאג.
  const vcf = [
    'BEGIN:VCARD', 'VERSION:3.0', 'FN:אבא',
    'item1.TEL:+972501111111', 'item1.X-ABLabel:ווצאפ', 'END:VCARD'
  ].join('\r\n');
  const { set, numbers, telLines } = parseContactsFile(vcf);
  assert.equal(numbers, 1);
  assert.equal(telLines, 1, 'הספירה לאימות שלמות חייבת לראות את השורה');
  assert.equal(isSaved(set, '+972501111111'), true);
});

t('קובץ מעורב: TEL רגיל וגם item#.TEL', () => {
  const vcf = [
    'BEGIN:VCARD','VERSION:3.0','FN:א','TEL;TYPE=CELL:+972501111111','END:VCARD',
    'BEGIN:VCARD','VERSION:3.0','FN:ב','item1.TEL;type=pref:+972502222222','END:VCARD',
    'BEGIN:VCARD','VERSION:3.0','FN:ג','item2.TEL:050-333-3333','END:VCARD'
  ].join('\r\n');
  const { set, numbers, telLines } = parseContactsFile(vcf);
  assert.equal(telLines, 3);
  assert.equal(numbers, 3, 'כל השלושה, לא רק הראשון');
  ['+972501111111','+972502222222','+972503333333'].forEach((n) =>
    assert.equal(isSaved(set, n), true, n));
});

t('שלוחה מודבקת — המספר האמיתי הוא תחילית', () => {
  // "03-6123456-204": השלוחה נדבקת דרך מקף, מפריד לגיטימי לגמרי.
  // אי אפשר להבחין ברג'קס תווים - ההבדל מבני. מפתחות תחילית פותרים.
  [['03-6123456-204', '+97236123456'],
   ['03-6123456 204', '+97236123456'],
   ['050.123.4567.12', '+972501234567'],
   ['+1-646-207-6164-101', '+16462076164']].forEach(([inBook, fromWa]) => {
    const { set, unparsed } = parseContactsFile(
      `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:x\r\nTEL:${inBook}\r\nEND:VCARD`);
    assert.ok(isSaved(set, fromWa) || unparsed > 0, `${inBook} מול ${fromWa}`);
  });
});

t('שני מספרים בשדה אחד — שניהם מזוהים', () => {
  const { set } = parseContactsFile(
    'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:x\r\nTEL:+972-50-123-4567, +972-52-765-4321\r\nEND:VCARD');
  assert.equal(isSaved(set, '+972501234567'), true, 'הראשון');
  assert.equal(isSaved(set, '+972527654321'), true, 'השני');
});

t('vCard 4.0 עם tel: URI', () => {
  const { set, unparsed } = parseContactsFile(
    'BEGIN:VCARD\r\nVERSION:4.0\r\nFN:x\r\nTEL;VALUE=uri:tel:+972544938217\r\nEND:VCARD');
  assert.equal(unparsed, 0, 'ייצוא CardDAV תקין לא נחסם');
  assert.equal(isSaved(set, '+972544938217'), true);
});

t('CSV של גוגל ואאוטלוק לא נחסם בגלל מיקוד ותאריך', () => {
  // מיקוד (7 ספרות) ותאריך לידה נספרו קודם כשדות טלפון, המכנה
  // התנפח פי שלושה, והקובץ נחסם. זיהוי לפי תוכן עמודה פותר.
  const num = (i) => `+9725449${String(38217 + i).padStart(5, '0')}`;
  let g = 'Name,Birthday,Postal Code,Phone 1 - Value,E-mail 1 - Value\n';
  for (let i = 0; i < 30; i++) g += `איש${i},1980-12-05,672123${i % 10},${num(i)},a@b.com\n`;
  const r = parseContactsFile(g);
  assert.equal(r.unparsed, 0);
  assert.ok(r.numbers >= r.telLines * 0.95, `יחס ${r.numbers}/${r.telLines} — חסימת שווא`);
  assert.equal(isSaved(r.set, num(5)), true);
});

t('עמודת טלפון שלא מזוהה בכותרת נקראת לפי תוכן', () => {
  const num = (i) => `+9725449${String(38217 + i).padStart(5, '0')}`;
  let u = 'Name,Column X\n';
  for (let i = 0; i < 20; i++) u += `x,${num(i)}\n`;
  const r = parseContactsFile(u);
  assert.ok(r.numbers >= 20, 'העמודה נקראה למרות כותרת לא מוכרת');
  assert.equal(isSaved(r.set, num(3)), true);
});

t('מספר שני שנעלם בשדה — השער יורה', () => {
  // "050-123-4567 - 03-6123456": אחד נקרא, השני מתאדה בלי שאף
  // מונה יבחין. זו הדליפה שנשארה פתוחה אחרי ארבעה סבבים.
  const { unparsed, numbers } = parseContactsFile(
    'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:x\r\nTEL:050-123-4567 - 03-6123456\r\nEND:VCARD');
  assert.ok(unparsed > 0, `נמצאו ${numbers} מספרים והשאר נעלם בשקט`);
});

t('המנתח חייב להיות טעון — כשל סגור', () => {
  // בלי הספרייה הקוד היה נופל לניחוש לפי ספרות, בלי שום סימן
  const bare = { TextEncoder };
  bare.globalThis = bare;
  bare.window = bare;
  vm.createContext(bare);
  vm.runInContext(contactsSrc, bare);
  assert.throws(
    () => bare.window.ContactBook.parseContactsFile('BEGIN:VCARD\r\nTEL:050-123-4567\r\nEND:VCARD'),
    /PHONE_PARSER_MISSING/
  );
});

t('שלוחה והערה נקלפות ולא נבלעות למספר', () => {
  // "050-123-4567 x12" -> בלי קילוף הספרות 12 נדבקות ויוצרות מפתח שגוי
  [['050-123-4567 x12'], ['0501234567 ext. 5'], ['050-123-4567 (2)'],
   ['0501234567,,3'], ['050-123-4567/052-999-9999']].forEach(([raw]) => {
    const { set } = parseContactsFile(
      `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:x\r\nTEL:${raw}\r\nEND:VCARD`);
    assert.equal(isSaved(set, '+972501234567'), true, raw);
  });
});

t('מספר בינלאומי עם סוגריים לקידומת אזור', () => {
  // "+1 (646) 207-6164" הוא צורת ייצוא רגילה של גוגל ואייפון.
  // חיתוך בסוגר מוחק את כל המספר, והאיש הזה - שכבר שמור - נדרס.
  [['+1 (646) 207-6164', '+16462076164'],
   ['(646) 207-6164', '+16462076164'],
   ['+44 (0) 20 7946 0958', '+442079460958'],
   ['+1 (305) 555-0142', '+13055550142']].forEach(([inBook, fromWa]) => {
    const { set, unparsed } = parseContactsFile(
      `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:x\r\nTEL:${inBook}\r\nEND:VCARD`);
    assert.equal(unparsed, 0, `${inBook} חייב להניב מפתח`);
    assert.equal(isSaved(set, fromWa), true, `${inBook} מול ${fromWa}`);
  });
});

t('שדה עם 7+ ספרות תמיד מניב מפתח — assertion גורף', () => {
  // הרצפה המוחלטת. כל צורת ייצוא שנתקלנו בה, בבדיקה אחת.
  const forms = [
    '+972501234567', '050-123-4567', '+1 (646) 207-6164', '(02) 123-4567',
    '+44 (0) 20 7946 0958', '00972501234567', '972-50-123-4567',
    '050 123 4567', '03-9876543', '+41 44 668 18 00', '12 34 56 78',
    '050-123-4567 x12', '0501234567 ext. 5', '050-123-4567 (2)',
    '0501234567,,3', '+1-800-FLOWERS'.replace(/[A-Z]/g, '2')
  ];
  forms.forEach((f) => {
    const { unparsed } = parseContactsFile(
      `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:x\r\nTEL:${f}\r\nEND:VCARD`);
    assert.equal(unparsed, 0, `לא נקרא: ${f}`);
  });
});

t('פסיק בודד — תו ההשהיה של אייפון — נקלף', () => {
  // ",,3" טופל, "," בודד לא. אותו נזק בדיוק, בתו אחר.
  [['0501234567,,3', '+972501234567'],
   ['0501234567,3', '+972501234567'],
   ['+1-646-207-6164,3', '+16462076164'],
   ['050-1234567,1234', '+972501234567']].forEach(([inBook, fromWa]) => {
    const { set } = parseContactsFile(
      `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:x\r\nTEL:${inBook}\r\nEND:VCARD`);
    assert.equal(isSaved(set, fromWa), true, inBook);
  });
});

t('ספרות שאינן ASCII מנורמלות', () => {
  const { set, numbers } = parseContactsFile(
    'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:x\r\nTEL:\u0660\u0665\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\r\nEND:VCARD');
  assert.equal(numbers, 1, 'ספרות ערביות-הודיות הן מספר, לא זבל');
  assert.equal(isSaved(set, '+972501234567'), true);
});

t('תכונת הבטיחות: או שמזהים נכון, או שעוצרים', () => {
  // האינוריאנט היחיד שחשוב, וזה שנשבר בכל ארבעת הסבבים.
  // אסור מצב שלישי: להמשיך בשקט עם מפתח שגוי.
  const cases = [
    ['0501234567~3', '+972501234567'],
    ['0501234567 abc', '+972501234567'],
    ['050123456 7 &', '+972501234567'],
    ['0501234567\u2022', '+972501234567'],
    ['03-6123456-204', '+97236123456'],
    ['050.123.4567.12', '+972501234567'],
    ['0501234567 0501234568', '+972501234567'],
    ['+1-646-207-6164-101', '+16462076164'],
    ['0501234567,3', '+972501234567'],
    ['050-123-4567 (2)', '+972501234567'],
    ['\u202a+972-50-123-4567\u202c', '+972501234567']
  ];
  cases.forEach(([inBook, fromWa]) => {
    const { set, unparsed } = parseContactsFile(
      `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:x\r\nTEL:${inBook}\r\nEND:VCARD`);
    const matched = isSaved(set, fromWa);
    assert.ok(matched || unparsed > 0,
      `${inBook}: לא זוהה ולא נעצר — זו דריסה של איש קשר קיים`);
  });
});

t('השער לא יורה על ייצוא לגיטימי', () => {
  ['+972501234567', '050-123-4567', '+1 (646) 207-6164', '050-123-4567 x12',
   '0501234567,3', '1-800-FLOWERS', '100', '', '+41 44 668 18 00',
   // תווי בקרה דו-כיווניים: בלתי נראים, ומופיעים ב-411 מתוך 7,486
   // השדות בייצוא אמיתי של משתמש עברית
   '\u202a+972-50-123-4567\u202c', '\u200f050-123-4567'].forEach((ok) => {
    const { unparsed } = parseContactsFile(
      `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:x\r\nTEL:${ok}\r\nEND:VCARD`);
    assert.equal(unparsed, 0, `חסימת שווא על: ${ok}`);
  });
});

t('גם ל-CSV יש שער שלמות', () => {
  // המכנה נמדד לפי עמודות שזוהו כטלפון מהתוכן. שורה אחת לא מספיקה
  // לזיהוי עמודה, ולכן בודקים על קובץ בגודל אמיתי.
  const num = (i) => `+9725449${String(38217 + i).padStart(5, '0')}`;
  let csv = 'Name,Phone 1 - Value\n';
  for (let i = 0; i < 12; i++) csv += `דני${i},"${num(i)}"\n`;
  const { telLines } = parseContactsFile(csv);
  assert.ok(telLines > 0, 'בלי מונה שדות השער האחוזי מדולג ב-CSV');
});

t('מספר שירות קצר לא נספר ככשל פרסור', () => {
  const { unparsed, numbers } = parseContactsFile(
    'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:x\r\nTEL:100\r\nEND:VCARD');
  assert.equal(unparsed, 0, '*2800 ו-100 אינם כשל');
  assert.equal(numbers, 0);
});

t('מדינה עם מספר לאומי בן 8 ספרות', () => {
  // נורבגיה, הונג קונג: מפתח 9 הספרות לא נוצר, ולכן צריך מפתח 7
  const cases = [['12 34 56 78', '+4712345678'], ['9123 4567', '+85291234567']];
  cases.forEach(([inBook, fromWa]) => {
    const { set } = parseContactsFile(
      `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:x\r\nTEL:${inBook}\r\nEND:VCARD`);
    assert.equal(isSaved(set, fromWa), true, `${inBook} מול ${fromWa}`);
  });
});

t('שורה מקופלת נפרשת לפני הפרסור', () => {
  const vcf = 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:x\r\nTEL;TYPE=CELL:+97250\r\n 1234567\r\nEND:VCARD';
  assert.equal(unfold(vcf).includes('+972501234567'), true);
  const { set, numbers } = parseContactsFile(vcf);
  assert.equal(numbers, 1);
  assert.equal(isSaved(set, '+972501234567'), true, 'לא חצי מספר');
});

t('נתוני אימות שלמות מוחזרים לדף', () => {
  const vcf = [
    'BEGIN:VCARD','VERSION:3.0','FN:א','TEL:+972501111111','END:VCARD',
    'BEGIN:VCARD','VERSION:3.0','FN:ב','EMAIL:b@x.com','END:VCARD'
  ].join('\r\n');
  const r = parseContactsFile(vcf);
  assert.equal(r.cards, 2);
  assert.equal(r.telLines, 1, 'איש קשר בלי טלפון לא נספר כשדה טלפון');
  assert.equal(r.numbers, 1);
  // הדף חוסם כש-numbers < telLines * 0.95
  assert.ok(r.numbers >= r.telLines * 0.95);
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
