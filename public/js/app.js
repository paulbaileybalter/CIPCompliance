// Wires the page together: rendering, events, import flow, modals.
import { S, db, config, hooks, esc, ready, load, startPolling, setStatus, setUi, dispatch, putFv, putBbt, findFv, findBbt, removeRecord, api, uid, todayISO } from './store.js';
import { overview, fvView, bbtView, I } from './views.js';
import { fvStatus, bbtStatus, addDays, mondayOf, fmtDate, fmtDateY, parseList, fvYear, bbtYear } from './rules.js';
import { detectKind, parseBoard, parseLegacy } from './board.js';
import { planBoardImport, planLegacyImport } from './merge.js';

const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');

/* ---------- toast ---------- */
let toastTimer = 0;
function toast(msg, actionLabel, fn) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${actionLabel ? `<button type="button">${esc(actionLabel)}</button>` : ''}`;
  el.classList.add('show');
  if (actionLabel) el.querySelector('button').onclick = () => { fn(); el.classList.remove('show'); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), actionLabel ? 7000 : 4000);
}
hooks.toast = toast;

/* ---------- render ---------- */
function render() {
  const tabs = document.querySelectorAll('.tab');
  tabs.forEach((t) => { const on = t.dataset.view === S.ui.view; t.setAttribute('aria-selected', on); t.classList.toggle('on', on); });
  const today = $('#now'); if (today) today.textContent = new Date().toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' });
  if (!ready()) { app.innerHTML = '<div class="loading"><i></i><i></i><i></i><span>Pouring the data…</span></div>'; return; }
  const a = document.activeElement;
  const key = a && app.contains(a) ? a.dataset.k : null;
  const caret = key && a.selectionStart !== undefined && a.type === 'search' ? [a.selectionStart, a.selectionEnd] : null;
  const y = window.scrollY;
  app.innerHTML = S.ui.view === 'fv' ? fvView() : S.ui.view === 'bbt' ? bbtView() : overview();
  window.scrollTo(0, y);
  if (key) {
    const el = app.querySelector(`[data-k="${CSS.escape(key)}"]`);
    if (el) { el.focus({ preventScroll: true }); if (caret) try { el.setSelectionRange(...caret); } catch { /* not a text input */ } }
  }
}
hooks.render = render;

/* ---------- field edits ---------- */
function setField(el) {
  const { t, id, f } = el.dataset;
  const rec = (t === 'fv' ? findFv : findBbt)(id);
  if (!rec) return;
  let v = el.value;
  if (f === 'acidCount') v = v === '' ? null : Math.max(0, Math.min(99, Math.round(Number(v))));
  const next = { ...rec, [f]: v };
  if (f === 'brew') next.bsrc = '';          // typed by hand now, so a board re-import won't move it
  if (f === 'transfer') next.tsrc = '';
  (t === 'fv' ? putFv : putBbt)(next);
}

document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  if (el.dataset.act === 'set') setField(el);
  else if (el.dataset.act === 'year') setUi({ year: Number(el.value), limit: 300 });
});

let searchTimer = 0;
document.addEventListener('input', (e) => {
  if (e.target.dataset.act !== 'search') return;
  clearTimeout(searchTimer);
  const v = e.target.value;
  searchTimer = setTimeout(() => setUi({ q: v, limit: 300 }), 160);
});

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const d = el.dataset;
  switch (d.act) {
    case 'view': setUi({ view: d.view, q: '', limit: 300 }); window.scrollTo(0, 0); break;
    case 'goto': setUi({ view: d.view, q: d.q || '', fvFilter: 'all', bbtFilter: 'all', limit: 300 }); window.scrollTo(0, 0); break;
    case 'filter': { const k = d.t === 'fv' ? 'fvFilter' : 'bbtFilter'; setUi({ [k]: S.ui[k] === d.v ? 'all' : d.v, limit: 300 }); break; }
    case 'today': { const rec = (d.t === 'fv' ? findFv : findBbt)(d.id); if (rec) (d.t === 'fv' ? putFv : putBbt)({ ...rec, [d.f]: todayISO() }); break; }
    case 'del': removeRecord(d.t, d.id); break;
    case 'more': setUi({ limit: 1e9 }); break;
    case 'browse': $('#file').click(); break;
    case 'log': openLog(d.t); break;
    case 'export': exportCsv(d.t); break;
    case 'settings': openSettings(); break;
    default: break;
  }
});
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.id === 'drop') { e.preventDefault(); $('#file').click(); }
});

/* ---------- modal ---------- */
let modalEl = null, lastFocus = null;
function openModal({ title, body, wide = false, onMount }) {
  closeModal();
  lastFocus = document.activeElement;
  const root = $('#modal');
  root.innerHTML = `<div class="backdrop" data-close></div><div class="dlg ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <header><h3>${esc(title)}</h3><button class="icon-btn" data-close aria-label="Close">${I.x}</button></header><div class="dlg-b">${body}</div></div>`;
  root.classList.add('open');
  modalEl = root.querySelector('.dlg');
  root.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModal));
  (modalEl.querySelector('[autofocus]') || modalEl.querySelector('input,select,button:not([data-close])'))?.focus();
  onMount?.(modalEl);
  return modalEl;
}
function closeModal() {
  const root = $('#modal');
  root.classList.remove('open'); root.innerHTML = ''; modalEl = null;
  lastFocus?.focus?.(); lastFocus = null;
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modalEl) closeModal(); });

