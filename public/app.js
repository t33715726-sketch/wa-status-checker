/* מי לא רואה את הסטטוס שלי - לוגיקת צד לקוח.

   כל הנתונים חיים בזיכרון הדף בלבד. אין localStorage, אין קוקיז.

   הכלל שמחזיק את כל הקובץ הזה:
   ספר הטלפונים של המשתמש הוא מקור האמת היחיד לשאלה "מי כבר שמור אצלי".
   הוא נקרא כאן, נשאר כאן, ומסנן גם את הרשימה שמוצגת וגם את הקובץ שנבנה.
   בלי ספר טלפונים טעון - אי אפשר להתחיל סריקה בכלל. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var socket = null;
  var sessionId = null;

  /** כל התוצאות מהשרת, אחרי סינון מול ספר הטלפונים */
  var items = [];
  var selected = new Set();
  var activeTab = 'chat';

  /** ספר הטלפונים של המשתמש. null = טרם נטען. */
  var savedSet = null;
  var savedCount = 0;

  var MAX_FILE_BYTES = 25 * 1024 * 1024;

  var views = {
    intro: $('viewIntro'),
    contacts: $('viewContacts'),
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
    show('connect');
  });

  /** שער יחיד: שום דבר לא מתחיל בלי ספר טלפונים טעון */
  function requireContacts() {
    if (savedSet) return true;
    show('contacts');
    contactsError('צריך לבחור קודם את קובץ אנשי הקשר. בלעדיו אי אפשר לדעת מי כבר שמור אצלך.');
    return false;
  }

  /* ============================================================
     שלב 2: חיבור וואטסאפ
     ============================================================ */

  function connectSocket() {
    if (socket) return socket;
    socket = io({ transports: ['websocket', 'polling'] });

    socket.on('session', function (d) { sessionId = d.sessionId; });

    socket.on('state', function (d) {
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
     תוצאות
     ============================================================ */

  function renderResults(d) {
    var raw = Array.isArray(d.items) ? d.items : [];

    // הסינון האמיתי. השרת לא יודע מי שמור אצל המשתמש, ולכן הוא שולח
    // את כל מי שמצא. כאן מורידים את מי שכבר קיים בספר הטלפונים.
    var removed = 0;
    items = raw.filter(function (it) {
      if (savedSet && window.ContactBook.isSaved(savedSet, it.phone)) {
        removed += 1;
        return false;
      }
      return true;
    });

    selected = new Set();

    var s = d.stats || {};
    $('gapCount').textContent = String(items.length);
    $('resultSub').textContent =
      'נסרקו ' + (s.chats || 0) + ' שיחות, והוצלבו מול ' + savedCount +
      ' מספרים מספר הטלפונים שלך.';

    var note = $('filterNote');
    if (removed > 0) {
      $('filteredCount').textContent = String(removed);
      note.classList.remove('hidden');
    } else {
      note.classList.add('hidden');
    }

    $('bar').style.width = '100%';

    var chatGap = items.filter(function (it) { return it.source === 'chat'; }).length;
    var groupGap = items.length - chatGap;
    activeTab = chatGap > 0 || groupGap === 0 ? 'chat' : 'contact';

    syncTabs();
    renderList();
    show('results');
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
      cb.checked = selected.has(it.i);
      cb.addEventListener('change', function () {
        if (cb.checked) selected.add(it.i); else selected.delete(it.i);
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
      sub.textContent = it.pushName ? it.display : 'ללא שם בוואטסאפ';
      main.appendChild(name);
      main.appendChild(sub);

      li.appendChild(cb);
      li.appendChild(av);
      li.appendChild(main);

      if (it.wroteToYou) {
        var tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = 'כתב לך';
        li.appendChild(tag);
      } else if (it.business) {
        var b = document.createElement('span');
        b.className = 'tag';
        b.textContent = 'עסקי';
        li.appendChild(b);
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
    var all = rows.length > 0 && rows.every(function (it) { return selected.has(it.i); });
    $('selectAll').checked = all;
  }

  $('selectAll').addEventListener('change', function () {
    var rows = visible();
    rows.forEach(function (it) {
      if ($('selectAll').checked) selected.add(it.i); else selected.delete(it.i);
    });
    renderList();
  });

  $('search').addEventListener('input', renderList);

  function syncTabs() {
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

    var chosen = items.filter(function (it) { return selected.has(it.i); });

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
    barPct = 8;
    $('bar').style.width = '8%';

    // גם ספר הטלפונים נמחק: הבטחנו שהוא לא נשמר בשום מקום
    savedSet = null;
    savedCount = 0;
    $('contactsFile').value = '';
    $('contactsOk').classList.add('hidden');
    $('contactsErr').classList.add('hidden');
    $('filterNote').classList.add('hidden');

    $('phoneForm').classList.add('hidden');
    show('intro');
  }

  Array.prototype.forEach.call(document.querySelectorAll('[data-action="restart"]'), function (b) {
    b.addEventListener('click', reset);
  });

  window.addEventListener('pagehide', function () {
    if (socket && sessionId) socket.emit('end');
  });
})();
