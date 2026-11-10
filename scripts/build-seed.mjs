// Builds public/seed.json from the old CIP workbook:  node scripts/build-seed.mjs path/to/Vessel_Equipment_CIP_monitoring.xlsx
// The Worker loads seed.json into KV the first time the site is used (only when KV has no data yet).
import fs from 'node:fs';
import { parseLegacy } from '../public/js/board.js';
import { planLegacyImport } from '../public/js/merge.js';
import { emptyDb, applyOps } from '../public/js/ops.js';

const src = process.argv[2];
if (!src) { console.error('usage: node scripts/build-seed.mjs <workbook.xlsx>'); process.exit(1); }
const legacy = parseLegacy(new Uint8Array(fs.readFileSync(src)));
const db = emptyDb();
const plan = planLegacyImport(db, legacy);
applyOps(db, plan.ops);
db.ver = 'seed';
fs.writeFileSync(new URL('../public/seed.json', import.meta.url), JSON.stringify(db));
for (const s of plan.sheets) console.log(s.name, 'FV', s.fv.new, 'BBT', s.bbt.new);
console.log('seed.json:', db.fv.length, 'FV rows,', db.bbt.length, 'BBT rows');
