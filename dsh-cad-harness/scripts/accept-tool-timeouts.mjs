// Lightweight step watchdog: every CAD tool must have an explicit or default time limit.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAD_TOOL_TIMEOUTS, DEFAULT_TOOL_TIMEOUT_MS } from '../src/host/tools.ts';
import { CAD_TOOL_GROUPS } from '../src/host/tool-groups.ts';

let failures = 0;
const check = (ok, label, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };
check(DEFAULT_TOOL_TIMEOUT_MS === 120_000, 'default tool timeout is 120s', String(DEFAULT_TOOL_TIMEOUT_MS));
for (const [name, ms] of Object.entries(CAD_TOOL_TIMEOUTS)) {
  check(ms > 0, `${name}: positive timeout`, String(ms));
}
check(CAD_TOOL_TIMEOUTS.check_assembly === 300_000, 'check_assembly has 300s', String(CAD_TOOL_TIMEOUTS.check_assembly));
check(CAD_TOOL_TIMEOUTS.write_assembly === undefined || CAD_TOOL_TIMEOUTS.write_assembly > 0, 'write_assembly explicit timeout is valid');
const names = new Set(Object.values(CAD_TOOL_GROUPS).flat());
check(names.has('write_assembly') && names.has('pearl_run'), 'new tools are in a group');
console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
