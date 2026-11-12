#!/usr/bin/env node
// N01 acceptance: the real `dsh plugin add -w` path.
//
// Local sandboxes often make pnpm's global store read-only. That is an
// environment limitation, not a package failure: without --require this script
// reports SKIP; CI passes --require so a skip is a failure there.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const required = process.argv.includes('--require');
let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const home = mkdtempSync(join(tmpdir(), 'cad-add-'));
const runtime = join(home, 'runtime');
mkdirSync(runtime, { recursive: true });
const env = { ...process.env, DSH_HOME: home, XDG_RUNTIME_DIR: runtime };
try {
  const add = spawnSync('dsh', ['plugin', '--profile', 'smoke', 'add', '-w', ROOT], {
    encoding: 'utf8',
    env,
    timeout: 300_000,
  });
  const out = `${add.stdout ?? ''}\n${add.stderr ?? ''}`;
  if (add.status !== 0 && /EROFS|Read-only file system|STORE_DIR_OPEN_OPERATION_LOCK/i.test(out)) {
    console.log('SKIP dsh plugin add: the sandbox pnpm store is read-only');
    if (required) {
      failed++;
      console.error('  FAIL --require turns the environment skip into a failure');
    }
    console.log(`\naccept-plugin-add: ${passed} passed, ${failed} failed, 1 skipped`);
    process.exit(required ? 1 : 0);
  }

  check('dsh plugin add exits 0', add.status === 0, out.slice(-800));
  if (add.status === 0) {
    const dump = spawnSync('dsh', ['--profile', 'smoke', '--dump-config'], {
      encoding: 'utf8', env, timeout: 60_000,
    });
    const config = `${dump.stdout ?? ''}\n${dump.stderr ?? ''}`;
    check('dump-config exits 0', dump.status === 0, config.slice(-500));
    check('config contains the CAD host row', config.includes('cad-harness-host'));
    check('config contains the CAD preset', config.includes('preset-cad'));
    check('config contains the skill provider', config.includes('cad-skill-filesystem'));
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log(`\naccept-plugin-add: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
