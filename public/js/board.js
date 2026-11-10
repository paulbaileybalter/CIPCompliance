// Readers for the two spreadsheets the site understands:
//   1. Live Brewery Board  — one sheet per week ("WC 9th Nov"). Brews fill FVs, transfers move FV -> BBT.
//   2. Vessel & Equipment CIP monitoring — the old "FV/BBT CIP Compliance 26" tab (one-off migration of existing rows).
import { openWorkbook, serialToISO } from './xlsx.js';

/* ---------------- Live Brewery Board ---------------- */
const DAY_COL = [2, 5, 8, 11, 14, 17, 20];            // B,E,H,K,N,Q,T — first of the AM/PM/NIGHT columns for Mon..Sun
const FV_RE = /\b(?:FV|FMT)\s*(\d+(?:\s*[,/&+]\s*(?:FV|FMT)?\s*\d+)*)/i;   // FV23, FMT4, FV23/FV24, FV16,23,24  (not CCFV48 / PFV2)
const BBT_RE = /\bBBT\s*(\d+)\b/i;
const NOT_BEER = /^(DRY|YPP\d*|CIP\b.*|STARTER|TOPUP|TOP UP|SAT|SUN)$/i;
const nums = (s) => (s.match(/\d+/g) || []).map(Number);
const clean = (s) => s.replace(/\s+/g, ' ').trim();

export function parseWeek(rows, sheetName) {
  const cell = (r, c) => { const v = rows.get(r)?.get(c); return v; };
  const dates = DAY_COL.map((c) => serialToISO(cell(2, c)));
  if (!dates[0]) return null;
  const warnings = [], brews = [], transfers = [], incomplete = [];

  const labels = [];
  for (let r = 3; r <= 60; r++) { const v = cell(r, 1); if (typeof v === 'string' && v.trim()) labels.push([r, v.trim()]); }
  const sections = labels.map(([r, text], i) => ({ text, from: r, to: (labels[i + 1]?.[0] ?? 61) - 1 }));

  for (const sec of sections) {
    const isBrew = /^(dme|krones)\s*brew/i.test(sec.text);
    const tr = /^transfer\s*(\d+)\s*hl/i.exec(sec.text);
    if (!isBrew && !tr) continue;
    for (let r = sec.from; r <= sec.to; r++) {
      for (let d = 0; d < 7; d++) {
        const date = dates[d] || (dates[0] ? new Date(Date.parse(dates[0] + 'T00:00:00Z') + d * 86400000).toISOString().slice(0, 10) : '');
        const strs = [0, 1, 2].map((k) => cell(r, DAY_COL[d] + k)).filter((v) => typeof v === 'string' && v.trim()).map(clean);
        if (!strs.length) continue;
        const ref = `${sheetName}!${String.fromCharCode(64 + DAY_COL[d])}${r}`;
        if (isBrew) {
          const kind = /^dme/i.test(sec.text) ? 'dme' : 'krones';
          const fvCells = strs.filter((s) => FV_RE.test(s) && !/\bCC\s*FV|\bPFV/i.test(s));
          if (!fvCells.length) { const odd = strs.find((s) => /FV|FMT/i.test(s) && !/CCFV|PFV/i.test(s)); if (odd) warnings.push({ ref, text: odd }); continue; }
          const recipe = strs.find((s) => !FV_RE.test(s) && !NOT_BEER.test(s) && !/^\d/.test(s)) || '';
          for (const fc of fvCells) for (const fv of nums(FV_RE.exec(fc)[1])) brews.push({ fv, date, recipe, kind, ref });
        } else {
          const fvCell = strs.find((s) => FV_RE.test(s));
          const bbtCell = strs.find((s) => BBT_RE.test(s));
          if (!fvCell && !bbtCell) continue;
          const batch = strs.find((s) => !FV_RE.test(s) && !BBT_RE.test(s) && !/^(SD TX|S\.D\.TX)/i.test(s)) || '';
          if (fvCell && bbtCell) {
            const bbt = +BBT_RE.exec(bbtCell)[1];
            for (const fv of nums(FV_RE.exec(fvCell)[1])) transfers.push({ fv, bbt, date, batch, hl: +tr[1], ref });
          } else {
            incomplete.push({ fv: fvCell ? nums(FV_RE.exec(fvCell)[1])[0] : null, bbt: bbtCell ? +BBT_RE.exec(bbtCell)[1] : null, date, batch, ref });
          }
        }
      }
    }
  }
  const uniq = (list, key) => { const seen = new Set(); return list.filter((x) => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true; }); };
  return {
    sheet: sheetName, monday: dates[0], sunday: dates[6] || dates[0],
    brews: uniq(brews, (b) => `${b.fv}|${b.date}`),
    transfers: uniq(transfers, (t) => `${t.fv}|${t.bbt}|${t.date}`),
    incomplete, warnings,
  };
}

