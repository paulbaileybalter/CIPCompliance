// Compliance rules, date helpers. Pure functions — no DOM, no network (also unit-tested in Node).
// The rules mirror the "FV/BBT CIP Compliance 26" tab of the Vessel & Equipment CIP monitoring workbook.

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
export function fvStatus(r, today) {
  const f = diffDays(r.brew, r.cip);
  const g = diffDays(r.brew, r.sip);
  const planned = !!r.brew && !!today && r.brew > today;
  const base = { f, g, planned, fTone: '', gTone: '', reasons: [] };
  if (!r.brew) {
    return { ...base, state: 'wait', label: r.cip || r.sip ? 'Awaiting brew' : 'No data', missing: [!r.cip && 'CIP', !r.sip && 'SIP'].filter(Boolean) };
  }
  if (!r.cip || !r.sip) {
    const missing = [!r.cip && 'CIP', !r.sip && 'SIP'].filter(Boolean);
    return { ...base, state: 'need', label: `Needs ${missing.join(' + ')}`, missing,
      fTone: r.cip ? (f < 8 ? 'ok' : 'bad') : '', gTone: r.sip ? (g < 3 ? 'ok' : 'bad') : '' };
  }
  if (f < 0 || g < 0) return { ...base, state: 'check', label: 'Check dates', reasons: ['CIP/SIP date is after the brew date'], missing: [] };
  const fOk = f < 8;
  const gOk = g < 3;
  const gOk72 = g === 3 && f === 3;
  base.fTone = fOk ? 'ok' : 'bad';
  base.gTone = gOk || gOk72 ? 'ok' : 'bad';
  if (fOk && gOk) return { ...base, state: 'ok', label: 'Yes', missing: [] };
  if (f === 3 && g === 3) return { ...base, state: 'ok72', label: 'Yes · <72 h since CIP', missing: [] };
  if (!fOk) base.reasons.push(`CIP is ${f} days before ${planned ? 'the planned ' : ''}fill (limit: under 8)`);
  if (!gOk) base.reasons.push(`SIP is ${g} days before ${planned ? 'the planned ' : ''}fill (limit: under 3)`);
  // A brew that hasn't happened yet isn't a breach — the vessel just needs cleaning again closer to the day.
  if (planned) return { ...base, state: 'need', label: 'CIP/SIP too early', missing: [] };
  return { ...base, state: 'bad', label: 'No', missing: [] };
}

/* ---------------- Brite beer tanks (BBT) ----------------
   N = transfer date − acid CIP date   green < 3 days. Over that: purple (acceptable) for DME BBTs, flagged for Krones BBTs.
   L = number of acid CIPs / beer fills   6 pale yellow · 7 yellow · 8+ orange (must be re-cleaned)
   Ready to fill: L < 8 (Krones BBTs also need N < 3: "must be green" for Krones). */
export function bbtStatus(r, dmeList, today) {
  const dme = dmeList.includes(r.bbt);
  const n = diffDays(r.transfer, r.acidCip);
  const count = r.acidCount === null || r.acidCount === undefined || r.acidCount === '' ? null : Number(r.acidCount);
  const planned = !!r.transfer && !!today && r.transfer > today;
  const countTone = count === null ? '' : count >= 8 ? 'bad' : count === 7 ? 'warn2' : count === 6 ? 'warn1' : '';
  const base = { n, count, dme, planned, nTone: '', countTone, reasons: [] };
  if (!r.transfer) {
    return { ...base, state: 'wait', label: r.acidCip ? 'Awaiting transfer' : 'No data', missing: [!r.acidCip && 'acid CIP', count === null && 'count'].filter(Boolean) };
  }
  const missing = [!r.acidCip && 'acid CIP', count === null && 'fill count'].filter(Boolean);
  if (!r.acidCip) return { ...base, state: 'need', label: `Needs ${missing.join(' + ')}`, missing };
  if (n < 0) return { ...base, state: 'check', label: 'Check dates', reasons: ['Acid CIP date is after the transfer date'], missing };
  base.nTone = n < 3 ? 'ok' : dme ? 'dme' : 'bad';
  if (count === null) return { ...base, state: 'need', label: 'Needs fill count', missing };
  const reasons = [];
  if (count >= 8) reasons.push(`${count} acid CIPs/fills — limit is under 8`);
  if (!dme && n >= 3) reasons.push(`Acid CIP was ${n} days before transfer — Krones BBTs need under 3`);
  if (reasons.length && planned) return { ...base, state: 'need', label: count >= 8 ? 'Acid CIP due' : 'Acid CIP too early', reasons, missing: [] };
  if (reasons.length) return { ...base, state: 'bad', label: 'No', reasons, missing: [] };
  return { ...base, state: dme && n >= 3 ? 'ok-dme' : 'ok', label: 'Yes', missing: [] };
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
