// Run with:  npm test   (Node 20+). Real-file tests run only if the two spreadsheets are present in ./test/data or /mnt/user-data/uploads.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { fvStatus, bbtStatus, parseList, summarise, addDays, mondayOf, diffDays } from '../public/js/rules.js';
import { applyOps, emptyDb } from '../public/js/ops.js';
import { planBoardImport, planLegacyImport } from '../public/js/merge.js';
import { parseWeek, parseBoard, parseLegacy, detectKind } from '../public/js/board.js';
import worker from '../src/worker.js';

let passed = 0, failed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const T = '2026-11-10';

/* ---------------- rules: identical to the spreadsheet formulas ---------------- */
test('FV compliance matches the sheet formula for every CIP/SIP/brew combination', () => {
  // sheet: =IF(AND(F<8,G<3),"Yes",IF(AND(F=3,G=3),"Yes <72 hours since CIP","No"))  with F=brew-CIP, G=brew-SIP
  const sheet = (F, G) => (F < 8 && G < 3 ? 'Yes' : F === 3 && G === 3 ? 'Yes <72 hours since CIP' : 'No');
  let n = 0;
  for (let F = 0; F <= 12; F++) for (let G = 0; G <= F; G++) {   // SIP is never before CIP
    const r = { fv: 1, brew: '2026-06-20', cip: addDays('2026-06-20', -F), sip: addDays('2026-06-20', -G) };
    const s = fvStatus(r, '2026-07-01');
    const exp = sheet(F, G);
    assert.equal(s.state === 'ok' || s.state === 'ok72' ? (s.state === 'ok72' ? 'Yes <72 hours since CIP' : 'Yes') : 'No', exp, `F=${F} G=${G}`);
    n++;
  }
  assert.ok(n > 80);
});
test('FV states: need / wait / check / planned', () => {
  assert.equal(fvStatus({ brew: '2026-11-11', cip: '', sip: '' }, T).state, 'need');
  assert.equal(fvStatus({ brew: '2026-11-11', cip: '', sip: '' }, T).label, 'Needs CIP + SIP');
  assert.equal(fvStatus({ brew: '2026-11-11', cip: '2026-11-09', sip: '' }, T).label, 'Needs SIP');
  assert.equal(fvStatus({ brew: '', cip: '2026-11-09', sip: '' }, T).state, 'wait');
  assert.equal(fvStatus({ brew: '2026-11-01', cip: '2026-11-02', sip: '2026-11-02' }, T).state, 'check');
  assert.equal(fvStatus({ brew: '2026-11-11', cip: '2026-11-10', sip: '2026-11-10' }, T).planned, true);
  assert.equal(fvStatus({ brew: '2026-11-08', cip: '2026-11-01', sip: '2026-11-08' }, T).state, 'ok');   // CIP 7 days (<8) and SIP same day -> compliant
});
test('FV boundary: CIP 7 days ok, 8 days bad; SIP 2 days ok, 3 days bad', () => {
  const mk = (F, G) => fvStatus({ fv: 1, brew: '2026-06-20', cip: addDays('2026-06-20', -F), sip: addDays('2026-06-20', -G) }, T).state;
  assert.equal(mk(7, 2), 'ok'); assert.equal(mk(8, 2), 'bad'); assert.equal(mk(5, 3), 'bad'); assert.equal(mk(3, 3), 'ok72');
});
test('planned rows are never judged early', () => {
  const f = fvStatus({ fv: 1, brew: '2026-11-22', cip: '2026-11-10', sip: '2026-11-10' }, T);
  assert.equal(f.state, 'need'); assert.equal(f.label, 'CIP/SIP too early'); assert.ok(f.reasons.length);
  assert.equal(fvStatus({ fv: 1, brew: '2026-11-10', cip: '2026-11-01', sip: '2026-11-01' }, T).state, 'bad', 'on the day it is judged');
  const b = bbtStatus({ bbt: 8, acidCip: '2026-11-10', transfer: '2026-11-20', acidCount: 2 }, [3, 4, 5, 6], T);
  assert.equal(b.state, 'need'); assert.equal(b.label, 'Acid CIP too early');
  assert.equal(bbtStatus({ bbt: 8, acidCip: '2026-11-19', transfer: '2026-11-20', acidCount: 8 }, [3, 4, 5, 6], T).label, 'Acid CIP due');
});
test('BBT rules: DME purple, Krones flagged, count thresholds', () => {
  const dme = [3, 4, 5, 6];
  const mk = (bbt, n, count) => bbtStatus({ bbt, acidCip: addDays('2026-06-20', -n), transfer: '2026-06-20', acidCount: count }, dme, T);
  assert.equal(mk(4, 1, 2).state, 'ok');
  assert.equal(mk(4, 5, 2).state, 'ok-dme');           // over 2 days is fine for DME
  assert.equal(mk(4, 5, 2).nTone, 'dme');
  assert.equal(mk(8, 5, 2).state, 'bad');              // Krones: must be < 3
  assert.equal(mk(8, 2, 2).state, 'ok');
  assert.equal(mk(8, 1, 6).countTone, 'warn1'); assert.equal(mk(8, 1, 7).countTone, 'warn2'); assert.equal(mk(8, 1, 8).countTone, 'bad');
  assert.equal(mk(8, 1, 8).state, 'bad'); assert.equal(mk(8, 1, 7).state, 'ok');
  assert.equal(mk(8, 1, null).state, 'need');
  assert.equal(bbtStatus({ bbt: 2, acidCip: '', transfer: '2026-11-12', acidCount: null }, dme, T).state, 'need');
  assert.equal(bbtStatus({ bbt: 2, acidCip: '2026-11-09', transfer: '', acidCount: 1 }, dme, T).state, 'wait');
});
test('Real-data cross-check: BBT counts/tones vs the sheet conditional formats', () => {
  // sheet CF: N<3 green, N>2 purple (DME); L=6/7/8 -> yellow/orange/red; O = "Yes" if L<8
  const dme = [3, 4, 5, 6];
  for (const L of [0, 3, 5, 6, 7, 8, 9]) {
    const s = bbtStatus({ bbt: 4, acidCip: '2026-06-19', transfer: '2026-06-20', acidCount: L }, dme, T);
    assert.equal(s.state === 'bad', L >= 8, `L=${L}`);
  }
});
test('parseList / summarise / dates', () => {
  assert.deepEqual(parseList('1-3, 5, 7-8'), [1, 2, 3, 5, 7, 8]);
  assert.deepEqual(parseList('  '), []);
  assert.equal(mondayOf('2026-11-12'), '2026-11-09'); assert.equal(mondayOf('2026-11-15'), '2026-11-09'); assert.equal(mondayOf('2026-11-09'), '2026-11-09');
  assert.equal(diffDays('2026-03-01', '2026-02-27'), 2);
  const s = summarise([{ brew: '2026-06-20', cip: '2026-06-19', sip: '2026-06-19' }, { brew: '2026-06-20', cip: '2026-06-01', sip: '2026-06-01' }, { brew: '2026-06-20', cip: '', sip: '' }], (r) => fvStatus(r, T));
  assert.deepEqual([s.total, s.good, s.bad, s.need, s.pct], [3, 1, 1, 1, 50]);
});

