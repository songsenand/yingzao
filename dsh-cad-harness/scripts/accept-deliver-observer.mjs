// Delivery has no persisted run in this corpus; the observer reads an explicit
// delivery-audit.json if present and otherwise says unobserved, never green.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { observeDeliver } from '../src/host/pearls/ledger.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (ok, label, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };

async function project(report) {
  const dir = await mkdtemp(join(tmpdir(), 'deliver-'));
  if (report) {
    await mkdir(join(dir, 'assembly'), { recursive: true });
    await writeFile(join(dir, 'assembly/delivery-audit.json'), JSON.stringify(report));
  }
  return dir;
}

const passDir = await project({ verdict: 'not-excluded', findings: [], summary: 'ok' });
const pass = await observeDeliver(passDir);
check(pass.status === 'pass' && pass.failures.length === 0, 'delivery not-excluded -> pass', pass.status);

const warnDir = await project({ verdict: 'difficult', findings: [{ severity: 'warn', code: 'x', detail: 'weaker evidence' }] });
const warn = await observeDeliver(warnDir);
check(warn.status === 'warn' && warn.failures[0]?.location.kind === 'manifest', 'delivery difficult -> warn + manifest location', warn.status);

const failDir = await project({ verdict: 'excluded', findings: [{ severity: 'blocked', code: 'claim-without-evidence', detail: 'no witness' }] });
const fail = await observeDeliver(failDir);
check(fail.status === 'fail' && fail.failures[0]?.code === 'deliver.blocked', 'delivery excluded/blocked -> fail', fail.status);

const noneDir = await project(null);
const none = await observeDeliver(noneDir);
check(none.status === 'unobserved' && none.failures[0]?.code === 'deliver.no-evidence', 'missing delivery artifact -> unobserved, not pass', none.status);

await Promise.all([passDir, warnDir, failDir, noneDir].map((d) => rm(d, { recursive: true, force: true })));
console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
