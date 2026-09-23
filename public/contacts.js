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
  /**
   * היכן נגמר המספר ומתחילה שלוחה או הערה.
   *
   * אותו תו אומר שני דברים שונים לפי מיקומו:
   *   "+1 (646) 207-6164"  - הסוגר הוא קידומת אזור, חלק מהמספר
   *   "050-123-4567 (2)"   - הסוגר הוא הערה אחרי מספר שלם
   *
   * לכן חותכים רק אחרי שכבר נאספו 7 ספרות, כלומר אחרי שיש מספר
   * שעומד בפני עצמו. חיתוך מוקדם מדי מוחק מספר בינלאומי שלם;
   * אי-חיתוך בולע את ספרות השלוחה למספר. שתי הטעויות מסתיימות
   * באותו מקום: איש קשר שמור שאינו מזוהה, ולכן נדרס בייבוא.
   *
   * @returns {number} אינדקס החיתוך, או ‎-1 אם אין
   */
  function extensionStart(value) {
    var digits = 0;
    for (var i = 0; i < value.length; i++) {
      var ch = value.charAt(i);
      if (ch >= '0' && ch <= '9') { digits += 1; continue; }
      if (digits < 7) continue;

      if (ch === ';' || ch === '#' || ch === '|' || ch === '(' || ch === ',') return i;
      if ((ch === 'x' || ch === 'X') && /^\s*\d/.test(value.slice(i + 1))) return i;
      if ((ch === 'e' || ch === 'E') && /^xt\.?\s*\d/i.test(value.slice(i + 1))) return i;
    }
    return -1;
  }

  /**
   * ספרות שאינן ASCII (ערביות-הודיות, דוואנגרי, פרסיות) ל-ASCII.
   * בלי זה `\D` מוחק אותן, השדה מחזיר אפס ספרות, והאדם נחשב
   * ללא-שמור - כלומר נכתב לקובץ ונדרס.
   */
  function asciiDigits(value) {
    return String(value).replace(/[\u0660-\u0669\u06f0-\u06f9\u0966-\u096f]/g, function (d) {
      var c = d.charCodeAt(0);
      var base = c >= 0x0966 ? 0x0966 : c >= 0x06f0 ? 0x06f0 : 0x0660;
      return String(c - base);
    });
  }

  /**
   * התווים הלגיטימיים במספר טלפון: ספרות ומפרידי תצוגה בלבד.
   *
   * כולל את תווי הבקרה הדו-כיווניים (U+200E/200F, U+202A-202E,
   * U+2066-2069). הם בלתי נראים, מערכות עבריות וערביות עוטפות בהם
   * מספרים כדי שיוצגו משמאל לימין, והם מופיעים ב-411 מתוך 7,486
   * השדות בייצוא אמיתי. הם לא חלק מהמספר אבל גם לא סימן לתקלה.
   */
  var PHONE_CHARS = /^[+0-9\s()\-.\u00a0\u200e\u200f\u202a-\u202e\u2066-\u2069]*$/;

  function phoneKeys(raw) {
    var value = asciiDigits(String(raw || ''));

    var cut = extensionStart(value);
    if (cut > 0) value = value.slice(0, cut);

    var digits = value.replace(/\D/g, '');
    if (digits.length < 6) return [];

    var keys = [];
    var rest = digits;

    if (rest.indexOf('00') === 0) rest = rest.slice(2);
    if (rest.indexOf('972') === 0) rest = rest.slice(3);
    else if (rest.charAt(0) === '0') rest = rest.slice(1);

    if (rest.length >= 6) keys.push(rest);

    // מפתחות גיבוי: 9 ו-7 הספרות האחרונות.
    //
    // 9 מכסה מספר ישראלי שנשמר בלי קידומת מול מספר בינלאומי מוואטסאפ.
    // 7 מכסה מדינות עם מספר לאומי בן 8 ספרות - נורבגיה, דנמרק, הונג קונג,
    // סינגפור - שבהן מפתח 9 לא נוצר כלל.
    //
    // זה מרחיב את ההתאמה ולכן מרחיב את ההחרגה. הכיוון הזה הוא הבטוח:
    // התאמת שווא אומרת שמישהו לא ייכנס לקובץ, והחמצה אומרת שאיש קשר
    // קיים נדרס. הסיכון להתנגשות אקראית על 7 ספרות בספר של 7000 מספרים
    // הוא פחות מעשירית האחוז.
    [9, 7].forEach(function (n) {
      if (digits.length >= n) {
        var tail = digits.slice(-n);
        if (keys.indexOf(tail) === -1) keys.push(tail);
      }
    });
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

  /**
   * כל השורות שהן שדה טלפון ב-vCard.
   *
   * חייב לכלול את צורת ה-property המקובץ: אייפון וגוגל מייצאים איש קשר
   * עם תווית מותאמת ("ווצאפ", "אבא") כ-`item1.TEL:...` עם `item1.X-ABLabel`
   * בשורה אחריה. רג'קס שדורש שורה שמתחילה ב-TEL מפספס אותם לגמרי -
   * והאנשים האלה, שכבר שמורים, נכתבים לקובץ ונדרסים בייבוא.
   */
  var TEL_LINE = /^(?:[A-Za-z0-9-]+\.)?TEL[^:\r\n]*:(.+)$/gim;

  /** פרישת שורות מקופלות לפי תקן vCard, לפני כל פרסור */
  function unfold(text) {
    return String(text || '').replace(/\r?\n[ \t]/g, '');
  }

  /** מחלץ מספרים מקובץ vCard (‎.vcf) */
  function fromVcard(text) {
    var out = [];
    var m;
    TEL_LINE.lastIndex = 0;
    while ((m = TEL_LINE.exec(text)) !== null) {
      // שדה אחד עשוי להחזיק כמה מספרים
      var parts = m[1].split(/:::|\//);
      for (var i = 0; i < parts.length; i++) {
        // הנרמול לפני הספירה: ספרות שאינן ASCII נמחקות על ידי \D
        if (asciiDigits(parts[i]).replace(/\D/g, '').length >= 6) out.push(parts[i]);
      }
    }
    return out;
  }

  /** כמה שורות טלפון יש בקובץ - לאימות שהפרסור לא פספס */
  function countTelLines(text) {
    TEL_LINE.lastIndex = 0;
    var n = 0;
    while (TEL_LINE.exec(text) !== null) n += 1;
    return n;
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
        if (!cols.length && !/^[\s+\-()0-9]{7,25}$/.test(asciiDigits(val))) continue;
        // גוגל מפרידה כמה מספרים באותו תא ב-":::"
        var parts = String(val).split(/:::|;|\//);
        for (var p = 0; p < parts.length; p++) out.push(parts[p]);
      }
    }
    return out;
  }

  /**
   * האם הבנו את השדה במלואו.
   *
   * מצב הכשל שהפיל אותנו פעמיים אינו "לא הופק מפתח" אלא "הופק מפתח
   * שגוי": תו לא צפוי בתוך המספר מזיז את הספרות, המפתח לא תואם,
   * והאדם - ששמור אצל המשתמש - נכתב לקובץ ונדרס. שער שסופר שדות
   * בלי מפתח עיוור לזה לגמרי.
   *
   * לכן בודקים את מה שנשמר אחרי קילוף השלוחה: אם נשאר בו תו שאינו
   * ספרה או מפריד תצוגה, לא הבנו את השדה ואסור להמשיך.
   *
   * שדה עם פחות מ-6 ספרות אינו מספר (מספר שירות, "1-800-FLOWERS",
   * תא ריק) ואינו נספר ככשל.
   */
  function understood(raw) {
    var value = asciiDigits(String(raw || ''));
    if (value.replace(/\D/g, '').length < 6) return true;
    var cut = extensionStart(value);
    var kept = cut > 0 ? value.slice(0, cut) : value;
    return PHONE_CHARS.test(kept);
  }

  /**
   * @param {string} text תוכן קובץ הייצוא
   * @returns {{set: Set<string>, numbers: number, unparsed: number, telLines: number, cards: number}}
   */
  function parseContactsFile(text) {
    var body = unfold(text);
    var isVcard = body.indexOf('BEGIN:VCARD') !== -1;
    var raw = isVcard ? fromVcard(body) : fromCsv(body);

    var set = new Set();
    var withKeys = 0;
    var unparsed = 0;

    for (var i = 0; i < raw.length; i++) {
      var keys = phoneKeys(raw[i]);
      if (keys.length) {
        withKeys += 1;
        for (var k = 0; k < keys.length; k++) set.add(keys[k]);
      }
      if (!understood(raw[i])) unparsed += 1;
    }

    return {
      set: set,
      numbers: withKeys,
      // נתוני אימות. שער באחוזים לבדו לא מספיק: פגם שנוגע ב-0.1%
      // מהשורות עובר אותו ברווח, ושמונה אנשים נדרסים בשקט. לכן
      // `unparsed` הוא רצפה מוחלטת - אפילו שדה אחד כזה הוא עצירה.
      unparsed: unparsed,
      // גם ל-CSV יש שער: בלי מונה שדות השער האחוזי מדולג לגמרי
      telLines: isVcard ? countTelLines(body) : raw.length,
      cards: isVcard ? (body.match(/BEGIN:VCARD/g) || []).length : 0
    };
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
    unfold: unfold,
    understood: understood,
    isSaved: isSaved,
    parseContactsFile: parseContactsFile,
    buildVcf: buildVcf,
    sanitizePrefix: sanitizePrefix
  };
})();