/* ---------------- ops ---------------- */
test('applyOps validates, upserts and deletes', () => {
  const db = emptyDb();
  const n = applyOps(db, [
    { op: 'put', t: 'fv', rec: { id: 'a', fv: 5, cip: '2026-01-02', sip: 'nope', brew: '2026-01-03', recipe: '  IPA   X2 ', evil: 1 } },
    { op: 'put', t: 'fv', rec: { id: '', fv: 5 } }, { op: 'put', t: 'fv', rec: { id: 'b', fv: 0 } }, { op: 'put', t: 'zzz', rec: {} }, null,
    { op: 'put', t: 'bbt', rec: { id: 'c', bbt: 3, acidCount: '4', fromFv: '12' } },
  ]);
  assert.equal(n, 2);
  assert.deepEqual(db.fv[0], { id: 'a', fv: 5, cip: '2026-01-02', sip: '', brew: '2026-01-03', recipe: 'IPA X2', note: '', bsrc: '' });
  assert.equal(db.bbt[0].acidCount, 4); assert.equal(db.bbt[0].fromFv, 12);
  applyOps(db, [{ op: 'put', t: 'fv', rec: { id: 'a', fv: 5, sip: '2026-01-02' } }]);
  assert.equal(db.fv.length, 1); assert.equal(db.fv[0].sip, '2026-01-02');
  applyOps(db, [{ op: 'del', t: 'fv', id: 'a' }, { op: 'cfg', set: { dme: '1-2', fvs: '<script>' } }]);
  assert.equal(db.fv.length, 0); assert.equal(db.cfg.dme, '1-2'); assert.notEqual(db.cfg.fvs, '<script>');
});

