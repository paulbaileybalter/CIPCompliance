// Turns a parsed spreadsheet into change operations (put/del) against the current data — without touching the network.
// Imports are idempotent: dropping the same board twice changes nothing, and manually entered CIP/SIP data is never overwritten.
import { uid, addDays, diffDays } from './rules.js';

const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
const near = (a, b, tol = 2) => { const d = diffDays(a, b); return d !== null && Math.abs(d) <= tol; };

/* ---------------- Live Brewery Board ---------------- */
// One FV fill can span two brew days (double batches), so a brew within 2 days of the previous brew in the same FV is a
// top-up of that fill — the first day is the fill date. Several FVs emptying into one BBT on a day are likewise one BBT fill.
export function collapseBrews(brews) {
  const last = new Map(), out = [], topups = [];
  for (const b of [...brews].sort(byDate)) {
    const prev = last.get(b.fv);
    if (prev !== undefined && diffDays(b.date, prev) <= 2) { topups.push(b); continue; }
    last.set(b.fv, b.date); out.push(b);
  }
  return { brews: out, topups };
}
export function collapseTransfers(transfers) {
  const seen = new Set();
  return [...transfers].sort(byDate).filter((t) => { const k = `${t.bbt}|${t.date}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

export function planBoardImport(db, parsed, { from, today }) {
  const weeks = parsed.weeks.filter((w) => w.sunday >= from);
  const collapsed = collapseBrews(parsed.weeks.flatMap((w) => w.brews));
  const brews = collapsed.brews.filter((b) => b.date >= from && weeks.some((w) => b.date >= w.monday && b.date <= w.sunday));
  const transfers = collapseTransfers(weeks.flatMap((w) => w.transfers)).filter((t) => t.date >= from);
  const ctx = { today, rangeMin: weeks[0]?.monday || '9999', rangeMax: weeks.at(-1)?.sunday || '0000', recent: addDays(today, -2) };
  const fv = planFv(db.fv, brews, ctx);
  fv.stats.topups = collapsed.topups.filter((b) => b.date >= from).length;
  const bbt = planBbt(db.bbt, transfers, ctx);
  const incomplete = weeks.flatMap((w) => w.incomplete).filter((x) => x.date >= from && x.date >= today);
  return {
    ops: [...fv.ops, ...bbt.ops],
    fv: fv.stats, bbt: bbt.stats, items: { fv: fv.items, bbt: bbt.items }, incomplete,
    weeks: weeks.length, range: weeks.length ? [weeks[0].monday, weeks.at(-1).sunday] : null,
    brews: brews.length, transfers: transfers.length,
  };
}

function planFv(existing, brews, ctx) {
  const recs = existing.map((r) => ({ ...r }));
  const touched = new Set(), removed = new Set(), claimed = new Set(), items = [];
  const st = { new: 0, same: 0, updated: 0, attached: 0, detached: 0, removed: 0, needs: 0 };
  const wanted = new Set(brews.map((b) => `${b.fv}|${b.date}`));
  const free = (r) => !removed.has(r.id) && !claimed.has(r.id);

  // The board is a plan: if a future brew that came from the board has moved or vanished, undo it.
  for (const r of recs) {
    if (r.bsrc === 'board' && r.brew && r.brew >= ctx.today && r.brew >= ctx.rangeMin && r.brew <= ctx.rangeMax && !wanted.has(`${r.fv}|${r.brew}`)) {
      items.push({ fv: r.fv, date: r.brew, recipe: r.recipe, action: r.cip || r.sip ? 'detached' : 'removed' });
      if (r.cip || r.sip) { r.brew = ''; r.recipe = ''; r.bsrc = ''; touched.add(r.id); st.detached++; }
      else { removed.add(r.id); st.removed++; }
    }
  }
  for (const b of brews) {
    let r = recs.find((x) => free(x) && x.fv === b.fv && x.brew === b.date)
         || recs.find((x) => free(x) && x.bsrc === 'sheet' && x.fv === b.fv && x.brew && near(x.brew, b.date));   // migrated rows hold the actual date
    if (r) {
      claimed.add(r.id);
      if ((b.recipe && r.recipe !== b.recipe) || !r.bsrc) { if (b.recipe) r.recipe = b.recipe; if (!r.bsrc) r.bsrc = 'board'; touched.add(r.id); st.updated++; items.push({ fv: b.fv, date: b.date, recipe: b.recipe, action: 'updated' }); }
      else st.same++;
      continue;
    }
    if (b.date >= ctx.recent) {
      // A CIP/SIP logged ahead of time (no brew date yet) belongs to the next brew in that vessel.
      const open = recs.filter((x) => free(x) && x.fv === b.fv && !x.brew && (x.cip || x.sip) && (!x.cip || x.cip <= b.date))
        .sort((p, q) => ((q.cip || q.sip) < (p.cip || p.sip) ? -1 : 1));
      if (open[0]) {
        r = open[0]; r.brew = b.date; r.recipe = b.recipe; r.bsrc = 'board';
        claimed.add(r.id); touched.add(r.id); st.attached++; items.push({ fv: b.fv, date: b.date, recipe: b.recipe, action: 'attached' });
        continue;
      }
    }
    r = { id: uid(), fv: b.fv, cip: '', sip: '', brew: b.date, recipe: b.recipe, note: '', bsrc: 'board' };
    recs.push(r); claimed.add(r.id); touched.add(r.id); st.new++; items.push({ fv: b.fv, date: b.date, recipe: b.recipe, action: 'new' });
  }
  const ops = [];
  for (const r of recs) {
    if (removed.has(r.id)) ops.push({ op: 'del', t: 'fv', id: r.id });
    else if (touched.has(r.id)) { ops.push({ op: 'put', t: 'fv', rec: r }); if (!r.cip || !r.sip) st.needs++; }
  }
  return { ops, stats: st, items: items.sort(byDate) };
}

function planBbt(existing, transfers, ctx) {
  const recs = existing.map((r) => ({ ...r }));
  const touched = new Set(), removed = new Set(), claimed = new Set(), items = [];
  const st = { new: 0, same: 0, updated: 0, attached: 0, detached: 0, removed: 0, needs: 0 };
  const wanted = new Set(transfers.map((t) => `${t.bbt}|${t.date}`));
  const free = (r) => !removed.has(r.id) && !claimed.has(r.id);
  const manual = (r) => !!r.acidCip || r.acidCount !== null;

  for (const r of recs) {
    if (r.tsrc === 'board' && r.transfer && r.transfer >= ctx.today && r.transfer >= ctx.rangeMin && r.transfer <= ctx.rangeMax && !wanted.has(`${r.bbt}|${r.transfer}`)) {
      items.push({ bbt: r.bbt, fv: r.fromFv, date: r.transfer, batch: r.batch, action: manual(r) ? 'detached' : 'removed' });
      if (manual(r)) { r.transfer = ''; r.fromFv = null; r.batch = ''; r.tsrc = ''; touched.add(r.id); st.detached++; }
      else { removed.add(r.id); st.removed++; }
    }
  }
  for (const t of transfers) {
    let r = recs.find((x) => free(x) && x.bbt === t.bbt && x.transfer === t.date)
         || recs.find((x) => free(x) && x.tsrc === 'sheet' && x.bbt === t.bbt && (x.fromFv === null || x.fromFv === t.fv) && x.transfer && near(x.transfer, t.date));
    if (r) {
      claimed.add(r.id);
      if (r.fromFv === null || (t.batch && r.batch !== t.batch) || !r.tsrc) { if (r.fromFv === null) r.fromFv = t.fv; if (t.batch) r.batch = t.batch; if (!r.tsrc) r.tsrc = 'board'; touched.add(r.id); st.updated++; items.push({ bbt: t.bbt, fv: t.fv, date: t.date, batch: t.batch, action: 'updated' }); }
      else st.same++;
      continue;
    }
    if (t.date >= ctx.recent) {
      const open = recs.filter((x) => free(x) && x.bbt === t.bbt && !x.transfer && x.acidCip && x.acidCip <= t.date)
        .sort((p, q) => (q.acidCip < p.acidCip ? -1 : 1));
      if (open[0]) {
        r = open[0]; r.transfer = t.date; r.fromFv = t.fv; r.batch = t.batch; r.tsrc = 'board';
        claimed.add(r.id); touched.add(r.id); st.attached++; items.push({ bbt: t.bbt, fv: t.fv, date: t.date, batch: t.batch, action: 'attached' });
        continue;
      }
    }
    r = { id: uid(), bbt: t.bbt, acidCip: '', acidCount: null, transfer: t.date, fromFv: t.fv, batch: t.batch, note: '', tsrc: 'board' };
    recs.push(r); claimed.add(r.id); touched.add(r.id); st.new++; items.push({ bbt: t.bbt, fv: t.fv, date: t.date, batch: t.batch, action: 'new' });
  }
  const ops = [];
  for (const r of recs) {
    if (removed.has(r.id)) ops.push({ op: 'del', t: 'bbt', id: r.id });
    else if (touched.has(r.id)) { ops.push({ op: 'put', t: 'bbt', rec: r }); if (!r.acidCip || r.acidCount === null) st.needs++; }
  }
  return { ops, stats: st, items: items.sort(byDate) };
}

/* ---------------- Old CIP compliance tab (one-off migration) ---------------- */
export function planLegacyImport(db, legacy, { sheets } = {}) {
  const useSheets = legacy.sheets.filter((s) => !sheets || sheets.includes(s.name));
  const fvRecs = db.fv.map((r) => ({ ...r })), bbtRecs = db.bbt.map((r) => ({ ...r }));
  const touchedFv = new Set(), touchedBbt = new Set(), claimedFv = new Set(), claimedBbt = new Set();
  const per = [];
  for (const s of useSheets) {
    const stat = { name: s.name, fv: { new: 0, merged: 0, same: 0 }, bbt: { new: 0, merged: 0, same: 0 } };
    for (const row of s.fv) {
      const free = (x) => !claimedFv.has(x.id);
      let r = row.brew
        ? fvRecs.find((x) => free(x) && x.fv === row.fv && x.brew === row.brew)
          || fvRecs.find((x) => free(x) && x.fv === row.fv && x.bsrc === 'board' && !x.cip && !x.sip && x.brew && near(x.brew, row.brew))
        : fvRecs.find((x) => free(x) && x.fv === row.fv && !x.brew && x.cip === row.cip && x.sip === row.sip);
      if (r) {
        claimedFv.add(r.id);
        const before = JSON.stringify(r);
        if (!r.cip) r.cip = row.cip;
        if (!r.sip) r.sip = row.sip;
        if (row.brew && r.brew !== row.brew && r.bsrc === 'board') { r.brew = row.brew; r.bsrc = 'sheet'; }   // the sheet recorded what actually happened
        if (JSON.stringify(r) !== before) { touchedFv.add(r.id); stat.fv.merged++; } else stat.fv.same++;
      } else {
        r = { id: uid(), fv: row.fv, cip: row.cip, sip: row.sip, brew: row.brew, recipe: '', note: '', bsrc: row.brew ? 'sheet' : '' };
        fvRecs.push(r); claimedFv.add(r.id); touchedFv.add(r.id); stat.fv.new++;
      }
    }
    for (const row of s.bbt) {
      const free = (x) => !claimedBbt.has(x.id);
      let r = row.transfer
        ? bbtRecs.find((x) => free(x) && x.bbt === row.bbt && x.transfer === row.transfer)
          || bbtRecs.find((x) => free(x) && x.bbt === row.bbt && x.tsrc === 'board' && !x.acidCip && x.acidCount === null && x.transfer && near(x.transfer, row.transfer))
        : bbtRecs.find((x) => free(x) && x.bbt === row.bbt && !x.transfer && x.acidCip === row.acidCip);
      if (r) {
        claimedBbt.add(r.id);
        const before = JSON.stringify(r);
        if (!r.acidCip) r.acidCip = row.acidCip;
        if (r.acidCount === null) r.acidCount = row.acidCount;
        if (row.transfer && r.transfer !== row.transfer && r.tsrc === 'board') { r.transfer = row.transfer; r.tsrc = 'sheet'; }
        if (JSON.stringify(r) !== before) { touchedBbt.add(r.id); stat.bbt.merged++; } else stat.bbt.same++;
      } else {
        r = { id: uid(), bbt: row.bbt, acidCip: row.acidCip, acidCount: row.acidCount, transfer: row.transfer, fromFv: null, batch: '', note: '', tsrc: row.transfer ? 'sheet' : '' };
        bbtRecs.push(r); claimedBbt.add(r.id); touchedBbt.add(r.id); stat.bbt.new++;
      }
    }
    per.push(stat);
  }
  const ops = [
    ...fvRecs.filter((r) => touchedFv.has(r.id)).map((rec) => ({ op: 'put', t: 'fv', rec })),
    ...bbtRecs.filter((r) => touchedBbt.has(r.id)).map((rec) => ({ op: 'put', t: 'bbt', rec })),
  ];
  return { ops, sheets: per };
}
