// State, saving and syncing. No DOM building here (see views.js / app.js).
// Edits are applied locally straight away ("pending"), then sent to the Worker in batches.
import { applyOps, emptyDb, rulesOf } from './ops.js';
import { todayISO, uid, parseList, yearOf, fvYear, bbtYear, recomputeCounts } from './rules.js';
export { uid, todayISO };

export const hooks = { render: () => {}, toast: () => {} };

export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const ls = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode etc. */ } },
};

export const S = {
  server: null,            // last copy from the Worker
  pending: [],             // [{op}] changes the Worker hasn't confirmed yet
  rev: 0,
  ui: {
    view: ls.get('bct.view') || 'overview',
    year: Number(ls.get('bct.year')) || Number(todayISO().slice(0, 4)),
    fvFilter: 'all', bbtFilter: 'all', q: '', limit: 300,
  },
  lastPut: 0,
};
try { S.pending = (JSON.parse(ls.get('bct.pending') || '[]') || []).filter((o) => o && o.op); } catch { S.pending = []; }
const persist = () => ls.set('bct.pending', JSON.stringify(S.pending));

/* ---------- API ---------- */
export async function api(path, { method = 'GET', body } = {}) {
  try {
    const res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
    if (res.status === 401 && !path.startsWith('/api/auth/')) { location.href = '/login'; return { ok: false, status: 401 }; }
    const type = res.headers.get('content-type') || '';
    return { ok: res.ok, status: res.status, data: type.includes('json') ? await res.json() : null };
  } catch { return { ok: false, status: 0 }; }
}

/* ---------- derived data = server copy + pending changes ---------- */
let cache = null;
export const touch = () => { S.rev++; };
export function db() {
  if (cache && cache.rev === S.rev) return cache.doc;
  const doc = S.server ? structuredClone(S.server) : emptyDb();
  if (S.pending.length) applyOps(doc, S.pending);
  cache = { rev: S.rev, doc };
  return doc;
}
export const ready = () => S.server !== null;

export function config() {
  const c = db().cfg;
  return { fvs: parseList(c.fvs), bbts: parseList(c.bbts), dme: parseList(c.dme), rules: rulesOf(c), raw: c };
}
export function years() {
  const d = db(), set = new Set([Number(todayISO().slice(0, 4)), S.ui.year]);
  for (const r of d.fv) { const y = fvYear(r); if (y) set.add(y); }
  for (const r of d.bbt) { const y = bbtYear(r); if (y) set.add(y); }
  return [...set].sort((a, b) => b - a);
}

/* ---------- editing ---------- */
export function dispatch(ops) {
  ops = Array.isArray(ops) ? ops : [ops];
  if (!ops.length) return;
  S.pending.push(...ops);
  touch(); persist(); hooks.render(); scheduleFlush();
}
export const putFv = (rec) => dispatch({ op: 'put', t: 'fv', rec });
export function putBbt(rec) {
  // saving a row also refreshes the calculated counts of that tank's later rows
  const changed = recomputeCounts([...db().bbt.filter((r) => r.id !== rec.id), rec], rec.bbt);
  const mine = changed.find((r) => r.id === rec.id) || rec;
  dispatch([{ op: 'put', t: 'bbt', rec: mine }, ...changed.filter((r) => r.id !== rec.id).map((r) => ({ op: 'put', t: 'bbt', rec: r }))]);
}
export const findFv = (id) => db().fv.find((r) => r.id === id);
export const findBbt = (id) => db().bbt.find((r) => r.id === id);

export function removeRecord(t, id) {
  const rec = (t === 'fv' ? findFv : findBbt)(id);
  if (!rec) return;
  dispatch({ op: 'del', t, id });
  hooks.toast(`${t === 'fv' ? 'FV ' + rec.fv : 'BBT ' + rec.bbt} row deleted`, 'Undo', () => dispatch({ op: 'put', t, rec }));
}

/* ---------- sync ---------- */
let flushing = false, flushTimer = 0, backoff = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function setStatus(state) {
  const el = document.getElementById('sync'); if (!el) return;
  el.dataset.state = state;
  document.getElementById('syncTxt').textContent = { saved: 'Saved', saving: 'Saving…', offline: 'Offline — will sync', retry: 'Retrying…' }[state];
}
export function scheduleFlush(ms = 600) { clearTimeout(flushTimer); flushTimer = setTimeout(flush, ms); }
export async function flush() {
  if (flushing || !S.pending.length) { if (!S.pending.length) setStatus('saved'); return; }
  flushing = true; setStatus('saving');
  let failed = false;
  while (S.pending.length) {
    const wait = 1150 - (Date.now() - S.lastPut);          // KV allows one write per second per key
    if (wait > 0) await sleep(wait);
    const batch = S.pending.slice(0, 1500);
    const res = await api('/api/db', { method: 'PUT', body: { ops: batch } });
    S.lastPut = Date.now();
    if (res.ok) {
      S.pending.splice(0, batch.length);
      S.server = res.data; touch(); persist(); hooks.render();
    } else if (res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 0) {
      S.pending.splice(0, batch.length); touch(); persist(); hooks.render();
      hooks.toast('One change couldn’t be saved');
    } else { failed = true; break; }
  }
  flushing = false;
  if (failed) { setStatus(navigator.onLine ? 'retry' : 'offline'); backoff = Math.min(30000, (backoff || 2000) * 2); scheduleFlush(backoff); }
  else { backoff = 0; setStatus('saved'); }
}

export async function load() {
  const r = await api('/api/db');
  if (r.ok) { S.server = r.data; touch(); hooks.render(); if (S.pending.length) scheduleFlush(300); }
  return r.ok;
}

// Pick up changes made on another device / tab.
export function startPolling() {
  const poll = async () => {
    if (document.hidden || S.pending.length || flushing || !S.server) return;
    const r = await api('/api/db?ver=' + encodeURIComponent(S.server.ver || ''));
    if (r.ok && !r.data.unchanged && r.data.ver !== S.server.ver && !S.pending.length) { S.server = r.data; touch(); hooks.render(); }
  };
  setInterval(poll, 20000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { poll(); flush(); } });
  window.addEventListener('online', () => flush());
  window.addEventListener('offline', () => setStatus('offline'));
}

export function setUi(patch) {
  Object.assign(S.ui, patch);
  if ('view' in patch) ls.set('bct.view', S.ui.view);
  if ('year' in patch) ls.set('bct.year', String(S.ui.year));
  hooks.render();
}
export { yearOf };