/* ---------------- merge logic (synthetic) ---------------- */
const week = (monday, brews = [], transfers = []) => ({ sheet: 'WC', monday, sunday: addDays(monday, 6), brews, transfers, incomplete: [], warnings: [] });
const apply = (db, plan) => { applyOps(db, plan.ops); return db; };
const FROM = '2026-11-01';

test('board import: new rows, idempotent, preserves manual CIP/SIP', () => {
  const parsed = { weeks: [week('2026-11-09', [{ fv: 23, date: '2026-11-11', recipe: 'CPTX2', kind: 'dme' }], [{ fv: 23, bbt: 4, date: '2026-11-10', batch: 'IPA 6150', hl: 70 }])], warnings: [] };
  const db = emptyDb();
  let plan = planBoardImport(db, parsed, { from: FROM, today: T });
  assert.equal(plan.fv.new, 1); assert.equal(plan.bbt.new, 1); assert.equal(plan.fv.needs, 1);
  apply(db, plan);
  // operator enters data
  db.fv[0].cip = '2026-11-10'; db.fv[0].sip = '2026-11-10'; db.bbt[0].acidCip = '2026-11-09'; db.bbt[0].acidCount = 2;
  plan = planBoardImport(db, parsed, { from: FROM, today: T });
  assert.equal(plan.ops.length, 0, 'second import is a no-op');
  assert.equal(db.fv[0].cip, '2026-11-10');
});
test('board import: a CIP/SIP logged ahead of the brew attaches to the next brew', () => {
  const db = emptyDb();
  db.fv.push({ id: 'x', fv: 23, cip: '2026-11-09', sip: '2026-11-10', brew: '', recipe: '', note: '', bsrc: '' });
  const parsed = { weeks: [week('2026-11-09', [{ fv: 23, date: '2026-11-11', recipe: 'CPTX2' }])] , warnings: [] };
  const plan = planBoardImport(db, parsed, { from: FROM, today: T });
  assert.equal(plan.fv.attached, 1); assert.equal(plan.fv.new, 0);
  apply(db, plan);
  assert.equal(db.fv.length, 1); assert.equal(db.fv[0].brew, '2026-11-11'); assert.equal(db.fv[0].cip, '2026-11-09'); assert.equal(db.fv[0].bsrc, 'board');
  assert.equal(fvStatus(db.fv[0], T).state, 'ok');
});
test('board import: pending CIP does not attach to a stale past brew', () => {
  const db = emptyDb();
  db.fv.push({ id: 'x', fv: 23, cip: '2026-11-09', sip: '', brew: '', recipe: '', note: '', bsrc: '' });
  const parsed = { weeks: [week('2026-11-02', [{ fv: 23, date: '2026-11-03', recipe: 'OLD' }]), week('2026-11-09', [{ fv: 23, date: '2026-11-12', recipe: 'NEW' }])], warnings: [] };
  const plan = planBoardImport(db, parsed, { from: FROM, today: T });
  apply(db, plan);
  assert.equal(db.fv.find((r) => r.id === 'x').brew, '2026-11-12');
  assert.equal(db.fv.length, 2);
});
test('board import: plan changes — moved brew with data is detached then re-attached; without data it is removed', () => {
  const db = emptyDb();
  apply(db, planBoardImport(db, { weeks: [week('2026-11-09', [{ fv: 10, date: '2026-11-12', recipe: 'A' }, { fv: 11, date: '2026-11-12', recipe: 'B' }])], warnings: [] }, { from: FROM, today: T }));
  const withData = db.fv.find((r) => r.fv === 10); withData.cip = '2026-11-11'; withData.sip = '2026-11-11';
  // both brews moved to the 13th
  const moved = { weeks: [week('2026-11-09', [{ fv: 10, date: '2026-11-13', recipe: 'A' }])], warnings: [] };
  const plan = planBoardImport(db, moved, { from: FROM, today: T });
  assert.equal(plan.fv.removed, 1); assert.equal(plan.fv.detached, 1); assert.equal(plan.fv.attached, 1);
  apply(db, plan);
  assert.equal(db.fv.length, 1);
  assert.equal(db.fv[0].brew, '2026-11-13'); assert.equal(db.fv[0].cip, '2026-11-11');
});
test('board import: a double-batch fill over consecutive days is one FV row (first day)', () => {
  const db = emptyDb();
  const parsed = { weeks: [week('2026-11-09', [{ fv: 38, date: '2026-11-12', recipe: 'EAZYx2' }, { fv: 38, date: '2026-11-13', recipe: 'EAZYx2' }]), week('2026-11-23', [{ fv: 38, date: '2026-11-25', recipe: 'IPA' }])], warnings: [] };
  const plan = planBoardImport(db, parsed, { from: FROM, today: T });
  assert.equal(plan.fv.new, 2); assert.equal(plan.fv.topups, 1);
  apply(db, plan);
  assert.deepEqual(db.fv.map((r) => r.brew).sort(), ['2026-11-12', '2026-11-25']);
});
test('board import: history is never altered by plan-change logic', () => {
  const db = emptyDb();
  db.fv.push({ id: 'h', fv: 5, cip: '', sip: '', brew: '2026-11-03', recipe: 'OLD', note: '', bsrc: 'board' });
  const plan = planBoardImport(db, { weeks: [week('2026-11-02', [])], warnings: [] }, { from: FROM, today: T });
  assert.equal(plan.ops.length, 0);
});
test('board import: two FVs into one BBT on a day is one BBT fill; open acid CIP attaches', () => {
  const db = emptyDb();
  db.bbt.push({ id: 'o', bbt: 4, acidCip: '2026-11-09', acidCount: 2, transfer: '', fromFv: null, batch: '', note: '', tsrc: '' });
  const parsed = { weeks: [week('2026-11-09', [], [{ fv: 23, bbt: 4, date: '2026-11-10', batch: 'IPA 1' }, { fv: 24, bbt: 4, date: '2026-11-10', batch: 'IPA 1' }])], warnings: [] };
  const plan = planBoardImport(db, parsed, { from: FROM, today: T });
  assert.equal(plan.bbt.attached, 1); assert.equal(plan.bbt.new, 0);
  apply(db, plan);
  assert.equal(db.bbt.length, 1); assert.equal(db.bbt[0].fromFv, 23);
  assert.equal(planBoardImport(db, parsed, { from: FROM, today: T }).ops.length, 0);
});
test('board import: migrated rows (±2 days) are matched, not duplicated', () => {
  const db = emptyDb();
  db.fv.push({ id: 'm', fv: 7, cip: '2026-11-04', sip: '2026-11-05', brew: '2026-11-06', recipe: '', note: '', bsrc: 'sheet' });
  const plan = planBoardImport(db, { weeks: [week('2026-11-02', [{ fv: 7, date: '2026-11-05', recipe: 'LPAX2' }])], warnings: [] }, { from: FROM, today: T });
  assert.equal(plan.fv.new, 0); apply(db, plan);
  assert.equal(db.fv.length, 1); assert.equal(db.fv[0].brew, '2026-11-06'); assert.equal(db.fv[0].recipe, 'LPAX2');
});
test('legacy import is idempotent and merges into board rows', () => {
  const legacy = { sheets: [{ name: 'FVBBT CIP Compliance 26', warnings: [], fv: [{ fv: 5, cip: '2026-01-02', sip: '2026-01-03', brew: '2026-01-04' }, { fv: 5, cip: '2026-01-10', sip: '2026-01-10', brew: '' }], bbt: [{ bbt: 3, acidCip: '2026-01-01', acidCount: 2, transfer: '2026-01-04' }] }] };
  const db = emptyDb();
  apply(db, planBoardImport(db, { weeks: [week('2025-12-29', [{ fv: 5, date: '2026-01-03', recipe: 'XPAX6' }], [{ fv: 5, bbt: 3, date: '2026-01-05', batch: 'XPA 1' }])], warnings: [] }, { from: '2025-12-01', today: T }));
  const plan = planLegacyImport(db, legacy);
  apply(db, plan);
  assert.equal(db.fv.length, 2, 'board row merged with sheet row + one open row'); assert.equal(db.bbt.length, 1);
  const r = db.fv.find((x) => x.brew); assert.equal(r.brew, '2026-01-04'); assert.equal(r.cip, '2026-01-02'); assert.equal(r.recipe, 'XPAX6'); assert.equal(r.bsrc, 'sheet');
  assert.equal(db.bbt[0].acidCount, 2); assert.equal(db.bbt[0].batch, 'XPA 1'); assert.equal(db.bbt[0].fromFv, 5);
  assert.equal(planLegacyImport(db, legacy).ops.length, 0);
});

