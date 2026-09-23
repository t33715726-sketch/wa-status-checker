/* מי לא רואה את הסטטוס שלי - לוגיקת צד לקוח.
   כל הנתונים חיים בזיכרון הדף בלבד. אין localStorage, אין קוקיז. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var socket = null;
  var sessionId = null;
  var items = [];
  var selected = new Set();
  var activeTab = 'chat';

  var views = {
    intro: $('viewIntro'),
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

  /* ---------------- ערכת נושא ---------------- */
  var themeBtn = $('themeBtn');
  themeBtn.addEventListener('click', function () {
    var cur = document.documentElement.getAttribute('data-theme');
    var next = cur === 'dark' ? 'light' : cur === 'light' ? '' : 'dark';
    if (next) document.documentElement.setAttribute('data-theme', next);
    else document.documentElement.removeAttribute('data-theme');
  });

  /* ---------------- חיבור ---------------- */
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
      $('errText').textContent = (d && d.message) || 'נסה שוב בעוד רגע.';
      show('error');
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
    show('connect');
    $('qrBox').classList.add('hidden');
    $('pairBox').classList.add('hidden');
    $('waitBox').classList.remove('hidden');
    $('waitText').textContent = phone ? 'מייצרים קוד...' : 'מייצרים קוד QR...';
    connectSocket().emit('start', phone ? { phone: phone } : {});
  }

  $('btnQr').addEventListener('click', function () { start(null); });

  $('btnPair').addEventListener('click', function () {
    $('phoneForm').classList.remove('hidden');
    $('phone').focus();
  });

  $('phoneForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = $('phone').value.replace(/\D/g, '');
    if (v.length < 8) { $('phone').focus(); return; }
    start(v);
  });

  /* ---------------- תוצאות ---------------- */
  function renderResults(d) {
    items = Array.isArray(d.items) ? d.items : [];
    selected = new Set();
    var s = d.stats || {};
    $('gapCount').textContent = String(s.total || 0);
    $('resultSub').textContent =
      'מתוך ' + (s.chats || 0) + ' שיחות ו-' + (s.savedContacts || 0) + ' אנשי קשר שמורים.';
    $('bar').style.width = '100%';
    activeTab = (s.chatGap || 0) > 0 || (s.groupGap || 0) === 0 ? 'chat' : 'contact';
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
      if (!it.pushName) sub.classList.add('row-sub-plain');
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

  /* ---------------- ייצוא ---------------- */
  $('btnExport').addEventListener('click', function () {
    if (!sessionId || selected.size === 0) return;
    var btn = $('btnExport');
    btn.disabled = true;
    btn.textContent = 'מכינים קובץ...';

    fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: sessionId,
        ids: Array.from(selected),
        prefix: $('prefix').value
      })
    })
      .then(function (r) {
        if (!r.ok) throw new Error('export failed');
        return r.blob();
      })
      .then(function (blob) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'whatsapp-status.vcf';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
        btn.textContent = 'הורדת קובץ אנשי קשר';
        btn.disabled = false;
      })
      .catch(function () {
        btn.textContent = 'הורדת קובץ אנשי קשר';
        btn.disabled = false;
        $('errText').textContent = 'הייצוא נכשל. אם עברו כמה דקות, התחל סריקה מחדש.';
        show('error');
      });
  });

  /* ---------------- איפוס ---------------- */
  function reset() {
    if (socket && sessionId) socket.emit('end');
    sessionId = null;
    items = [];
    selected = new Set();
    barPct = 8;
    $('bar').style.width = '8%';
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