/* ---------- importing a spreadsheet ---------- */
const fileInput = $('#file');
fileInput.addEventListener('change', () => { const f = fileInput.files[0]; fileInput.value = ''; if (f) handleFile(f); });

let dragDepth = 0;
const overlay = $('#dropOverlay');
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; overlay.classList.add('on'); });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) overlay.classList.remove('on'); });
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; overlay.classList.remove('on');
  const f = e.dataTransfer.files[0]; if (f) handleFile(f);
});

async function handleFile(file) {
  if (!/\.xls[xm]$/i.test(file.name)) { toast('That isn’t an Excel .xlsx file'); return; }
  if (!ready()) { toast('Still loading — try again in a moment'); return; }
  openModal({ title: 'Reading spreadsheet', body: `<div class="busy"><div class="loading"><i></i><i></i><i></i></div><p>Reading <b>${esc(file.name)}</b>…</p></div>` });
  await new Promise((r) => setTimeout(r, 50));
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const kind = detectKind(bytes);
    if (kind === 'board') previewBoard(file.name, parseBoard(bytes));
    else if (kind === 'legacy') previewLegacy(file.name, parseLegacy(bytes));
    else { closeModal(); openModal({ title: 'Not recognised', body: '<p>This workbook doesn’t look like the <b>Live Brewery Board</b> (weekly “WC …” sheets) or the <b>Vessel &amp; Equipment CIP monitoring</b> workbook (“FVBBT CIP Compliance” sheets).</p><div class="dlg-f"><button class="btn primary" data-close>OK</button></div>' }); }
  } catch (err) {
    console.error(err);
    closeModal(); toast('Couldn’t read that file — is it a valid .xlsx?');
  }
}

const pl = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
function defaultFrom() {
  const d = db(), today = todayISO();
  return d.fv.length || d.bbt.length ? mondayOf(addDays(today, -14)) : today.slice(0, 4) + '-01-01';
}
const ACTION = { new: ['new', 'New row'], attached: ['attached', 'Joined your CIP/SIP'], updated: ['updated', 'Updated'], detached: ['detached', 'Moved off board'], removed: ['removed', 'Cancelled on board'] };

