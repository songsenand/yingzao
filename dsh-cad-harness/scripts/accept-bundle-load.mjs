#!/usr/bin/env node
// A1 acceptance (bundle load): a profile that only knows this package can
// compose it without a build step. This is not `dsh plugin add` (that needs a
// writable pnpm store); it is the load step that add would produce.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const home = mkdtempSync(join(tmpdir(), 'cad-bundle-'));
const profile = join(home, 'profiles', 'smoke');
try {
  mkdirSync(join(profile, 'node_modules'), { recursive: true });
  symlinkSync(ROOT, join(profile, 'node_modules', 'dsh-cad-harness'), 'junction');
  writeFileSync(join(profile, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-smoke',
    private: true,
    dependencies: { 'dsh-cad-harness': `link:${ROOT}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-cad-harness'] } },
  }, null, 2)}\n`);

  const result = spawnSync('dsh', ['--profile', 'smoke', '--dump-config'], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: home },
    timeout: 60_000,
  });
  const out = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  check('dsh --dump-config exits 0', result.status === 0, `status=${result.status}`);
  check('composed config contains the CAD host row', out.includes('cad-harness-host'));
  check('composed config contains the CAD preset', out.includes('preset-cad'));
  check('composed config contains the skill provider', out.includes('cad-skill-filesystem'));
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log(`\naccept-bundle-load: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
