// Data model + the change operations. Shared by the browser (optimistic updates) and the Worker (authoritative save).
// Record shapes:
//   FV  : { id, fv, cip, sip, brew, recipe, note, bsrc }                       dates are 'YYYY-MM-DD' or ''
//   BBT : { id, bbt, acidCip, acidSip, acidType, acidCount, transfer, fromFv, batch, note, tsrc }
//   acidType: 'cip' (caustic CIP: count resets to 0), 'sip' (the acid CIP/SIP done between brews: count + 1) or '' (count typed by hand / migrated).
//   bsrc/tsrc say where the brew/transfer date came from: 'board' (Live Brewery Board), 'sheet' (migrated spreadsheet) or ''.

export const DEFAULT_CFG = { fvs: '1-12, 14-28, 31, 35-60', bbts: '1-8', dme: '3-6' };
export const emptyDb = () => ({ ver: '', fv: [], bbt: [], cfg: { ...DEFAULT_CFG }, meta: {} });

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const date = (v) => (typeof v === 'string' && ISO.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z')) ? v : '');
const int = (v, min, max) => { if (v === '' || v === null || v === undefined) return null; const n = Number(v); return Number.isInteger(n) && n >= min && n <= max ? n : null; };
const str = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
const src = (v) => (v === 'board' || v === 'sheet' ? v : '');

export function cleanFv(r) {
  if (!r || typeof r !== 'object') return null;
  const id = str(r.id, 40), fv = int(r.fv, 1, 999);
  if (!id || !fv) return null;
  return { id, fv, cip: date(r.cip), sip: date(r.sip), brew: date(r.brew), recipe: str(r.recipe, 80), note: str(r.note, 200), bsrc: src(r.bsrc) };
}
export function cleanBbt(r) {
  if (!r || typeof r !== 'object') return null;
  const id = str(r.id, 40), bbt = int(r.bbt, 1, 999);
  if (!id || !bbt) return null;
  return { id, bbt, acidCip: date(r.acidCip), acidSip: date(r.acidSip), acidType: r.acidType === 'cip' || r.acidType === 'sip' ? r.acidType : '', acidCount: int(r.acidCount, 0, 99), transfer: date(r.transfer), fromFv: int(r.fromFv, 1, 999), batch: str(r.batch, 80), note: str(r.note, 200), tsrc: src(r.tsrc) };
}

const CLEAN = { fv: cleanFv, bbt: cleanBbt };
const LIST_OK = /^[\d\s,;–-]{0,200}$/;
export const MAX_RECORDS = 40000;

// Applies ops in place. Returns how many were applied; invalid ops are skipped.
export function applyOps(db, ops) {
  let applied = 0;
  const index = { fv: null, bbt: null };
  const ix = (t) => (index[t] ||= new Map(db[t].map((r, i) => [r.id, i])));
  for (const op of ops || []) {
    if (!op || typeof op !== 'object') continue;
    if (op.op === 'put' && CLEAN[op.t]) {
      const rec = CLEAN[op.t](op.rec);
      if (!rec) continue;
      const list = db[op.t], map = ix(op.t), at = map.get(rec.id);
      if (at !== undefined && list[at]) list[at] = rec;
      else if (list.length < MAX_RECORDS) { map.set(rec.id, list.length); list.push(rec); }
      else continue;
      applied++;
    } else if (op.op === 'del' && CLEAN[op.t]) {
      const list = db[op.t], map = ix(op.t), at = map.get(str(op.id, 40));
      if (at !== undefined && list[at]) { list[at] = null; map.delete(str(op.id, 40)); applied++; }
    } else if (op.op === 'cfg' && op.set && typeof op.set === 'object') {
      for (const k of Object.keys(DEFAULT_CFG)) if (typeof op.set[k] === 'string' && LIST_OK.test(op.set[k])) db.cfg[k] = op.set[k].trim();
      applied++;
    } else if (op.op === 'meta' && op.set && typeof op.set === 'object') {
      const li = op.set.lastImport;
      if (li && typeof li === 'object') db.meta.lastImport = { at: Number(li.at) || 0, kind: str(li.kind, 20), file: str(li.file, 120), text: str(li.text, 300) };
      applied++;
    }
  }
  for (const t of ['fv', 'bbt']) if (db[t].includes(null)) db[t] = db[t].filter(Boolean);
  return applied;
}
