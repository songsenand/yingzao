#!/usr/bin/env node
// The 0.1.1 release gate. `accept:preview` alone may skip the real CadQuery
// half when the pack is absent, so this wrapper fails closed and also runs the
// STEP/datums acceptance that is not in the preview chain.
import { spawnSync } from 'node:child_process';
const env = { ...process.env, DSH_CAD_REQUIRE_CQ: '1' };
let failed = 0;
for (const script of ['accept:preview', 'accept:step-validation']) {
  console.log(`\n== ${script}`);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npm, ['run', script], { stdio: 'inherit', env, timeout: 30 * 60_000, shell: process.platform === 'win32' });
  if (r.status !== 0) { failed++; console.error(`FAIL ${script} (exit ${r.status})`); }
}
console.log(failed ? `\naccept:release: ${failed} failed` : '\naccept:release: PASS');
process.exit(failed ? 1 : 0);