/* ---------------- board layout (synthetic cells) ---------------- */
const rowsOf = (cells) => { const m = new Map(); for (const [r, c, v] of cells) { if (!m.has(r)) m.set(r, new Map()); m.get(r).set(c, v); } return m; };
const serial = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8)) / 86400000 + 25569;
test('parseWeek: brews, transfers, multi-FV, CCFV/PFV ignored, partial transfers reported', () => {
  const rows = rowsOf([
    [2, 2, serial('2026-11-09')], [2, 5, serial('2026-11-10')], [2, 8, serial('2026-11-11')],
    [14, 1, 'DME Brew'], [14, 2, 'IPAX2'], [14, 3, 'FV18'], [14, 5, 'CIP'],
    [18, 1, 'YO1 to YPP'], [18, 3, 'CCFV48'],
    [19, 1, 'KRONES Brew'], [19, 8, 'XPAX6'], [19, 9, 'FV23/FV24'], [19, 10, 'YPP1'], [20, 5, 'PFV2'],
    [28, 1, 'Transfer 70HL'], [28, 5, 'IPA 6150'], [28, 6, 'FV23'], [28, 7, 'BBT4'],
    [29, 8, 'BLACK 1'], [29, 9, 'FV16,23,24'], [29, 10, 'SD TX BBT5'],
    [30, 5, 'LAGER'], [30, 6, 'FV31'],
    [32, 1, 'Transfer 300HL'], [32, 2, 'EAZY  6139 '], [32, 3, 'FV 44'], [32, 4, 'BBT2'],
    [36, 1, 'Cartons'], [36, 2, 'EAZY 6151'], [36, 3, 'BBT7'], [36, 4, 7700],
  ]);
  const w = parseWeek(rows, 'WC 9th Nov');
  assert.deepEqual(w.brews.map((b) => [b.fv, b.date, b.recipe]), [[18, '2026-11-09', 'IPAX2'], [23, '2026-11-11', 'XPAX6'], [24, '2026-11-11', 'XPAX6']]);
  assert.deepEqual(w.transfers.map((t) => [t.fv, t.bbt, t.date, t.batch]), [[23, 4, '2026-11-10', 'IPA 6150'], [16, 5, '2026-11-11', 'BLACK 1'], [23, 5, '2026-11-11', 'BLACK 1'], [24, 5, '2026-11-11', 'BLACK 1'], [44, 2, '2026-11-09', 'EAZY 6139']]);
  assert.equal(w.incomplete.length, 1); assert.equal(w.incomplete[0].fv, 31);
});

