// HTML for the three views. Pure string building from state — events are wired in app.js.
import { S, db, config, years, esc, todayISO } from './store.js';
import { fvStatus, bbtStatus, isGood, summarise, fvYear, bbtYear, fmtDate, fmtDateY, relDay, diffDays, addDays } from './rules.js';

/* ---------- icons ---------- */
const svg = (d, extra = '') => `<svg class="ic" viewBox="0 0 16 16" aria-hidden="true" ${extra}>${d}</svg>`;
export const I = {
  check: svg('<path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'),
  x: svg('<path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'),
  alert: svg('<path d="M8 3v6M8 12.2v.1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'),
  clock: svg('<circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 5v3.3l2 1.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'),
  plus: svg('<path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'),
  up: svg('<path d="M8 11V3M4.5 6.5L8 3l3.5 3.5M3 13h10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'),
  down: svg('<path d="M8 3v8M4.5 7.5L8 11l3.5-3.5M3 13h10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'),
  trash: svg('<path d="M3.5 5h9M6.5 5V3.5h3V5M5 5l.5 8h5l.5-8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'),
  board: svg('<rect x="2.5" y="3" width="11" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5 6.5h6M5 9.5h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>'),
};

/* ---------- small pieces ---------- */
const CHIP_ICON = { ok: I.check, ok72: I.check, 'ok-dme': I.check, bad: I.x, need: I.alert, wait: I.clock, check: I.alert };
const CHIP_CLASS = { ok: 'ok', ok72: 'ok', 'ok-dme': 'ok', bad: 'bad', need: 'need', wait: 'wait', check: 'bad' };
function statusChip(s) {
  const title = s.reasons?.length ? s.reasons.join(' · ') : s.missing?.length ? `Missing: ${s.missing.join(', ')}` : s.label;
  return `<span class="chip ${CHIP_CLASS[s.state]}" title="${esc(title)}">${CHIP_ICON[s.state]}<span>${esc(s.label)}</span></span>`;
}
const daysChip = (n, tone, title = '') => `<span class="days ${tone || ''}" ${title ? `title="${esc(title)}"` : ''}>${n === null || n === undefined ? '–' : n}</span>`;
const dateIn = (t, id, f, v, label) => `<input class="d" type="date" value="${esc(v)}" data-act="set" data-t="${t}" data-id="${id}" data-f="${f}" data-k="${t}:${id}:${f}" aria-label="${esc(label)}">`;
const todayBtn = (t, id, f, v) => (v ? '' : `<button type="button" class="today" data-act="today" data-t="${t}" data-id="${id}" data-f="${f}" tabindex="-1">Today</button>`);
const dateCell = (t, id, f, v, label) => `<div class="dc">${dateIn(t, id, f, v, label)}${todayBtn(t, id, f, v)}</div>`;
const countIn = (id, v, tone, label) => `<input class="n ${tone || ''}" type="number" min="0" max="99" inputmode="numeric" value="${v === null || v === undefined ? '' : v}" placeholder="–" data-act="set" data-t="bbt" data-id="${id}" data-f="acidCount" data-k="bbt:${id}:acidCount" aria-label="${esc(label)}">`;
const vpill = (kind, n) => `<span class="vpill ${kind}">${kind === 'fv' ? 'FV' : 'BBT'} ${n}</span>`;
const plannedTag = (on) => (on ? '<span class="tag plan" title="Date is in the future (from the board plan)">planned</span>' : '');
const boardMark = (src) => (src === 'board' ? `<span class="srcmark" title="Date from the Live Brewery Board">${I.board}</span>` : '');

