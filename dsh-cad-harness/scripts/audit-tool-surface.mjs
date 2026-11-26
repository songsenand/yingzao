#!/usr/bin/env node
// Measure the live catalogue and its tool-declared surfaces.
//
//   node scripts/audit-tool-surface.mjs            # human summary
//   node scripts/audit-tool-surface.mjs --json     # machine report
//   node scripts/audit-tool-surface.mjs --write     # regenerate the v1 ledger + map
//
// The surface map is derived from each definition's `surface` metadata at
// registration. There is no hand-written 9×members table to drift.
//
// --write regenerates TWO checked-in artifacts from the live ledger:
//   docs/TOOL-SURFACE-V1.json   the freeze ledger accept scripts compare against
//   docs/TOOL-SURFACE-MAP.md    the legacy-name → surface.action migration table
//
// Regeneration REFUSES to drop a frozen (surface, action) pair: under the 0.2.0
// contract a removal must go through deprecation (see docs/dev/COMPATIBILITY.md
// once Q3 lands). `--force` is the deliberate escape hatch and prints what it
// dropped, so a `git diff` of the ledger is the review.

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const JSON_OUT = process.argv.includes('--json');
const WRITE = process.argv.includes('--write');
const FORCE = process.argv.includes('--force');
const LEDGER = join(ROOT, 'docs/TOOL-SURFACE-V1.json');
const MAP = join(ROOT, 'docs/TOOL-SURFACE-MAP.md');
const home = mkdtempSync(join(tmpdir(), 'cad-tool-surface-'));
process.env.DSH_HOME = home;
process.env.DSH_CAD_PYTHON = process.env.DSH_CAD_PYTHON || 'off';

const { registerCadTools } = await import('../src/host/tools.ts');
const tools = new Map();
const ctx = {
  tools: { register: (definition) => { tools.set(definition.name, definition); return () => {}; } },
  connection: { fetch: { register: () => (() => {}) } },
  attachments: { saveImages: async () => [] },
  reflect: { get: () => undefined },
  on: () => () => {},
  effect: (fn) => { try { fn(); } catch { /* registration effects are not under test */ } },
  logger: { debug() {}, info() {}, warn() {}, error() {} },
};
try {
  registerCadTools(ctx);
} catch (error) {
  console.error(`tool-surface: registration failed: ${error?.stack ?? error}`);
  rmSync(home, { recursive: true, force: true });
  process.exit(1);
}

const rows = [...tools.entries()].map(([name, definition]) => {
  const schema = JSON.stringify({
    name,
    description: definition.description ?? '',
    parameters: definition.parameters ?? {},
  });
  return {
    name,
    surface: definition.surface?.id ?? null,
    action: definition.surface?.action ?? null,
    schemaChars: schema.length,
  };
}).sort((a, b) => b.schemaChars - a.schemaChars);

const missing = rows.filter((row) => row.surface === null).map((row) => row.name);
const pairs = new Map();
for (const row of rows) {
  if (!row.surface) continue;
  const key = `${row.surface}.${row.action}`;
  pairs.set(key, (pairs.get(key) ?? 0) + 1);
}
const duplicates = [...pairs.entries()].filter(([, count]) => count > 1).map(([key]) => key);
const ids = [...new Set(rows.map((row) => row.surface).filter(Boolean))].sort();
const totalChars = rows.reduce((sum, row) => sum + row.schemaChars, 0);
const bySurface = ids.map((id) => {
  const members = rows.filter((row) => row.surface === id);
  return {
    id,
    gate: id === 'cad_deliver',
    tools: members.length,
    schemaChars: members.reduce((sum, row) => sum + row.schemaChars, 0),
    names: members.map((row) => row.name),
  };
});
const failed = missing.length > 0 || duplicates.length > 0 || ids.length !== 9;

