// Compliance rules, date helpers. Pure functions — no DOM, no network (also unit-tested in Node).
// The rules mirror the "FV/BBT CIP Compliance 26" tab of the Vessel & Equipment CIP monitoring workbook.

import { DEFAULT_RULES } from './ops.js';

export const DAY = 86400000;
const pad = (n) => String(n).padStart(2, '0');

export const uid = () => 't' + [...crypto.getRandomValues(new Uint8Array(9))].map((b) => (b % 36).toString(36)).join('');
export const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
export const dayNum = (iso) => (iso ? Math.round(Date.parse(iso + 'T00:00:00Z') / DAY) : null);
export const diffDays = (later, earlier) => (later && earlier ? dayNum(later) - dayNum(earlier) : null);
export const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
export const mondayOf = (iso) => { const dow = new Date(iso + 'T00:00:00Z').getUTCDay(); return addDays(iso, -((dow + 6) % 7)); };

const dtf = (iso, o) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-AU', { timeZone: 'UTC', ...o });
export const fmtDate = (iso) => (iso ? dtf(iso, { weekday: 'short', day: 'numeric', month: 'short' }) : '');
export const fmtDateY = (iso) => (iso ? dtf(iso, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
export const fmtLong = (iso) => (iso ? dtf(iso, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : '');

export function relDay(iso, today) {
  const d = diffDays(iso, today);
  if (d === null) return '';
  if (d === 0) return 'today';
  if (d === 1) return 'tomorrow';
  if (d === -1) return 'yesterday';
  return d > 0 ? `in ${d} days` : `${-d} days ago`;
}

// "2-4, 7, 10-12" -> [2,3,4,7,10,11,12]
export function parseList(text) {
  const out = new Set();
  for (const part of String(text || '').split(/[,\s;]+/)) {
    const m = /^(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?$/.exec(part.trim());
    if (!m) continue;
    const a = +m[1], b = m[2] ? +m[2] : a;
    for (let n = Math.min(a, b); n <= Math.max(a, b) && n < 1000; n++) out.add(n);
  }
  return [...out].sort((x, y) => x - y);
}

/* ---------------- Fermentation vessels (FV) ----------------
   F = brew date − CIP date        green < 8 days, otherwise flagged
   G = brew date − SIP date        green < 3 days (3 days is OK only if F is also 3: "<72 hours since CIP")
   Compliant: F < 8 and G < 3  → Yes;   F = 3 and G = 3 → "Yes <72 hours since CIP";  otherwise No.
   States: ok | ok72 | bad | need (missing CIP/SIP) | wait (CIP'd, no brew date yet) | check (dates out of order) */
export function fvStatus(r, today, rules = DEFAULT_RULES) {
  const f = diffDays(r.brew, r.cip);
  const g = diffDays(r.brew, r.sip);
  const planned = !!r.brew && !!today && r.brew > today;
  const base = { f, g, planned, fTone: '', gTone: '', reasons: [] };
  const notDue = !!r.brew && !!today && r.brew >= today;        // data can't be entered ahead of time, so only past brews raise "needs data"
  if (!r.brew) {
    return { ...base, state: 'wait', label: r.cip || r.sip ? 'Awaiting brew' : 'No data', missing: [!r.cip && 'CIP', !r.sip && 'SIP'].filter(Boolean) };
  }
  if (!r.cip || !r.sip) {
    const missing = [!r.cip && 'CIP', !r.sip && 'SIP'].filter(Boolean);
    return { ...base, state: notDue ? 'wait' : 'need', label: notDue ? 'Not due yet' : `Needs ${missing.join(' + ')}`, missing,
      fTone: r.cip ? (f < rules.fvCip ? 'ok' : 'bad') : '', gTone: r.sip ? (g < rules.fvSip ? 'ok' : 'bad') : '' };
  }
  if (f < 0 || g < 0) return { ...base, state: 'check', label: 'Check dates', reasons: ['CIP/SIP date is after the brew date'], missing: [] };
  if (r.sip < r.cip) return { ...base, state: 'check', label: 'Check dates', reasons: ['SIP is dated before its CIP — every CIP is followed by a SIP'], missing: [] };
  const fOk = f < rules.fvCip;
  const gOk = g < rules.fvSip;
  const gOk72 = rules.fvAlt > 0 && g === rules.fvAlt && f === rules.fvAlt;
  base.fTone = fOk ? 'ok' : 'bad';
  base.gTone = gOk || gOk72 ? 'ok' : 'bad';
  if (fOk && gOk) return { ...base, state: 'ok', label: 'Yes', missing: [] };
  if (gOk72) return { ...base, state: 'ok72', label: 'Yes · <72 h since CIP', missing: [] };
  if (!fOk) base.reasons.push(`CIP is ${f} days before ${planned ? 'the planned ' : ''}fill (limit: under ${rules.fvCip})`);
  if (!gOk) base.reasons.push(`SIP is ${g} days before ${planned ? 'the planned ' : ''}fill (limit: under ${rules.fvSip})`);
  // A brew that hasn't happened yet isn't a breach — the vessel just needs cleaning again closer to the day.
  if (planned) return { ...base, state: 'wait', label: 'CIP/SIP too early', missing: [] };
  return { ...base, state: 'bad', label: 'No', missing: [] };
}

/* ---------------- Brite beer tanks (BBT) ----------------
   N = transfer date − acid CIP date   green < 3 days. Over that: purple (acceptable) for DME BBTs, flagged for Krones BBTs.
   L = number of acid CIPs / beer fills   6 pale yellow · 7 yellow · 8+ orange (must be re-cleaned)
   Ready to fill: L < 8 (Krones BBTs also need N < 3: "must be green" for Krones). */
export function bbtStatus(r, dmeList, today, rules = DEFAULT_RULES) {
  const dme = dmeList.includes(r.bbt);
  // days are counted from the SIP when the clean was a CIP + SIP; otherwise from the Acid CIP
  const n = diffDays(r.transfer, r.acidType === 'cip' && r.acidSip ? r.acidSip : r.acidCip);
  const count = r.acidCount === null || r.acidCount === undefined || r.acidCount === '' ? null : Number(r.acidCount);
  const planned = !!r.transfer && !!today && r.transfer > today;
  const countTone = count !== null && count >= rules.cntMax ? 'bad' : '';
  const base = { n, count, dme, planned, nTone: '', countTone, reasons: [] };
  const notDue = !!r.transfer && !!today && r.transfer >= today;   // only past transfers raise "needs data"
  if (!r.transfer) {
    return { ...base, state: 'wait', label: r.acidCip ? 'Awaiting transfer' : 'No data', missing: [!r.acidCip && 'acid CIP', count === null && 'count'].filter(Boolean) };
  }
  const missing = [!r.acidCip && 'acid CIP', count === null && 'fill count'].filter(Boolean);
  if (!r.acidCip) return { ...base, state: notDue ? 'wait' : 'need', label: notDue ? 'Not due yet' : `Needs ${missing.join(' + ')}`, missing };
  if (n < 0) return { ...base, state: 'check', label: 'Check dates', reasons: ['Clean date is after the transfer date'], missing };
  if (r.acidType === 'cip' && r.acidSip && r.acidSip < r.acidCip) return { ...base, state: 'check', label: 'Check dates', reasons: ['SIP is dated before its CIP — every CIP is followed by a SIP'], missing };
  base.nTone = n < rules.bbtDays ? 'ok' : dme ? 'dme' : 'bad';
  if (count === null) return { ...base, state: notDue ? 'wait' : 'need', label: notDue ? 'Not due yet' : 'Needs fill count', missing };
  const reasons = [];
  if (count >= rules.cntMax) reasons.push(`${count} fills since the last CIP — limit is under ${rules.cntMax}`);
  if (!dme && n >= rules.bbtDays) reasons.push(`Clean was ${n} days before transfer — Krones BBTs need under ${rules.bbtDays}`);
  if (reasons.length && planned) return { ...base, state: 'wait', label: count >= rules.cntMax ? 'CIP due' : 'Acid CIP too early', reasons, missing: [] };
  if (reasons.length) return { ...base, state: 'bad', label: 'No', reasons, missing: [] };
  return { ...base, state: dme && n >= rules.bbtDays ? 'ok-dme' : 'ok', label: 'Yes', missing: [] };
}

export const isGood = (s) => s.state === 'ok' || s.state === 'ok72' || s.state === 'ok-dme';

/* ---------------- roll-ups ---------------- */
export const yearOf = (iso) => (iso ? +iso.slice(0, 4) : null);
export const fvYear = (r) => yearOf(r.brew || r.cip || r.sip);
export const bbtYear = (r) => yearOf(r.transfer || r.acidCip);

export function summarise(rows, statusFn) {
  const s = { total: 0, good: 0, bad: 0, need: 0, wait: 0, check: 0, planned: 0 };
  for (const r of rows) {
    const st = statusFn(r);
    s.total++;
    if (isGood(st)) s.good++; else if (st.state === 'bad') s.bad++; else if (st.state === 'need') s.need++; else if (st.state === 'wait') s.wait++; else if (st.state === 'check') s.check++;
    if (st.planned) s.planned++;
  }
  const judged = s.good + s.bad;
  s.pct = judged ? (s.bad ? Math.min(99, Math.round((s.good / judged) * 100)) : 100) : null;   // never show 100% while a row is non-compliant
  return s;
}


/* ---------- BBT fill count, calculated ----------
   A caustic CIP resets the count to 0; the acid CIP/SIP done between brews adds 1 to the previous count.
   Only rows with an acidType are calculated (older / hand-typed counts are left alone and used as the starting point). */
const bbtKey = (r) => r.transfer || r.acidCip || '9999-12-31';
export function recomputeCounts(records, bbt) {
  const list = records.filter((r) => r.bbt === bbt).map((r, i) => [r, i]).sort((a, b) => (bbtKey(a[0]) < bbtKey(b[0]) ? -1 : bbtKey(a[0]) > bbtKey(b[0]) ? 1 : a[1] - b[1])).map((x) => x[0]);
  const changed = [];
  let prev = null;
  for (const r of list) {
    let count = r.acidCount ?? null;
    if (r.acidType) {
      const c = r.acidType === 'cip' ? 0 : prev === null ? null : prev + 1;
      if (c !== null && c !== count) { count = c; changed.push({ ...r, acidCount: c }); }
    }
    prev = count;
  }
  return changed;
}

/* ---------- Upcoming brews & transfers: what's going where, and when to clean ----------
   FV  brew on D   → CIP + SIP must land inside the window [D − (limit − 1), D]  (CIP < fvCip days, SIP < fvSip days before the brew).
   BBT transfer on T → Acid CIP (or CIP + SIP when the tank has reached its fill limit) inside [T − (bbtDays − 1), T].
   Each event gets a `task`: what to do, the window it can be done in, and whether it's already done / due now / opens later. */
export function buildUpcoming(d, cfg, today, horizon = 14) {
  const rules = cfg.rules || DEFAULT_RULES, dmeList = cfg.dme || [];
  const last = addDays(today, horizon);
  const events = [];
  const state = (task, start, end) => (task === 'done' ? 'done' : today >= start ? 'now' : 'later');

  for (const r of d.fv) {
    if (!r.brew || r.brew < today || r.brew > last) continue;
    const st = fvStatus(r, today, rules);
    const D = r.brew;
    const cipOk = !!r.cip && r.cip <= D && diffDays(D, r.cip) < rules.fvCip;
    const sipOk = !!r.sip && r.sip <= D && diffDays(D, r.sip) < rules.fvSip && (!r.cip || r.sip >= r.cip);
    let task = 'CIP + SIP', start = addDays(D, -(Math.min(rules.fvCip, rules.fvSip) - 1));
    if (st.state === 'ok' || st.state === 'ok72') task = 'done';
    else if (cipOk && !sipOk) { task = 'SIP'; start = addDays(D, -(rules.fvSip - 1)); }
    events.push({ kind: 'brew', date: D, id: r.id, vessel: r.fv, beer: r.recipe || '', task, start, end: D, when: state(task, start, D),
      note: task === 'done' ? `CIP ${fmtDate(r.cip)}, SIP ${fmtDate(r.sip)}` : '', rec: r });
  }

  // expected fill count per planned BBT row, carried forward from the last known count
  const need = new Map();
  const byBbt = new Map();
  for (const r of d.bbt) { if (!byBbt.has(r.bbt)) byBbt.set(r.bbt, []); byBbt.get(r.bbt).push(r); }
  for (const [, list] of byBbt) {
    const rows = list.map((r, i) => [r, i]).sort((a, b) => ((a[0].transfer || a[0].acidCip || '9') < (b[0].transfer || b[0].acidCip || '9') ? -1 : (a[0].transfer || a[0].acidCip || '9') > (b[0].transfer || b[0].acidCip || '9') ? 1 : a[1] - b[1])).map((x) => x[0]);
    let carry = null;
    for (const r of rows) {
      const known = r.acidCount === null || r.acidCount === undefined || r.acidCount === '' ? null : Number(r.acidCount);
      let after = known, needCip = false, expected = null;
      if (r.acidType === 'cip') after = 0;
      else if (known !== null) { if (known >= rules.cntMax) { needCip = true; after = 0; } }
      else if (carry !== null) { expected = carry + 1; if (expected >= rules.cntMax) { needCip = true; after = 0; } else after = expected; }
      need.set(r.id, { needCip, expected: known ?? expected, before: carry });
      carry = after;
    }
  }
  const beerFor = (r) => {
    if (r.batch) return r.batch;
    if (!r.fromFv) return '';
    const m = d.fv.filter((f) => f.fv === r.fromFv && f.brew && f.brew <= (r.transfer || '9')).sort((a, b) => (a.brew < b.brew ? 1 : -1))[0];
    return m ? m.recipe || '' : '';
  };
  for (const r of d.bbt) {
    if (!r.transfer || r.transfer < today || r.transfer > last) continue;
    const st = bbtStatus(r, dmeList, today, rules);
    const T = r.transfer, n = need.get(r.id) || {};
    let task = n.needCip || r.acidType === 'cip' ? 'CIP + SIP' : 'Acid CIP';
    if (st.state === 'ok' || st.state === 'ok-dme') task = 'done';
    const start = addDays(T, -(rules.bbtDays - 1));
    const dme = dmeList.includes(r.bbt);
    let note = '';
    if (task === 'done') note = r.acidType === 'cip' ? `CIP + SIP ${fmtDate(r.acidSip || r.acidCip)}` : `Acid CIP ${fmtDate(r.acidCip)}`;
    else if (n.needCip) note = `Fill limit reached (${rules.cntMax}) — caustic CIP resets the count`;
    else if (n.expected !== null && n.expected !== undefined) note = `Count will be ${n.expected} of ${rules.cntMax}`;
    events.push({ kind: 'transfer', date: T, id: r.id, vessel: r.bbt, from: r.fromFv, beer: beerFor(r), task, start, end: T, when: state(task, start, T), dme, note, rec: r });
  }
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.kind === b.kind ? a.vessel - b.vessel : a.kind === 'transfer' ? -1 : 1));
  return events;
}