/* ---------- illustrations ---------- */
const tankSvg = (kind) => kind === 'fv'
  ? `<svg class="tank" viewBox="0 0 44 64" aria-hidden="true"><path class="legs" d="M12 36l-3 26M32 36l3 26"/><path class="body" d="M7 15Q7 5 22 5T37 15V37L26 54H18L7 37Z"/><path class="band" d="M7 37h30M18 54h8"/><circle class="hatch" cx="22" cy="20" r="3.2"/></svg>`
  : `<svg class="tank" viewBox="0 0 44 64" aria-hidden="true"><path class="legs" d="M12 50l-3 12M32 50l3 12"/><path class="body" d="M7 14Q7 4 22 4T37 14V52H7Z"/><path class="band" d="M7 46h30"/><circle class="hatch" cx="22" cy="21" r="3.2"/></svg>`;

function glass(pct, id) {
  const top = 16, bottom = 118, H = bottom - top;
  const h = pct === null ? 0 : Math.max(2, Math.round((H * pct) / 100));
  const y = bottom - h;
  return `<svg class="glass" viewBox="0 0 90 132" role="img" aria-label="${pct === null ? 'No data' : pct + '% compliant'}">
    <defs><clipPath id="gl${id}"><path d="M13 10H77L70 120Q69.6 124 65 124H25Q20.4 124 20 120Z"/></clipPath></defs>
    <g clip-path="url(#gl${id})"><rect x="0" y="${y}" width="90" height="${h + 8}" fill="#FFD637"/>
      ${pct === null ? '' : `<rect x="0" y="${y}" width="90" height="9" fill="#F1EB9C"/><circle cx="30" cy="${y + 26}" r="2" fill="#F1EB9C"/><circle cx="52" cy="${y + 42}" r="1.6" fill="#F1EB9C"/><circle cx="62" cy="${y + 20}" r="2.2" fill="#F1EB9C"/>`}</g>
    <path d="M13 10H77L70 120Q69.6 124 65 124H25Q20.4 124 20 120Z" fill="none" stroke="#000" stroke-width="2.4" stroke-linejoin="round"/>
  </svg>`;
}

/* ---------- data selection ---------- */
function ctx() {
  const d = db(), cfg = config(), today = todayISO(), year = S.ui.year;
  const fvAll = d.fv.map((r) => ({ r, s: fvStatus(r, today) }));
  const bbtAll = d.bbt.map((r) => ({ r, s: bbtStatus(r, cfg.dme, today) }));
  return { d, cfg, today, year, fvAll, bbtAll, fv: fvAll.filter((x) => fvYear(x.r) === year), bbt: bbtAll.filter((x) => bbtYear(x.r) === year) };
}
const sortKey = (x, k) => x.r[k] || '9999-12-31';
const byDateDesc = (k) => (a, b) => (sortKey(a, k) < sortKey(b, k) ? 1 : sortKey(a, k) > sortKey(b, k) ? -1 : 0);

function matchQ(x, q, fields) {
  if (!q) return true;
  const t = q.trim().toLowerCase();
  if (/^\d+$/.test(t)) return fields.num.some((f) => String(x.r[f]) === t);
  return fields.txt.some((f) => String(x.r[f] ?? '').toLowerCase().includes(t));
}

const yearSelect = () => `<label class="yearsel"><span>Year</span><select data-act="year" data-k="year" aria-label="Year">${years().map((y) => `<option value="${y}" ${y === S.ui.year ? 'selected' : ''}>${y}</option>`).join('')}</select></label>`;

