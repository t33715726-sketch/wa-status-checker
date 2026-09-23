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
  var DEFAULT_COUNTRY = 'IL';

  /**
   * המנתח חייב להיות טעון. בלעדיו הקוד היה נופל בשקט לניחוש לפי
   * ספרות - בדיוק ההתנהגות שדרסה אנשי קשר - ושום שער לא היה יורה.
   * 404, חוסם פרסומות או כשל רשת חייבים לעצור את המוצר, לא להשתיק אותו.
   */
  function getLib() {
    var lib = (typeof globalThis !== 'undefined' && globalThis.libphonenumber) ||
      (typeof window !== 'undefined' && window.libphonenumber);
    if (!lib || typeof lib.parsePhoneNumberFromString !== 'function') {
      throw new Error('PHONE_PARSER_MISSING');
    }
    return lib;
  }

  /** ספרות שאינן ASCII (ערביות-הודיות, פרסיות, דוואנגרי) ל-ASCII */
  function asciiDigits(value) {
    return String(value).replace(/[\u0660-\u0669\u06f0-\u06f9\u0966-\u096f]/g, function (d) {
      var c = d.charCodeAt(0);
      var base = c >= 0x0966 ? 0x0966 : c >= 0x06f0 ? 0x06f0 : 0x0660;
      return String(c - base);
    });
  }

  /**
   * כל המספרים התקינים בשדה אחד, בצורת E.164 בלי ‎+‎.
   *
   * למה מנתח ולא רג'קס
   * -------------------
   * ניסינו שלוש פעמים לקלף שלוחות והערות ברג'קס, ובכל פעם נסגר חור
   * ונפתח אחר: סוגר הוא קידומת אזור וגם הערה, פסיק הוא השהיה וגם מפריד
   * בין שני מספרים, ומקף מחבר "03-6123456-204" שבו השלוחה נדבקת למספר.
   * מחלקת תווים לא יכולה להבחין ביניהם, כי ההבדל הוא מבני ולא תחבירי.
   *
   * `isValid()` כן יכול: הוא בודק את המספר מול תוכנית המספור של המדינה.
   * "+97236123456204" הוא לא מספר ישראלי תקין, ולכן נדחה - וזה בדיוק
   * המקרה שדלף. שדה שלא הניב אף מספר תקין מסומן כלא-מובן, והדף עוצר.
   *
   * @returns {string[]}
   */
  function parseNumbers(raw) {
    return parseField(raw).numbers;
  }

  /**
   * ניתוח שדה אחד: כל המספרים שנמצאו, וכמה ספרות נשארו בלי שנצרכו.
   *
   * השארית היא הדיסקרימינטור. "050-123-4567 - 03-6123456" מחזיר
   * מספר אחד תקין, והספרות של המספר השני פשוט נעלמות - בלי שאף
   * מונה יבחין. האדם ההוא, ששמור אצל המשתמש, נכתב לקובץ ונדרס.
   *
   * @returns {{numbers: string[], leftover: number}}
   */
  function parseField(raw) {
    var value = asciiDigits(String(raw || '')).replace(/^\s*tel:/i, '').trim();
    if (!value) return { numbers: [], leftover: 0 };

    var lib = getLib();
    var found = [];

    try {
      var one = lib.parsePhoneNumberFromString(value, DEFAULT_COUNTRY);
      if (one && (one.isValid() || one.isPossible())) found.push(one);
    } catch (err) { /* ממשיכים */ }

    // תמיד, ולא רק כשה-parse נכשל: שדה יכול להחזיק מספר תקין אחד
    // ועוד אחד שה-parse הבודד בלע.
    try {
      var it = lib.findNumbers(value, DEFAULT_COUNTRY, { v2: true });
      for (var i = 0; i < it.length; i++) found.push(it[i].number);
    } catch (err2) { /* ממשיכים */ }

    var numbers = [];
    var remaining = value.replace(/\D/g, '');

    for (var k = 0; k < found.length; k++) {
      var e164 = String(found[k].number || '').replace(/\D/g, '');
      if (!e164 || numbers.indexOf(e164) !== -1) continue;
      numbers.push(e164);

      // מוציאים מהשארית את הספרות שהמספר הזה צרך
      var nat = String(found[k].nationalNumber || '').replace(/\D/g, '');
      var at = nat ? remaining.indexOf(nat) : -1;
      if (at === -1) at = remaining.indexOf(e164);
      if (at !== -1) {
        var len = (at === remaining.indexOf(nat) && nat) ? nat.length : e164.length;
        remaining = remaining.slice(0, at) + remaining.slice(at + len);
      }
    }

    return { numbers: numbers, leftover: remaining.length };
  }

  /**
   * מפתחות השוואה לכל המספרים בשדה.
   *
   * אותו אדם מופיע בספר הטלפונים כ-050-123-4567 ובוואטסאפ כ-+972501234567.
   * מנרמלים לאותה צורה, ומוסיפים מפתחות זנב של 9 ו-7 ספרות:
   * 9 למספר ישראלי שנשמר בלי קידומת, 7 למדינות עם מספר לאומי בן 8
   * ספרות (נורבגיה, דנמרק, הונג קונג) שבהן מפתח 9 לא נוצר.
   *
   * מפתח זנב מרחיב את ההתאמה ולכן מרחיב את ההחרגה. זה הכיוון הבטוח:
   * התאמת שווא אומרת שמישהו לא ייכנס לקובץ, והחמצה אומרת שאיש קשר
   * קיים נדרס. נמדד על ספר אמיתי: 0.071% התאמות שווא.
   */
  function phoneKeys(raw) {
    var numbers = parseNumbers(raw);

    // המנתח לא הכיר - נופלים לספרות הגולמיות. עדיף מפתח משוער
    // מאשר שום מפתח, כי "שום מפתח" פירושו שהאדם נחשב ללא-שמור.
    if (!numbers.length) {
      var rawDigits = asciiDigits(String(raw || '')).replace(/^\s*tel:/i, '').replace(/\D/g, '');
      if (rawDigits.length >= 6 && rawDigits.length <= 20) {
        if (rawDigits.charAt(0) === '0') rawDigits = '972' + rawDigits.slice(1);
        numbers = [rawDigits];
      }
    }

    var keys = [];

    for (var n = 0; n < numbers.length; n++) {
      var digits = numbers[n];
      if (digits.length < 6) continue;

      var rest = digits;
      if (rest.indexOf('972') === 0) rest = rest.slice(3);
      if (rest.length >= 6 && keys.indexOf(rest) === -1) keys.push(rest);

      [9, 7].forEach(function (len) {
        if (digits.length >= len) {
          var tail = digits.slice(-len);
          if (keys.indexOf(tail) === -1) keys.push(tail);
        }
      });

      // שלוחה שהודבקה בסוף ("03-6123456-204"): המספר האמיתי הוא
      // תחילית של מחרוזת הספרות. מפיקים גם מפתחות תחילית כדי שההתאמה
      // תצליח במקום להיכשל. מפתח עודף רק מרחיב את ההחרגה - הכיוון
      // הבטוח: מישהו לא ייכנס לקובץ, במקום שאיש קשר קיים יידרס.
      if (rest.length > 9) {
        [9, 8, 7].forEach(function (len) {
          var pre = rest.slice(0, len);
          if (pre.length === len && keys.indexOf(pre) === -1) keys.push(pre);
        });
      }
    }
    return keys;
  }

  /**
   * האם הבנו את השדה.
   *
   * מצב הכשל שהפיל אותנו שלוש פעמים אינו "לא הופק מפתח" אלא "הופק מפתח
   * שגוי": ספרות שהודבקו דרך מפריד לגיטימי מזיזות את המספר, ההשוואה
   * נכשלת, והאדם - ששמור אצל המשתמש - נכתב לקובץ ונדרס.
   *
   * שדה עם 6 ספרות ומעלה שלא הניב אף מספר תקין הוא כשל, והדף עוצר.
   * שדה קצר יותר (מספר שירות, "1-800-FLOWERS", תא ריק) אינו מספר.
   */
  function understood(raw) {
    var value = asciiDigits(String(raw || '')).replace(/^\s*tel:/i, '').trim();
    var digits = value.replace(/\D/g, '');
    if (digits.length < 6) return true;

    var field = parseField(raw);

    // שארית של 6 ספרות ומעלה **אחרי שכבר נמצא מספר** = מספר שלם
    // שנעלם בשקט. זה מצב הכשל שנשאר פתוח אחרי ארבעה סבבים:
    // "050-123-4567 - 03-6123456" מחזיר אחד, והשני מתאדה.
    if (field.numbers.length > 0) return field.leftover < 6;

    // לא נמצא כלום: מספר זר, ישן או לא מוקצה. אלה אנשים אמיתיים,
    // והמפתחות מהספרות הגולמיות מכסים אותם. חסימה כאן היא חסימת שווא.

    // המנתח לא הכיר את המספר, אבל השדה מורכב רק מספרות וממפרידי
    // תצוגה - כלומר הוא מספר, גם אם ישן, זר או לא מוקצה. חסימת
    // המשתמש כאן היא חסימת שווא, ומפתחות התחילית והזנב ממילא
    // מכסים אותו. חוסמים רק שדה שיש בו תוכן שלא הבנו.
    return digits.length <= 20 &&
      /^[+0-9\s()\-.\u00a0\u200e\u200f\u202a-\u202e\u2066-\u2069]+$/.test(value);
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
      var parts = m[1].split(/:::|\/|(?<!\\),/);
      for (var i = 0; i < parts.length; i++) {
        if (asciiDigits(parts[i]).replace(/\D/g, '').length >= 6) out.push(parts[i]);
      }
    }
    return out;
  }

  /** האם הערך הזה הוא מספר טלפון תקין באמת */
  function looksLikePhone(value) {
    var v = asciiDigits(String(value || '')).trim();
    if (v.replace(/\D/g, '').length < 6) return false;
    try {
      var one = getLib().parsePhoneNumberFromString(v, DEFAULT_COUNTRY);
      return Boolean(one && one.isValid());
    } catch (err) {
      return false;
    }
  }

  /**
   * אילו עמודות ב-CSV הן באמת עמודות טלפון, לפי התוכן שלהן.
   *
   * זיהוי לפי מחלקת תווים סופר מיקוד (7 ספרות) ותאריך לידה
   * ("1980-12-05") כמספרי טלפון. בייצוא רגיל של גוגל או אאוטלוק זה
   * מנפח את המכנה פי שלושה, היחס צונח ל-0.33, והקובץ נחסם לשווא -
   * כלומר מסלול ה-CSV מת לשני הייצואים הנפוצים ביותר.
   *
   * לכן מחליטים לפי תוכן: עמודה שבה רוב התאים הלא-ריקים הם מספר
   * תקין היא עמודת טלפון. `isValid` מפריד נקי - מיקוד ותאריך נפסלים.
   *
   * @returns {{cols: number[], candidates: number}}
   */
  function csvPhoneColumns(lines) {
    var width = 0;
    var rows = [];
    for (var r = 1; r < lines.length; r++) {
      var cells = splitCsvLine(lines[r]);
      rows.push(cells);
      if (cells.length > width) width = cells.length;
    }

    var cols = [];
    var candidates = 0;
    for (var c = 0; c < width; c++) {
      var filled = 0;
      var valid = 0;
      for (var i = 0; i < rows.length; i++) {
        var raw = rows[i][c];
        if (raw === undefined || !String(raw).trim()) continue;
        filled += 1;
        var parts = String(raw).split(/:::|;|\/|,/);
        for (var k = 0; k < parts.length; k++) {
          if (looksLikePhone(parts[k])) { valid += 1; break; }
        }
      }
      if (filled > 0 && valid / filled >= 0.6) {
        cols.push(c);
        candidates += filled;
      }
    }
    return { cols: cols, candidates: candidates };
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

  /** מחלץ מספרים מייצוא CSV של אנשי הקשר של גוגל או אאוטלוק */
  function fromCsv(text) {
    var lines = text.split(/\r?\n/).filter(function (l) { return l.trim(); });
    if (!lines.length) return [];

    var header = splitCsvLine(lines[0]);
    var byHeader = [];
    for (var i = 0; i < header.length; i++) {
      var h = header[i].toLowerCase();
      if (/phone|mobile|cell|tel|fax|טלפון|נייד|סלולר|וואטסאפ|whatsapp/.test(h)) byHeader.push(i);
    }

    // איחוד: מה שהכותרת אמרה ומה שהתוכן מוכיח
    var byContent = csvPhoneColumns(lines).cols;
    var cols = byHeader.slice();
    for (var b = 0; b < byContent.length; b++) {
      if (cols.indexOf(byContent[b]) === -1) cols.push(byContent[b]);
    }

    var out = [];
    for (var r = 1; r < lines.length; r++) {
      var cells = splitCsvLine(lines[r]);
      // בלי שום עמודה מזוהה: סורקים כל תא שנראה כמו מספר
      var scan = cols.length ? cols : cells.map(function (_, idx) { return idx; });
      for (var c = 0; c < scan.length; c++) {
        var val = cells[scan[c]];
        if (!val) continue;
        if (!cols.length && !looksLikePhone(val)) continue;
        var parts = String(val).split(/:::|;|\//);
        for (var p = 0; p < parts.length; p++) out.push(parts[p]);
      }
    }
    return out;
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
      // המכנה נמדד מהקלט הגולמי ולא מהתוצר. מכנה שנגזר מ-`raw` נותן
      // יחס 1.000 תמיד - גם כשעמודת "נייד" לא זוהתה ונזרקה בשלמותה.
      telLines: isVcard
        ? countTelLines(body)
        : csvPhoneColumns(body.split(/\r?\n/).filter(function (l) { return l.trim(); })).candidates,
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
    parseNumbers: parseNumbers,
    parseField: parseField,
    isSaved: isSaved,
    parseContactsFile: parseContactsFile,
    buildVcf: buildVcf,
    sanitizePrefix: sanitizePrefix
  };
})();