function previewBoard(fileName, parsed) {
  if (!parsed.weeks.length) { closeModal(); toast('No weekly sheets found in that board'); return; }
  const first = parsed.weeks[0].monday, last = parsed.weeks.at(-1).sunday;
  let from = defaultFrom();
  if (from < first) from = first;
  const body = `
    <p class="muted"><b>${esc(fileName)}</b> · ${pl(parsed.weeks.length, 'weekly sheet')} (${fmtDateY(first)} – ${fmtDateY(last)})</p>
    <div class="fromrow"><label>Import weeks from <input type="date" id="impFrom" value="${from}" min="${first}" max="${last}"></label>
      <button class="btn small" type="button" data-pre="year">This year</button><button class="btn small" type="button" data-pre="4w">Last 4 weeks</button><button class="btn small" type="button" data-pre="all">Everything</button></div>
    <div id="impPlan"></div>
    <div class="dlg-f"><button class="btn" data-close>Cancel</button><button class="btn primary" id="impGo">${I.check}<span>Import</span></button></div>`;
  openModal({
    title: 'Import Live Brewery Board', body, wide: true,
    onMount(m) {
      const fromEl = $('#impFrom', m), planEl = $('#impPlan', m);
      const show = () => {
        const plan = planBoardImport(db(), parsed, { from: fromEl.value || first, today: todayISO() });
        planEl.innerHTML = boardPlanHtml(plan, parsed);
        $('#impGo', m).disabled = !plan.ops.length;
        $('#impGo span', m).textContent = plan.ops.length ? 'Import' : 'Already up to date';
      };
      fromEl.addEventListener('change', show);
      m.querySelectorAll('[data-pre]').forEach((b) => b.addEventListener('click', () => {
        const t = todayISO();
        fromEl.value = { year: t.slice(0, 4) + '-01-01', '4w': mondayOf(addDays(t, -28)), all: first }[b.dataset.pre];
        if (fromEl.value < first) fromEl.value = first;
        show();
      }));
      $('#impGo', m).addEventListener('click', () => {
        const plan = planBoardImport(db(), parsed, { from: fromEl.value || first, today: todayISO() });
        const text = `${pl(plan.brews, 'brew')}, ${pl(plan.transfers, 'transfer')}`;
        dispatch([...plan.ops, { op: 'meta', set: { lastImport: { at: Date.now(), kind: 'board', file: fileName, text } } }]);
        closeModal();
        toast(`Imported — ${pl(plan.fv.new + plan.fv.attached, 'FV row')} and ${pl(plan.bbt.new + plan.bbt.attached, 'BBT row')} added${plan.fv.needs + plan.bbt.needs ? `, ${plan.fv.needs + plan.bbt.needs} need CIP/SIP` : ''}`);
      });
      show();
    },
  });
}

