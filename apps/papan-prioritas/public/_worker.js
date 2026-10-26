// Papan Prioritas: Cloudflare Pages "advanced mode" Worker.
// Serves the static app from env.ASSETS and the JSON API under /api/, backed by the D1 binding `DB`.
// Login: email + password (PBKDF2-SHA256), session in an HttpOnly cookie whose SHA-256 is stored in D1.
// Sign-up is open only while no user exists, or when the ALLOW_SIGNUP variable is "true".

const PBKDF2_ITER = 100000; // the Workers runtime maximum
const SESSION_DAYS = 30;
const COOKIE = '__Host-sid';
const MAX_ATTEMPTS = 8; // failed logins per 15 minutes, per email and per IP

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) return secure(await api(request, env, url));
      const res = await env.ASSETS.fetch(request);
      return secure(res, cacheFor(url.pathname));
    } catch (err) {
      console.error(err && err.stack ? err.stack : err);
      return secure(json({ error: 'Server sedang bermasalah. Coba lagi sebentar lagi.' }, 500));
    }
  },
};

function cacheFor(path) {
  if (path.startsWith('/fonts/') || path.startsWith('/icons/')) return 'public, max-age=604800';
  return 'no-cache'; // html, js, css, sw, manifest: the service worker keeps the offline copy
}

function secure(res, cache) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  if (cache) out.headers.set('Cache-Control', cache);
  return out;
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}
const fail = (status, error) => json({ error }, status);

/* ---------------- routing ---------------- */

async function api(request, env, url) {
  if (!env.DB) return fail(500, 'Database belum terhubung. Tambahkan binding D1 bernama DB.');
  const method = request.method;
  const path = url.pathname.replace(/\/+$/, '');

  // Writes must come from this site (CSRF) and carry JSON.
  if (method !== 'GET' && method !== 'HEAD') {
    const origin = request.headers.get('Origin');
    if (origin && new URL(origin).host !== url.host) return fail(403, 'Permintaan ditolak.');
    if (method !== 'DELETE' && !(request.headers.get('Content-Type') || '').includes('application/json'))
      return fail(415, 'Kirim data sebagai JSON.');
  }

  if (path === '/api/auth/status' && method === 'GET') return authStatus(request, env);
  if (path === '/api/auth/signup' && method === 'POST') return signup(request, env);
  if (path === '/api/auth/login' && method === 'POST') return login(request, env);
  if (path === '/api/auth/logout' && method === 'POST') return logout(request, env);

  const user = await currentUser(request, env);
  if (!user) return fail(401, 'Kamu perlu masuk dulu.');

  if (path === '/api/state' && method === 'GET') return state(env, user);
  if (path === '/api/tasks/purge-done' && method === 'POST') {
    const r = await env.DB.prepare('DELETE FROM tasks WHERE user_id = ? AND done = 1').bind(user.id).run();
    return json({ deleted: r.meta.changes });
  }

  let m = path.match(/^\/api\/(tasks|events)\/([A-Za-z0-9_-]{1,64})$/);
  if (m) {
    const [, kind, id] = m;
    const T = TABLES[kind];
    if (method === 'PUT') return upsert(request, env, user, T, id);
    if (method === 'PATCH') return patch(request, env, user, T, id);
    if (method === 'DELETE') {
      await env.DB.prepare(`DELETE FROM ${T.table} WHERE id = ? AND user_id = ?`).bind(id, user.id).run();
      return json({ ok: true });
    }
  }
  return fail(404, 'Alamat API tidak dikenal.');
}

/* ---------------- data ---------------- */

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

// field (JSON name) -> [column, validator returning the stored value or throwing]
const str = (max, required) => (v) => {
  if (v == null) {
    if (required) throw new Error('Judul wajib diisi.');
    return '';
  }
  if (typeof v !== 'string') throw new Error('Isian tidak valid.');
  const s = v.trim();
  if (required && !s) throw new Error('Judul wajib diisi.');
  if (s.length > max) throw new Error(`Maksimal ${max} karakter.`);
  return s;
};
const optStr = (max) => (v) => (v == null || v === '' ? null : str(max)(v) || null);
const optRe = (re, msg) => (v) => {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !re.test(v)) throw new Error(msg);
  return v;
};
const reqRe = (re, msg) => (v) => {
  if (typeof v !== 'string' || !re.test(v)) throw new Error(msg);
  return v;
};