/* ---------- OVERVIEW ---------- */
export function overview() {
  const c = ctx();
  const empty = !c.d.fv.length && !c.d.bbt.length;
  const fvSum = summarise(c.fv.map((x) => x.r), (r) => fvStatus(r, c.today));
  const bbtSum = summarise(c.bbt.map((x) => x.r), (r) => bbtStatus(r, c.cfg.dme, c.today));
  return `
  ${dropzone(c, empty)}
  <section class="grid2">
    <div class="card meters">
      <div class="card-h"><h2>Compliance in ${c.year}</h2>${yearSelect()}</div>
      <div class="glasses">
        ${meter('fv', 'Fermenters', fvSum, 'g1')}
        ${meter('bbt', 'Brite tanks', bbtSum, 'g2')}
      </div>
    </div>
    <div class="card attn">
      <div class="card-h"><h2>Needs a CIP / SIP entry</h2></div>
      ${attention(c)}
    </div>
  </section>
  <section class="card farm">
    <div class="card-h"><h2>Brite tanks</h2><span class="legend">${legend()}</span></div>
    <div class="bbts">${c.cfg.bbts.concat(extraVessels(c.bbtAll, 'bbt', c.cfg.bbts)).map((n) => bbtTile(n, c)).join('')}</div>
    <div class="card-h sub"><h2>Fermenters</h2><span class="muted">tap a tank to see its history</span></div>
    <div class="fvs">${c.cfg.fvs.concat(extraVessels(c.fvAll, 'fv', c.cfg.fvs)).map((n) => fvTile(n, c)).join('')}</div>
  </section>`;
}
const extraVessels = (all, key, known) => [...new Set(all.map((x) => x.r[key]))].filter((n) => !known.includes(n)).sort((a, b) => a - b);

function legend() {
  return [['ok', 'Compliant'], ['bad', 'Not compliant'], ['need', 'Needs CIP/SIP'], ['wait', 'CIP’d, awaiting fill'], ['idle', 'No record']]
    .map(([k, t]) => `<span class="lg"><i class="sw ${k}"></i>${t}</span>`).join('');
}

function dropzone(c, empty) {
  const li = c.d.meta?.lastImport;
  const last = li ? `<p class="meta">Last import: <b>${esc(li.file || 'file')}</b> · ${new Date(li.at).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}${li.text ? ' · ' + esc(li.text) : ''}</p>` : '';
  return `<section class="drop ${empty ? 'big' : ''}" id="drop" role="button" tabindex="0" data-act="browse" aria-label="Drop the Live Brewery Board spreadsheet here, or press Enter to choose a file">
    <svg class="hop" viewBox="0 0 64 64" aria-hidden="true"><path d="M32 6c-3 0-4 4-4 6 0 2 1 4 4 4s4-2 4-4c0-2-1-6-4-6z" fill="#47D7AC" stroke="#000" stroke-width="2"/><path d="M32 18c-9 0-15 8-15 18 0 11 7 20 15 24 8-4 15-13 15-24 0-10-6-18-15-18z" fill="#F1EB9C" stroke="#000" stroke-width="2" stroke-linejoin="round"/><path d="M22 30c4 2 8 2 10 0 2 2 6 2 10 0M21 40c4 2 8 3 11 1 3 2 7 1 11-1M25 50c3 1 5 2 7 0 2 2 4 1 7 0" fill="none" stroke="#000" stroke-width="1.8" stroke-linecap="round"/></svg>
    <div class="drop-t">
      <h2>${empty ? 'Mash in your first Live Brewery Board' : 'Drop the Live Brewery Board here'}</h2>
      <p>Brews become FV rows and transfers become BBT rows — you only add the CIP and SIP dates. ${empty ? 'Got the old <b>Vessel &amp; Equipment CIP monitoring</b> workbook? Drop that too and your existing rows come across.' : 'Re-importing is safe: nothing you typed is overwritten.'}</p>
      ${last}
    </div>
    <span class="btn primary">${I.up}<span>Choose file</span></span>
  </section>`;
}

function meter(kind, title, s, id) {
  const sub = s.total ? `${s.good} of ${s.good + s.bad} judged rows compliant` : 'No rows yet this year';
  return `<button class="meter" data-act="goto" data-view="${kind}" title="Open ${title}">
    ${glass(s.pct, id)}
    <div class="m-t"><b class="pct">${s.pct === null ? '–' : s.pct + '%'}</b><span class="m-n">${title}</span><span class="muted">${sub}</span>
      <span class="m-c">${s.bad ? `<span class="chip bad">${I.x}${s.bad} not compliant</span>` : ''}${s.need ? `<span class="chip need">${I.alert}${s.need} need data</span>` : ''}${!s.bad && !s.need && s.total ? `<span class="chip ok">${I.check}all clear</span>` : ''}</span></div>
  </button>`;
}