function boardPlanHtml(p, parsed) {
  if (!p.weeks) return '<p class="muted">No weeks on or after that date.</p>';
  const stat = (label, s) => `<div class="pcol"><h4>${label}</h4><ul>
    <li><b>${s.new}</b> new row${s.new === 1 ? '' : 's'}</li>
    ${s.attached ? `<li><b>${s.attached}</b> joined to a CIP/SIP you’d already logged</li>` : ''}
    <li><b>${s.same + s.updated}</b> already in the tracker</li>
    ${s.detached + s.removed ? `<li><b>${s.detached + s.removed}</b> plan change${s.detached + s.removed === 1 ? '' : 's'} (moved or cancelled on the board)</li>` : ''}
  </ul></div>`;
  const upcoming = [...p.items.fv.map((i) => ({ ...i, v: `FV ${i.fv}`, what: i.recipe })), ...p.items.bbt.map((i) => ({ ...i, v: `BBT ${i.bbt}`, what: `${i.batch}${i.fv ? ' ← FV ' + i.fv : ''}` }))]
    .filter((i) => i.action !== 'updated' && i.date >= addDays(todayISO(), -1)).sort((a, b) => (a.date < b.date ? -1 : 1));
  const needs = p.fv.needs + p.bbt.needs;
  return `<div class="pgrid">${stat('Fermenters', p.fv)}${stat('Brite tanks', p.bbt)}</div>
    ${needs ? `<p class="callout need">${I.alert}<span><b>${pl(needs, 'row')}</b> will be waiting for CIP/SIP data.</span></p>` : ''}
    ${upcoming.length ? `<details open><summary>Rows to be added or changed from today on (${upcoming.length})</summary><ul class="plist">${upcoming.slice(0, 12).map((i) => `<li><span class="pa ${i.action}">${ACTION[i.action][1]}</span><b>${i.v}</b> ${esc(i.what || '')} <span class="muted">${fmtDate(i.date)}</span></li>`).join('')}${upcoming.length > 12 ? `<li class="muted">…and ${upcoming.length - 12} more</li>` : ''}</ul></details>` : ''}
    ${p.incomplete.length ? `<details><summary>${pl(p.incomplete.length, 'planned transfer')} without a BBT yet (skipped)</summary><ul class="plist">${p.incomplete.slice(0, 10).map((i) => `<li><b>${i.fv ? 'FV ' + i.fv : ''}${i.bbt ? 'BBT ' + i.bbt : ''}</b> ${esc(i.batch)} <span class="muted">${fmtDate(i.date)}</span></li>`).join('')}</ul></details>` : ''}
    ${parsed.warnings.length ? `<details><summary>${pl(parsed.warnings.length, 'cell')} couldn’t be read</summary><ul class="plist">${parsed.warnings.slice(0, 10).map((w) => `<li><code>${esc(w.ref)}</code> ${esc(w.text)}</li>`).join('')}</ul></details>` : ''}`;
}

function previewLegacy(fileName, parsed) {
  if (!parsed.sheets.length) { closeModal(); toast('No CIP compliance sheets found'); return; }
  const body = `
    <p class="muted"><b>${esc(fileName)}</b> · this brings your existing CIP/SIP rows across so nothing is retyped. Rows already in the tracker are matched, not duplicated.</p>
    <div class="sheetlist">${parsed.sheets.map((s, i) => `<label class="sheetrow"><input type="checkbox" data-sheet="${esc(s.name)}" ${/26$/.test(s.name) || i === 0 ? 'checked' : ''}><span><b>${esc(s.name)}</b><span class="muted">${pl(s.fv.length, 'FV row')} · ${pl(s.bbt.length, 'BBT row')}</span></span></label>`).join('')}</div>
    <div id="impPlan"></div>
    <div class="dlg-f"><button class="btn" data-close>Cancel</button><button class="btn primary" id="impGo">${I.check}<span>Import</span></button></div>`;
  openModal({
    title: 'Bring across existing CIP data', body, wide: true,
    onMount(m) {
      const chosen = () => [...m.querySelectorAll('[data-sheet]:checked')].map((c) => c.dataset.sheet);
      const show = () => {
        const plan = planLegacyImport(db(), parsed, { sheets: chosen() });
        $('#impPlan', m).innerHTML = plan.sheets.length ? `<div class="pgrid">${plan.sheets.map((s) => `<div class="pcol"><h4>${esc(s.name)}</h4><ul>
          <li><b>${s.fv.new}</b> FV rows added${s.fv.merged ? `, ${s.fv.merged} merged into existing` : ''}</li>
          <li><b>${s.bbt.new}</b> BBT rows added${s.bbt.merged ? `, ${s.bbt.merged} merged into existing` : ''}</li>
          ${s.fv.same + s.bbt.same ? `<li class="muted">${s.fv.same + s.bbt.same} already present</li>` : ''}</ul></div>`).join('')}</div>` : '<p class="muted">Tick at least one sheet.</p>';
        $('#impGo', m).disabled = !plan.ops.length;
        $('#impGo span', m).textContent = plan.ops.length ? 'Import' : 'Nothing to add';
      };
      m.querySelectorAll('[data-sheet]').forEach((c) => c.addEventListener('change', show));
      $('#impGo', m).addEventListener('click', () => {
        const plan = planLegacyImport(db(), parsed, { sheets: chosen() });
        const added = plan.sheets.reduce((n, s) => n + s.fv.new + s.bbt.new, 0);
        dispatch([...plan.ops, { op: 'meta', set: { lastImport: { at: Date.now(), kind: 'legacy', file: fileName, text: `${added} rows brought across` } } }]);
        closeModal();
        toast(`Brought across ${added} rows`);
      });
      show();
    },
  });
}

