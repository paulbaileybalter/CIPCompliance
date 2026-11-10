// Minimal styled .xlsx writer (zip + XML). Supports fonts, fills, borders, number formats, merged cells,
// column widths, frozen panes, autofilter and tab colours - enough for a clean report.
// A cell is a primitive (string / number / null) or { v, s: style, d: 'YYYY-MM-DD' } where d is written as a real Excel date.
import { zipSync, strToU8 } from '../vendor/fflate.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const colName = (i) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const serial = (iso) => { const [y, m, d] = iso.split('-').map(Number); return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000; };
const rgb = (hex) => 'FF' + hex.replace('#', '').toUpperCase();

export function buildXlsx(sheets, { title = 'Report', author = 'Balter Brewing' } = {}) {
  // ---- style registry ----
  const fonts = [], fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'], borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
  const numFmts = [], xfs = [], seen = new Map();
  const idx = (arr, xml) => { let i = arr.indexOf(xml); if (i < 0) { i = arr.length; arr.push(xml); } return i; };
  const fontXml = (s) => `<font>${s.b ? '<b/>' : ''}${s.i ? '<i/>' : ''}<sz val="${s.sz || 11}"/><color rgb="${rgb(s.color || '#000000')}"/><name val="${s.font || 'Calibri'}"/><family val="2"/></font>`;
  const borderXml = (s) => {
    if (!s.border) return borders[0];
    const side = (n) => `<${n} style="${s.border.style || 'thin'}"><color rgb="${rgb(s.border.color || '#D9D9D9')}"/></${n}>`;
    return `<border>${side('left')}${side('right')}${side('top')}${side('bottom')}<diagonal/></border>`;
  };
  const xf = (s = {}) => {
    const key = JSON.stringify(s);
    if (seen.has(key)) return seen.get(key);
    const fontId = idx(fonts, fontXml(s));
    const fillId = s.bg ? idx(fills, `<fill><patternFill patternType="solid"><fgColor rgb="${rgb(s.bg)}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
    const borderId = idx(borders, borderXml(s));
    let numId = 0;
    if (s.fmt) { let i = numFmts.indexOf(s.fmt); if (i < 0) { i = numFmts.length; numFmts.push(s.fmt); } numId = 164 + i; }
    const al = s.h || s.v || s.wrap || s.indent ? `<alignment${s.h ? ` horizontal="${s.h}"` : ''} vertical="${s.v || 'center'}"${s.wrap ? ' wrapText="1"' : ''}${s.indent ? ` indent="${s.indent}"` : ''}/>` : '<alignment vertical="center"/>';
    xfs.push(`<xf numFmtId="${numId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">${al}</xf>`);
    seen.set(key, xfs.length - 1);
    return xfs.length - 1;
  };
  xf({});                                                          // style 0 = default

  // ---- sheets ----
  const sheetXml = sheets.map((sh) => {
    const rows = sh.rows.map((row, r) => {
      const h = sh.heights?.[r];
      const cells = row.map((c, i) => {
        if (c === null || c === undefined) return '';
        const cell = typeof c === 'object' ? c : { v: c };
        const ref = colName(i) + (r + 1), s = xf(cell.s || {});
        if (cell.d) return cell.d ? `<c r="${ref}" s="${s}"><v>${serial(cell.d)}</v></c>` : `<c r="${ref}" s="${s}"/>`;
        if (cell.v === '' || cell.v === null || cell.v === undefined) return `<c r="${ref}" s="${s}"/>`;
        if (typeof cell.v === 'number') return `<c r="${ref}" s="${s}"><v>${cell.v}</v></c>`;
        return `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${esc(cell.v)}</t></is></c>`;
      }).join('');
      return `<row r="${r + 1}"${h ? ` ht="${h}" customHeight="1"` : ''}>${cells}</row>`;
    }).join('');
    const cols = sh.widths ? `<cols>${sh.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
    const pane = sh.freeze ? `<pane ySplit="${sh.freeze}" topLeftCell="A${sh.freeze + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${sh.freeze + 1}" sqref="A${sh.freeze + 1}"/>` : '';
    const width = Math.max(...sh.rows.map((r) => r.length));
    const filter = sh.filter ? `<autoFilter ref="A${sh.filter}:${colName(width - 1)}${sh.rows.length}"/>` : '';
    const merges = sh.merges?.length ? `<mergeCells count="${sh.merges.length}">${sh.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr>${sh.tab ? `<tabColor rgb="${rgb(sh.tab)}"/>` : ''}<pageSetUpPr fitToPage="1"/></sheetPr><sheetViews><sheetView showGridLines="0" workbookViewId="0"${sh.first ? ' tabSelected="1"' : ''}>${pane}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/>${cols}<sheetData>${rows}</sheetData>${filter}${merges}<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="${sh.landscape === false ? 'portrait' : 'landscape'}" fitToWidth="1" fitToHeight="0"/></worksheet>`;
  });
  sheets[0].first = true;
  sheetXml[0] = sheetXml[0].replace('<sheetView showGridLines="0"', '<sheetView showGridLines="0" tabSelected="1"').replace(' tabSelected="1" tabSelected="1"', ' tabSelected="1"');

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${numFmts.length ? `<numFmts count="${numFmts.length}">${numFmts.map((f, i) => `<numFmt numFmtId="${164 + i}" formatCode="${esc(f)}"/>`).join('')}</numFmts>` : ''}<fonts count="${fonts.length}">${fonts.join('')}</fonts><fills count="${fills.length}">${fills.join('')}</fills><borders count="${borders.length}">${borders.join('')}</borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  const names = sheets.map((s, i) => s.filter ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${esc(s.name)}'!$A$${s.filter}:$${colName(Math.max(...s.rows.map((r) => r.length)) - 1)}$${s.rows.length}</definedName>` : '').join('');
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>${names ? `<definedNames>${names}</definedNames>` : ''}</workbook>`;
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
    'docProps/core.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title)}</dc:title><dc:creator>${esc(author)}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created></cp:coreProperties>`,
    'xl/workbook.xml': workbook,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': styles,
  };
  sheetXml.forEach((x, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = x; });
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])), { level: 6 });
}