function attention(c) {
  const limit = addDays(c.today, -14);
  const fv = c.fvAll.filter((x) => x.s.state === 'need' && x.r.brew >= limit);
  const bbt = c.bbtAll.filter((x) => x.s.state === 'need' && x.r.transfer >= limit);
  const items = [
    ...fv.map((x) => ({ date: x.r.brew, html: fvAttn(x, c) })),
    ...bbt.map((x) => ({ date: x.r.transfer, html: bbtAttn(x, c) })),
  ].sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!items.length) return `<div class="allgood">${I.check}<div><b>All caught up.</b><span class="muted">Every recent and upcoming brew and transfer has its CIP/SIP data.</span></div></div>`;
  const older = c.fvAll.filter((x) => x.s.state === 'need' && x.r.brew < limit).length + c.bbtAll.filter((x) => x.s.state === 'need' && x.r.transfer < limit).length;
  const shown = items.slice(0, 14);
  return `<div class="att-list">${shown.map((i) => i.html).join('')}</div>
    ${items.length > shown.length ? `<p class="muted more">+ ${items.length - shown.length} more — open the Fermenters / Brite tabs and use “Needs data”.</p>` : ''}
    ${older ? `<p class="muted more">${older} older rows (before ${fmtDate(limit)}) are still missing data — see the tables.</p>` : ''}`;
}
const dueLabel = (date, today) => {
  const d = diffDays(date, today);
  return `<span class="due ${d < 0 ? 'late' : d <= 1 ? 'soon' : ''}">${d < 0 ? 'was due' : 'due'} ${fmtDate(date)} · ${relDay(date, today)}</span>`;
};
function fvAttn({ r, s }, c) {
  return `<div class="att" data-id="${r.id}">
    <div class="att-h">${vpill('fv', r.fv)}<span class="att-t">${esc(r.recipe || 'brew')}</span>${dueLabel(r.brew, c.today)}</div>
    <div class="att-f">
      <label><span>CIP</span>${dateCell('fv', r.id, 'cip', r.cip, `FV ${r.fv} CIP date`)}</label>
      <label><span>SIP</span>${dateCell('fv', r.id, 'sip', r.sip, `FV ${r.fv} SIP date`)}</label>
    </div></div>`;
}
function bbtAttn({ r, s }, c) {
  return `<div class="att" data-id="${r.id}">
    <div class="att-h">${vpill('bbt', r.bbt)}<span class="att-t">${esc(r.batch || 'transfer')}${r.fromFv ? ` <span class="muted">from FV ${r.fromFv}</span>` : ''}</span>${dueLabel(r.transfer, c.today)}</div>
    <div class="att-f">
      <label><span>Acid CIP</span>${dateCell('bbt', r.id, 'acidCip', r.acidCip, `BBT ${r.bbt} acid CIP date`)}</label>
      <label><span>Count</span>${countIn(r.id, r.acidCount, '', `BBT ${r.bbt} number of acid CIPs`)}</label>
    </div></div>`;
}

// the record a tank tile represents: next planned fill, else one that's CIP'd and waiting, else the latest actual fill
function focusOf(list, today, dateKey, noDateKey) {
  const planned = list.filter((x) => x.r[dateKey] > today).sort((a, b) => (a.r[dateKey] < b.r[dateKey] ? -1 : 1));
  if (planned[0]) return { x: planned[0], kind: 'next' };
  const waiting = list.filter((x) => !x.r[dateKey]).sort((a, b) => ((b.r[noDateKey] || '') < (a.r[noDateKey] || '') ? -1 : 1));
  if (waiting[0]) return { x: waiting[0], kind: 'wait' };
  const done = list.filter((x) => x.r[dateKey]).sort(byDateDesc(dateKey));
  return done[0] ? { x: done[0], kind: 'last' } : null;
}
const tileState = (s) => (s.state === 'ok72' || s.state === 'ok-dme' ? 'ok' : s.state === 'check' ? 'bad' : s.state);

