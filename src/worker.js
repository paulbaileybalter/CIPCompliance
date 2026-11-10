// Balter Brewing — CIP/SIP compliance tracker.
// One Worker: serves the static site from ./public behind a password, and stores everything in Workers KV.
//
// KV keys
//   auth            { salt, hash, iter }        PBKDF2 password hash (set on first visit)
//   sess:<sha256>   "1"                         login sessions (30 days, token itself only lives in the cookie)
//   db              { ver, fv[], bbt[], cfg, meta }   all tracker data
//   bak:YYYY-MM-DD  copy of db before that day's first change (kept 30 days)
//   rl:<ip>         failed-login counter (15 min)
import { applyOps, emptyDb } from '../public/js/ops.js';

const SESSION_COOKIE = 'bct';
const SESSION_TTL = 60 * 60 * 24 * 30;
const PBKDF2_ITER = 100000;                 // Workers' maximum
const MAX_BODY = 3_000_000;
const MAX_OPS = 5000;
const MAX_FAILS = 10;

// Reachable without a session (just enough to render the sign-in page).
const PUBLIC = new Set(['/login', '/login.js', '/app.css', '/favicon.svg', '/icon-192.png', '/icon-512.png', '/manifest.json', '/fonts/lexend-latin-wght-normal.woff2']);

const enc = new TextEncoder();
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });

async function pbkdf2(password, salt, iter) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256));
}
const sha256hex = async (s) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))));
function safeEqual(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0; }

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { salt: b64(salt), hash: b64(await pbkdf2(password, salt, PBKDF2_ITER)), iter: PBKDF2_ITER };
}
async function checkPassword(password, rec) {
  return safeEqual(await pbkdf2(password, unb64(rec.salt), rec.iter || PBKDF2_ITER), unb64(rec.hash));
}

