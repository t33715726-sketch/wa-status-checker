/* מי לא רואה את הסטטוס שלי - לוגיקת צד לקוח.

   כל הנתונים חיים בזיכרון הדף בלבד. אין localStorage, אין קוקיז.

   הכלל שמחזיק את כל הקובץ הזה:
   ספר הטלפונים של המשתמש הוא מקור האמת היחיד לשאלה "מי כבר שמור אצלי".
   הוא נקרא כאן, נשאר כאן, ומסנן גם את הרשימה שמוצגת וגם את הקובץ שנבנה.
   בלי ספר טלפונים טעון - אי אפשר להתחיל בכלל.

   שני מקורות, פלט אחד:
     me   - מי שמר את המספר שלך (התשובה המלאה)
     wa   - מי מתכתב איתך ואינו שמור אצלך (קירוב, בלי תלות בשירות חיצוני)
   שניהם מתמזגים לרשימה אחת לפי מספר מנורמל, בלי כפילויות. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var socket = null;
  var sessionId = null;

  /** הרשימה המאוחדת מכל המקורות, אחרי סינון מול ספר הטלפונים */
  var items = [];
  /** נבחרים לפי מפתח יציב ולא לפי אינדקס - אינדקסים מתנגשים בין מקורות */
  var selected = new Set();
  var activeTab = 'chat';
  var removedTotal = 0;
  var sourcesDone = {};
  var meAvailable = false;

  /** ספר הטלפונים של המשתמש. null = טרם נטען. */
  var savedSet = null;
  var savedCount = 0;

  var MAX_FILE_BYTES = 25 * 1024 * 1024;

  var views = {
    intro: $('viewIntro'),
    contacts: $('viewContacts'),
    source: $('viewSource'),
    me: $('viewMe'),
    connect: $('viewConnect'),
    sync: $('viewSync'),
    results: $('viewResults'),
    error: $('viewError')
  };

  function show(name) {
    Object.keys(views).forEach(function (k) {
      views[k].classList.toggle('hidden', k !== name);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function fail(message) {
    $('errText').textContent = message;
    show('error');
  }

  /** מפתח יציב לזיהוי אדם בין המקורות */
  function keyOf(item) {
    var keys = window.ContactBook.phoneKeys(item.phone);
    return keys.length ? keys[0] : String(item.phone || '');
  }

  /* ---------------- ערכת נושא ---------------- */
  $('themeBtn').addEventListener('click', function () {
    var cur = document.documentElement.getAttribute('data-theme');
    var next = cur === 'dark' ? 'light' : cur === 'light' ? '' : 'dark';
    if (next) document.documentElement.setAttribute('data-theme', next);
    else document.documentElement.removeAttribute('data-theme');
  });

  /* ============================================================
     שלב 1: ספר הטלפונים
     ============================================================ */

  $('btnBegin').addEventListener('click', function () { show('contacts'); });

  function contactsError(message) {
    savedSet = null;
    savedCount = 0;
    $('contactsOk').classList.add('hidden');
    var el = $('contactsErr');
    el.textContent = message;
    el.classList.remove('hidden');
  }

  $('contactsFile').addEventListener('change', function () {
    var file = this.files && this.files[0];
    if (!file) return;

    $('contactsErr').classList.add('hidden');
    $('contactsOk').classList.add('hidden');

    if (file.size > MAX_FILE_BYTES) {
      contactsError('הקובץ גדול מדי. ייצוא אנשי קשר רגיל שוקל הרבה פחות - בדוק שבחרת את הקובץ הנכון.');
      return;
    }

    var reader = new FileReader();

    reader.onerror = function () {
      contactsError('לא הצלחנו לקרוא את הקובץ. נסה לבחור אותו שוב.');
    };

    reader.onload = function () {
      var parsed;
      try {
        parsed = window.ContactBook.parseContactsFile(String(reader.result || ''));
      } catch (err) {
        contactsError('הקובץ לא נראה כמו ייצוא אנשי קשר. צריך קובץ ‎.vcf או ‎.csv.');
        return;
      }

      // קובץ שממנו לא יצא אף מספר פירושו שאין לנו במה להשוות.
      // בדיוק כאן נשברה הגרסה הראשונה: רשימת "שמורים" ריקה הפכה את כולם
      // ללא-שמורים. עדיף לעצור מאשר להמשיך עם סינון שאינו קיים.
      if (!parsed || !parsed.set || parsed.set.size === 0) {
        contactsError('לא נמצאו מספרי טלפון בקובץ. ודא שייצאת "כל אנשי הקשר" בפורמט vCard, ונסה שוב.');
        return;
      }

      // שער שלמות, ולא רק שער קיום. פרסור חלקי מסוכן יותר מפרסור שנכשל:
      // הוא נראה כמו הצלחה, והאנשים שפוספסו הם בדיוק אלה שיידרסו בייבוא.
      if (parsed.telLines > 0 && parsed.numbers < parsed.telLines * 0.95) {
        contactsError(
          'הקובץ נקרא רק חלקית - זוהו ' + parsed.numbers + ' מספרים מתוך ' +
          parsed.telLines + ' שדות טלפון. אי אפשר להמשיך ככה, כי מי שפוספס ' +
          'עלול להידרס בייבוא. שלח לי את הקובץ ונתקן את הקריאה.'
        );
        return;
      }

      savedSet = parsed.set;
      savedCount = parsed.numbers;
      $('contactsCount').textContent = String(savedCount);
      $('contactsOk').classList.remove('hidden');
      $('btnToConnect').focus();
    };

    reader.readAsText(file, 'utf-8');
  });

  $('btnToConnect').addEventListener('click', function () {
    if (!savedSet) return;
    show('source');
  });

  /** שער יחיד: שום דבר לא מתחיל בלי ספר טלפונים טעון */
  function requireContacts() {
    if (savedSet) return true;
    show('contacts');
    contactsError('צריך לבחור קודם את קובץ אנשי הקשר. בלעדיו אי אפשר לדעת מי כבר שמור אצלך.');
    return false;
  }

  /* ============================================================
     שלב 2: בחירת מקור
     ============================================================ */

  // המסלול של "מי שמר אותי" תלוי בשירות חיצוני. שואלים את השרת אם הוא
  // מחובר, ולא מציעים למשתמש מסלול שייכשל.
  fetch('/api/sources')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      meAvailable = Boolean(d && d.me);
      var card = $('srcMe');
      var state = $('srcMeState');
      if (meAvailable) {
        state.textContent = 'זמין';
        state.className = 'source-state ok';
      } else {
        card.classList.add('is-off');
        state.textContent = 'עדיין לא מחובר';
        state.className = 'source-state off';
      }
    })
    .catch(function () {
      $('srcMe').classList.add('is-off');
      $('srcMeState').textContent = 'עדיין לא מחובר';
      $('srcMeState').className = 'source-state off';
    });

  $('srcMe').addEventListener('click', function () {
    if (!requireContacts()) return;
    if (!meAvailable) {
      // מסלול שידוע שאינו זמין הוא לא תקלה - לא זורקים את המשתמש למסך שגיאה
      var note = $('srcNote');
      note.textContent =
        'מסלול "מי שמר אותי" עדיין לא מחובר לשירות זיהוי המספרים. בינתיים אפשר להריץ את סריקת וואטסאפ.';
      note.classList.remove('hidden');
      $('srcWa').focus();
      return;
    }
    $('srcNote').classList.add('hidden');
    $('meCodeForm').classList.add('hidden');
    $('meWait').classList.add('hidden');
    $('mePhoneForm').classList.remove('hidden');
    show('me');
    $('mePhone').focus();
  });

  $('srcWa').addEventListener('click', function () {
    if (!requireContacts()) return;
    $('qrBox').classList.add('hidden');
    $('pairBox').classList.add('hidden');
    $('waitBox').classList.add('hidden');
    $('phoneForm').classList.add('hidden');
    $('chooser').classList.remove('hidden');
    show('connect');
  });

  $('btnToResults').addEventListener('click', function () {
    if (items.length) show('results');
  });

  /* ============================================================
     סוקט - משותף לשני המקורות
     ============================================================ */

  function connectSocket() {
    if (socket) return socket;
    socket = io({ transports: ['websocket', 'polling'] });

    socket.on('session', function (d) { sessionId = d.sessionId; });

    socket.on('state', function (d) {
      /* --- מצבי וואטסאפ --- */
      if (d.state === 'qr') {
        show('connect');
        $('qrImg').src = d.qr;
        $('qrBox').classList.remove('hidden');
        $('pairBox').classList.add('hidden');
        $('waitBox').classList.add('hidden');
      } else if (d.state === 'pairing') {
        show('connect');
        $('pairCode').textContent = formatCode(d.code);
        $('pairBox').classList.remove('hidden');
        $('qrBox').classList.add('hidden');
        $('waitBox').classList.add('hidden');
      } else if (d.state === 'syncing') {
        show('sync');

      /* --- מצבי Me --- */
      } else if (d.state === 'otp') {
        show('me');
        $('mePhoneForm').classList.add('hidden');
        $('meWait').classList.add('hidden');
        $('meCodeForm').classList.remove('hidden');
        $('meSentTo').textContent = d.sentTo || '';
        var err = $('meCodeErr');
        if (d.error) {
          err.textContent = d.error + (d.attemptsLeft != null ? ' נשארו ' + d.attemptsLeft + ' ניסיונות.' : '');
          err.classList.remove('hidden');
        } else {
          err.classList.add('hidden');
        }
        $('meCode').value = '';
        $('meCode').focus();
      } else if (d.state === 'verifying' || d.state === 'fetching') {
        show('me');
        $('mePhoneForm').classList.add('hidden');
        $('meCodeForm').classList.add('hidden');
        $('meWait').classList.remove('hidden');
        $('meWaitText').textContent =
          d.state === 'verifying' ? 'מאמתים את הקוד...' : 'מביאים את הרשימה...';

      /* --- משותף --- */
      } else if (d.state === 'done') {
        renderResults(d);
        if (socket) socket.emit('done');
      }
    });

    socket.on('sync', function (d) {
      $('cContacts').textContent = String(d.contacts || 0);
      $('cChats').textContent = String(d.chats || 0);
      var pct = d.progress != null ? Math.max(8, d.progress) : null;
      if (pct != null) $('bar').style.width = pct + '%';
      else bumpBar();
    });

    socket.on('failed', function (d) {
      fail((d && d.message) || 'נסה שוב בעוד רגע.');
    });

    socket.on('attach:failed', function () { reset(); });

    socket.on('disconnect', function () {
      if (!views.results.classList.contains('hidden')) return;
      var w = $('waitText');
      if (w) w.textContent = 'החיבור נקטע, מנסים שוב...';
    });

    socket.on('connect', function () {
      if (sessionId) socket.emit('attach', { sessionId: sessionId });
    });

    return socket;
  }

  var barPct = 8;
  function bumpBar() {
    barPct = Math.min(92, barPct + 6);
    $('bar').style.width = barPct + '%';
  }

  function formatCode(code) {
    var c = String(code || '').replace(/\s/g, '');
    return c.length === 8 ? c.slice(0, 4) + '-' + c.slice(4) : c;
  }

  /* ============================================================
     שלב 3א: מי שמר אותי
     ============================================================ */

  $('mePhoneForm').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!requireContacts()) return;
    var v = $('mePhone').value.replace(/\D/g, '');
    if (v.length < 8) { $('mePhone').focus(); return; }

    $('mePhoneForm').classList.add('hidden');
    $('meCodeForm').classList.add('hidden');
    $('meWait').classList.remove('hidden');
    $('meWaitText').textContent = 'שולחים קוד...';

    connectSocket().emit('me:start', { phone: v });
  });

  $('meCodeForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = $('meCode').value.replace(/\D/g, '');
    if (v.length < 4) { $('meCode').focus(); return; }
    connectSocket().emit('me:verify', { code: v });
  });

  /* ============================================================
     שלב 3ב: חיבור וואטסאפ
     ============================================================ */

  function start(phone) {
    if (!requireContacts()) return;
    show('connect');
    $('qrBox').classList.add('hidden');
    $('pairBox').classList.add('hidden');
    $('waitBox').classList.remove('hidden');
    $('waitText').textContent = phone ? 'מייצרים קוד...' : 'מייצרים קוד QR...';
    connectSocket().emit('start', phone ? { phone: phone } : {});
  }

  $('btnQr').addEventListener('click', function () { start(null); });

  $('btnPair').addEventListener('click', function () {
    if (!requireContacts()) return;
    $('phoneForm').classList.remove('hidden');
    $('phone').focus();
  });

  $('phoneForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = $('phone').value.replace(/\D/g, '');
    if (v.length < 8) { $('phone').focus(); return; }
    start(v);
  });

  /* ============================================================
     תוצאות - מיזוג שני המקורות
     ============================================================ */

  function renderResults(d) {
    // בלי ספר טלפונים אין הצלבה, ורשימה בלי הצלבה היא שקר מסוכן:
    // היא מציגה אנשים שכבר שמורים כאילו הם פער. קורה כשהמשתמש מבטל
    // בזמן שתוצאה כבר בדרך.
    if (!savedSet) {
      fail('ספר הטלפונים נמחק באמצע, ולכן אי אפשר להצליב. התחל מחדש ובחר את קובץ אנשי הקשר.');
      return;
    }

    var raw = Array.isArray(d.items) ? d.items : [];
    var source = (d.stats && d.stats.source) || (raw[0] && raw[0].source === 'me' ? 'me' : 'wa');
    sourcesDone[source === 'me' ? 'me' : 'wa'] = true;

    // מפתחות שכבר ברשימה - מונע כפילות כשאותו אדם מגיע משני המקורות
    var have = new Set();
    items.forEach(function (it) { have.add(it.key); });

    raw.forEach(function (it) {
      // הסינון האמיתי. שום מקור לא יודע מי שמור אצל המשתמש - רק ספר
      // הטלפונים שלו יודע, והוא נמצא כאן.
      if (window.ContactBook.isSaved(savedSet, it.phone)) {
        removedTotal += 1;
        return;
      }
      var key = keyOf(it);
      if (have.has(key)) {
        // אותו אדם משני המקורות: משדרגים שם חסר ומסמנים ששמר אותך
        var prev = items.find(function (x) { return x.key === key; });
        if (prev) {
          if (!prev.pushName && it.pushName) prev.pushName = it.pushName;
          if (it.savedYou) prev.savedYou = true;
          if (it.wroteToYou) prev.wroteToYou = true;
        }
        return;
      }
      have.add(key);
      it.key = key;
      items.push(it);
    });

    var s = d.stats || {};
    $('gapCount').textContent = String(items.length);

    var parts = [];
    if (sourcesDone.me) parts.push('מ-Me: מי ששמר אותך');
    if (sourcesDone.wa) parts.push('מוואטסאפ: ' + (s.chats || 0) + ' שיחות');
    $('resultSub').textContent =
      parts.join(' · ') + '. הוצלב מול ' + savedCount + ' מספרים מספר הטלפונים שלך.';

    var note = $('filterNote');
    if (removedTotal > 0) {
      $('filteredCount').textContent = String(removedTotal);
      note.classList.remove('hidden');
    } else {
      note.classList.add('hidden');
    }

    $('bar').style.width = '100%';

    // כפתור "להוסיף גם את המקור השני" רק אם באמת יש מקור שני זמין
    var canAdd = (!sourcesDone.me && meAvailable) || !sourcesDone.wa;
    $('btnAddSource').classList.toggle('hidden', !canAdd);

    syncTabs();
    renderList();
    show('results');
  }

  /** אילו לשוניות בכלל יש בהן משהו */
  function tabCounts() {
    var c = { me: 0, chat: 0, contact: 0 };
    items.forEach(function (it) {
      if (c[it.source] !== undefined) c[it.source] += 1;
    });
    return c;
  }

  function visible() {
    var q = ($('search').value || '').trim().toLowerCase();
    return items.filter(function (it) {
      if (it.source !== activeTab) return false;
      if (!q) return true;
      return (
        (it.pushName || '').toLowerCase().indexOf(q) !== -1 ||
        (it.display || '').replace(/\D/g, '').indexOf(q.replace(/\D/g, '')) !== -1
      );
    });
  }

  function initials(it) {
    var n = (it.pushName || '').trim();
    if (n) return n.slice(0, 1).toUpperCase();
    return '#';
  }

  function renderList() {
    var list = $('list');
    var rows = visible();
    list.textContent = '';
    $('emptyMsg').classList.toggle('hidden', rows.length > 0);

    var frag = document.createDocumentFragment();
    rows.forEach(function (it) {
      var li = document.createElement('li');
      li.className = 'row';

      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = selected.has(it.key);
      cb.addEventListener('change', function () {
        if (cb.checked) selected.add(it.key); else selected.delete(it.key);
        updateCount();
      });

      var av = document.createElement('div');
      av.className = 'avatar';
      av.textContent = initials(it);

      var main = document.createElement('div');
      main.className = 'row-main';
      var name = document.createElement('div');
      name.className = 'row-name';
      name.textContent = it.pushName || it.display;
      var sub = document.createElement('div');
      sub.className = 'row-sub';
      // בלי שם תצוגה אין טעם להציג את המספר פעמיים
      sub.textContent = it.pushName ? it.display : 'ללא שם';
      main.appendChild(name);
      main.appendChild(sub);

      li.appendChild(cb);
      li.appendChild(av);
      li.appendChild(main);

      var label = it.savedYou ? 'שמר אותך' : it.wroteToYou ? 'כתב לך' : it.business ? 'עסקי' : '';
      if (label) {
        var tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = label;
        li.appendChild(tag);
      }

      li.addEventListener('click', function (e) {
        if (e.target === cb) return;
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event('change'));
      });

      frag.appendChild(li);
    });
    list.appendChild(frag);
    updateCount();
  }

  function updateCount() {
    $('selCount').textContent = selected.size + ' נבחרו';
    $('btnExport').disabled = selected.size === 0;
    var rows = visible();
    var all = rows.length > 0 && rows.every(function (it) { return selected.has(it.key); });
    $('selectAll').checked = all;
  }

  $('selectAll').addEventListener('change', function () {
    var rows = visible();
    rows.forEach(function (it) {
      if ($('selectAll').checked) selected.add(it.key); else selected.delete(it.key);
    });
    renderList();
  });

  $('search').addEventListener('input', renderList);

  function syncTabs() {
    var counts = tabCounts();
    // לשונית ריקה רק מבלבלת - מסתירים אותה
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      var key = t.getAttribute('data-tab');
      // שומרים את הכיתוב המקורי פעם אחת, אחרת הספירה מצטברת בכל רינדור
      if (!t.dataset.label) t.dataset.label = t.textContent.trim();
      t.classList.toggle('hidden', counts[key] === 0);
      t.textContent = t.dataset.label + ' (' + counts[key] + ')';
    });
    if (counts[activeTab] === 0) {
      activeTab = counts.me ? 'me' : counts.chat ? 'chat' : 'contact';
    }
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.classList.toggle('is-active', t.getAttribute('data-tab') === activeTab);
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
    t.addEventListener('click', function () {
      activeTab = t.getAttribute('data-tab');
      syncTabs();
      renderList();
    });
  });

  /* ---------------- הוספת המקור השני ---------------- */
  $('btnAddSource').addEventListener('click', function () {
    // משחררים את הסשן הנוכחי בשרת לפני שפותחים אחד חדש
    if (socket && sessionId) socket.emit('release');
    sessionId = null;
    $('mergeCount').textContent = String(items.length);
    $('mergeNote').classList.remove('hidden');
    $('srcMe').classList.toggle('is-done', Boolean(sourcesDone.me));
    $('srcWa').classList.toggle('is-done', Boolean(sourcesDone.wa));
    show('source');
  });

  /* ============================================================
     ייצוא - בדפדפן בלבד, בלי שום קריאת רשת
     ============================================================ */

  function vcfFilename() {
    var d = new Date();
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return 'whatsapp-status-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '.vcf';
  }

  function download(text, filename) {
    var blob = new Blob([text], { type: 'text/vcard;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  $('btnExport').addEventListener('click', function () {
    if (selected.size === 0) return;
    if (!savedSet) {
      fail('ספר הטלפונים לא טעון, ולכן לא נבנה קובץ. התחל מחדש ובחר את קובץ אנשי הקשר.');
      return;
    }

    var chosen = items.filter(function (it) { return selected.has(it.key); });

    // בדיקת הביטחון האחרונה קורית בתוך buildVcf: כל מספר נבדק שוב מול
    // ספר הטלפונים ממש לפני הכתיבה, גם אם כבר סונן ברשימה.
    var out = window.ContactBook.buildVcf(chosen, $('prefix').value, savedSet);

    if (!out.cards) {
      fail('לא נשאר אף אחד לייצוא - כל מי שנבחר כבר שמור אצלך.');
      return;
    }

    download(out.text, vcfFilename());

    var btn = $('btnExport');
    btn.textContent = out.skipped
      ? 'הורד. ' + out.skipped + ' כבר היו שמורים והושמטו'
      : 'הקובץ ירד. אפשר לייבא בטלפון';
    setTimeout(function () { btn.textContent = 'הורדת קובץ אנשי קשר'; }, 6000);
  });

  /* ---------------- איפוס ---------------- */
  function reset() {
    if (socket && sessionId) socket.emit('end');
    sessionId = null;
    items = [];
    selected = new Set();
    removedTotal = 0;
    sourcesDone = {};
    barPct = 8;
    $('bar').style.width = '8%';

    // גם ספר הטלפונים נמחק: הבטחנו שהוא לא נשמר בשום מקום
    savedSet = null;
    savedCount = 0;
    $('contactsFile').value = '';
    $('contactsOk').classList.add('hidden');
    $('contactsErr').classList.add('hidden');
    $('filterNote').classList.add('hidden');
    $('mergeNote').classList.add('hidden');
    $('srcNote').classList.add('hidden');
    $('btnAddSource').classList.add('hidden');
    $('srcMe').classList.remove('is-done');
    $('srcWa').classList.remove('is-done');

    $('phoneForm').classList.add('hidden');
    $('mePhoneForm').classList.remove('hidden');
    $('meCodeForm').classList.add('hidden');
    $('meWait').classList.add('hidden');
    $('meCodeErr').classList.add('hidden');
    $('mePhone').value = '';
    $('meCode').value = '';

    show('intro');
  }

  Array.prototype.forEach.call(document.querySelectorAll('[data-action="restart"]'), function (b) {
    b.addEventListener('click', reset);
  });

  window.addEventListener('pagehide', function () {
    if (socket && sessionId) socket.emit('end');
  });
})();