const TABLES = {
  tasks: {
    table: 'tasks',
    fields: {
      title: ['title', str(300, true)],
      notes: ['notes', str(5000)],
      quadrant: ['quadrant', (v) => {
        if (v == null || v === '') return null;
        if (!['q1', 'q2', 'q3', 'q4'].includes(v)) throw new Error('Kuadran tidak dikenal.');
        return v;
      }],
      due: ['due_date', optRe(DATE, 'Tanggal tidak valid.')],
      time: ['due_time', optRe(TIME, 'Jam tidak valid.')],
      delegateTo: ['delegate_to', optStr(100)],
      done: ['done', (v) => (v ? 1 : 0)],
      doneAt: ['done_at', optRe(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/, 'Waktu selesai tidak valid.')],
    },
    required: ['title'],
  },
  events: {
    table: 'events',
    fields: {
      title: ['title', str(300, true)],
      date: ['date', reqRe(DATE, 'Tanggal acara wajib diisi.')],
      start: ['start_time', optRe(TIME, 'Jam mulai tidak valid.')],
      end: ['end_time', optRe(TIME, 'Jam selesai tidak valid.')],
      notes: ['notes', str(5000)],
    },
    required: ['title', 'date'],
  },
};

function taskOut(r) {
  return {
    id: r.id, title: r.title, notes: r.notes, quadrant: r.quadrant, due: r.due_date, time: r.due_time,
    delegateTo: r.delegate_to, done: !!r.done, doneAt: r.done_at, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function eventOut(r) {
  return {
    id: r.id, title: r.title, date: r.date, start: r.start_time, end: r.end_time, notes: r.notes,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

async function state(env, user) {
  const [t, e] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at').bind(user.id),
    env.DB.prepare('SELECT * FROM events WHERE user_id = ? ORDER BY date, start_time').bind(user.id),
  ]);
  return json({
    user: { id: user.id, email: user.email, name: user.name },
    tasks: t.results.map(taskOut),
    events: e.results.map(eventOut),
    serverTime: new Date().toISOString(),
  });
}

async function body(request) {
  try {
    const b = await request.json();
    return b && typeof b === 'object' && !Array.isArray(b) ? b : null;
  } catch {
    return null;
  }
}

function clean(T, input, partial) {
  const cols = {};
  for (const [key, [col, check]] of Object.entries(T.fields)) {
    if (!(key in input)) {
      if (!partial && T.required.includes(key)) check(undefined);
      continue;
    }
    cols[col] = check(input[key]);
  }
  return cols;
}

// PUT creates or fully replaces (idempotent, so the offline queue can resend it).
async function upsert(request, env, user, T, id) {
  const input = await body(request);
  if (!input) return fail(400, 'Data tidak terbaca.');
  let cols;
  try { cols = clean(T, input, false); } catch (e) { return fail(422, e.message); }
  const now = new Date().toISOString();
  const createdAt = typeof input.createdAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(input.createdAt) ? input.createdAt : now;
  const names = Object.keys(cols);
  const sql =
    `INSERT INTO ${T.table} (id, user_id, ${names.join(', ')}, created_at, updated_at) ` +
    `VALUES (?, ?, ${names.map(() => '?').join(', ')}, ?, ?) ` +
    `ON CONFLICT(id) DO UPDATE SET ${names.map((n) => `${n} = excluded.${n}`).join(', ')}, updated_at = excluded.updated_at ` +
    `WHERE ${T.table}.user_id = excluded.user_id`;
  await env.DB.prepare(sql).bind(id, user.id, ...names.map((n) => cols[n]), createdAt, now).run();
  return json({ ok: true, updatedAt: now });
}

// PATCH changes only the fields sent, so a stale screen never undoes an edit made elsewhere (by Claude, say).
async function patch(request, env, user, T, id) {
  const input = await body(request);
  if (!input) return fail(400, 'Data tidak terbaca.');
  let cols;
  try { cols = clean(T, input, true); } catch (e) { return fail(422, e.message); }
  const names = Object.keys(cols);
  if (!names.length) return fail(400, 'Tidak ada yang diubah.');
  const now = new Date().toISOString();
  const r = await env.DB.prepare(
    `UPDATE ${T.table} SET ${names.map((n) => `${n} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND user_id = ?`,
  ).bind(...names.map((n) => cols[n]), now, id, user.id).run();
  if (!r.meta.changes) return fail(404, 'Data ini sudah tidak ada.');
  return json({ ok: true, updatedAt: now });
}

/* ---------------- auth ---------------- */

const enc = new TextEncoder();
function b64u(buf) {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64u(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
const randomB64u = (n) => b64u(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s) => b64u(await crypto.subtle.digest('SHA-256', enc.encode(s)));

async function hashPassword(password, salt, iter) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64u(salt), iterations: iter }, key, 256);
  return b64u(bits);
}
function sameString(a, b) {
  const x = enc.encode(a), y = enc.encode(b);
  if (x.length !== y.length) return false;
  if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(x, y);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

function readCookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}
const sessionCookie = (token, maxAge) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

async function currentUser(request, env) {
  const token = readCookie(request, COOKIE);
  if (!token || token.length > 100) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
  ).bind(await sha256(token)).first();
  if (!row || row.expires_at < new Date().toISOString()) return null;
  return row;
}

async function signupOpen(env) {
  if (String(env.ALLOW_SIGNUP).toLowerCase() === 'true') return true;
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
  return row.n === 0;
}

async function authStatus(request, env) {
  const user = await currentUser(request, env);
  return json({
    signedIn: !!user,
    user: user ? { id: user.id, email: user.email, name: user.name } : null,
    signupOpen: user ? false : await signupOpen(env),
  });
}

async function startSession(env, userId) {
  const token = randomB64u(32);
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 864e5);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind(await sha256(token), userId, now.toISOString(), expires.toISOString()),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now.toISOString()),
  ]);
  return sessionCookie(token, SESSION_DAYS * 86400);
}

function credentials(input) {
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  const password = typeof input.password === 'string' ? input.password : '';
  return { email, password };
}

async function signup(request, env) {
  const input = await body(request);
  if (!input) return fail(400, 'Data tidak terbaca.');
  if (!(await signupOpen(env))) return fail(403, 'Pendaftaran ditutup. Minta pemilik membukakan akses.');
  const { email, password } = credentials(input);
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 80) : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) return fail(422, 'Email belum benar.');
  if (password.length < 8) return fail(422, 'Kata sandi minimal 8 karakter.');
  if (password.length > 200) return fail(422, 'Kata sandi terlalu panjang.');
  const exists = await env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first();
  if (exists) return fail(409, 'Email ini sudah terdaftar. Masuk saja.');
  const salt = randomB64u(16);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO users (id, email, name, pass_hash, pass_salt, pass_iter, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).bind(id, email, name, await hashPassword(password, salt, PBKDF2_ITER), salt, PBKDF2_ITER, new Date().toISOString()).run();
  return json({ ok: true, user: { id, email, name } }, 200, { 'Set-Cookie': await startSession(env, id) });
}

async function login(request, env) {
  const input = await body(request);
  if (!input) return fail(400, 'Data tidak terbaca.');
  const { email, password } = credentials(input);
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const since = new Date(Date.now() - 15 * 60e3).toISOString();
  const keys = ['email:' + email, 'ip:' + ip];
  const { n } = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM login_attempts WHERE key IN (?, ?) AND at > ?',
  ).bind(...keys, since).first();
  if (n >= MAX_ATTEMPTS * 2) return fail(429, 'Terlalu sering gagal. Coba lagi 15 menit lagi.');

  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  // Hash even when the email is unknown, so timing does not reveal which emails exist.
  const salt = user ? user.pass_salt : 'AAAAAAAAAAAAAAAAAAAAAA';
  const hash = await hashPassword(password, salt, user ? user.pass_iter : PBKDF2_ITER);
  if (!user || !sameString(hash, user.pass_hash)) {
    const now = new Date().toISOString();
    await env.DB.batch([
      ...keys.map((k) => env.DB.prepare('INSERT INTO login_attempts (key, at) VALUES (?, ?)').bind(k, now)),
      env.DB.prepare('DELETE FROM login_attempts WHERE at < ?').bind(new Date(Date.now() - 864e5).toISOString()),
    ]);
    return fail(401, 'Email atau kata sandi salah.');
  }
  await env.DB.prepare('DELETE FROM login_attempts WHERE key = ?').bind(keys[0]).run();
  return json(
    { ok: true, user: { id: user.id, email: user.email, name: user.name } },
    200,
    { 'Set-Cookie': await startSession(env, user.id) },
  );
}

async function logout(request, env) {
  const token = readCookie(request, COOKIE);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
}