const cookieOf = (request, name) => {
  for (const part of (request.headers.get('cookie') || '').split(/;\s*/)) { const i = part.indexOf('='); if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1); }
  return '';
};
const setCookie = (token, secure, maxAge) => `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;

async function newSession(env, secure) {
  const token = b64(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' }[c]));
  await env.KV.put('sess:' + (await sha256hex(token)), '1', { expirationTtl: SESSION_TTL });
  return setCookie(token, secure, SESSION_TTL);
}
async function isAuthed(request, env) {
  const token = cookieOf(request, SESSION_COOKIE);
  return !!token && (await env.KV.get('sess:' + (await sha256hex(token)))) !== null;
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'Too large');
  try { return JSON.parse(text || '{}'); } catch { throw new HttpError(400, 'Bad JSON'); }
}
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

/* ---------------- auth routes ---------------- */
async function authRoutes(request, env, url, secure) {
  const path = url.pathname;
  const auth = await env.KV.get('auth', 'json');
  const authed = await isAuthed(request, env);

  if (path === '/api/auth/status' && request.method === 'GET') {
    return json({ configured: !!auth, authed, needsCode: !auth && !!env.SETUP_CODE });
  }
  if (path === '/api/auth/logout' && request.method === 'POST') {
    const token = cookieOf(request, SESSION_COOKIE);
    if (token) await env.KV.delete('sess:' + (await sha256hex(token)));
    return json({ ok: true }, 200, { 'set-cookie': setCookie('', secure, 0) });
  }
  if (request.method !== 'POST') return json({ error: 'Not found' }, 404);
  const body = await readJson(request);
  const password = typeof body.password === 'string' ? body.password : '';

  if (path === '/api/auth/setup') {
    if (auth) return json({ error: 'Already set up' }, 409);
    if (env.SETUP_CODE && body.code !== env.SETUP_CODE) return json({ error: 'Setup code is incorrect' }, 403);
    if (password.length < 8 || password.length > 200) return json({ error: 'Choose a password of at least 8 characters' }, 400);
    await env.KV.put('auth', JSON.stringify(await hashPassword(password)));
    return json({ ok: true }, 200, { 'set-cookie': await newSession(env, secure) });
  }

  const ip = request.headers.get('cf-connecting-ip') || 'local';
  const rlKey = 'rl:' + ip;
  if (path === '/api/auth/login') {
    if (!auth) return json({ error: 'Not set up yet' }, 409);
    const fails = Number(await env.KV.get(rlKey)) || 0;
    if (fails >= MAX_FAILS) return json({ error: 'Too many attempts — try again in 15 minutes' }, 429);
    if (!(await checkPassword(password, auth))) {
      await env.KV.put(rlKey, String(fails + 1), { expirationTtl: 900 });
      return json({ error: 'Wrong password' }, 401);
    }
    if (fails) await env.KV.delete(rlKey);
    return json({ ok: true }, 200, { 'set-cookie': await newSession(env, secure) });
  }
  if (path === '/api/auth/password') {
    if (!authed || !auth) return json({ error: 'Sign in first' }, 401);
    const next = typeof body.next === 'string' ? body.next : '';
    if (!(await checkPassword(typeof body.current === 'string' ? body.current : '', auth))) return json({ error: 'Current password is wrong' }, 403);
    if (next.length < 8 || next.length > 200) return json({ error: 'New password must be at least 8 characters' }, 400);
    await env.KV.put('auth', JSON.stringify(await hashPassword(next)));
    return json({ ok: true });
  }
  return json({ error: 'Not found' }, 404);
}

/* ---------------- data routes ---------------- */
async function loadDb(env) {
  const db = (await env.KV.get('db', 'json')) || emptyDb();
  db.fv ||= []; db.bbt ||= []; db.cfg = { ...emptyDb().cfg, ...(db.cfg || {}) }; db.meta ||= {};
  return db;
}

async function dataRoutes(request, env, url) {
  if (url.pathname !== '/api/db') return json({ error: 'Not found' }, 404);
  if (request.method === 'GET') {
    const db = await loadDb(env);
    if (url.searchParams.get('ver') && url.searchParams.get('ver') === db.ver) return json({ unchanged: true, ver: db.ver });
    return json(db);
  }
  if (request.method === 'PUT') {
    const body = await readJson(request);
    if (!Array.isArray(body.ops) || body.ops.length > MAX_OPS) return json({ error: 'Bad request' }, 400);
    const db = await loadDb(env);
    const before = JSON.stringify(db);
    const applied = applyOps(db, body.ops);
    if (applied === 0 && body.ops.length) return json({ error: 'Nothing valid to save' }, 422);
    db.ver = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    // A safety copy of the data as it was before the first change each day.
    const day = new Date().toISOString().slice(0, 10);
    if ((db.fv.length || db.bbt.length || before.length > 200) && !(await env.KV.get('bak:' + day))) {
      await env.KV.put('bak:' + day, before, { expirationTtl: 60 * 60 * 24 * 30 });
    }
    await env.KV.put('db', JSON.stringify(db));
    return json(db);
  }
  return json({ error: 'Method not allowed' }, 405);
}

/* ---------------- static assets ---------------- */
const SECURITY = {
  'x-robots-tag': 'noindex, nofollow',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'SAMEORIGIN',
};
function withSecurity(resp, noStore) {
  const h = new Headers(resp.headers);
  for (const [k, v] of Object.entries(SECURITY)) h.set(k, v);
  if (noStore) h.set('cache-control', 'no-store');
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}
async function asset(request, env, path) {
  const u = new URL(request.url);
  u.pathname = path;
  return env.ASSETS.fetch(new Request(u.toString(), { method: 'GET', headers: request.headers }));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const secure = url.protocol === 'https:';
    try {
      if (!env.KV) return json({ error: 'KV namespace "KV" is not bound — see README' }, 500);
      const path = url.pathname.replace(/\/{2,}/g, '/');

      if (path.startsWith('/api/')) {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          const origin = request.headers.get('origin');
          if (origin && new URL(origin).host !== url.host) return json({ error: 'Forbidden' }, 403);
        }
        if (path.startsWith('/api/auth/')) return withSecurity(await authRoutes(request, env, url, secure), true);
        if (!(await isAuthed(request, env))) return withSecurity(json({ error: 'Sign in required' }, 401), true);
        return withSecurity(await dataRoutes(request, env, url), true);
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });

      const authed = await isAuthed(request, env);
      if (path === '/login') {
        if (authed) return Response.redirect(url.origin + '/', 302);
        return withSecurity(await asset(request, env, '/login.html'), true);
      }
      if (!authed && !PUBLIC.has(path)) return Response.redirect(url.origin + '/login', 302);
      const target = path === '/' ? '/index.html' : path;
      if (target === '/login.html') return Response.redirect(url.origin + '/login', 302);
      return withSecurity(await asset(request, env, target), target.endsWith('.html'));
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      return json({ error: 'Server error' }, 500);
    }
  },
};
