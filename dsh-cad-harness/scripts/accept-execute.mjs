// Contract round executor: stage order, repair routing, no-progress, deadline.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeContractRound } from '../src/host/pearls/execute.ts';
import { CONTRACT_STAGES } from '../src/host/pearls/contract.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (ok, label, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };

const table = await executeContractRound(join(ROOT, '../examples/eight-immortals-table'), { round: 0 });
check(table.status === 'blocked', 'table round 0 stays blocked (fit blocked)', table.status);
check(table.repair.action === 'continue', 'table still gets a repair route', table.repair.action);
check(table.stages.length === CONTRACT_STAGES.length, 'stage list is complete', String(table.stages.length));
check(table.next[0] === 'model', 'hard failure routes to model', table.next.join(','));
check(table.repair.action === 'continue' && table.repair.signatures.length > 0, 'new failure is progress by default');

const repeat = await executeContractRound(join(ROOT, '../examples/eight-immortals-table'), {
  round: 1,
  previousSignatures: table.repair.signatures,
});
check(repeat.status === 'blocked' && repeat.repair.action === 'no-progress', 'same signatures stop as no-progress', repeat.repair.action);

const windup = await executeContractRound(join(ROOT, '../examples/windup-frog'), { round: 0 });
check(windup.status === 'repair-needed' && windup.next.includes('make'), 'windup routes warnings to make', windup.next.join(','));

const deadline = await executeContractRound(join(ROOT, '../examples/windup-frog'), { round: 0, deadlineMs: 1 });
check(deadline.status === 'blocked' && deadline.timedOut && deadline.failures[0]?.code === 'pearl.deadline', 'deadline blocks with pearl.deadline', deadline.status);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
