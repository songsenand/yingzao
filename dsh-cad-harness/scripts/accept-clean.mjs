#!/usr/bin/env node
// N17 acceptance (first slice): stale temp dirs are found, dry-run is safe,
// --apply removes only harness-owned names.

import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const CLEAN = new URL('./clean.mjs', import.meta.url).pathname;
const DOCTOR = new URL('./doctor.mjs', import.meta.url).pathname;
let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function run(script, args, env = {}) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env } });
}
function age(path, minutes) {
  const date = new Date(Date.now() - minutes * 60_000);
  utimesSync(path, date, date);
}

const root = mkdtempSync(join(tmpdir(), 'cad-clean-test-'));
try {
  const old = join(root, 'cad-harness-old');
  const fresh = join(root, 'cad-harness-fresh');
  const unrelated = join(root, 'other-data');
  for (const dir of [old, fresh, unrelated]) mkdirSync(dir);
  writeFileSync(join(old, 'payload'), 'x');
  age(old, 120);
  age(fresh, 1);

  const dry = run(CLEAN, ['--tmpdir', root, '--older-than-min', '60', '--json']);
  const dryJson = JSON.parse(dry.stdout);
  check('dry-run finds the stale dir', dryJson.candidates.some((c) => c.path === old));
  check('dry-run does not remove', existsSync(old));
  check('dry-run ignores fresh dirs', !dryJson.candidates.some((c) => c.path === fresh));
  check('dry-run ignores unrelated names', !dryJson.candidates.some((c) => c.path === unrelated));

  const capped = run(CLEAN, ['--tmpdir', root, '--older-than-min', '60', '--max-mb', '0', '--json']);
  check('the size cap is reported', JSON.parse(capped.stdout).overLimit === true);

  const doctor = run(DOCTOR, ['--tmpdir', root, '--json']);
  const doctorJson = JSON.parse(doctor.stdout);
  check('doctor warns about stale temps', doctorJson.checks.find((c) => c.id === 'temp-dirs')?.status === 'warn');

  const cappedDoctor = run(DOCTOR, ['--tmpdir', root, '--json'], { DSH_CAD_TEMP_MAX_MB: '0' });
  check('doctor knows the size cap', JSON.parse(cappedDoctor.stdout).checks.find((c) => c.id === 'temp-dirs')?.detail.includes('limit'));

  const applied = run(CLEAN, ['--tmpdir', root, '--older-than-min', '60', '--apply', '--json']);
  const appliedJson = JSON.parse(applied.stdout);
  check('apply removes the stale dir', appliedJson.removed === 1 && !existsSync(old));
  check('apply keeps fresh dirs', existsSync(fresh));
  check('apply keeps unrelated dirs', existsSync(unrelated));
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\naccept-clean: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