export function parseBoard(bytes) {
  const wb = openWorkbook(bytes);
  const cands = wb.sheets.filter((s) => !s.hidden && /^(WC\b|Week of|Week\b)/i.test(s.name));
  const data = wb.readSheets(cands, { minRow: 1, maxRow: 62 });
  const byMonday = new Map();
  const skipped = [];
  for (const s of cands) {
    const wk = parseWeek(data.get(s.name) || new Map(), s.name);
    if (!wk) { skipped.push(s.name); continue; }
    const prev = byMonday.get(wk.monday);
    const isCopy = /^(OG\b|Copy of)/i.test(s.name);
    if (!prev || (prev.isCopy && !isCopy)) byMonday.set(wk.monday, { wk, isCopy });   // sheets are newest-first; keep the first real one
  }
  const weeks = [...byMonday.values()].map((x) => x.wk).sort((a, b) => (a.monday < b.monday ? -1 : 1));
  return { weeks, skipped, warnings: weeks.flatMap((w) => w.warnings) };
}

/* ---------------- Old CIP compliance tab (migration) ---------------- */
const LEGACY_SHEET = /^FV\/?\s*BBT\s+CIP\s+Compliance\s+(\d{2,4})$/i;

export function detectKind(bytes) {
  const wb = openWorkbook(bytes);
  if (wb.sheets.some((s) => LEGACY_SHEET.test(s.name))) return 'legacy';
  if (wb.sheets.some((s) => /^(WC\b|Week of)/i.test(s.name))) return 'board';
  return 'unknown';
}

export function parseLegacy(bytes) {
  const wb = openWorkbook(bytes);
  const targets = wb.sheets.filter((s) => LEGACY_SHEET.test(s.name));
  const data = wb.readSheets(targets, { minRow: 4, maxRow: 1500 });
  const out = [];
  for (const s of targets) {
    const rows = data.get(s.name) || new Map();
    const fv = [], bbt = [], warnings = [];
    for (const [rn, cells] of rows) {
      const g = (c) => cells.get(c);
      const dt = (c) => { const v = g(c); if (v === undefined) return ''; const d = serialToISO(v); if (!d) warnings.push(`${s.name} row ${rn}: unreadable date`); return d; };
      const fvNo = g(2);
      if (typeof fvNo === 'number' && Number.isInteger(fvNo) && fvNo > 0 && fvNo < 1000) {
        const row = { fv: fvNo, cip: dt(3), sip: dt(4), brew: dt(5) };
        if (row.cip || row.sip || row.brew) fv.push(row);
      }
      const bbtNo = g(10);
      if (typeof bbtNo === 'number' && Number.isInteger(bbtNo) && bbtNo > 0 && bbtNo < 1000) {
        const cnt = g(12);
        const row = { bbt: bbtNo, acidCip: dt(11), acidCount: typeof cnt === 'number' ? Math.round(cnt) : null, transfer: dt(13) };
        if (row.acidCip || row.transfer) bbt.push(row);
      }
    }
    out.push({ name: s.name, fv, bbt, warnings });
  }
  return { sheets: out };
}
