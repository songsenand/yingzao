// P0 gate acceptance: profile auto-load, budget provenance, six-pearl status.
import { mkdtemp, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runPearl } from '../src/host/pearls/run.ts';
import { CAD_TOOL_GROUPS } from '../src/host/tool-groups.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (ok, label, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };

const expected = {
  'windup-frog': 'warn',
  'roberval-balance': 'fail',
  'eight-immortals-table': 'blocked',
};
for (const [example, status] of Object.entries(expected)) {
  const r = await runPearl(join(ROOT, '../examples', example));
  check(r.status === status, `${example}: pearl_run status`, `${r.status}/${status}`);
  check(r.budgetSource === 'profile', `${example}: budget is project-declared`, r.budgetSource);
  check(r.budgetUsed.calls === 3 && r.budgetUsed.distinctTools === 3, `${example}: plan fits 3 tools/3 calls`, JSON.stringify(r.budgetUsed));
  check(r.probe.required === false, `${example}: probe is optional`, JSON.stringify(r.probe));
  check(r.ledger && ['brief', 'model', 'fit', 'make', 'review', 'deliver'].every((k) => r.ledger[k]), `${example}: six ledger entries present`);
}
check(CAD_TOOL_GROUPS.deliver.includes('pearl_run'), 'pearl_run is a deliver-group host tool');

const empty = await mkdtemp(join(tmpdir(), 'pearl-run-empty-'));
const noProfile = await runPearl(empty);
check(noProfile.status === 'blocked' && noProfile.failures.some((f) => f.code === 'pearl.profile-missing'), 'missing profile blocks instead of defaulting', noProfile.status);
await rm(empty, { recursive: true, force: true });

console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