/* ---------------- real files ---------------- */
const find = (name) => ['./test/data/', '/mnt/user-data/uploads/'].flatMap((d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith(name)).map((f) => d + f) : []))[0];
const boardPath = find('Live_Brewery_Board.xlsx'), legacyPath = find('Vessel__Equipment_CIP_monitoring.xlsx');
if (boardPath && legacyPath) {
  const board = new Uint8Array(fs.readFileSync(boardPath)), legacy = new Uint8Array(fs.readFileSync(legacyPath));
  let pb, pl;
  test('real files: kinds detected', () => { assert.equal(detectKind(board), 'board'); assert.equal(detectKind(legacy), 'legacy'); });
  test('real board: parses every weekly sheet quickly', () => {
    const t = Date.now(); pb = parseBoard(board);
    assert.ok(pb.weeks.length > 100, 'weeks ' + pb.weeks.length); assert.ok(Date.now() - t < 5000);
    const wk = pb.weeks.find((w) => w.monday === '2026-11-09');
    assert.ok(wk.brews.some((b) => b.fv === 48 && b.date === '2026-11-09') && wk.brews.some((b) => b.fv === 49 && b.date === '2026-11-10'));
    assert.ok(wk.transfers.some((t) => t.fv === 23 && t.bbt === 4 && t.date === '2026-11-10' && t.batch === 'IPA 6150'));
  });
  test('real data: board agrees with the logged 2026 sheet (±2 days)', () => {
    pl = parseLegacy(legacy);
    const sheet = pl.sheets.flatMap((s) => s.fv).filter((r) => r.brew), sheetB = pl.sheets.flatMap((s) => s.bbt).filter((r) => r.transfer);
    const wk = pb.weeks.filter((w) => w.monday >= '2025-12-29' && w.monday <= '2026-11-02');
    const near = (list, key, v, d) => list.some((r) => r[key] === v.n && Math.abs(diffDays(r.d, d)) <= 2);
    const fvs = wk.flatMap((w) => w.brews), bbts = wk.flatMap((w) => w.transfers);
    const fvHit = fvs.filter((b) => sheet.some((r) => r.fv === b.fv && Math.abs(diffDays(r.brew, b.date)) <= 2)).length / fvs.length;
    const bbtHit = bbts.filter((t) => sheetB.some((r) => r.bbt === t.bbt && Math.abs(diffDays(r.transfer, t.date)) <= 2)).length / bbts.length;
    assert.ok(fvHit > 0.95, 'FV agreement ' + fvHit); assert.ok(bbtHit > 0.95, 'BBT agreement ' + bbtHit); void near;
  });
  test('real data: end-to-end migrate then board import yields few duplicates and sane statuses', () => {
    const db = emptyDb();
    apply(db, planLegacyImport(db, pl, { sheets: ['FVBBT CIP Compliance 26'] }));
    const nFv = db.fv.length, nB = db.bbt.length;
    assert.ok(nFv > 400 && nB > 400, `${nFv}/${nB}`);
    const plan = planBoardImport(db, pb, { from: '2026-01-01', today: T });
    apply(db, plan);
    const pastNew = plan.items.fv.filter((i) => i.action === 'new' && i.date < T).length;
    assert.ok(pastNew <= 12, 'past board brews missing from the sheet: ' + pastNew);    // a handful of planned brews that were never logged
    assert.ok(planBoardImport(db, pb, { from: '2026-01-01', today: T }).ops.length === 0, 'idempotent');
    const sum = summarise(db.fv.filter((r) => r.brew.startsWith('2026')), (r) => fvStatus(r, T));
    assert.ok(sum.bad >= 1 && sum.bad < 15, 'bad ' + sum.bad);   // the sheet itself has 2 non-compliant rows
    // upcoming rows are waiting for data
    assert.ok(db.fv.filter((r) => r.brew > T && !r.cip).length >= 5);
  });
  test('real data: legacy FV compliance matches the sheet’s own "No" count', () => {
    const rows = pl.sheets.find((s) => /26$/.test(s.name)).fv.filter((r) => r.cip && r.sip && r.brew);
    const no = rows.filter((r) => fvStatus(r, T).state === 'bad').length;
    assert.equal(no, 2);   // openpyxl check of the sheet: 2 of 450 non-compliant
  });
}

