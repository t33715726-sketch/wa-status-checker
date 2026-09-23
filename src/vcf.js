/**
 * בניית קובץ אנשי קשר (vCard 3.0) לייבוא בטלפון.
 *
 * הערה חשובה למוצר: אי אפשר לכתוב ליומן הטלפון מהדפדפן.
 * לכן "הוספה בבת אחת" = קובץ vcf אחד עם כל האנשים שנבחרו,
 * שהמשתמש פותח בטלפון ומייבא בלחיצה. תחילית שם קבועה
 * (למשל "סטטוס") מאפשרת לו לאתר ולמחוק אותם בקלות אחר כך.
 */

const MAX_PREFIX = 20;

/** תו בריחה לפי RFC 6350 - מונע הזרקת שורות ושדות לתוך ה-vCard */
function esc(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

/** קיפול שורות ל-75 בתים, כנדרש בתקן, בלי לשבור תווים רב-בתיים */
function fold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const out = [];
  let chunk = '';
  let len = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (len + size > (out.length === 0 ? 75 : 74)) {
      out.push(chunk);
      chunk = '';
      len = 0;
    }
    chunk += ch;
    len += size;
  }
  if (chunk) out.push(chunk);
  return out.join('\r\n ');
}

export function sanitizePrefix(prefix) {
  if (typeof prefix !== 'string') return '';
  return prefix
    .replace(/[\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_PREFIX);
}

/**
 * @param {Array<{phone:string, display:string, pushName?:string}>} items
 * @param {string} prefix תחילית לשם, לזיהוי ומחיקה קלה בהמשך
 */
export function buildVcf(items, prefix = '') {
  const p = sanitizePrefix(prefix);
  const lines = [];

  for (const item of items) {
    const digits = String(item.phone || '').replace(/\D/g, '');
    if (!/^\d{6,20}$/.test(digits)) continue;

    const base = item.pushName || item.display || `+${digits}`;
    const name = p ? `${p} ${base}` : base;

    lines.push('BEGIN:VCARD');
    lines.push('VERSION:3.0');
    lines.push(fold(`N:;${esc(name)};;;`));
    lines.push(fold(`FN:${esc(name)}`));
    lines.push(fold(`TEL;TYPE=CELL:+${digits}`));
    lines.push(fold(`NOTE:${esc('נוסף אוטומטית כדי לראות את הסטטוס')}`));
    lines.push('END:VCARD');
  }

  // \r\n לפי התקן + BOM כדי שאנדרואיד/iOS יזהו עברית כ-UTF-8
  return `﻿${lines.join('\r\n')}${lines.length ? '\r\n' : ''}`;
}

export function vcfFilename() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `whatsapp-status-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.vcf`;
}
