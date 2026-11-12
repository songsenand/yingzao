#!/usr/bin/env node
// C2 acceptance: the packaged verify CLI runs from lib/verify.js, not src/.ts.

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CLI = join(ROOT, 'scripts', 'verify-cli.mjs');
let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 60000 });
}

check('lib/verify.js exists (built package)', existsSync(join(ROOT, 'lib', 'verify.js')));
const help = run(['--help']);
check('--help exits 0', help.status === 0);
check('--help names verify', `${help.stdout}${help.stderr}`.includes('usage: verify'));

const project = join(ROOT, '..', 'examples', 'microscope5');
const advisory = run([project, '--advisory', '--json']);
const parsed = (() => { try { return JSON.parse(advisory.stdout); } catch { return null; } })();
check('advisory JSON is parseable', parsed !== null, advisory.stderr);
check('advisory exits 0', advisory.status === 0, `status=${advisory.status}`);
check('report names the project', parsed?.project === resolve(project));
const rowIds = new Set((parsed?.rows ?? []).map((row) => row.id));
check('report has the six rows', ['requirements', 'model', 'fit', 'make', 'review', 'delivery'].every((id) => rowIds.has(id)), [...rowIds].join(','));

const missing = run([]);
check('missing project is a usage/error exit', missing.status === 3, `status=${missing.status}`);

console.log(`\naccept-verify-cli: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