/* ---------------- worker (fake KV + assets) ---------------- */
function fakeEnv(extra = {}) {
  const store = new Map();
  const KV = { async get(k, type) { const e = store.get(k); if (!e) return null; return type === 'json' ? JSON.parse(e) : e; }, async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); } };
  const ASSETS = { async fetch(req) { const p = new URL(req.url).pathname; return p === '/missing' ? new Response('nope', { status: 404 }) : new Response(`asset:${p}`, { headers: { 'content-type': 'text/html' } }); } };
  return { KV, ASSETS, store, ...extra };
}
const call = async (env, path, { method = 'GET', body, cookie, origin } = {}) => {
  const headers = {}; if (body) headers['content-type'] = 'application/json'; if (cookie) headers.cookie = cookie; if (origin) headers.origin = origin;
  return worker.fetch(new Request('https://tracker.example' + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' }), env);
};
const cookieFrom = (res) => (res.headers.get('set-cookie') || '').split(';')[0];

test('worker: unauthenticated visitors only get the login page', async () => {
  const env = fakeEnv();
  let r = await call(env, '/'); assert.equal(r.status, 302); assert.equal(r.headers.get('location'), 'https://tracker.example/login');
  r = await call(env, '/js/app.js'); assert.equal(r.status, 302);
  r = await call(env, '/login'); assert.equal(r.status, 200); assert.match(await r.text(), /asset:\/login.html/);
  r = await call(env, '/app.css'); assert.equal(r.status, 200);
  r = await call(env, '/api/db'); assert.equal(r.status, 401);
  r = await call(env, '/api/db', { method: 'PUT', body: { ops: [] } }); assert.equal(r.status, 401);
  assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow');
});
test('worker: first-time setup, login, wrong password, logout', async () => {
  const env = fakeEnv();
  let r = await call(env, '/api/auth/status'); assert.deepEqual(await r.json(), { configured: false, authed: false, needsCode: false });
  r = await call(env, '/api/auth/setup', { method: 'POST', body: { password: 'short' } }); assert.equal(r.status, 400);
  r = await call(env, '/api/auth/setup', { method: 'POST', body: { password: '12345' } }); assert.equal(r.status, 400, 'PIN must be exactly 4 digits');
  r = await call(env, '/api/auth/setup', { method: 'POST', body: { password: '4827' } }); assert.equal(r.status, 200);
  const ck = cookieFrom(r); assert.match(ck, /^bct=/);
  assert.match(r.headers.get('set-cookie'), /HttpOnly/); assert.match(r.headers.get('set-cookie'), /Secure/); assert.match(r.headers.get('set-cookie'), /SameSite=Strict/);
  assert.ok(!JSON.stringify([...env.store.values()]).includes('4827'), 'password is never stored in clear');
  r = await call(env, '/api/auth/setup', { method: 'POST', body: { password: '1111' } }); assert.equal(r.status, 409, 'cannot re-run setup');
  r = await call(env, '/', { cookie: ck }); assert.equal(r.status, 200); assert.match(await r.text(), /asset:\/index.html/);
  r = await call(env, '/login', { cookie: ck }); assert.equal(r.status, 302);
  r = await call(env, '/api/auth/login', { method: 'POST', body: { password: 'wrong' } }); assert.equal(r.status, 401);
  r = await call(env, '/api/auth/login', { method: 'POST', body: { password: '4827' } }); assert.equal(r.status, 200);
  const ck2 = cookieFrom(r);
  r = await call(env, '/api/auth/logout', { method: 'POST', cookie: ck2 }); assert.equal(r.status, 200);
  r = await call(env, '/api/db', { cookie: ck2 }); assert.equal(r.status, 401, 'session is revoked server-side');
});
test('worker: login is rate limited', async () => {
  const env = fakeEnv();
  await call(env, '/api/auth/setup', { method: 'POST', body: { password: '4827' } });
  let last; for (let i = 0; i < 6; i++) last = await call(env, '/api/auth/login', { method: 'POST', body: { password: 'nope' + i } });
  assert.equal(last.status, 429);
  const r = await call(env, '/api/auth/login', { method: 'POST', body: { password: '4827' } }); assert.equal(r.status, 429, 'even the right password waits');
});
test('worker: SETUP_CODE guards first-time setup', async () => {
  const env = fakeEnv({ SETUP_CODE: 'brew-crew' });
  assert.equal((await (await call(env, '/api/auth/status')).json()).needsCode, true);
  let r = await call(env, '/api/auth/setup', { method: 'POST', body: { password: '4827', code: 'guess' } }); assert.equal(r.status, 403);
  r = await call(env, '/api/auth/setup', { method: 'POST', body: { password: '4827', code: 'brew-crew' } }); assert.equal(r.status, 200);
});
test('worker: data API — save, read, version polling, backup, validation, CSRF', async () => {
  const env = fakeEnv();
  const ck = cookieFrom(await call(env, '/api/auth/setup', { method: 'POST', body: { password: '4827' } }));
  let r = await call(env, '/api/db', { cookie: ck }); let db = await r.json(); assert.deepEqual([db.fv, db.bbt], [[], []]); assert.equal(db.cfg.dme, '3-6');
  r = await call(env, '/api/db', { method: 'PUT', cookie: ck, body: { ops: [{ op: 'put', t: 'fv', rec: { id: 'a', fv: 12, cip: '2026-11-09', sip: '2026-11-09', brew: '2026-11-10' } }] } });
  assert.equal(r.status, 200); db = await r.json(); assert.equal(db.fv.length, 1); assert.ok(db.ver);
  r = await call(env, '/api/db?ver=' + db.ver, { cookie: ck }); assert.equal((await r.json()).unchanged, true);
  r = await call(env, '/api/db', { method: 'PUT', cookie: ck, body: { ops: [{ op: 'put', t: 'fv', rec: { id: 'b', fv: 13 } }] } });
  assert.ok([...env.store.keys()].some((k) => k.startsWith('bak:')), 'daily backup written');
  r = await call(env, '/api/db', { method: 'PUT', cookie: ck, body: { ops: [{ op: 'bogus' }] } }); assert.equal(r.status, 422);
  r = await call(env, '/api/db', { method: 'PUT', cookie: ck, body: { ops: 'x' } }); assert.equal(r.status, 400);
  r = await call(env, '/api/db', { method: 'PUT', cookie: ck, origin: 'https://evil.example', body: { ops: [] } }); assert.equal(r.status, 403);
  r = await call(env, '/api/auth/password', { method: 'POST', cookie: ck, body: { current: 'bad', next: '9034' } }); assert.equal(r.status, 403);
  r = await call(env, '/api/auth/password', { method: 'POST', cookie: ck, body: { current: '4827', next: '9034' } }); assert.equal(r.status, 200);
  r = await call(env, '/api/auth/login', { method: 'POST', body: { password: '9034' } }); assert.equal(r.status, 200);
});
test('worker: missing KV binding gives a clear error', async () => {
  const r = await worker.fetch(new Request('https://x.example/'), { ASSETS: {} }); assert.equal(r.status, 500); assert.match((await r.json()).error, /KV/);
});

for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log('  ✓', name); } catch (e) { failed++; console.log('  ✗', name, '\n    ', e.message.split('\n')[0]); }
}
console.log(`\n${passed} passed, ${failed} failed${boardPath ? '' : ' (real-file tests skipped)'}`);
process.exit(failed ? 1 : 0);
