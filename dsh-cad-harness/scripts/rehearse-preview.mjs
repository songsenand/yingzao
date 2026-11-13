#!/usr/bin/env node
// Local rehearsal of .github/workflows/preview.yml. It runs the same release
// steps that do not need a GitHub runner:
//   build -> accept:preview -> pack -> extract -> setup -> doctor -> verify.
//
// The only step it cannot reproduce is `dsh plugin add` (the sandbox's pnpm
// store is read-only); the workflow covers that with a manual profile load.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { findStandardPatch } from './preset-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
let failed = 0;
function run(label, command, args, options = {}) {
  process.stdout.write(`\n== ${label}\n`);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', ...options });
  if (result.status !== 0) {
    failed++;
    console.error(`FAIL ${label} (exit ${result.status})`);
  }
  return result.status === 0;
}
function check(label, condition, detail = '') {
  if (condition) console.log(`PASS ${label}`);
  else { failed++; console.error(`FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}

check('build', run('build', 'npm', ['run', 'build']));
check('accept:preview', run('accept:preview', 'npm', ['run', 'accept:preview']));

const work = mkdtempSync(join(ROOT, '.tmp-rehearse-'));
try {
  const packEnv = { ...process.env, npm_config_cache: join(work, 'npm-cache') };
  check('pack', run('pack', 'npm', ['pack', '--pack-destination', work], { env: packEnv }));
  const files = mkdtempSync(join(work, 'extract-'));
  const tgz = spawnSync('sh', ['-c', `ls ${work}/*.tgz | head -1`], { encoding: 'utf8' }).stdout.trim();
  check('tarball exists', Boolean(tgz) && existsSync(tgz), tgz);
  run('extract', 'tar', ['-xzf', tgz, '-C', files]);
  const listing = spawnSync('tar', ['-tzf', tgz], { encoding: 'utf8' }).stdout;
  check('tarball has LICENSE', listing.includes('package/LICENSE'));
  check('tarball has NOTICE', listing.includes('package/NOTICE'));
  check('tarball has no AppImage', !listing.includes('.AppImage'));
  check('tarball has no BOSL2', !listing.includes('BOSL2'));
  const pkg = join(files, 'package');
  check('package has lib/index.js', existsSync(join(pkg, 'lib', 'index.js')));
  check('package has lib/verify.js', existsSync(join(pkg, 'lib', 'verify.js')));

  const packedPreset = readFileSync(join(pkg, 'presets', 'cad', 'preset.patch.yml'), 'utf8');
  check('packed preset does not leak a machine path', !packedPreset.includes('/home/'));

  const standard = findStandardPatch(ROOT);
  check('standard.patch.yml found', Boolean(standard), standard ?? '');
  if (standard) {
    check('setup writes', run('setup', process.execPath, ['scripts/setup.mjs', '--root', pkg, '--standard', standard, '--openscad=off']));
    check('setup --check', run('setup --check', process.execPath, ['scripts/setup.mjs', '--root', pkg, '--standard', standard, '--check', '--openscad=off']));
  }
  const doctor = spawnSync(process.execPath, ['scripts/doctor.mjs', '--root', pkg, '--json'], { encoding: 'utf8' });
  let doctorJson = null;
  try { doctorJson = JSON.parse(doctor.stdout); } catch { /* reported below */ }
  check('doctor JSON parses', doctorJson !== null, doctor.stderr);
  check('doctor is not fail', doctorJson?.kind !== 'fail', doctorJson?.kind ?? '');

  const project = join(ROOT, '..', 'examples', 'microscope5');
  const verify = spawnSync(process.execPath, ['scripts/verify-cli.mjs', project, '--advisory', '--json'], {
    cwd: pkg, encoding: 'utf8', timeout: 60_000,
  });
  check('packaged verify-cli runs', verify.status === 0 && verify.stdout.includes('"rows"'), verify.stderr);
} finally {
  // prepack strips the development preset; restore it even if pack failed.
  spawnSync(process.execPath, ['scripts/sync-cad-preset.mjs'], { cwd: ROOT, stdio: 'ignore' });
  rmSync(work, { recursive: true, force: true });
}

console.log(`\nrehearse-preview: ${failed === 0 ? 'PASS' : `${failed} failed`}`);
process.exit(failed === 0 ? 0 : 1);
