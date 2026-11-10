// Builds the Excel report (Summary, Fermenters, Brite tanks) in the site's colours.
import { buildXlsx } from './xlsxwrite.js';
import { fvStatus, bbtStatus, summarise, fvYear, bbtYear, isGood } from './rules.js';

const C = { mint: '#47D7AC', mintT: '#E4F9F2', orange: '#FDAA63', orangeT: '#FEEBD8', purple: '#7566A0', purpleT: '#ECE9F4', sky: '#99D6EA', skyT: '#E5F5FA', cream: '#F1EB9C', creamT: '#FAF8DB', gold: '#FFD637', goldT: '#FFF5C9', ink: '#000000', grey: '#6B6B6B', line: '#D9D9D9' };
const DATE = 'd mmm yyyy';
const border = { color: C.line };

// status state -> fill / text
const STATE = {
  ok: { bg: C.mintT, color: '#116B52' }, ok72: { bg: C.mintT, color: '#116B52' }, 'ok-dme': { bg: C.purpleT, color: '#4B3F78' },
  bad: { bg: C.orange, color: '#000000' }, check: { bg: C.orange, color: '#000000' },
  need: { bg: C.gold, color: '#000000' }, wait: { bg: C.skyT, color: '#235E73' },
};
const LABEL = { ok: 'Compliant', ok72: 'Compliant', 'ok-dme': 'Compliant', bad: 'Not compliant', check: 'Check dates', need: 'Needs data', wait: 'Not due yet' };

const banner = (text, width, bg, color) => [{ v: text, s: { b: true, sz: 18, color, bg, indent: 1 } }, ...Array(width - 1).fill({ v: '', s: { bg } })];
const th = (text, bg, color, h = 'center') => ({ v: text, s: { b: true, color, bg, h, wrap: true, border: { color: bg === C.ink ? C.ink : C.line } } });
const td = (v, extra = {}) => ({ v, s: { border, h: 'center', ...extra } });
const date = (iso, extra = {}) => ({ d: iso || '', v: '', s: { border, h: 'center', fmt: DATE, ...extra } });

