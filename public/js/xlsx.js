// Minimal .xlsx reader (zip + XML via regex). Only reads cell values — that's all we need,
// and it keeps a 12 MB workbook with 190 sheets fast in the browser.
import { unzipSync, strFromU8 } from '../vendor/fflate.js';

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const unxml = (s) => s.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; }
  return ENT[e.toLowerCase()];
});
const attrs = (s) => { const o = {}; for (const m of s.matchAll(/([\w:.-]+)="([^"]*)"/g)) o[m[1]] = m[2]; return o; };
export const colIndex = (letters) => { let n = 0; for (const ch of letters) n = n * 26 + ch.charCodeAt(0) - 64; return n; };

// Excel serial (1900 system) -> 'YYYY-MM-DD'; '' when it is not a sensible date.
export function serialToISO(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 36526 || n > 73050) return ''; // 2000 – 2099
  return new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000).toISOString().slice(0, 10);
}

function sharedStrings(xml) {
  const out = [];
  for (const m of xml.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) {
    const body = (m[1] || '').replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
    let t = '';
    for (const x of body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) t += x[1];
    out.push(unxml(t));
  }
  return out;
}

export function openWorkbook(bytes) {
  const small = unzipSync(bytes, { filter: (f) => /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml)$/.test(f.name) });
  if (!small['xl/workbook.xml']) throw new Error('Not an Excel (.xlsx) workbook');
  const rels = {};
  for (const m of strFromU8(small['xl/_rels/workbook.xml.rels'] || new Uint8Array()).matchAll(/<Relationship\b([^>]*?)\/?>/g)) { const a = attrs(m[1]); rels[a.Id] = a.Target; }
  const sheets = [];
  for (const m of strFromU8(small['xl/workbook.xml']).matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const a = attrs(m[1]);
    let p = rels[a['r:id']] || '';
    p = p.replace(/^\//, ''); if (!p.startsWith('xl/')) p = 'xl/' + p;
    sheets.push({ name: unxml(a.name || ''), hidden: (a.state || 'visible') !== 'visible', path: p });
  }
  let ss = null;
  return {
    sheets,
    // Returns Map(sheet name -> Map(row -> Map(col -> value))) for the requested sheets, rows limited to [minRow, maxRow].
    readSheets(wanted, { minRow = 1, maxRow = Infinity } = {}) {
      const paths = new Set(wanted.map((s) => s.path));
      const files = unzipSync(bytes, { filter: (f) => paths.has(f.name) });
      ss ||= sharedStrings(small['xl/sharedStrings.xml'] ? strFromU8(small['xl/sharedStrings.xml']) : '');
      const out = new Map();
      for (const s of wanted) if (files[s.path]) out.set(s.name, parseRows(strFromU8(files[s.path]), ss, minRow, maxRow));
      return out;
    },
  };
}

export function parseRows(xml, ss, minRow = 1, maxRow = Infinity) {
  const rows = new Map();
  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  let m;
  while ((m = rowRe.exec(xml))) {
    const rn = +((/\br="(\d+)"/.exec(m[1]) || [])[1] || 0);
    if (!rn) continue;
    if (rn > maxRow) break;
    if (rn < minRow || !m[2]) continue;
    const cells = new Map();
    for (const c of m[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      if (!c[2]) continue;
      const a = attrs(c[1]);
      const ref = /^([A-Z]+)/.exec(a.r || '');
      if (!ref) continue;
      const body = c[2], t = a.t || 'n';
      let v;
      if (t === 's') { const x = /<v>(\d+)<\/v>/.exec(body); v = x ? ss[+x[1]] : undefined; }
      else if (t === 'inlineStr') { v = ''; for (const x of body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) v += unxml(x[1]); }
      else if (t === 'str') { const x = /<v>([\s\S]*?)<\/v>/.exec(body); v = x ? unxml(x[1]) : undefined; }
      else if (t === 'n') { const x = /<v>([^<]*)<\/v>/.exec(body); v = x ? parseFloat(x[1]) : undefined; if (Number.isNaN(v)) v = undefined; }
      if (v !== undefined && v !== '') cells.set(colIndex(ref[1]), v);
    }
    if (cells.size) rows.set(rn, cells);
  }
  return rows;
}
