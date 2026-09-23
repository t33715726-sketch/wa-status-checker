import assert from 'node:assert/strict';
import { analyze, formatPhone, isPersonalJid, jidUser } from '../src/analyze.js';
import { buildVcf, sanitizePrefix } from '../src/vcf.js';

let pass = 0;
const t = (name, fn) => {
  fn();
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

console.log('\nvCard');
t('נבנה vCard תקין עם תחילית', () => {
  const vcf = buildVcf([{ phone: '+972501234567', display: '050-123-4567', pushName: 'דני' }], 'סטטוס');
  assert.match(vcf, /BEGIN:VCARD/);
  assert.match(vcf, /VERSION:3\.0/);
  assert.match(vcf, /FN:סטטוס דני/);
  assert.match(vcf, /TEL;TYPE=CELL:\+972501234567/);
  assert.match(vcf, /END:VCARD/);
  assert.equal(vcf.charCodeAt(0), 0xfeff, 'BOM לתמיכה בעברית');
});

t('הזרקת שורות לא אפשרית', () => {
  const evil = 'דני\r\nEND:VCARD\r\nBEGIN:VCARD\r\nFN:פישינג';
  const vcf = buildVcf([{ phone: '+972501234567', display: 'x', pushName: evil }], '');
  // רק שורה שמתחילה ב-BEGIN/END היא הוראה אמיתית. טקסט מוברח הוא רק טקסט.
  assert.equal((vcf.match(/^﻿?BEGIN:VCARD\r$/gm) || []).length, 1);
  assert.equal((vcf.match(/^END:VCARD\r$/gm) || []).length, 1);
  const unfolded = vcf.replace(/\r\n /g, '');
  assert.match(unfolded, /FN:דני\\nEND:VCARD\\nBEGIN:VCARD\\nFN:פישינג/);
});

t('מספר לא תקין נזרק', () => {
  const vcf = buildVcf([{ phone: 'not-a-number', display: 'x' }], '');
  assert.equal(vcf.includes('BEGIN:VCARD'), false);
});

t('תחילית מנוקה ומוגבלת באורך', () => {
  assert.equal(sanitizePrefix('  a\nb  '), 'a b');
  assert.equal(sanitizePrefix('x'.repeat(50)).length, 20);
});

console.log(`\n${pass} בדיקות עברו\n`);