/* ---------- log CIP / SIP quickly ---------- */
function openLog(kind) {
  const cfg = config(), today = todayISO();
  const list = (kind === 'fv' ? cfg.fvs : cfg.bbts);
  const opts = list.map((n) => `<option value="${n}">${kind === 'fv' ? 'FV' : 'BBT'} ${n}</option>`).join('');
  const preset = /^\d+$/.test(S.ui.q) && list.includes(Number(S.ui.q)) ? S.ui.q : '';
  const body = kind === 'fv'
    ? `<form id="logForm" class="form">
        <label>Vessel<select name="v" required autofocus><option value="">Choose…</option>${opts}</select></label>
        <div class="row2"><label>CIP date<input type="date" name="a" value="${today}"></label><label>SIP date<input type="date" name="b"></label></div>
        <p class="muted">Leave a date empty to add it later. It joins the vessel’s next brew from the Live Brewery Board automatically.</p>
        <div class="dlg-f"><button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="submit">${I.check}<span>Save</span></button></div></form>`
    : `<form id="logForm" class="form">
        <label>Vessel<select name="v" required autofocus><option value="">Choose…</option>${opts}</select></label>
        <div class="row2"><label>Acid CIP date<input type="date" name="a" value="${today}"></label><label>Number of acid CIPs<input type="number" name="b" min="0" max="99" inputmode="numeric" placeholder="e.g. 3"></label></div>
        <p class="muted">It joins the tank’s next transfer from the Live Brewery Board automatically.</p>
        <div class="dlg-f"><button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="submit">${I.check}<span>Save</span></button></div></form>`;
  openModal({
    title: kind === 'fv' ? 'Log FV CIP / SIP' : 'Log BBT acid CIP', body,
    onMount(m) {
      const form = $('#logForm', m);
      if (preset) form.v.value = preset;
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const v = Number(form.v.value);
        if (!v) return;
        const msg = kind === 'fv' ? logFv(v, form.a.value, form.b.value) : logBbt(v, form.a.value, form.b.value === '' ? null : Number(form.b.value));
        closeModal(); toast(msg);
      });
    },
  });
}

function logFv(fv, cip, sip) {
  if (!cip && !sip) return 'Nothing to save — enter a CIP or SIP date';
  const ref = cip || sip;
  const mine = db().fv.filter((r) => r.fv === fv);
  const cands = mine.filter((r) => (!cip || !r.cip) && (!sip || !r.sip) && (!r.brew || r.brew >= ref))
    .sort((a, b) => {
      if (!cip && sip && !!a.cip !== !!b.cip) return a.cip ? -1 : 1;          // a SIP belongs with a row that already has its CIP
      return (a.brew || '9999') < (b.brew || '9999') ? -1 : 1;
    });
  const t = cands[0];
  if (t) {
    putFv({ ...t, cip: cip || t.cip, sip: sip || t.sip });
    return t.brew ? `Logged on FV ${fv} — brew ${fmtDate(t.brew)}` : `Logged on FV ${fv} — waiting for its next brew`;
  }
  putFv({ id: uid(), fv, cip: cip || '', sip: sip || '', brew: '', recipe: '', note: '', bsrc: '' });
  return `Logged FV ${fv} — it will join its next brew`;
}
function logBbt(bbt, acidCip, count) {
  if (!acidCip) return 'Nothing to save — enter the acid CIP date';
  const cands = db().bbt.filter((r) => r.bbt === bbt && !r.acidCip && (!r.transfer || r.transfer >= acidCip))
    .sort((a, b) => ((a.transfer || '9999') < (b.transfer || '9999') ? -1 : 1));
  const t = cands[0];
  if (t) {
    putBbt({ ...t, acidCip, acidCount: count ?? t.acidCount });
    return t.transfer ? `Logged on BBT ${bbt} — transfer ${fmtDate(t.transfer)}` : `Logged on BBT ${bbt} — waiting for its next transfer`;
  }
  putBbt({ id: uid(), bbt, acidCip, acidCount: count, transfer: '', fromFv: null, batch: '', note: '', tsrc: '' });
  return `Logged BBT ${bbt} — it will join its next transfer`;
}

