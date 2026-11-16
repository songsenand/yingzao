#!/usr/bin/env node
// Measure the live catalogue and its tool-declared surfaces.
//
//   node scripts/audit-tool-surface.mjs
//   node scripts/audit-tool-surface.mjs --json
//
// The surface map is derived from each definition's `surface` metadata at
// registration. There is no hand-written 9×members table to drift.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const JSON_OUT = process.argv.includes('--json');
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

if (JSON_OUT) {
  console.log(JSON.stringify({
    ok: !failed,
    tools: rows.length,
    surfaces: ids.length,
    schemaChars: totalChars,
    approxTokens: Math.round(totalChars / 4),
    coverage: { missing, absent: [], duplicates },
    bySurface,
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
