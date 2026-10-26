// Papan Prioritas client. No framework, no build step: one module of plain DOM code.
// Data comes from /api (Cloudflare D1). Changes apply on screen at once, wait in an outbox
// (localStorage) and are sent in order, so the app keeps working offline.
(() => {
  'use strict';

  /* ---------------- constants & helpers ---------------- */
  const QS = {
    q1: { code: 'Q1', name: 'Kerjakan', sub: 'Penting · Mendesak' },
    q2: { code: 'Q2', name: 'Jadwalkan', sub: 'Penting · Tidak mendesak' },
    q3: { code: 'Q3', name: 'Delegasikan', sub: 'Tidak penting · Mendesak' },
    q4: { code: 'Q4', name: 'Singkirkan', sub: 'Tidak penting · Tidak mendesak' },
  };
  const QK = ['q1', 'q2', 'q3', 'q4'];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  const MONF = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  const DOW = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
  const DOWF = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
  const BRANDS = [
    { hex: '#0f766e', name: 'Bawaan' }, { hex: '#8f140c', name: 'Merah tua' }, { hex: '#1d4ed8', name: 'Biru' },
    { hex: '#7c3aed', name: 'Ungu' }, { hex: '#ea580c', name: 'Oranye' }, { hex: '#ffd60a', name: 'Kuning' },
  ];
  const TABS = ['matriks', 'tugas', 'kalender', 'lainnya'];

  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const today = () => ymd(new Date());
  const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (n, cls = '') => `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${n}"/></svg>`;
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
  const $ = (sel, el = document) => el.querySelector(sel);

  function fmtDate(s) {
    const t = today();
    if (s === t) return 'Hari ini';
    if (s === addDays(t, 1)) return 'Besok';
    if (s === addDays(t, -1)) return 'Kemarin';
    const d = parse(s);
    const y = d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : '';
    return `${DOW[d.getDay()]}, ${d.getDate()} ${MON[d.getMonth()]}${y}`;
  }
  const longDate = (s) => { const d = parse(s); return `${DOWF[d.getDay()]}, ${d.getDate()} ${MONF[d.getMonth()]} ${d.getFullYear()}`; };

  /* ---------------- state ---------------- */
  const S = {
    user: null, tasks: [], events: [], loaded: false,
    tab: 'matriks', listTab: 'hari-ini', qfilter: 'all',
    month: today().slice(0, 7), sel: today(),
    online: navigator.onLine, updateReady: null, installEvt: null,
  };
  const app = $('#app');
  let outbox = [];
  const cacheKey = () => 'cache:' + S.user.id;
  const outboxKey = () => 'outbox:' + S.user.id;
  function saveLocal() {
    if (!S.user) return;
    PP.write(cacheKey(), JSON.stringify({ tasks: S.tasks, events: S.events }));
    PP.write(outboxKey(), JSON.stringify(outbox));
    PP.write('lastUser', JSON.stringify(S.user));
  }
  function loadLocal() {
    try {
      const c = JSON.parse(PP.read(cacheKey()) || 'null');
      if (c) { S.tasks = c.tasks || []; S.events = c.events || []; S.loaded = true; }
      outbox = JSON.parse(PP.read(outboxKey()) || '[]');
    } catch { outbox = []; }
  }

  /* ---------------- network ---------------- */
  async function req(method, path, body) {
    const res = await fetch(path, {
      method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    return { ok: res.ok, status: res.status, data };
  }

  let flushing = false, retryTimer = null, wantReload = false;
  async function flush() {
    if (flushing || !S.user) return;
    flushing = true;
    let resync = false;
    while (outbox.length) {
      const op = outbox[0];
      let r;
      try { r = await req(op.m, op.p, op.b); } catch { setOnline(false); break; }
      setOnline(true);
      if (r.status === 401) { flushing = false; return showAuth(); }
      if (r.ok || (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429)) {
        if (!r.ok) { snackbar((r.data && r.data.error) || 'Satu perubahan ditolak server.'); resync = true; }
        outbox.shift();
        saveLocal();
        continue;
      }
      break; // 5xx or rate limit: try again later
    }
    flushing = false;
    clearTimeout(retryTimer);
    if (outbox.length) retryTimer = setTimeout(flush, 15000);
    else if (resync) refresh();
    render();
  }

  async function refresh() {
    if (!S.user) return;
    if (outbox.length) { await flush(); if (outbox.length) return; }
    let r;
    try { r = await req('GET', '/api/state'); } catch { S.loaded = true; setOnline(false); render(); return; }
    setOnline(true);
    if (r.status === 401) return showAuth();
    if (!r.ok || outbox.length) return;
    S.user = r.data.user;
    S.tasks = r.data.tasks;
    S.events = r.data.events;
    S.loaded = true;
    saveLocal();
    render();
  }
  function setOnline(v) { if (S.online !== v) { S.online = v; render(); } }

  function queue(op) { outbox.push(op); saveLocal(); render(); flush(); }

  /* ---------------- mutations ---------------- */
  const taskBody = (t) => ({ title: t.title, notes: t.notes || '', quadrant: t.quadrant || null, due: t.due || null, time: t.time || null, delegateTo: t.delegateTo || null, done: !!t.done, doneAt: t.doneAt || null, createdAt: t.createdAt });
  const eventBody = (e) => ({ title: e.title, date: e.date, start: e.start || null, end: e.end || null, notes: e.notes || '', createdAt: e.createdAt });

  function createTask(data) {
    const t = { id: uid(), title: '', notes: '', quadrant: null, due: null, time: null, delegateTo: null, done: false, doneAt: null, createdAt: new Date().toISOString(), ...data };
    S.tasks.push(t);
    queue({ m: 'PUT', p: '/api/tasks/' + t.id, b: taskBody(t) });
    return t;
  }
  function patchTask(id, data) {
    const t = S.tasks.find((x) => x.id === id);
    if (!t) return;
    Object.assign(t, data);
    queue({ m: 'PATCH', p: '/api/tasks/' + id, b: data });
  }
  function removeTask(id) {
    S.tasks = S.tasks.filter((x) => x.id !== id);
    queue({ m: 'DELETE', p: '/api/tasks/' + id });
  }
  function createEvent(data) {
    const e = { id: uid(), title: '', date: today(), start: null, end: null, notes: '', createdAt: new Date().toISOString(), ...data };
    S.events.push(e);
    queue({ m: 'PUT', p: '/api/events/' + e.id, b: eventBody(e) });
  }
  function patchEvent(id, data) {
    const e = S.events.find((x) => x.id === id);
    if (!e) return;
    Object.assign(e, data);
    queue({ m: 'PATCH', p: '/api/events/' + id, b: data });
  }
  function removeEvent(id) {
    S.events = S.events.filter((x) => x.id !== id);
    queue({ m: 'DELETE', p: '/api/events/' + id });
  }
  function toggleTask(id) {
    const t = S.tasks.find((x) => x.id === id);
    if (!t) return;
    const done = !t.done;
    patchTask(id, { done, doneAt: done ? new Date().toISOString() : null });
    if (done) snackbar('Tugas selesai.', 'Urungkan', () => patchTask(id, { done: false, doneAt: null }));
  }

  /* ---------------- derived ---------------- */
  const open = () => S.tasks.filter((t) => !t.done);
  const qOrder = (t) => (t.quadrant ? QK.indexOf(t.quadrant) : 9);
  const byDue = (a, b) => (a.due || '9999').localeCompare(b.due || '9999') || (a.time || '99').localeCompare(b.time || '99') || (a.createdAt || '').localeCompare(b.createdAt || '');
  const evSort = (a, b) => (a.start || '').localeCompare(b.start || '') || (a.title || '').localeCompare(b.title || '');
  function counts() {
    const t = today(), o = open();
    return {
      q1: o.filter((x) => x.quadrant === 'q1').length,
      over: o.filter((x) => x.due && x.due < t).length,
      dueToday: o.filter((x) => x.due === t).length,
      evToday: S.events.filter((e) => e.date === t).length,
      inbox: o.filter((x) => !x.quadrant).length,
    };
  }

  /* ---------------- snackbar ---------------- */
  let snackTimer;
  function snackbar(msg, actionLabel, action) {
    const host = $('#snackbar-host');
    host.innerHTML = `<div class="snackbar"><p>${esc(msg)}</p>${actionLabel ? `<button type="button" class="pressable" id="snack-act">${esc(actionLabel)}</button>` : ''}</div>`;
    if (actionLabel) $('#snack-act').onclick = () => { host.innerHTML = ''; action(); };
    clearTimeout(snackTimer);
    snackTimer = setTimeout(() => { host.innerHTML = ''; }, 4000);
  }

  /* ---------------- overlays + back button ---------------- */
  // Every sheet/dialog pushes one history entry; Android back pops it and closes the overlay.
  const stack = [];
  let ignorePops = 0;
  function openOverlay(dlg) {
    if (dlg.open) return;
    dlg.removeAttribute('data-closing');
    dlg.showModal();
    stack.push(dlg);
    history.pushState({ tab: S.tab, overlay: true }, '');
  }
  function closeOverlay(dlg, fromPop) {
    const i = stack.indexOf(dlg);
    if (i < 0) return;
    stack.splice(i, 1);
    if (!fromPop) { ignorePops++; history.back(); }
    const instant = getComputedStyle(document.documentElement).getPropertyValue('--dur-2').trim() === '0ms';
    if (instant) { dlg.close(); return; }
    dlg.setAttribute('data-closing', '');
    setTimeout(() => { dlg.close(); dlg.removeAttribute('data-closing'); }, 240);
  }
  window.addEventListener('popstate', (e) => {
    if (ignorePops > 0) { ignorePops--; return; }
    if (stack.length) { closeOverlay(stack[stack.length - 1], true); return; }
    const t = e.state && e.state.tab;
    S.tab = TABS.includes(t) ? t : 'matriks';
    render(); window.scrollTo(0, 0);
  });
  for (const d of document.querySelectorAll('dialog')) {
    d.addEventListener('cancel', (e) => { e.preventDefault(); closeOverlay(d); });
    d.addEventListener('click', (e) => { if (e.target === d) closeOverlay(d); });
  }

  function goTab(tab) {
    if (tab === S.tab) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    // Beranda (matriks) is the root: other tabs replace each other, so back returns to it.
    if (S.tab === 'matriks') history.pushState({ tab }, '', '#' + tab);
    else if (tab === 'matriks') { history.back(); return; }
    else history.replaceState({ tab }, '', '#' + tab);
    S.tab = tab;
    render();
    window.scrollTo(0, 0);
  }

  /* confirm dialog */
  const confirmDlg = $('#confirm');
  let confirmFn = null;
  function confirmAsk(title, text, yes, fn) {
    $('#confirm-title').textContent = title;
    $('#confirm-text').textContent = text;
    $('#confirm-yes').textContent = yes;
    confirmFn = fn;
    openOverlay(confirmDlg);
  }
  $('#confirm-no').onclick = () => closeOverlay(confirmDlg);
  $('#confirm-yes').onclick = () => { const fn = confirmFn; closeOverlay(confirmDlg); if (fn) setTimeout(fn, 0); };

  /* ---------------- editor sheet ---------------- */
  const sheet = $('#sheet'), panel = $('#sheet-panel');
  let ctx = null; // { kind: 'task'|'event', item?, preset? , allowSwitch }

  function openEditor(c) {
    ctx = c;
    drawEditor();
    openOverlay(sheet);
    if (!c.item) setTimeout(() => $('#f-title')?.focus(), 60);
  }
  function drawEditor() {
    const { kind, item } = ctx;
    const p = ctx.preset || {};
    $('#sheet-title').textContent = item ? (kind === 'task' ? 'Ubah tugas' : 'Ubah acara') : 'Tambah';
    const sw = !item ? `
      <div class="segmented" role="radiogroup" aria-label="Jenis">
        <label><input type="radio" name="kind" value="task" ${kind === 'task' ? 'checked' : ''}><span>${icon('check')}Tugas</span></label>
        <label><input type="radio" name="kind" value="event" ${kind === 'event' ? 'checked' : ''}><span>${icon('check')}Acara</span></label>
      </div>` : '';
    let fields;
    if (kind === 'task') {
      const t = item || {};
      const q = item ? t.quadrant : (p.quadrant ?? null);
      fields = `
        <div><label class="label" for="f-title">Judul</label><input class="field" id="f-title" name="title" value="${esc(t.title)}" maxlength="300" autocomplete="off" enterkeyhint="done" placeholder="Mau mengerjakan apa?"></div>
        <fieldset class="qfs" aria-label="Kuadran"><span class="label">Kuadran</span><div class="qpick">
          ${QK.map((k) => `<label class="qopt ${k}"><input type="radio" name="quadrant" value="${k}" ${q === k ? 'checked' : ''}><span><b>${QS[k].code} ${QS[k].name}</b><small>${QS[k].sub}</small></span></label>`).join('')}
          <label class="qopt none"><input type="radio" name="quadrant" value="" ${!q ? 'checked' : ''}><span><b>Belum dipilah</b></span></label>
        </div></fieldset>
        <div class="fieldset-row">
          <div><label class="label" for="f-due">Tenggat</label><input class="field num" type="date" id="f-due" name="due" value="${esc(item ? t.due || '' : p.due || '')}"></div>
          <div><label class="label" for="f-time">Jam</label><input class="field num" type="time" id="f-time" name="time" value="${esc(t.time || '')}"></div>
        </div>
        <div id="deleg" ${q === 'q3' ? '' : 'hidden'}><label class="label" for="f-deleg">Diserahkan ke</label><input class="field" id="f-deleg" name="delegateTo" value="${esc(t.delegateTo || '')}" maxlength="100" autocomplete="off" placeholder="Nama orangnya"></div>
        <div><label class="label" for="f-notes">Catatan</label><textarea class="field" id="f-notes" name="notes" maxlength="5000">${esc(t.notes || '')}</textarea></div>`;
    } else {
      const e = item || {};
      fields = `
        <div><label class="label" for="f-title">Nama acara</label><input class="field" id="f-title" name="title" value="${esc(e.title)}" maxlength="300" autocomplete="off" enterkeyhint="done" placeholder="Rapat, janji, pengiriman…"></div>
        <div><label class="label" for="f-date">Tanggal</label><input class="field num" type="date" id="f-date" name="date" value="${esc(e.date || p.date || S.sel || today())}" required></div>
        <div class="fieldset-row">
          <div><label class="label" for="f-start">Mulai</label><input class="field num" type="time" id="f-start" name="start" value="${esc(e.start || '')}"></div>
          <div><label class="label" for="f-end">Selesai</label><input class="field num" type="time" id="f-end" name="end" value="${esc(e.end || '')}"></div>
        </div>
        <div><label class="label" for="f-notes">Catatan</label><textarea class="field" id="f-notes" name="notes" maxlength="5000">${esc(e.notes || '')}</textarea></div>`;
    }
    $('#sheet-body').innerHTML = `<div class="fields">${sw}${fields}<p class="error-text" id="f-err" hidden></p></div>`;
    $('#sheet-foot').innerHTML = item
      ? `<button type="button" class="icon-btn tonal pressable" id="f-del" aria-label="Hapus">${icon('trash')}</button><button type="submit" class="btn filled lg pressable">Simpan</button>`
      : `<button type="submit" class="btn filled lg block pressable">${kind === 'task' ? 'Tambah tugas' : 'Tambah acara'}</button>`;
  }
  $('#sheet-body').addEventListener('change', (e) => {
    if (e.target.name === 'kind') {
      const title = $('#f-title')?.value || '';
      ctx.kind = e.target.value;
      drawEditor();
      $('#f-title').value = title;
    }
    if (e.target.name === 'quadrant') $('#deleg').hidden = e.target.value !== 'q3';
  });
  $('#sheet-foot').addEventListener('click', (e) => {
    if (!e.target.closest('#f-del')) return;
    const { kind, item } = ctx;
    confirmAsk(kind === 'task' ? 'Hapus tugas ini?' : 'Hapus acara ini?', `"${item.title}" akan hilang dan tidak bisa dikembalikan.`, 'Hapus', () => {
      if (kind === 'task') removeTask(item.id); else removeEvent(item.id);
      closeOverlay(sheet);
      snackbar(kind === 'task' ? 'Tugas dihapus.' : 'Acara dihapus.');
    });
  });
  $('#sheet-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const v = (k) => String(f.get(k) ?? '').trim();
    const err = $('#f-err');
    const title = v('title');
    if (!title) { $('#f-title').setAttribute('aria-invalid', 'true'); err.textContent = 'Isi judulnya dulu.'; err.hidden = false; $('#f-title').focus(); return; }
    const { kind, item } = ctx;
    if (kind === 'task') {
      const quadrant = v('quadrant') || null;
      const data = { title, quadrant, due: v('due') || null, time: v('time') || null, notes: v('notes'), delegateTo: quadrant === 'q3' ? v('delegateTo') || null : null };
      if (item) patchTask(item.id, data); else createTask(data);
      snackbar(item ? 'Tugas disimpan.' : 'Tugas ditambahkan.');
    } else {
      const date = v('date');
      if (!date) { err.textContent = 'Pilih tanggal acaranya.'; err.hidden = false; return; }
      const start = v('start') || null, end = v('end') || null;
      if (start && end && end < start) { err.textContent = 'Jam selesai harus setelah jam mulai.'; err.hidden = false; return; }
      const data = { title, date, start, end, notes: v('notes') };
      if (item) patchEvent(item.id, data); else createEvent(data);
      if (!item) { S.sel = date; S.month = date.slice(0, 7); }
      snackbar(item ? 'Acara disimpan.' : 'Acara ditambahkan.');
    }
    closeOverlay(sheet);
  });

  // Drag the handle down to close the sheet.
  (() => {
    const grab = $('#sheet-grab');
    let y0 = null, dy = 0;
    grab.addEventListener('pointerdown', (e) => { y0 = e.clientY; dy = 0; grab.setPointerCapture(e.pointerId); panel.style.transition = 'none'; });
    grab.addEventListener('pointermove', (e) => { if (y0 == null) return; dy = Math.max(0, e.clientY - y0); panel.style.transform = `translateY(${dy}px)`; });
    const end = () => {
      if (y0 == null) return;
      y0 = null;
      panel.style.transition = '';
      panel.style.transform = '';
      if (dy > 96) closeOverlay(sheet);
    };
    grab.addEventListener('pointerup', end);
    grab.addEventListener('pointercancel', end);
  })();

  /* ---------------- views ---------------- */
  function taskRow(t, { showQ = true } = {}) {
    const tt = today();
    const over = !t.done && t.due && t.due < tt;
    const sub = [];
    if (t.due) sub.push(`<span class="meta num ${over ? 'over' : ''}">${icon('clock', 'xs')}${fmtDate(t.due)}${t.time ? ' · ' + esc(t.time) : ''}</span>`);
    if (t.delegateTo) sub.push(`<span class="meta">${icon('handoff', 'xs')}${esc(t.delegateTo)}</span>`);
    if (t.notes) sub.push(`<span class="meta">${icon('note', 'xs')}Catatan</span>`);
    const tag = showQ ? (t.quadrant ? `<span class="tag ${t.quadrant}">${QS[t.quadrant].code}</span>` : `<span class="tag plain">Pilah</span>`) : '';
    return `<li class="row ${t.done ? 'done' : ''}" data-id="${t.id}">
      <button type="button" class="check" role="checkbox" aria-checked="${!!t.done}" data-act="toggle" data-id="${t.id}" aria-label="${esc(t.title)}: tandai ${t.done ? 'belum selesai' : 'selesai'}"><span class="box">${icon('check')}</span></button>
      <button type="button" class="row-main" data-act="edit-task" data-id="${t.id}"><span class="row-title">${esc(t.title)}</span><span class="row-sub">${sub.join('')}</span></button>
      ${tag ? `<span class="row-end">${tag}</span>` : ''}
    </li>`;
  }
  const eventRow = (e) => `<li class="row event-row" data-eid="${e.id}"><span class="time-col">${e.start ? esc(e.start) + (e.end ? '–' + esc(e.end) : '') : 'Seharian'}</span><button type="button" class="row-main" data-act="edit-event" data-id="${e.id}"><span class="row-title">${esc(e.title)}</span>${e.notes ? `<span class="row-sub"><span class="meta">${icon('note', 'xs')}Catatan</span></span>` : ''}</button></li>`;

  const LIST_LABELS = { 'hari-ini': 'Hari ini', terlambat: 'Terlambat', mendatang: 'Mendatang', 'tanpa-tanggal': 'Tanpa tanggal', selesai: 'Selesai' };
  const EMPTY_LIST = {
    'hari-ini': ['Tidak ada yang jatuh tempo hari ini', 'Tugas dengan tenggat hari ini muncul di sini.'],
    terlambat: ['Tidak ada yang terlambat', 'Tugas yang lewat tenggat muncul di sini.'],
    mendatang: ['Belum ada tugas mendatang', 'Beri tenggat pada tugas supaya muncul di sini.'],
    'tanpa-tanggal': ['Semua tugas sudah bertanggal', 'Tugas tanpa tenggat muncul di sini.'],
    selesai: ['Belum ada yang selesai', 'Centang tugas untuk menandainya selesai.'],
  };
  function listGroups(qfilter) {
    const t = today();
    const f = (arr) => (qfilter === 'none' ? arr.filter((x) => !x.quadrant) : qfilter === 'all' ? arr : arr.filter((x) => x.quadrant === qfilter));
    const o = f(open());
    return {
      'hari-ini': o.filter((x) => x.due === t),
      terlambat: o.filter((x) => x.due && x.due < t),
      mendatang: o.filter((x) => x.due && x.due > t),
      'tanpa-tanggal': o.filter((x) => !x.due),
      selesai: f(S.tasks.filter((x) => x.done)),
    };
  }
  const listTabs = (groups) => Object.keys(LIST_LABELS).map((k) => `<button type="button" role="tab" class="stab ${k === 'terlambat' && groups[k].length ? 'over' : ''}" data-act="list-tab" data-k="${k}" aria-selected="${S.listTab === k}">${LIST_LABELS[k]} <span class="n">${groups[k].length}</span></button>`).join('');

  // The month grid for S.month. Day cells are drop targets: drop a task to set its due date, an event to move it.
  function calParts(compact) {
    const [y, m] = S.month.split('-').map(Number);
    const first = new Date(y, m - 1, 1);
    const offset = (first.getDay() + 6) % 7;
    const cells = Math.ceil((offset + new Date(y, m, 0).getDate()) / 7) * 7;
    const start = new Date(y, m - 1, 1 - offset);
    const t = today();
    const tasksBy = {}, evBy = {};
    S.tasks.forEach((x) => { if (x.due) (tasksBy[x.due] ||= []).push(x); });
    S.events.forEach((e) => { (evBy[e.date] ||= []).push(e); });
    let grid = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'].map((d) => `<div class="dow" aria-hidden="true">${d}</div>`).join('');
    for (let i = 0; i < cells; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i);
      const s = ymd(d);
      const evs = (evBy[s] || []).slice().sort(evSort);
      const tks = (tasksBy[s] || []).slice().sort((a, b) => a.done - b.done || qOrder(a) - qOrder(b));
      const items = compact ? [] : [
        ...evs.map((e) => `<span class="pill">${e.start ? esc(e.start) + ' ' : ''}${esc(e.title)}</span>`),
        ...tks.map((x) => `<span class="pill ${x.quadrant || 'q4'} ${x.done ? 'done' : ''}">${esc(x.title)}</span>`),
      ];
      const dots = [...evs.map(() => '<i class="ev"></i>'), ...tks.filter((x) => !x.done).map((x) => `<i class="${x.quadrant || 'q4'}"></i>`)].slice(0, 4).join('');
      const label = `${longDate(s)}${evs.length ? `, ${evs.length} acara` : ''}${tks.length ? `, ${tks.length} tugas` : ''}`;
      grid += `<button type="button" role="gridcell" class="day pressable ${d.getMonth() !== m - 1 ? 'out' : ''} ${s === t ? 'today' : ''}" data-act="pick-day" data-d="${s}" data-drop-day="${s}" aria-selected="${s === S.sel}" aria-label="${label}">
        <span class="dn">${d.getDate()}</span><span class="dots">${dots}</span>
        ${compact ? '' : `<span class="day-items">${items.slice(0, 3).join('')}${items.length > 3 ? `<span class="more">+${items.length - 3} lagi</span>` : ''}</span>`}</button>`;
    }
    const sel = S.sel;
    const rows = [
      ...(evBy[sel] || []).slice().sort(evSort).map(eventRow),
      ...(tasksBy[sel] || []).slice().sort((a, b) => a.done - b.done || qOrder(a) - qOrder(b)).map((x) => taskRow(x)),
    ];
    const head = `<div class="cal-head">
            <h2>${MONF[m - 1]} <span class="num">${y}</span></h2>
            <button type="button" class="btn text pressable" data-act="month-today">Hari ini</button>
            <button type="button" class="icon-btn pressable" data-act="month" data-n="-1" aria-label="Bulan sebelumnya">${icon('left')}</button>
            <button type="button" class="icon-btn pressable" data-act="month" data-n="1" aria-label="Bulan berikutnya">${icon('right')}</button>
          </div>`;
    return { head, grid: `<div class="cal ${compact ? 'compact' : ''}" role="grid" aria-label="${MONF[m - 1]} ${y}">${grid}</div>`, rows };
  }

  function section({ title, count, action, body, cls = '', attrs = '' }) {
    return `<section class="quad ${cls}" ${attrs}>
      <div class="section-h"><h2>${title}${count != null ? ` <span class="count">${count}</span>` : ''}</h2>${action || ''}</div>
      <div class="card"><ul>${body}</ul></div>
    </section>`;
  }

  function statusPill() {
    const pending = outbox.length;
    return !S.online
      ? `<span class="offline-pill">${icon('offline', 'xs')}Offline${pending ? ` · ${pending}` : ''}</span>`
      : pending ? `<span class="offline-pill">${icon('refresh', 'xs')}Menyimpan</span>` : '';
  }
  function topbar(title, { brand = false } = {}) {
    // On wide screens the other pages open from the board, so they get a way back to it.
    const back = wideMq.matches ? `<button type="button" class="icon-btn pressable" data-act="tab" data-tab="matriks" aria-label="Kembali ke papan">${icon('left')}</button>` : '';
    return `<header class="topbar ${brand ? 'brand' : ''}" id="topbar"><div class="wrap ${S.tab === 'matriks' || S.tab === 'kalender' ? 'wide' : ''} topbar-in">${back}<h1>${title}</h1>${statusPill()}</div></header>`;
  }

  function viewMatrix() {
    const c = counts();
    const o = open();
    const inbox = o.filter((t) => !t.quadrant).sort(byDue);
    const detail = [c.over ? `${c.over} terlambat` : null, `${c.dueToday} jatuh tempo hari ini`, `${c.evToday} acara hari ini`].filter(Boolean).join(' · ');
    const quad = (k) => {
      const list = o.filter((t) => t.quadrant === k).sort(byDue);
      return section({
        cls: k, attrs: `data-drop="${k}"`,
        title: `<span class="tag ${k}">${QS[k].code}</span>${QS[k].name}`,
        count: list.length,
        action: `<button type="button" class="link-btn pressable" data-act="new-task" data-q="${k}">Tambah</button>`,
        body: list.length ? list.map((t) => taskRow(t, { showQ: false })).join('') : `<li class="empty-row">Belum ada tugas di sini.</li>`,
      });
    };
    return `
      ${topbar('Papan Prioritas', { brand: true })}
      <div class="brand-header"><div class="wrap wide">
        <p class="eyebrow">Penting &amp; mendesak</p>
        <p class="figure num">${c.q1} tugas</p>
        <p class="detail num">${detail}</p>
      </div></div>
      <main class="wrap wide stack">
        <div class="quick">
          <button type="button" class="pressable" data-act="new-task">${`<span class="tile lg">${icon('plus')}</span>`}<span class="lbl">Tugas</span></button>
          <button type="button" class="pressable" data-act="new-event">${`<span class="tile lg">${icon('cal-plus')}</span>`}<span class="lbl">Acara</span></button>
          <button type="button" class="pressable" data-act="go-today"><span class="tile lg">${icon('sun')}</span><span class="lbl">Hari ini</span></button>
          <button type="button" class="pressable" data-act="go-inbox"><span class="badge-host"><span class="tile lg">${icon('inbox')}</span>${c.inbox ? `<span class="badge">${c.inbox}</span>` : ''}</span><span class="lbl">Pilah</span></button>
        </div>
        ${banner()}
        ${inbox.length ? section({ cls: '', attrs: 'id="inbox" data-drop="none"', title: 'Belum dipilah', count: inbox.length, body: inbox.map((t) => taskRow(t)).join('') }) : ''}
        <div class="matrix">
          <span class="corner"></span><div class="axis">Mendesak</div><div class="axis">Tidak mendesak</div>
          <div class="axis v">Penting</div>${quad('q1')}${quad('q2')}
          <div class="axis v">Tidak penting</div>${quad('q3')}${quad('q4')}
        </div>
      </main>`;
  }

  function viewList() {
    const groups = listGroups(S.qfilter);
    const tabs = listTabs(groups);
    const chips = [['all', 'Semua'], ...QK.map((k) => [k, `${QS[k].code} ${QS[k].name}`]), ['none', 'Belum dipilah']]
      .map(([k, l]) => `<button type="button" class="chip pressable" data-act="qfilter" data-k="${k}" aria-pressed="${S.qfilter === k}">${icon('check', 'sm')}${l}</button>`).join('');

    const list = groups[S.listTab];
    let body;
    if (!list.length) {
      const msg = EMPTY_LIST[S.listTab];
      body = `<div class="card"><div class="empty"><span class="tile lg">${icon('list')}</span><h3>${msg[0]}</h3><p>${msg[1]}</p><button type="button" class="btn tonal pressable" data-act="new-task">${icon('plus', 'sm')}Tambah tugas</button></div></div>`;
    } else if (S.listTab === 'mendatang') {
      const by = {};
      list.sort(byDue).forEach((x) => (by[x.due] ||= []).push(x));
      body = Object.keys(by).sort().map((d) => section({ title: fmtDate(d), count: by[d].length, body: by[d].map((x) => taskRow(x)).join('') })).join('');
    } else if (S.listTab === 'selesai') {
      list.sort((a, b) => (b.doneAt || '').localeCompare(a.doneAt || ''));
      body = section({ title: 'Selesai', count: list.length, action: `<button type="button" class="link-btn pressable" data-act="purge">Hapus semua</button>`, body: list.slice(0, 100).map((x) => taskRow(x)).join('') });
    } else {
      list.sort((a, b) => qOrder(a) - qOrder(b) || byDue(a, b));
      body = `<div class="card"><ul>${list.map((x) => taskRow(x)).join('')}</ul></div>`;
    }
    return `
      ${topbar('Tugas')}
      <div class="wrap"><div class="tabs scroll-row" role="tablist" aria-label="Status tugas">${tabs}</div>
      <div class="chips scroll-row" role="group" aria-label="Kuadran">${chips}</div></div>
      <main class="wrap stack">${banner()}<div class="stack">${body}</div></main>`;
  }

  function viewCal() {
    const cal = calParts(false);
    return `
      ${topbar('Kalender')}
      <main class="wrap wide stack">
        ${banner()}
        <div class="card">${cal.head}${cal.grid}</div>
        ${section({
          title: esc(longDate(S.sel)),
          action: `<button type="button" class="link-btn pressable" data-act="new-event" data-d="${S.sel}">Tambah acara</button>`,
          body: cal.rows.length ? cal.rows.join('') : `<li class="empty-row">Belum ada acara atau tugas.</li>`,
        })}
      </main>`;
  }

  // Wide screens (tablet landscape, desktop): the matrix fills the screen, the to-do list and the
  // calendar sit in a column on the right. Everything is one screen; each list scrolls on its own.
  function viewBoard() {
    const c = counts();
    const o = open();
    const inbox = o.filter((t) => !t.quadrant).sort(byDue);
    const quad = (k) => {
      const list = o.filter((t) => t.quadrant === k).sort(byDue);
      return `<section class="bq ${k}" data-drop="${k}" aria-labelledby="bq-${k}">
        <header class="bq-h"><span class="tag ${k}">${QS[k].code}</span><div class="bq-t"><h2 id="bq-${k}">${QS[k].name}</h2><p>${QS[k].sub}</p></div><span class="bq-n num">${list.length}</span>
          <button type="button" class="icon-btn pressable" data-act="new-task" data-q="${k}" aria-label="Tambah ke ${QS[k].name}">${icon('plus')}</button></header>
        <ul class="bq-list" data-scroll="${k}">${list.length ? list.map((t) => taskRow(t, { showQ: false })).join('') : `<li class="empty-row">Belum ada tugas. Seret ke sini atau ketuk +.</li>`}</ul>
      </section>`;
    };
    const groups = listGroups('all');
    const list = groups[S.listTab].slice();
    if (S.listTab === 'selesai') list.sort((a, b) => (b.doneAt || '').localeCompare(a.doneAt || ''));
    else if (S.listTab === 'tanpa-tanggal') list.sort((a, b) => qOrder(a) - qOrder(b) || (a.createdAt || '').localeCompare(b.createdAt || ''));
    else list.sort((a, b) => byDue(a, b) || qOrder(a) - qOrder(b));
    const cal = calParts(true);
    const pulse = [`<b>${c.q1}</b> penting &amp; mendesak`, c.over ? `<b class="over">${c.over}</b> terlambat` : null, `<b>${c.dueToday}</b> jatuh tempo hari ini`, `<b>${c.evToday}</b> acara hari ini`].filter(Boolean).join('<span aria-hidden="true"> · </span>');
    const fsOn = !!document.fullscreenElement;
    return `
      <header class="board-top"><div class="board-top-in">
        <h1>Papan Prioritas</h1>
        <p class="board-pulse num">${pulse}</p>
        ${statusPill()}
        ${document.fullscreenEnabled ? `<button type="button" class="icon-btn pressable" data-act="fullscreen" aria-label="${fsOn ? 'Keluar layar penuh' : 'Layar penuh'}">${icon(fsOn ? 'minimize' : 'maximize')}</button>` : ''}
        <button type="button" class="icon-btn pressable" data-act="tab" data-tab="lainnya" aria-label="Lainnya">${icon('menu')}</button>
        <button type="button" class="btn filled pressable" data-act="new-task">${icon('plus', 'sm')}Tambah</button>
      </div></header>
      ${S.updateReady ? `<div class="board-banner">${banner()}</div>` : ''}
      <div class="board">
        <section class="board-matrix" aria-label="Matriks Eisenhower">
          ${inbox.length ? `<div class="inbox-strip" data-drop="none"><span class="strip-l">Belum dipilah <span class="num">${inbox.length}</span></span>
            <ul class="strip-list scroll-row">${inbox.map((t) => `<li class="row strip-task" data-id="${t.id}"><button type="button" class="row-main" data-act="edit-task" data-id="${t.id}"><span class="row-title">${esc(t.title)}</span></button></li>`).join('')}</ul></div>` : ''}
          <div class="bm-grid">
            <span class="corner"></span><div class="axis">Mendesak</div><div class="axis">Tidak mendesak</div>
            <div class="axis v">Penting</div>${quad('q1')}${quad('q2')}
            <div class="axis v">Tidak penting</div>${quad('q3')}${quad('q4')}
          </div>
        </section>
        <aside class="board-side">
          <section class="side-card side-todo" aria-labelledby="side-todo-h">
            <div class="side-h"><h2 id="side-todo-h">Tugas</h2></div>
            <div class="tabs scroll-row" role="tablist" aria-label="Status tugas">${listTabs(groups)}</div>
            <ul class="side-list" data-scroll="todo-${S.listTab}">${list.length ? list.slice(0, 200).map((x) => taskRow(x)).join('') : `<li class="empty-row">${EMPTY_LIST[S.listTab][0]}.</li>`}</ul>
          </section>
          <section class="side-card side-cal" aria-label="Kalender">
            ${cal.head}${cal.grid}
            <div class="side-day">
              <div class="side-day-h"><h3>${esc(fmtDate(S.sel))}</h3><button type="button" class="link-btn pressable" data-act="new-event" data-d="${S.sel}">Tambah acara</button></div>
              <ul class="side-list" data-scroll="day">${cal.rows.length ? cal.rows.join('') : `<li class="empty-row">Belum ada acara atau tugas.</li>`}</ul>
            </div>
          </section>
        </aside>
      </div>`;
  }

  function viewMore() {
    const u = S.user;
    const p = PP.prefs;
    const seg = (name, cur, opts) => `<div class="segmented" role="radiogroup" aria-label="${name}">${opts.map(([v, l]) => `<label><input type="radio" name="${name}" value="${v}" ${cur === v ? 'checked' : ''}><span>${icon('check')}${l}</span></label>`).join('')}</div>`;
    const doneCount = S.tasks.filter((x) => x.done).length;
    return `
      ${topbar('Lainnya')}
      <main class="wrap stack">
        ${banner()}
        <section>
          <div class="section-h"><h2>Akun</h2></div>
          <div class="card"><div class="set-row"><span class="tile">${icon('user')}</span><div class="grow"><p class="t-headline">${esc(u.name || 'Kamu')}</p><p class="t-subhead c-2">${esc(u.email)}</p></div></div></div>
        </section>
        <section>
          <div class="section-h"><h2>Tampilan</h2></div>
          <div class="card">
            <div class="set-block"><span class="label">Tema</span>${seg('theme', p.theme, [['system', 'Sistem'], ['light', 'Terang'], ['dark', 'Gelap']])}</div>
            <div class="set-block"><span class="label">Mode</span>${seg('perf', p.perf, [['beautify', 'Tampilan Indah'], ['performance', 'Performa Tinggi']])}</div>
            <div class="set-block"><span class="label">Warna utama</span><div class="swatches" role="radiogroup" aria-label="Warna utama">
              ${BRANDS.map((b) => `<label class="swatch"><input type="radio" name="brand" value="${b.hex}" ${p.brand.toLowerCase() === b.hex ? 'checked' : ''} aria-label="${b.name}"><span><i data-color="${b.hex}"></i></span></label>`).join('')}
            </div></div>
          </div>
        </section>
        <section>
          <div class="section-h"><h2>Data</h2></div>
          <div class="card">
            ${S.installEvt ? `<button type="button" class="set-row pressable row-btn" data-act="install"><span class="tile">${icon('download')}</span><span class="grow t-headline">Pasang aplikasi</span>${icon('right', 'sm')}</button>` : ''}
            <button type="button" class="set-row pressable row-btn" data-act="refresh"><span class="tile">${icon('refresh')}</span><span class="grow t-headline">Muat ulang data</span>${icon('right', 'sm')}</button>
            <button type="button" class="set-row pressable row-btn" data-act="purge" ${doneCount ? '' : 'disabled'}><span class="tile">${icon('trash')}</span><span class="grow"><span class="t-headline">Hapus tugas selesai</span><br><span class="t-subhead c-2 num">${doneCount} tugas</span></span>${icon('right', 'sm')}</button>
            <button type="button" class="set-row pressable row-btn danger" data-act="logout"><span class="tile">${icon('logout')}</span><span class="grow t-headline">Keluar</span></button>
          </div>
        </section>
      </main>`;
  }

  function banner() {
    if (!S.updateReady) return '';
    return `<div class="banner"><p>Versi baru siap.</p><button type="button" class="btn text pressable" data-act="update">Muat ulang</button></div>`;
  }

  function bottomNav() {
    const item = (tab, ic, label) => `<a href="#${tab}" class="nav-item" data-act="tab" data-tab="${tab}" ${S.tab === tab ? 'aria-current="page"' : ''}><span class="pill-bg">${icon(ic)}</span><span class="nl">${label}</span></a>`;
    return `<nav class="bottom-nav" aria-label="Menu utama"><div class="in">
      ${item('matriks', 'grid', 'Matriks')}${item('tugas', 'list', 'Tugas')}
      <div class="nav-center"><button type="button" class="nav-fab pressable" data-act="new-task" aria-label="Tambah tugas atau acara">${icon('plus')}</button><span class="nl" aria-hidden="true">Tambah</span></div>
      ${item('kalender', 'cal', 'Kalender')}${item('lainnya', 'menu', 'Lainnya')}
    </div></nav>`;
  }

  const wideMq = window.matchMedia('(min-width: 960px)');
  wideMq.addEventListener('change', () => render());
  let renderLater = false;

  function render() {
    if (!S.user || !S.loaded) return;
    if (DRAG.active) { renderLater = true; return; } // never swap the DOM under a finger mid-drag
    const a = document.activeElement;
    const keepId = a && a.dataset && a.dataset.act ? a.dataset.act + '|' + (a.dataset.id || a.dataset.k || a.dataset.tab || a.dataset.q || a.dataset.d || '') : null;
    // Lists in the board scroll on their own; keep their positions across re-renders.
    const scrolls = {};
    app.querySelectorAll('[data-scroll]').forEach((el) => { scrolls[el.dataset.scroll] = el.scrollTop; });
    const board = wideMq.matches && S.tab !== 'lainnya';
    document.documentElement.classList.toggle('board-mode', board);
    const view = board ? viewBoard() : { matriks: viewMatrix, tugas: viewList, kalender: viewCal, lainnya: viewMore }[S.tab]();
    app.innerHTML = view + (wideMq.matches ? '' : bottomNav());
    app.querySelectorAll('[data-scroll]').forEach((el) => { if (scrolls[el.dataset.scroll]) el.scrollTop = scrolls[el.dataset.scroll]; });
    // Swatch colours are data, painted through the CSSOM (CSP allows no inline styles).
    app.querySelectorAll('[data-color]').forEach((el) => { el.style.background = el.dataset.color; });
    if (keepId) {
      const [act, key] = keepId.split('|');
      const el = [...app.querySelectorAll(`[data-act="${act}"]`)].find((x) => (x.dataset.id || x.dataset.k || x.dataset.tab || x.dataset.q || x.dataset.d || '') === key);
      el?.focus({ preventScroll: true });
    }
    syncChrome();
  }
  function syncChrome() {
    const brand = S.tab === 'matriks' && !wideMq.matches;
    PP.setThemeColor(brand ? getComputedStyle(document.documentElement).getPropertyValue('--brand').trim() : PP.pageColor());
    $('#topbar')?.classList.toggle('scrolled', window.scrollY > (brand ? 40 : 4));
  }
  window.addEventListener('scroll', () => $('#topbar')?.classList.toggle('scrolled', window.scrollY > (S.tab === 'matriks' ? 40 : 4)), { passive: true });
  PP.watchSystemTheme(syncChrome);

  /* ---------------- events ---------------- */
  app.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    switch (act) {
      case 'tab': e.preventDefault(); goTab(b.dataset.tab); break;
      case 'toggle': toggleTask(b.dataset.id); break;
      case 'edit-task': { const t = S.tasks.find((x) => x.id === b.dataset.id); if (t) openEditor({ kind: 'task', item: t }); break; }
      case 'edit-event': { const ev = S.events.find((x) => x.id === b.dataset.id); if (ev) openEditor({ kind: 'event', item: ev }); break; }
      case 'new-task': openEditor({ kind: 'task', preset: { quadrant: b.dataset.q || null, due: S.tab === 'kalender' ? S.sel : (S.tab === 'tugas' && S.listTab === 'hari-ini' ? today() : null) } }); break;
      case 'new-event': openEditor({ kind: 'event', preset: { date: b.dataset.d || (S.tab === 'kalender' ? S.sel : today()) } }); break;
      case 'go-today': S.listTab = 'hari-ini'; S.qfilter = 'all'; goTab('tugas'); break;
      case 'go-inbox': {
        const el = $('#inbox');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        else snackbar('Semua tugas sudah dipilah.');
        break;
      }
      case 'list-tab': S.listTab = b.dataset.k; render(); break;
      case 'qfilter': S.qfilter = b.dataset.k; render(); break;
      case 'month': { const [y, m] = S.month.split('-').map(Number); S.month = ymd(new Date(y, m - 1 + Number(b.dataset.n), 1)).slice(0, 7); render(); break; }
      case 'month-today': S.month = today().slice(0, 7); S.sel = today(); render(); break;
      case 'pick-day': S.sel = b.dataset.d; if (S.sel.slice(0, 7) !== S.month) S.month = S.sel.slice(0, 7); render(); break;
      case 'purge': {
        const n = S.tasks.filter((x) => x.done).length;
        if (!n) break;
        confirmAsk('Hapus tugas selesai?', `${n} tugas yang sudah selesai akan dihapus dan tidak bisa dikembalikan.`, 'Hapus', () => {
          S.tasks = S.tasks.filter((x) => !x.done);
          queue({ m: 'POST', p: '/api/tasks/purge-done', b: {} });
          snackbar(`${n} tugas dihapus.`);
        });
        break;
      }
      case 'refresh': refresh().then(() => snackbar(S.online ? 'Data terbaru sudah dimuat.' : 'Kamu sedang offline.')); break;
      case 'install': S.installEvt.prompt(); S.installEvt.userChoice.finally(() => { S.installEvt = null; render(); }); break;
      case 'fullscreen':
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else document.documentElement.requestFullscreen().catch(() => snackbar('Layar penuh tidak tersedia di sini.'));
        break;
      case 'update': if (S.updateReady) { wantReload = true; S.updateReady.postMessage('skip-waiting'); } break;
      case 'logout':
        if (outbox.length) confirmAsk('Ada perubahan belum terkirim', `${outbox.length} perubahan akan hilang kalau kamu keluar sekarang. Sambungkan internet dulu supaya tersimpan.`, 'Keluar saja', logout);
        else logout();
        break;
    }
  });
  app.addEventListener('change', (e) => {
    const t = e.target;
    if (t.name === 'theme') { PP.setTheme(t.value); syncChrome(); }
    if (t.name === 'perf') PP.setPerf(t.value);
    if (t.name === 'brand') { PP.setBrand(t.value); syncChrome(); }
  });

  /* ---------------- drag and drop (touch + mouse) ---------------- */
  // Touch: press and hold a task for a moment, then move. Mouse: press and move.
  // Drop on a quadrant to change its quadrant, on "Belum dipilah" to unsort it, or on a calendar
  // day to set its due date. Events can be dragged to another day.
  const DRAG = { el: null, id: null, kind: null, pid: null, x0: 0, y0: 0, dx: 0, dy: 0, timer: null, active: false, ghost: null, target: null, suppress: false, scroller: null };

  function dropTargetAt(x, y) {
    const el = document.elementFromPoint(x, y);
    const t = el && el.closest('[data-drop], [data-drop-day]');
    if (!t) return null;
    if (DRAG.kind === 'event' && t.dataset.dropDay === undefined) return null;
    return t;
  }
  function startDrag(x, y) {
    clearTimeout(DRAG.timer);
    const r = DRAG.el.getBoundingClientRect();
    DRAG.active = true;
    DRAG.dx = x - r.left; DRAG.dy = y - r.top;
    const g = DRAG.el.cloneNode(true);
    g.classList.add('drag-ghost');
    g.removeAttribute('data-id'); g.removeAttribute('data-eid');
    g.style.width = r.width + 'px';
    document.body.appendChild(g);
    DRAG.ghost = g;
    DRAG.el.classList.add('dragging');
    document.documentElement.classList.add('is-dragging');
    if (navigator.vibrate) { try { navigator.vibrate(12); } catch { /* not allowed */ } }
    moveDrag(x, y);
  }
  function moveDrag(x, y) {
    DRAG.ghost.style.transform = `translate(${Math.round(x - DRAG.dx)}px, ${Math.round(y - DRAG.dy)}px) rotate(-1.5deg)`;
    const t = dropTargetAt(x, y);
    if (t !== DRAG.target) {
      DRAG.target?.classList.remove('drop');
      t?.classList.add('drop');
      DRAG.target = t;
    }
    // Near the top or bottom edge, scroll the page (phone layout) so far quadrants can be reached.
    const edge = 72, speed = y < edge ? -(edge - y) / 4 : y > innerHeight - edge ? (y - (innerHeight - edge)) / 4 : 0;
    cancelAnimationFrame(DRAG.scroller);
    if (speed && !wideMq.matches) {
      const step = () => { window.scrollBy(0, speed); DRAG.scroller = requestAnimationFrame(step); };
      DRAG.scroller = requestAnimationFrame(step);
    }
  }
  function endDrag(x, y) {
    const t = dropTargetAt(x, y);
    const { id, kind } = DRAG;
    cleanupDrag();
    DRAG.suppress = true;
    setTimeout(() => { DRAG.suppress = false; }, 80);
    if (renderLater) { renderLater = false; render(); }
    if (!t) return;
    if (t.dataset.dropDay !== undefined) {
      const day = t.dataset.dropDay;
      if (kind === 'event') {
        const ev = S.events.find((x) => x.id === id);
        if (ev && ev.date !== day) { patchEvent(id, { date: day }); snackbar(`Acara dipindah ke ${fmtDate(day)}.`, 'Urungkan', () => patchEvent(id, { date: ev.date })); }
      } else {
        const tk = S.tasks.find((x) => x.id === id);
        if (tk && tk.due !== day) { const was = tk.due; patchTask(id, { due: day }); snackbar(`Tenggat jadi ${fmtDate(day)}.`, 'Urungkan', () => patchTask(id, { due: was })); }
      }
      S.sel = day;
      render();
      return;
    }
    const q = t.dataset.drop === 'none' ? null : t.dataset.drop;
    const tk = S.tasks.find((x) => x.id === id);
    if (tk && tk.quadrant !== q) {
      const was = tk.quadrant;
      patchTask(id, { quadrant: q, delegateTo: q === 'q3' ? tk.delegateTo : null });
      snackbar(q ? `Dipindah ke ${QS[q].code} ${QS[q].name}.` : 'Dipindah ke Belum dipilah.', 'Urungkan', () => patchTask(id, { quadrant: was }));
    }
  }
  function cleanupDrag() {
    clearTimeout(DRAG.timer);
    cancelAnimationFrame(DRAG.scroller);
    DRAG.ghost?.remove();
    DRAG.el?.classList.remove('dragging');
    DRAG.target?.classList.remove('drop');
    document.documentElement.classList.remove('is-dragging');
    Object.assign(DRAG, { el: null, id: null, kind: null, pid: null, active: false, ghost: null, target: null, timer: null });
  }

  app.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || DRAG.el) return;
    const row = e.target.closest('.row[data-id], .row[data-eid]');
    if (!row || e.target.closest('.check')) return;
    Object.assign(DRAG, { el: row, kind: row.dataset.eid ? 'event' : 'task', id: row.dataset.id || row.dataset.eid, pid: e.pointerId, x0: e.clientX, y0: e.clientY });
    if (e.pointerType !== 'mouse') DRAG.timer = setTimeout(() => { if (DRAG.el) startDrag(DRAG.x0, DRAG.y0); }, 300);
  });
  window.addEventListener('pointermove', (e) => {
    if (!DRAG.el || e.pointerId !== DRAG.pid) return;
    if (DRAG.active) { moveDrag(e.clientX, e.clientY); return; }
    const dist = Math.hypot(e.clientX - DRAG.x0, e.clientY - DRAG.y0);
    if (e.pointerType === 'mouse') { if (dist > 6) startDrag(e.clientX, e.clientY); }
    else if (dist > 10) cleanupDrag(); // the finger moved before the hold finished: it is a scroll
  });
  window.addEventListener('pointerup', (e) => {
    if (!DRAG.el || e.pointerId !== DRAG.pid) return;
    if (DRAG.active) endDrag(e.clientX, e.clientY); else cleanupDrag();
  });
  window.addEventListener('pointercancel', (e) => { if (DRAG.el && e.pointerId === DRAG.pid) { cleanupDrag(); if (renderLater) { renderLater = false; render(); } } });
  // While dragging, the finger moves the task, not the page.
  document.addEventListener('touchmove', (e) => { if (DRAG.active) e.preventDefault(); }, { passive: false });
  document.addEventListener('contextmenu', (e) => { if (DRAG.el) e.preventDefault(); });
  // A drag ends with a click on the row underneath; swallow it so the editor does not open.
  app.addEventListener('click', (e) => { if (DRAG.suppress) { e.preventDefault(); e.stopPropagation(); DRAG.suppress = false; } }, true);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && DRAG.active) cleanupDrag(); });
  document.addEventListener('fullscreenchange', () => render());

  /* ---------------- auth ---------------- */
  let authMode = 'login', signupOpen = false;
  function showAuth(open) {
    if (typeof open === 'boolean') signupOpen = open;
    S.user = null; S.loaded = false;
    authMode = signupOpen ? 'signup' : 'login';
    drawAuth();
  }
  function drawAuth(errMsg = '') {
    PP.setThemeColor(getComputedStyle(document.documentElement).getPropertyValue('--brand').trim());
    const su = authMode === 'signup';
    app.innerHTML = `
      <div class="auth">
        <div class="brand-header"><div class="wrap">
          <span class="mark">${icon('grid')}</span>
          <h1 class="t-title-lg">Papan Prioritas</h1>
          <p class="detail">${su ? 'Buat akun pemilik papan.' : 'Masuk untuk membuka papan kamu.'}</p>
        </div></div>
        <div class="wrap"><form class="auth-card fields" id="auth-form" novalidate>
          ${su ? `<div><label class="label" for="a-name">Nama</label><input class="field" id="a-name" name="name" autocomplete="name" maxlength="80"></div>` : ''}
          <div><label class="label" for="a-email">Email</label><input class="field" id="a-email" name="email" type="email" inputmode="email" autocomplete="${su ? 'email' : 'username'}" required></div>
          <div><label class="label" for="a-pass">Kata sandi</label><input class="field" id="a-pass" name="password" type="password" autocomplete="${su ? 'new-password' : 'current-password'}" required minlength="${su ? 8 : 1}">${su ? '<p class="hint">Minimal 8 karakter.</p>' : ''}</div>
          <p class="error-text" id="a-err" ${errMsg ? '' : 'hidden'}>${esc(errMsg)}</p>
          <button type="submit" class="btn filled lg block pressable" id="a-submit">${su ? 'Buat akun' : 'Masuk'}</button>
        </form>
        ${signupOpen ? `<p class="auth-switch"><button type="button" class="btn text pressable" id="a-switch">${su ? 'Sudah punya akun? Masuk' : 'Belum punya akun? Daftar'}</button></p>` : ''}
        </div>
      </div>`;
    $('#a-switch')?.addEventListener('click', () => { authMode = su ? 'login' : 'signup'; drawAuth(); });
    $('#auth-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const btn = $('#a-submit');
      btn.disabled = true;
      let r;
      try {
        r = await req('POST', su ? '/api/auth/signup' : '/api/auth/login', { email: f.get('email'), password: f.get('password'), name: f.get('name') || '' });
      } catch {
        btn.disabled = false;
        return drawAuthError('Tidak ada koneksi. Sambungkan internet lalu coba lagi.');
      }
      if (!r.ok) { btn.disabled = false; return drawAuthError((r.data && r.data.error) || 'Gagal masuk. Coba lagi.'); }
      startApp(r.data.user);
    });
    setTimeout(() => $(su ? '#a-name' : '#a-email')?.focus(), 50);
  }
  function drawAuthError(msg) { const el = $('#a-err'); el.textContent = msg; el.hidden = false; }

  async function logout() {
    try { await req('POST', '/api/auth/logout', {}); } catch { /* offline: the cookie stays, the local copy goes */ }
    if (S.user) { PP.write(cacheKey(), ''); PP.write(outboxKey(), '[]'); }
    PP.write('lastUser', '');
    outbox = [];
    showAuth(false);
  }

  function startApp(user) {
    S.user = user;
    loadLocal();
    const h = location.hash.slice(1);
    S.tab = TABS.includes(h) ? h : 'matriks';
    // Matriks is always the history root, so back from another tab lands there, not outside the app.
    history.replaceState({ tab: 'matriks' }, '', location.pathname);
    if (S.tab !== 'matriks') history.pushState({ tab: S.tab }, '', '#' + S.tab);
    if (S.loaded) render();
    else app.innerHTML = `<div class="boot t-subhead">Memuat data…</div>`;
    refresh();
  }

  async function boot() {
    let r;
    try { r = await req('GET', '/api/auth/status'); } catch { r = null; }
    if (r && r.ok) {
      setOnline(true);
      if (r.data.signedIn) return startApp(r.data.user);
      return showAuth(r.data.signupOpen);
    }
    // Offline (or server down): open the last account's local copy.
    S.online = false;
    let last = null;
    try { last = JSON.parse(PP.read('lastUser') || 'null'); } catch { /* none */ }
    if (last) return startApp(last);
    app.innerHTML = `<div class="boot"><div class="empty"><span class="tile lg">${icon('offline')}</span><h3>Belum bisa tersambung</h3><p>Sambungkan internet untuk masuk pertama kali.</p><button type="button" class="btn tonal pressable" id="retry">Coba lagi</button></div></div>`;
    $('#retry').onclick = boot;
  }

  /* ---------------- lifecycle ---------------- */
  window.addEventListener('online', () => { S.online = true; flush().then(refresh); });
  window.addEventListener('offline', () => setOnline(false));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
  setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 60000);
  // Keep "today" right after midnight.
  let lastDay = today();
  setInterval(() => { if (today() !== lastDay) { lastDay = today(); render(); } }, 30000);

  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.installEvt = e; render(); });
  window.addEventListener('appinstalled', () => { S.installEvt = null; render(); snackbar('Aplikasi terpasang.'); });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      const offer = (w) => { S.updateReady = w; render(); };
      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w && w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w); });
      });
      setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
    }).catch(() => {});
    // Reload only when the person asked for the new version; the first install's claim must not reload.
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (wantReload) { wantReload = false; location.reload(); } });
  }

  boot();
})();
