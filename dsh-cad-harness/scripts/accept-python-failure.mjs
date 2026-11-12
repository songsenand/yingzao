#!/usr/bin/env node
// A4 acceptance (first slice): provisioning failures get a stable code + hint,
// not a raw stack. No download and no runtime mutation.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyProvisionFailure, recordRuntimeFailure } from '../src/host/python-runtime.ts';

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const cases = [
  ['ENOSPC: no space left on device', 'disk-full'],
  ['EACCES: permission denied, mkdir', 'permission'],
  ['sha256 digest mismatch', 'integrity'],
  ['getaddrinfo ENOTFOUND github.com', 'network'],
  ['request timed out', 'network'],
  ['404 not found', 'mirror'],
  ['something unexpected', 'provision-failed'],
];
for (const [message, code] of cases) {
  const result = classifyProvisionFailure(new Error(message));
  check(`${code} is classified`, result.code === code, `${message} -> ${result.code}`);
  check(`${code} has a hint`, result.hint.length > 0);
  check(`${code} keeps the message`, result.message.includes(message.split(':')[0]));
}
const dn = classifyProvisionFailure(new Error('getaddrinfo ENOTFOUND'));
check('network hint names the mirror knob', dn.hint.includes('DSH_CAD_PYTHON_MIRROR'));
const disk = classifyProvisionFailure(new Error('ENOSPC'));
check('disk hint names the runtime dir', disk.hint.includes('runtime'));
const home = mkdtempSync(join(tmpdir(), 'cad-pyfail-'));
try {
  process.env.DSH_HOME = home;
  const stored = await recordRuntimeFailure(new Error('ENOSPC: no space left on device'));
  check('recorded failure carries the code', stored.includes('[disk-full]'), stored);
  check('recorded failure carries a hint', stored.includes('Hint:'), stored);
  const state = JSON.parse(readFileSync(join(home, 'cad', 'runtime', 'state.json'), 'utf8'));
  check('state.json records the classified error', String(state.error).includes('[disk-full]'));
  check('state.json keeps the hint', String(state.error).includes('free disk space'));
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log(`\naccept-python-failure: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
