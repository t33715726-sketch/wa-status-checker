/* ============================================================
   ספר הטלפונים של המשתמש - נקרא ומעובד בדפדפן בלבד.
   הקובץ הזה לא עולה לשום שרת ולא נשמר בשום מקום.

   זה הלב של תיקון הבאג שהרס אנשי קשר בגרסה הראשונה:
   רק מספר שלא קיים בספר הטלפונים של המשתמש יכול להיכנס לקובץ הייצוא.
   ============================================================ */
(function () {
  'use strict';

  /**
   * מפתח השוואה למספר טלפון.
   *
   * אותו אדם מופיע בספר הטלפונים כ-050-123-4567 ובוואטסאפ כ-+972501234567.
   * מנרמלים את שניהם לאותה צורה: בלי קידומת מדינה ובלי אפס מוביל.
   */
  function phoneKeys(raw) {
    var digits = String(raw || '').replace(/\D/g, '');
    if (digits.length < 6) return [];

    var keys = [];
    var rest = digits;

    if (rest.indexOf('00') === 0) rest = rest.slice(2);
    if (rest.indexOf('972') === 0) rest = rest.slice(3);
    else if (rest.charAt(0) === '0') rest = rest.slice(1);

    if (rest.length >= 6) keys.push(rest);

    // מפתח גיבוי: 9 הספרות האחרונות. מרחיב את ההתאמה, ולכן מרחיב את
    // ההחרגה - וזה הכיוון הבטוח: עדיף לפספס מישהו מאשר לדרוס איש קשר.
    if (digits.length >= 9) {
      var tail = digits.slice(-9);
      if (keys.indexOf(tail) === -1) keys.push(tail);
    }
    return keys;
  }

  /** האם המספר הזה כבר קיים בספר הטלפונים */
  function isSaved(set, raw) {
    var keys = phoneKeys(raw);
    for (var i = 0; i < keys.length; i++) {
      if (set.has(keys[i])) return true;
    }
    return false;
  }

  /** מחלץ מספרים מקובץ vCard (‎.vcf) */
  function fromVcard(text) {
    var out = [];
    var re = /^TEL[^:\r\n]*:(.+)$/gim;
    var m;
    while ((m = re.exec(text)) !== null) out.push(m[1]);
    return out;
  }

  /** פיצול שורת CSV שמכבד מרכאות */
  function splitCsvLine(line) {
    var cells = [];
    var cur = '';
    var inQuotes = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line.charAt(i);
      if (ch === '"') {
        if (inQuotes && line.charAt(i + 1) === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        cells.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    cells.push(cur);
    return cells;
  }

  /** מחלץ מספרים מייצוא CSV של אנשי הקשר של גוגל */
  function fromCsv(text) {
    var lines = text.split(/\r?\n/).filter(function (l) { return l.trim(); });
    if (!lines.length) return [];

    var header = splitCsvLine(lines[0]);
    var cols = [];
    for (var i = 0; i < header.length; i++) {
      var h = header[i].toLowerCase();
      if (h.indexOf('phone') !== -1 || h.indexOf('טלפון') !== -1 || h.indexOf('tel') === 0) {
        cols.push(i);
      }
    }

    var out = [];
    for (var r = 1; r < lines.length; r++) {
      var cells = splitCsvLine(lines[r]);
      // בלי כותרת מזוהה: סורקים כל תא שנראה כמו מספר טלפון
      var scan = cols.length ? cols : cells.map(function (_, idx) { return idx; });
      for (var c = 0; c < scan.length; c++) {
        var val = cells[scan[c]];
        if (!val) continue;
        if (!cols.length && !/^[\s+\-()0-9]{7,25}$/.test(val)) continue;
        // גוגל מפרידה כמה מספרים באותו תא ב-":::"
        var parts = String(val).split(/:::|;/);
        for (var p = 0; p < parts.length; p++) out.push(parts[p]);
      }
    }
    return out;
  }

  /**
   * @param {string} text תוכן קובץ הייצוא
   * @returns {{set: Set<string>, numbers: number}}
   */
  function parseContactsFile(text) {
    var raw = text.indexOf('BEGIN:VCARD') !== -1 ? fromVcard(text) : fromCsv(text);
    var set = new Set();
    for (var i = 0; i < raw.length; i++) {
      var keys = phoneKeys(raw[i]);
      for (var k = 0; k < keys.length; k++) set.add(keys[k]);
    }
    return { set: set, numbers: raw.length };
  }

  /* ---------------- בניית קובץ vCard ---------------- */

  function esc(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/\\/g, '\\\\')
      .replace(/\r/g, '')
      .replace(/\n/g, '\\n')
      .replace(/,/g, '\\,')
      .replace(/;/g, '\\;');
  }

  /**
   * קיפול שורות ל-75 בתים כנדרש בתקן vCard, בלי לשבור תו רב-בתי.
   * שם בעברית הוא 2 בתים לתו, ולכן שם ארוך חוצה את הגבול בקלות -
   * וחלק מהמייבאים נחנקים על שורה ארוכה מדי.
   */
  function fold(line) {
    var enc = new TextEncoder();
    if (enc.encode(line).length <= 75) return line;

    var out = [];
    var chunk = '';
    var len = 0;
    var chars = Array.from(line);
    for (var i = 0; i < chars.length; i++) {
      var size = enc.encode(chars[i]).length;
      if (len + size > (out.length === 0 ? 75 : 74)) {
        out.push(chunk);
        chunk = '';
        len = 0;
      }
      chunk += chars[i];
      len += size;
    }
    if (chunk) out.push(chunk);
    return out.join('\r\n ');
  }

  function sanitizePrefix(prefix) {
    return String(prefix || '')
      .replace(/[\r\n\t]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 20);
  }

  /**
   * בונה קובץ אנשי קשר. שכבת הביטחון האחרונה: כל מספר נבדק שוב מול
   * ספר הטלפונים ממש לפני הכתיבה, כך שקובץ הייצוא לא יכול להכיל
   * מישהו שכבר שמור - ולכן ייבוא שלו לא יכול לדרוס שום איש קשר קיים.
   */
  function buildVcf(items, prefix, savedSet) {
    var p = sanitizePrefix(prefix);
    var lines = [];
    var skipped = 0;

    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var digits = String(item.phone || '').replace(/\D/g, '');
      if (!/^\d{6,20}$/.test(digits)) continue;

      if (savedSet && isSaved(savedSet, digits)) {
        skipped += 1;
        continue;
      }

      var base = item.pushName || item.display || '+' + digits;
      var name = p ? p + ' ' + base : base;

      lines.push('BEGIN:VCARD');
      lines.push('VERSION:3.0');
      lines.push(fold('N:;' + esc(name) + ';;;'));
      lines.push(fold('FN:' + esc(name)));
      lines.push(fold('TEL;TYPE=CELL:+' + digits));
      if (p) lines.push(fold('CATEGORIES:' + esc(p)));
      lines.push('END:VCARD');
    }

    return {
      // בלי BOM: אנשי הקשר של גוגל דורשים ש-BEGIN:VCARD יהיה התו הראשון
      text: lines.join('\r\n') + (lines.length ? '\r\n' : ''),
      cards: lines.filter(function (l) { return l === 'BEGIN:VCARD'; }).length,
      skipped: skipped
    };
  }

  window.ContactBook = {
    phoneKeys: phoneKeys,
    isSaved: isSaved,
    parseContactsFile: parseContactsFile,
    buildVcf: buildVcf,
    sanitizePrefix: sanitizePrefix
  };
})();