/* ---------- CSV ---------- */
function exportCsv(kind) {
  const cfg = config(), today = todayISO(), year = S.ui.year;
  const q = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  let head, rows;
  if (kind === 'fv') {
    head = ['FV', 'CIP Date', 'SIP Date', 'Brew Date', 'Beer', 'Time between CIP/SIP & fill', 'Time between SIP & fill', 'Compliant'];
    rows = db().fv.filter((r) => fvYear(r) === year).sort((a, b) => ((a.brew || a.cip) < (b.brew || b.cip) ? -1 : 1)).map((r) => { const s = fvStatus(r, today); return [r.fv, r.cip, r.sip, r.brew, r.recipe, s.f, s.g, s.state === 'need' || s.state === 'wait' ? '' : s.label]; });
  } else {
    head = ['BBT', 'Type', 'Acid CIP Date', 'Number of acid CIPs', 'Transfer Date', 'From FV', 'Beer', 'Time between CIP and fill', 'Ready to Fill?'];
    rows = db().bbt.filter((r) => bbtYear(r) === year).sort((a, b) => ((a.transfer || a.acidCip) < (b.transfer || b.acidCip) ? -1 : 1)).map((r) => { const s = bbtStatus(r, cfg.dme, today); return [r.bbt, s.dme ? 'DME' : 'Krones', r.acidCip, r.acidCount, r.transfer, r.fromFv, r.batch, s.n, s.state === 'need' || s.state === 'wait' ? '' : s.label]; });
  }
  const csv = '﻿' + [head, ...rows].map((r) => r.map(q).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `balter-${kind === 'fv' ? 'FV' : 'BBT'}-CIP-compliance-${year}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---------- settings ---------- */
function openSettings() {
  const c = db().cfg;
  openModal({
    title: 'Settings', wide: true,
    body: `<form id="cfgForm" class="form"><h4>Vessels</h4>
        <label>Fermenters (FV) <input name="fvs" value="${esc(c.fvs)}" spellcheck="false"><small class="muted">Numbers and ranges, e.g. 1-12, 14-28, 31, 35-60. Any other FV that appears on the board is added automatically.</small></label>
        <label>Brite tanks (BBT) <input name="bbts" value="${esc(c.bbts)}" spellcheck="false"></label>
        <label>DME brite tanks <input name="dme" value="${esc(c.dme)}" spellcheck="false"><small class="muted">These may sit over 2 days after acid CIP (shown purple). Every other BBT is treated as Krones and must be filled within 2 days.</small></label>
        <div class="dlg-f flush"><button class="btn primary" type="submit">${I.check}<span>Save vessels</span></button></div></form>
      <hr><form id="pwForm" class="form"><h4>PIN</h4>
        <div class="row2"><label>Current PIN<input type="password" name="current" inputmode="numeric" autocomplete="current-password" required></label><label>New 4-digit PIN<input type="password" name="next" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="new-password" required></label></div>
        <p class="msg" id="pwMsg" role="status"></p>
        <div class="dlg-f flush"><button class="btn" type="submit">Change PIN</button></div></form>
      <hr><div class="form"><h4>History</h4><p class="muted">Merge the CIP/SIP history built into this site (from the Vessel &amp; Equipment CIP monitoring workbook, 2025 &amp; 2026) into your current data. Existing rows are matched, never duplicated or overwritten.</p>
        <div class="dlg-f flush"><button class="btn" type="button" id="loadSeed">Load CIP history</button></div></div>
      <hr><div class="dlg-f flush split"><span class="muted">Daily backups of your data are kept for 30 days.</span><button class="btn" id="signOut">Sign out</button></div>`,
    onMount(m) {
      $('#cfgForm', m).addEventListener('submit', (e) => {
        e.preventDefault();
        const f = e.target;
        for (const k of ['fvs', 'bbts', 'dme']) if (!parseList(f[k].value).length) { toast('Enter at least one vessel number in each list'); return; }
        dispatch({ op: 'cfg', set: { fvs: f.fvs.value, bbts: f.bbts.value, dme: f.dme.value } });
        closeModal(); toast('Vessel lists saved');
      });
      $('#pwForm', m).addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.target, msg = $('#pwMsg', m);
        msg.textContent = 'Saving…'; msg.className = 'msg';
        const r = await api('/api/auth/password', { method: 'POST', body: { current: f.current.value, next: f.next.value } });
        msg.textContent = r.ok ? 'PIN changed.' : (r.data?.error || 'Couldn’t change the PIN');
        msg.className = 'msg ' + (r.ok ? 'ok' : 'err');
        if (r.ok) f.reset();
      });
      $('#loadSeed', m).addEventListener('click', async () => {
        try {
          const r = await fetch('/seed.json', { credentials: 'same-origin' });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const d = await r.json();
          const pick = (o, ks) => Object.fromEntries(ks.map((k) => [k, o[k]]));
          previewLegacy('Built-in CIP history', { sheets: [{ name: 'CIP history (2025 + 2026)', warnings: [],
            fv: d.fv.map((x) => pick(x, ['fv', 'cip', 'sip', 'brew'])),
            bbt: d.bbt.map((x) => pick(x, ['bbt', 'acidCip', 'acidCount', 'transfer'])) }] });
        } catch (err) { console.error(err); toast('Couldn’t load the built-in history'); }
      });
      $('#signOut', m).addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }); location.href = '/login'; });
    },
  });
}

/* ---------- boot ---------- */
function bubbles() {
  const el = $('.bubbles');
  if (!el || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  el.innerHTML = Array.from({ length: 16 }, (_, i) => {
    const s = 8 + Math.round(Math.random() * 30), l = Math.round(Math.random() * 100), d = 14 + Math.random() * 18, dl = -Math.random() * 30;
    return `<i style="--s:${s}px;left:${l}%;animation-duration:${d.toFixed(1)}s;animation-delay:${dl.toFixed(1)}s;--c:${['#47D7AC', '#99D6EA', '#F1EB9C', '#FFD637', '#7566A0'][i % 5]}"></i>`;
  }).join('');
}

$('#settingsBtn').innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M12 15.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM19.4 13.5a7.7 7.7 0 000-3l2-1.6-2-3.4-2.4 1a7.6 7.6 0 00-2.6-1.5L14 2.5h-4l-.4 2.5a7.6 7.6 0 00-2.6 1.5l-2.4-1-2 3.4 2 1.6a7.7 7.7 0 000 3l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 002.6 1.5l.4 2.5h4l.4-2.5a7.6 7.6 0 002.6-1.5l2.4 1 2-3.4z"/></svg>';
bubbles();
render();
load().then((ok) => { if (!ok) toast('Couldn’t load data — retrying'); startPolling(); setStatus('saved'); });
if (!ready()) setTimeout(() => { if (!ready()) load(); }, 4000);