export function buildReport(db, cfg, year, today) {
  const rules = cfg.rules;
  const fv = db.fv.filter((r) => fvYear(r) === year).map((r) => ({ r, s: fvStatus(r, today, rules) }));
  const bbt = db.bbt.filter((r) => bbtYear(r) === year).map((r) => ({ r, s: bbtStatus(r, cfg.dme, today, rules) }));
  const key = (k) => (a, b) => ((a.r[k] || '9999') < (b.r[k] || '9999') ? 1 : (a.r[k] || '9999') > (b.r[k] || '9999') ? -1 : 0);   // newest first; undated rows on top
  fv.sort(key('brew')); bbt.sort(key('transfer'));                        // latest first, like the site
  const fvSum = summarise(fv.map((x) => x.r), (r) => fvStatus(r, today, rules));
  const bbtSum = summarise(bbt.map((x) => x.r), (r) => bbtStatus(r, cfg.dme, today, rules));
  const nice = new Date(today + 'T00:00:00Z').toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const stat = (s) => ({ v: LABEL[s.state], s: { border, h: 'center', b: true, ...STATE[s.state] } });
  const tone = (t) => (t === 'ok' ? { bg: C.mintT } : t === 'bad' ? { bg: C.orange } : t === 'dme' ? { bg: C.purpleT } : {});

  /* ---------- Summary ---------- */
  const W = 4;
  const sum = [
    banner(`CIP / SIP Compliance ${year}`, W, C.ink, '#FFFFFF'),
    [{ v: `Balter Brewing  ·  exported ${nice}`, s: { color: C.grey, indent: 1 } }],
    [],
    [th('', C.ink, '#FFFFFF', 'left'), th('Fermenters', C.mint, C.ink), th('Brite tanks', C.purple, '#FFFFFF'), null],
  ];
  const line = (label, a, b, fillA, fillB, bold) => sum.push([
    { v: label, s: { border, b: !!bold, indent: 1 } },
    td(a, { b: !!bold, ...(fillA ? { bg: fillA } : {}) }), td(b, { b: !!bold, ...(fillB ? { bg: fillB } : {}) }),
  ]);
  line('Rows this year', fvSum.total, bbtSum.total);
  line('Compliant', fvSum.good, bbtSum.good, C.mintT, C.mintT);
  line('Not compliant', fvSum.bad, bbtSum.bad, fvSum.bad ? C.orange : null, bbtSum.bad ? C.orange : null);
  line('Needs data (past dates)', fvSum.need, bbtSum.need, fvSum.need ? C.gold : null, bbtSum.need ? C.gold : null);
  line('Not due yet', fvSum.wait, bbtSum.wait, C.skyT, C.skyT);
  if (fvSum.check || bbtSum.check) line('Check dates', fvSum.check, bbtSum.check, C.orange, C.orange);
  sum.push([{ v: 'Compliance', s: { border, b: true, indent: 1, sz: 14, bg: C.creamT } }, ...[fvSum, bbtSum].map((s) => td(s.pct === null ? '–' : s.pct / 100, { b: true, sz: 16, fmt: '0%', bg: C.cream }))]);
  sum.push([{ v: 'Compliance = compliant ÷ (compliant + not compliant). Rows still needing data or not yet due are not counted.', s: { color: C.grey, i: true, sz: 9, indent: 1 } }]);
  sum.push([]);
  sum.push([th('Rules used', C.ink, '#FFFFFF', 'left'), th('', C.ink, '#FFFFFF'), th('', C.ink, '#FFFFFF'), null]);
  const rule = (text, val, bg) => sum.push([{ v: text, s: { border, indent: 1, wrap: true, bg } }, td(val, { b: true, bg }), null]);
  const band = (text, bg, color) => sum.push([{ v: text, s: { b: true, bg, color, indent: 1 } }, { v: '', s: { bg } }, { v: '', s: { bg } }]);
  const bands = [];
  band('Fermenters', C.mint, C.ink); bands.push(sum.length);
  rule('CIP done fewer than … days before the brew', rules.fvCip);
  rule('SIP done fewer than … days (72 h) before the brew', rules.fvSip);
  rule('Every CIP is followed by a SIP. A tank unfilled for over a week needs a new CIP and SIP; over 72 h after its SIP it needs another SIP.', '');
  band('Brite tanks', C.purple, '#FFFFFF'); bands.push(sum.length);
  rule('CIP (caustic) required after … fills; a tank on this count can’t be filled until it has had a CIP', rules.cntMax);
  rule('Acid CIP or CIP done fewer than … days before the transfer', rules.bbtDays);
  rule('DME tanks (acceptable when over the clean window)', db.cfg.dme || '');
  rule('Each acid CIP (acid wash after a fill) adds 1 to the count; a CIP at any time resets it to 0.', '');
  sum.push([]);
  sum.push([th('Colour key', C.ink, '#FFFFFF', 'left'), th('', C.ink, '#FFFFFF'), th('', C.ink, '#FFFFFF'), null]);
  for (const [state, text] of [['ok', 'Compliant'], ['ok-dme', 'Compliant (DME tank over the clean window)'], ['bad', 'Not compliant'], ['need', 'Needs CIP / SIP data (past date)'], ['wait', 'Not due yet (today or later)']]) {
    sum.push([{ v: text, s: { border, indent: 1 } }, { v: LABEL[state], s: { border, h: 'center', b: true, ...STATE[state] } }, null]);
  }
  const summary = { name: 'Summary', rows: sum, widths: [62, 18, 18, 4], tab: C.ink, merges: ['A1:D1', 'A2:D2'], heights: { 0: 34, 1: 20, 3: 24 }, landscape: false };

  /* ---------- Fermenters ---------- */
  const fvHead = ['FV', 'CIP date', 'SIP date', 'Brew date', 'Beer', 'CIP → brew (days)', 'SIP → brew (days)', 'Status'];
  const fvRows = [
    banner(`Fermenters ${year}`, fvHead.length, C.mint, C.ink),
    [{ v: `${fvSum.total} rows · ${fvSum.good} compliant · ${fvSum.bad} not compliant · ${fvSum.need} need data  (latest brew first)`, s: { color: C.grey, indent: 1 } }],
    [],
    fvHead.map((h, i) => th(h, C.ink, '#FFFFFF', i === 4 ? 'left' : 'center')),
    ...fv.map(({ r, s }) => [
      td(r.fv, { b: true, bg: C.mintT }), date(r.cip), date(r.sip), date(r.brew),
      td(r.recipe, { h: 'left', indent: 1 }),
      td(r.cip && r.brew ? s.f : '', tone(s.fTone)), td(r.sip && r.brew ? s.g : '', tone(s.gTone)), stat(s),
    ]),
  ];
  const fvSheet = { name: 'Fermenters', rows: fvRows, widths: [8, 15, 15, 15, 34, 17, 17, 17], tab: C.mint, freeze: 4, filter: 4, merges: ['A1:H1', 'A2:H2'], heights: { 0: 30, 3: 32 } };

  /* ---------- Brite tanks ---------- */
  const bbtHead = ['BBT', 'Tank', 'Clean date', 'Clean type', 'SIP date (after CIP)', 'Fills since last CIP', 'Transfer date', 'From FV', 'Beer', 'Clean → transfer (days)', 'Ready to fill?'];
  const bbtRows = [
    banner(`Brite tanks ${year}`, bbtHead.length, C.purple, '#FFFFFF'),
    [{ v: `${bbtSum.total} rows · ${bbtSum.good} compliant · ${bbtSum.bad} not compliant · ${bbtSum.need} need data  (latest transfer first)`, s: { color: C.grey, indent: 1 } }],
    [],
    bbtHead.map((h, i) => th(h, C.ink, '#FFFFFF', i === 8 ? 'left' : 'center')),
    ...bbt.map(({ r, s }) => [
      td(r.bbt, { b: true, bg: C.purpleT }), td(s.dme ? 'DME' : 'Krones', { color: s.dme ? '#4B3F78' : C.ink }),
      date(r.acidCip), td(r.acidType === 'cip' ? 'CIP' : r.acidType === 'sip' ? 'Acid CIP' : r.acidCip ? '' : ''),
      date(r.acidType === 'cip' ? r.acidSip : ''),
      td(r.acidCount === null ? '' : r.acidCount, s.countTone === 'bad' ? { bg: C.orange, b: true } : {}),
      date(r.transfer), td(r.fromFv || ''), td(r.batch, { h: 'left', indent: 1 }),
      td(r.acidCip && r.transfer ? s.n : '', tone(s.nTone)), stat(s),
    ]),
  ];
  const bbtSheet = { name: 'Brite tanks', rows: bbtRows, widths: [8, 10, 15, 13, 17, 14, 15, 10, 34, 17, 17], tab: C.purple, freeze: 4, filter: 4, merges: ['A1:K1', 'A2:K2'], heights: { 0: 30, 3: 44 } };

  return buildXlsx([summary, fvSheet, bbtSheet], { title: `Balter Brewing CIP / SIP Compliance ${year}` });
}