function fvTile(n, c) {
  const f = focusOf(c.fvAll.filter((x) => x.r.fv === n), c.today, 'brew', 'cip');
  const st = f ? tileState(f.x.s) : 'idle';
  const sub = !f ? 'no record' : f.kind === 'wait' ? `CIP ${fmtShort(f.x.r.cip || f.x.r.sip)}` : `${f.kind === 'next' ? 'next ' : ''}${fmtShort(f.x.r.brew)}`;
  const tip = !f ? `FV ${n} — no record` : `FV ${n} — ${f.x.s.label}${f.x.r.recipe ? ' · ' + f.x.r.recipe : ''}${f.x.r.brew ? ' · brew ' + fmtDate(f.x.r.brew) : ''}`;
  return `<button class="tile ${st}" data-act="goto" data-view="fv" data-q="${n}" title="${esc(tip)}">${tankSvg('fv')}<b>${n}</b><small>${esc(sub)}</small></button>`;
}
function bbtTile(n, c) {
  const f = focusOf(c.bbtAll.filter((x) => x.r.bbt === n), c.today, 'transfer', 'acidCip');
  const dme = c.cfg.dme.includes(n);
  const st = f ? tileState(f.x.s) : 'idle';
  const r = f?.x.r, s = f?.x.s;
  const known = c.bbtAll.filter((x) => x.r.bbt === n && x.s.count !== null && x.r.transfer && x.r.transfer <= c.today).sort(byDateDesc('transfer'))[0];
  const count = s?.count ?? known?.s.count ?? null;
  const countNote = s?.count !== null && s?.count !== undefined ? '' : known ? ` (last logged, ${fmtShort(known.r.transfer)})` : '';
  const segs = Array.from({ length: 8 }, (_, i) => `<i class="${count !== null && i < count ? (i >= 7 ? 'bad' : i === 6 ? 'warn2' : i === 5 ? 'warn1' : 'on') : ''}"></i>`).join('');
  const sub = !f ? 'No record' : f.kind === 'wait' ? `Acid CIP ${fmtShort(r.acidCip)}` : `${f.kind === 'next' ? 'Next fill ' : 'Filled '}${fmtShort(r.transfer)}`;
  const tip = !f ? `BBT ${n} — no record` : `BBT ${n} — ${s.label}${r.batch ? ' · ' + r.batch : ''} · ${count === null ? 'count not entered' : count + ' acid CIPs/fills'}`;
  return `<button class="tile big ${st}" data-act="goto" data-view="bbt" data-q="${n}" title="${esc(tip)}">
    ${tankSvg('bbt')}<div class="bt"><b>BBT ${n}</b><span class="tag ${dme ? 'dme' : 'krones'}">${dme ? 'DME' : 'Krones'}</span><small>${esc(sub)}</small><span class="segs" title="${count === null ? 'Fill count not entered' : count + ' of 8' + countNote}">${segs}</span></div></button>`;
}
const fmtShort = (iso) => (iso ? new Date(iso + 'T00:00:00Z').toLocaleDateString('en-AU', { timeZone: 'UTC', day: 'numeric', month: 'short' }) : '');

/* ---------- FV VIEW ---------- */
const FV_FILTERS = [['all', 'Fills'], ['good', 'Compliant'], ['bad', 'Not compliant'], ['need', 'Needs CIP/SIP'], ['wait', 'Awaiting brew']];
const passFilter = (f, s) => f === 'all' || (f === 'good' ? isGood(s) : s.state === f);

