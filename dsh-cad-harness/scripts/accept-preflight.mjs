// Acceptance for `preflight` (DESIGN §25.7): the sequence may not lose a step, and a
// step that did not run may not be averaged into a pass.
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preflightSummary, worstOf } from '../src/host/preflight.ts';
import { CAD_TOOL_GROUPS } from '../src/host/tool-groups.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (ok, label, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };

check(worstOf(['not-excluded', 'not-excluded']) === 'not-excluded', 'all clean -> not-excluded');
check(worstOf(['not-excluded', 'difficult']) === 'difficult', 'a difficult step wins over clean ones');
check(worstOf(['difficult', 'excluded']) === 'excluded', 'an excluded step wins over difficult');
check(worstOf(['excluded', 'not-excluded', 'difficult']) === 'excluded', 'order does not matter');

const s = preflightSummary([
  { step: 'printability', ran: true, judgement: 'not-excluded', detail: 'ok' },
  { step: 'assembly', ran: false, judgement: 'difficult', detail: 'not orchestrated yet' },
]);
check(s.judgement === 'difficult', 'a step that did NOT run cannot be averaged into a pass', s.judgement);
check(s.notRun.length === 1 && s.notRun[0].step === 'assembly', 'it is listed in notRun');
check(s.unevaluable[0].startsWith('assembly:'), 'and its reason reaches unevaluable');

const src = await readFile(join(ROOT, 'src/host/tools.ts'), 'utf8');
check(/name: 'preflight'/.test(src), 'the tool is registered');
check(/ran: false/.test(src) && /does not orchestrate/.test(src), 'un-orchestrated steps are declared, not skipped silently');
check(CAD_TOOL_GROUPS.deliver.includes('preflight'), 'preflight is in the deliver group (a group-scoped session still sees it)');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
