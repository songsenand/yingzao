#!/usr/bin/env node
// Phase 0 acceptance for the 9-surface migration ledger.
//
// It does not require a live session, CAD engine or Python runtime: the audit
// captures the registered definitions with a fake ctx and derives the 9 surfaces
// from each tool's metadata. A failure means a tool is unlabelled or an
// (surface, action) pair is duplicated.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  PASS ${name}`);
  else { failed++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const run = spawnSync(process.execPath, [join(ROOT, 'scripts/audit-tool-surface.mjs'), '--json'], {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: 30000,
});
check('audit runs', run.status === 0, (run.stderr ?? '').trim().slice(0, 160));
let report = null;
try { report = JSON.parse(run.stdout); } catch { /* checked below */ }
check('audit JSON parses', report !== null);
check('9 surfaces declared', report?.surfaces === 9, String(report?.surfaces));
check('the current tool set is captured (coverage, not a frozen count)', Number(report?.tools) >= 39, String(report?.tools));
check('every registered tool is in exactly one surface',
  report?.coverage?.missing?.length === 0
  && report?.coverage?.absent?.length === 0
  && report?.coverage?.duplicates?.length === 0,
  JSON.stringify(report?.coverage));
check('every surface is non-empty',
  (report?.bySurface ?? []).length === 9 && (report?.bySurface ?? []).every((f) => f.tools > 0));
check('deliver is a top-level gate',
  (report?.bySurface ?? []).find((f) => f.id === 'cad_deliver')?.gate === true);
check('simulate is the largest current surface',
  (report?.bySurface ?? []).slice().sort((a, b) => b.schemaChars - a.schemaChars)[0]?.id === 'cad_simulate');
check('schema is measured, not assumed',
  Number(report?.schemaChars) > 0 && Number(report?.approxTokens) > 0,
  String(report?.schemaChars));

console.log(`\naccept-tool-surface: ${failed === 0 ? 'PASS' : `${failed} FAILURE(S)`}`);
process.exit(failed === 0 ? 0 : 1);