export function fvView() {
  const c = ctx();
  const sum = summarise(c.fv.map((x) => x.r), (r) => fvStatus(r, c.today));
  const counts = { all: sum.total, good: sum.good, bad: sum.bad, need: sum.need, wait: sum.wait };
  const f = S.ui.fvFilter;
  const rows = c.fv.filter((x) => passFilter(f, x.s) && matchQ(x, S.ui.q, { num: ['fv'], txt: ['recipe', 'note'] })).sort(byDateDesc('brew'));
  const shown = rows.slice(0, S.ui.limit);
  return `${head('Fermenters', 'FV CIP / SIP compliance', 'fv')}
  ${tiles(FV_FILTERS, counts, f, 'fv', sum)}
  ${toolbar('fv', rows.length, c.fv.length)}
  <div class="card tablecard"><div class="tscroll"><table class="grid fvt">
    <thead><tr><th>FV</th><th>CIP date</th><th>SIP date</th><th>Brew date</th><th>Beer</th><th class="c" title="Brew date − CIP date. Under 8 days.">CIP → fill<small>days</small></th><th class="c" title="Brew date − SIP date. Under 3 days.">SIP → fill<small>days</small></th><th>Compliant</th><th class="act"></th></tr></thead>
    <tbody>${shown.map(({ r, s }) => `<tr class="row ${s.state}${s.planned ? ' planned' : ''}" data-id="${r.id}">
      <td data-l="Vessel">${vpill('fv', r.fv)}</td>
      <td data-l="CIP date">${dateCell('fv', r.id, 'cip', r.cip, `FV ${r.fv} CIP date`)}</td>
      <td data-l="SIP date">${dateCell('fv', r.id, 'sip', r.sip, `FV ${r.fv} SIP date`)}</td>
      <td data-l="Brew date"><div class="dc">${dateIn('fv', r.id, 'brew', r.brew, `FV ${r.fv} brew date`)}${boardMark(r.bsrc)}${plannedTag(s.planned)}</div></td>
      <td data-l="Beer" class="beer">${esc(r.recipe)}</td>
      <td data-l="CIP → fill" class="c">${daysChip(s.f, s.fTone, 'Brew date − CIP date')}</td>
      <td data-l="SIP → fill" class="c">${daysChip(s.g, s.gTone, 'Brew date − SIP date')}</td>
      <td data-l="Compliant">${statusChip(s)}</td>
      <td class="act"><button class="icon-btn" data-act="del" data-t="fv" data-id="${r.id}" aria-label="Delete row" title="Delete row">${I.trash}</button></td>
    </tr>`).join('')}</tbody></table></div>
    ${emptyNote(rows.length, c.fv.length)}${moreBtn(rows.length, shown.length)}
  </div>`;
}

