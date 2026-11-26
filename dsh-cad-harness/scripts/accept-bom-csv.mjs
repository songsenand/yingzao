// U22 acceptance — the BOM sheet a workshop/quote actually reads.
//
// The interesting cases are textual and financial, not visual: a comma inside a
// material, a quote inside a note, an undeclared quantity (empty ≠ 0), duplicate
// nodes (two hangers are two rows), and an agent-recommended process that nobody
// confirmed (it must not read as settled, or a recommendation reaches a quote).
//
//   node scripts/accept-bom-csv.mjs

import { bomFileName, bomGaps, BOM_HEADER, buildBomCsv, csvCell, processCell } from '../src/client/bom-csv.ts';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const sample = [
  {
    part: '底座', version: 'v001', qty: 1, material: 'AL 6061, T6',
    process: { id: 'cnc-alu', source: 'user' }, source: 'purchased', stockRef: 'STK-1001',
  },
  {
    part: '压片簧', version: 'v050', qty: 2, material: '65Mn',
    process: { id: 'sheet-metal', source: 'agent' }, source: 'printed', stockRef: undefined,
  },
  { part: '轴承 608', version: null },
];

console.log('BOM CSV acceptance\n');

check(BOM_HEADER.join(',') === '零件名,版本,数量,材料,工艺,来源,库存编号',
  'the columns are the ones a workshop reads, in order', BOM_HEADER.join(','));

// ── escaping ────────────────────────────────────────────────────────────────
check(csvCell('plain') === 'plain', 'a plain cell is not quoted');
check(csvCell('AL 6061, T6') === '"AL 6061, T6"', 'a comma forces quotes', csvCell('AL 6061, T6'));
check(csvCell('a"b') === '"a""b"', 'a quote is doubled inside quotes', csvCell('a"b'));
check(csvCell('line1\nline2') === '"line1\nline2"', 'a newline forces quotes');
check(csvCell(undefined) === '' && csvCell(null) === '', 'absent stays empty, not "undefined"');
check(csvCell(0) === '0', 'a real zero is a value');

// ── the whole sheet ─────────────────────────────────────────────────────────
const csv = buildBomCsv(sample);
const lines = csv.trimEnd().split('\n');
check(lines.length === 4, 'header + one row per NODE (duplicates kept)', `${lines.length} lines`);
check(csv.endsWith('\n'), 'the file ends with a newline');
check(lines[1].startsWith('底座,v001,1,"AL 6061, T6",cnc-alu,purchased,STK-1001'),
  'a full row carries every column in order', lines[1]);
check(lines[2].includes('sheet-metal（未确认）'),
  'an unconfirmed agent process is marked, not printed as settled', lines[2]);
check(lines[3] === '轴承 608,,,,,,' || lines[3] === '轴承 608,,,,,,',
  'a node with nothing declared is empty cells, not invented values', lines[3]);

// ── the honesty helpers ─────────────────────────────────────────────────────
check(processCell({ part: 'x', process: { id: 'fdm-pla', source: 'agent', confirmedBy: 'user@rev2' } }) === 'fdm-pla',
  'a confirmed agent recommendation is settled (no marker)');
check(processCell({ part: 'x', process: { id: 'fdm-pla', source: 'policy' } }) === 'fdm-pla',
  'a policy-approved process needs no marker');
check(processCell({ part: 'x' }) === '', 'no process → empty cell');

const gaps = bomGaps(sample);
check(gaps.rows === 3, 'gaps count rows', String(gaps.rows));
check(gaps.qty === 2 && gaps.material === 2 && gaps.process === 2,
  'gaps count the DECLARED ones per column (what the sheet cannot answer)',
  JSON.stringify(gaps));

// ── file name ───────────────────────────────────────────────────────────────
const name = bomFileName('显微镜 · 单目复式（M12 物镜）', new Date('2026-11-27T00:00:00Z'));
check(/^[^\\/:*?"<>|\s]+_BOM_2026-11-27\.csv$/.test(name), 'the file name is safe for three OSes', name);
check(bomFileName(null, new Date('2026-11-27T00:00:00Z')) === 'bom_BOM_2026-11-27.csv',
  'no machine name falls back to "bom"', bomFileName(null, new Date('2026-11-27T00:00:00Z')));

// ── a round trip through a naive parser ─────────────────────────────────────
{
  // Split on commas that are not inside quotes: if the quoting were wrong, the
  // row would gain columns, which is exactly how a comma in a material breaks a
  // quote in a spreadsheet.
  const parseRow = (line) => {
    const cells = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { cells.push(cell); cell = ''; }
      else cell += ch;
    }
    cells.push(cell);
    return cells;
  };
  const row = parseRow(lines[1]);
  check(row.length === 7, 'a row survives a naive comma split with seven cells', `${row.length}: ${JSON.stringify(row)}`);
  check(row[3] === 'AL 6061, T6', 'the comma inside the material is preserved', row[3]);
  const allRows = lines.map(parseRow);
  check(allRows.every((cells) => cells.length === 7), 'every row has seven cells');
}

console.log(failures ? `\naccept-bom-csv: ${failures} FAILURE(S)` : '\naccept-bom-csv: PASS');
process.exit(failures ? 1 : 0);
