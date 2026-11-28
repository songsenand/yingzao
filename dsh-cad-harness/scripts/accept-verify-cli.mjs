#!/usr/bin/env node
// C2 acceptance: the packaged verify CLI runs from lib/verify.js, not src/.ts.

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CLI = join(ROOT, 'scripts', 'verify-cli.mjs');
const CHECK_CLI = join(ROOT, 'scripts', 'check-register.mjs');
let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 60000 });
}
function runCheckRegister(args) {
  return spawnSync(process.execPath, [CHECK_CLI, ...args], { encoding: 'utf8', timeout: 60000 });
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

// Packaged custom-check CLI: same promise as verify — a clean install has no src/.
check('lib/check-register.js exists (built package)', existsSync(join(ROOT, 'lib', 'check-register.js')));
const checkHelp = runCheckRegister(['--help']);
check('check-register --help exits 0', checkHelp.status === 0);
check('check-register --help names the command', `${checkHelp.stdout}${checkHelp.stderr}`.includes('usage: check-register'));

const checkProject = await mkdtemp(join(tmpdir(), 'check-register-'));
try {
  await mkdir(join(checkProject, 'checks'), { recursive: true });
  await cp(join(ROOT, 'examples', 'checks', 'fit-clearance'), join(checkProject, 'checks', 'fit-clearance'), { recursive: true });
  const registered = runCheckRegister([checkProject, '--id', 'fit-clearance']);
  check('check-register --id exits 0', registered.status === 0, registered.stderr);
  const registry = JSON.parse(await readFile(join(checkProject, 'checks', 'registry.json'), 'utf8'));
  check('check-register wrote the registry entry', registry.checks?.some((c) => c.id === 'fit-clearance') === true);
} finally {
  await rm(checkProject, { recursive: true, force: true });
}

console.log(`\naccept-verify-cli: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