/* ---------- BBT VIEW ---------- */
const BBT_FILTERS = [['all', 'Fills'], ['good', 'Ready / OK'], ['bad', 'Not OK'], ['need', 'Needs data'], ['wait', 'Awaiting transfer']];
export function bbtView() {
  const c = ctx();
  const sum = summarise(c.bbt.map((x) => x.r), (r) => bbtStatus(r, c.cfg.dme, c.today));
  const counts = { all: sum.total, good: sum.good, bad: sum.bad, need: sum.need, wait: sum.wait };
  const f = S.ui.bbtFilter;
  const rows = c.bbt.filter((x) => passFilter(f, x.s) && matchQ(x, S.ui.q, { num: ['bbt', 'fromFv'], txt: ['batch', 'note'] })).sort(byDateDesc('transfer'));
  const shown = rows.slice(0, S.ui.limit);
  return `${head('Brite tanks', 'BBT acid CIP compliance', 'bbt')}
  ${tiles(BBT_FILTERS, counts, f, 'bbt', sum)}
  ${toolbar('bbt', rows.length, c.bbt.length)}
  <div class="card tablecard"><div class="tscroll"><table class="grid bbtt">
    <thead><tr><th>BBT</th><th>Acid CIP date</th><th class="c" title="Number of acid CIPs (beer fills for DME BBTs). 6 = caution, 7 = warning, 8 = must be cleaned.">Acid CIPs<small>count</small></th><th>Transfer date</th><th>From FV · beer</th><th class="c" title="Transfer date − acid CIP date. Under 3 days is green; purple is acceptable for DME BBTs.">CIP → fill<small>days</small></th><th title="Needs fewer than 8 acid CIPs. Krones BBTs must also be green in CIP → fill.">Ready to fill?</th><th class="act"></th></tr></thead>
    <tbody>${shown.map(({ r, s }) => `<tr class="row ${s.state}${s.planned ? ' planned' : ''}" data-id="${r.id}">
      <td data-l="Vessel"><div class="vcell">${vpill('bbt', r.bbt)}<span class="tag ${s.dme ? 'dme' : 'krones'}">${s.dme ? 'DME' : 'Krones'}</span></div></td>
      <td data-l="Acid CIP date">${dateCell('bbt', r.id, 'acidCip', r.acidCip, `BBT ${r.bbt} acid CIP date`)}</td>
      <td data-l="Acid CIPs" class="c">${countIn(r.id, r.acidCount, s.countTone, `BBT ${r.bbt} number of acid CIPs`)}</td>
      <td data-l="Transfer date"><div class="dc">${dateIn('bbt', r.id, 'transfer', r.transfer, `BBT ${r.bbt} transfer date`)}${boardMark(r.tsrc)}${plannedTag(s.planned)}</div></td>
      <td data-l="From" class="beer">${r.fromFv ? `<span class="muted">FV ${r.fromFv}</span> ` : ''}${esc(r.batch)}</td>
      <td data-l="CIP → fill" class="c">${daysChip(s.n, s.nTone, s.nTone === 'dme' ? 'Over 2 days — acceptable for DME BBTs' : 'Transfer date − acid CIP date')}</td>
      <td data-l="Ready to fill?">${statusChip(s)}</td>
      <td class="act"><button class="icon-btn" data-act="del" data-t="bbt" data-id="${r.id}" aria-label="Delete row" title="Delete row">${I.trash}</button></td>
    </tr>`).join('')}</tbody></table></div>
    ${emptyNote(rows.length, c.bbt.length)}${moreBtn(rows.length, shown.length)}
  </div>`;
}

/* ---------- shared view chrome ---------- */
function head(title, sub, kind) {
  return `<div class="vhead"><div><h2 class="vt">${vpillIcon(kind)}${title}</h2><p class="muted">${sub}</p></div>${yearSelect()}</div>`;
}
const vpillIcon = (kind) => `<span class="vt-ic">${tankSvg(kind)}</span>`;

function tiles(defs, counts, active, kind, sum) {
  return `<div class="stiles" role="group" aria-label="Filter rows">${defs.map(([k, label]) => `<button class="stile ${k} ${active === k ? 'on' : ''}" data-act="filter" data-t="${kind}" data-v="${k}" aria-pressed="${active === k}">
    <b>${counts[k]}</b><span>${label}</span>${k === 'good' && sum.pct !== null ? `<em>${sum.pct}%</em>` : ''}</button>`).join('')}</div>`;
}
function toolbar(kind, shown, total) {
  return `<div class="toolbar">
    <label class="search"><span class="sr">Search</span><input type="search" id="q" data-act="search" data-k="search" placeholder="${kind === 'fv' ? 'Search FV number or beer…' : 'Search BBT number or beer…'}" value="${esc(S.ui.q)}" autocomplete="off"></label>
    <span class="muted count">${shown === total ? `${total} rows` : `${shown} of ${total} rows`}</span>
    <span class="grow"></span>
    <button class="btn primary" data-act="log" data-t="${kind}">${I.plus}<span>Log ${kind === 'fv' ? 'CIP / SIP' : 'acid CIP'}</span></button>
    <button class="btn" data-act="browse">${I.up}<span>Import board</span></button>
    <button class="btn" data-act="export" data-t="${kind}">${I.down}<span>CSV</span></button>
  </div>`;
}
const emptyNote = (shown, total) => (shown ? '' : `<div class="emptyrows">${total ? 'No rows match this filter.' : 'No rows for this year yet. Drop the Live Brewery Board onto the page, or use “Log CIP / SIP”.'}</div>`);
const moreBtn = (all, shown) => (all > shown ? `<div class="emptyrows"><button class="btn" data-act="more">Show all ${all} rows</button></div>` : '');
