#!/usr/bin/env node
// Phase 0 of the tool-surface compression: measure the CURRENT catalogue and
// check the frozen 9-facade mapping. This script must not change behaviour.
//
//   node scripts/audit-tool-surface.mjs
//   node scripts/audit-tool-surface.mjs --json
//
// The numbers are intentionally measured from the live registrations, not a
// hand-written list: a renamed/added tool must show up as MISSING in the mapping
// before Phase 1 starts.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const JSON_OUT = process.argv.includes('--json');
const home = mkdtempSync(join(tmpdir(), 'cad-tool-surface-'));
const originalHome = process.env.DSH_HOME;
process.env.DSH_HOME = home;
// Registration alone must not provision anything; keep the Python helper inert.
process.env.DSH_CAD_PYTHON = process.env.DSH_CAD_PYTHON || 'off';

const { registerCadTools } = await import('../src/host/tools.ts');
const { CAD_FACADE_IDS, CAD_FACADES, facadeCoverage } = await import('../src/host/tool-facades.ts');

const tools = new Map();
const connection = { fetch: { register: () => (() => {}) } };
const ctx = {
  tools: { register: (definition) => { tools.set(definition.name, definition); return () => {}; } },
  connection,
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
    facade: CAD_FACADE_IDS.find((id) => CAD_FACADES[id].members.includes(name)) ?? null,
    descriptionChars: String(definition.description ?? '').length,
    schemaChars: schema.length,
  };
}).sort((a, b) => b.schemaChars - a.schemaChars);

const registered = rows.map((row) => row.name);
const coverage = facadeCoverage(registered);
const totalChars = rows.reduce((sum, row) => sum + row.schemaChars, 0);
const byFacade = CAD_FACADE_IDS.map((id) => {
  const members = rows.filter((row) => row.facade === id);
  return {
    id,
    title: CAD_FACADES[id].title,
    gate: Boolean(CAD_FACADES[id].gate),
    tools: members.length,
    schemaChars: members.reduce((sum, row) => sum + row.schemaChars, 0),
    names: members.map((row) => row.name),
  };
});

const failed = coverage.missing.length > 0 || coverage.absent.length > 0 || coverage.duplicates.length > 0;

if (JSON_OUT) {
  console.log(JSON.stringify({
    ok: !failed,
    tools: rows.length,
    facades: CAD_FACADE_IDS.length,
    schemaChars: totalChars,
    approxTokens: Math.round(totalChars / 4),
    coverage,
    byFacade,
    largest: rows.slice(0, 10),
  }, null, 2));
} else {
  console.log(`tools: ${rows.length}`);
  console.log(`facades: ${CAD_FACADE_IDS.length}`);
  console.log(`schema chars: ${totalChars} (~${Math.round(totalChars / 4)} tokens, chars/4)`);
  console.log('');
  console.log('facade       tools  schemaKB');
  for (const facade of byFacade) {
    console.log(`${facade.id.padEnd(12)} ${String(facade.tools).padStart(5)}  ${(facade.schemaChars / 1024).toFixed(1).padStart(8)}`);
  }
  console.log('');
  console.log('largest tools:');
  for (const row of rows.slice(0, 10)) {
    console.log(`  ${row.name.padEnd(24)} ${(row.schemaChars / 1024).toFixed(1).padStart(6)} KB  ${row.facade ?? 'MISSING'}`);
  }
  if (failed) {
    console.log('');
    if (coverage.missing.length) console.log(`MISSING from facade table: ${coverage.missing.join(', ')}`);
    if (coverage.absent.length) console.log(`IN TABLE but not registered: ${coverage.absent.join(', ')}`);
    if (coverage.duplicates.length) console.log(`DUPLICATE facade members: ${coverage.duplicates.join(', ')}`);
  }
}

rmSync(home, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