function renderMap(ledger) {
  const lines = [
    '# Tool surface map (generated — do not edit by hand)',
    '',
    '> `node scripts/audit-tool-surface.mjs --write`',
    '>',
    `> **Frozen** ${ledger.frozenAt}${ledger.revision ? `, revision ${ledger.revision} (${ledger.updatedAt})` : ''}.`,
    '> Under the 0.2.0 contract the nine surface names and every action name below are',
    `> **frozen: add only**. \`docs/TOOL-SURFACE-V1.json\` is the machine copy this page is`,
    '> rendered from; `accept-tool-surface` and `accept-cad-all-surfaces` compare the live',
    '> registration against it.',
    '',
    '## Deprecation policy (0.2.x)',
    '',
    '1. **Add**: add the tool, declare `surface: { id, action }`, run',
    '   `node scripts/audit-tool-surface.mjs --write`, commit the ledger diff with the code.',
    '   The new pair appears in `docs/TOOL-SURFACE-V1.json`; nothing else changes.',
    '2. **Deprecate**: keep the pair in the ledger and mark it deprecated in the tool',
    '   description plus `docs/TOOL-CONTRACTS.md`; the action keeps working and keeps its',
    '   name for at least one minor version.',
    '3. **Remove**: only after step 2 has shipped in a released minor. `--write` refuses to',
    '   drop a frozen pair; the deliberate removal needs `--force` **and** a changelog line',
    '   naming the released version that carried the deprecation.',
    '4. **Rename**: never in place. Add the new action (step 1), deprecate the old one',
    '   (step 2), remove it later (step 3) — a rename is two deprecations away, by design.',
    '',
    'The full forward-compatibility contract (project schema, CLI/env stability, golden',
    'project regression) is `docs/dev/COMPATIBILITY.md` (Q3); this page is the tool-surface',
    'half of it.',
    '',
    '## Legacy name → surface call',
    '',
    'Every pre-cutover tool keeps its implementation; only the call changes.',
    'Call the surface/action on the right, not the tool on the left.',
    '',
    '| legacy tool | call it as |',
    '|---|---|',
  ];
  for (const [name, entry] of Object.entries(ledger.tools)) {
    lines.push(`| \`${name}\` | \`${entry.surface}\` action \`${entry.action}\` |`);
  }
  lines.push('', '## Ops per surface', '', '| surface | ops | actions |', '|---|---|---|');
  for (const [surface, actions] of Object.entries(ledger.surfaces)) {
    lines.push(`| \`${surface}\` | ${actions.length} | ${actions.map((a) => `\`${a}\``).join(', ')} |`);
  }
  lines.push('', `Budget: the nine surface schemas must stay ≤ ${ledger.schemaCharsBudget} chars (Q1).`, '');
  return lines.join('\n');
}

function writeLedger() {
  const live = new Map();
  for (const row of rows) {
    if (!row.surface) continue;
    if (!live.has(row.surface)) live.set(row.surface, []);
    live.get(row.surface).push(row.action);
  }
  for (const list of live.values()) list.sort();
  const tools = {};
  for (const row of [...rows].sort((a, b) => a.name.localeCompare(b.name))) {
    tools[row.name] = { surface: row.surface, action: row.action };
  }
  let previous = null;
  if (existsSync(LEDGER)) {
    try { previous = JSON.parse(readFileSync(LEDGER, 'utf8')); } catch { previous = null; }
  }
  const dropped = [];
  for (const [surface, actions] of Object.entries(previous?.surfaces ?? {})) {
    for (const action of actions) {
      if (!(live.get(surface) ?? []).includes(action)) dropped.push(`${surface}.${action}`);
    }
  }
  if (dropped.length > 0 && !FORCE) {
    console.error(`\naudit-tool-surface: --write would DROP frozen ops: ${dropped.join(', ')}`);
    console.error('Under the 0.2.0 contract a removal needs a deprecation cycle first.');
    console.error('If the removal is deliberate, re-run with --force and record it in the changelog.');
    return false;
  }
  const added = [];
  for (const [surface, actions] of live) {
    for (const action of actions) {
      if (!(previous?.surfaces?.[surface] ?? []).includes(action)) added.push(`${surface}.${action}`);
    }
  }
  const today = new Date().toISOString().slice(0, 10);
  const ledger = {
    frozenAt: previous?.frozenAt ?? today,
    updatedAt: today,
    revision: (previous?.revision ?? 0) + (added.length > 0 ? 1 : 0),
    policy: 'add only; removal or rename needs a deprecation cycle of at least one minor version',
    schemaCharsBudget: 6144,
    surfaces: Object.fromEntries([...live.keys()].sort().map((id) => [id, live.get(id)])),
    tools,
  };
  writeFileSync(LEDGER, `${JSON.stringify(ledger, null, 2)}\n`);
  writeFileSync(MAP, renderMap(ledger));
  if (dropped.length > 0) console.error(`  FORCED drop: ${dropped.join(', ')}`);
  console.log(`tool-surface: wrote docs/TOOL-SURFACE-V1.json (${Object.keys(ledger.surfaces).length} surfaces, ${Object.keys(tools).length} ops)`);
  console.log('tool-surface: wrote docs/TOOL-SURFACE-MAP.md');
  if (added.length > 0) console.log(`tool-surface: added ${added.join(', ')}`);
  return true;
}

if (WRITE) {
  if (!writeLedger()) {
    rmSync(home, { recursive: true, force: true });
    process.exit(1);
  }
}

if (JSON_OUT) {
  console.log(JSON.stringify({
    ok: !failed,
    tools: rows.length,
    surfaces: ids.length,
    schemaChars: totalChars,
    approxTokens: Math.round(totalChars / 4),
    coverage: { missing, absent: [], duplicates },
    bySurface,
    // The ledger form of the live map: accept-tool-surface compares this to
    // docs/TOOL-SURFACE-V1.json so a new/removed action cannot reach a commit
    // without the frozen ledger being regenerated in the same change.
    pairs: rows.filter((row) => row.surface).map((row) => ({ tool: row.name, surface: row.surface, action: row.action })),
    largest: rows.slice(0, 10),
  }, null, 2));
} else {
  console.log(`tools: ${rows.length}`);
  console.log(`surfaces: ${ids.length}`);
  console.log(`schema chars: ${totalChars} (~${Math.round(totalChars / 4)} tokens, chars/4)`);
  console.log('');
  console.log('surface       tools  schemaKB');
  for (const surface of bySurface) {
    console.log(`${surface.id.padEnd(12)} ${String(surface.tools).padStart(5)}  ${(surface.schemaChars / 1024).toFixed(1).padStart(8)}`);
  }
  console.log('');
  console.log('largest tools:');
  for (const row of rows.slice(0, 10)) {
    console.log(`  ${row.name.padEnd(24)} ${(row.schemaChars / 1024).toFixed(1).padStart(6)} KB  ${row.surface ?? 'MISSING'}.${row.action ?? '?'}`);
  }
  if (failed) {
    console.log('');
    if (missing.length) console.log(`MISSING surface metadata: ${missing.join(', ')}`);
    if (duplicates.length) console.log(`DUPLICATE (surface, action): ${duplicates.join(', ')}`);
    if (ids.length !== 9) console.log(`EXPECTED 9 surfaces, got ${ids.length}: ${ids.join(', ')}`);
  }
}

rmSync(home, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
