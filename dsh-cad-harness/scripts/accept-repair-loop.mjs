// Repair loop: reruns only after a caller-declared change; no-progress stops.
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadPearl } from '../src/host/pearls/registry.ts';
import { buildStepContext } from '../src/host/pearls/context.ts';
import { runTemplateRepairLoop } from '../src/host/pearls/repair-loop.ts';
import { readRepairHistory } from '../src/host/pearls/repair-history.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (ok, label, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };
const base = await mkdtemp(join(tmpdir(), 'repair-loop-'));
await cp(join(ROOT, '../examples/roberval-balance'), join(base, 'roberval-balance'), { recursive: true });
await cp(join(ROOT, '../examples/rulepacks'), join(base, 'rulepacks'), { recursive: true });
const project = join(base, 'roberval-balance');
const fit = await loadPearl(join(ROOT, 'pearls/fit'));
let calls = 0;
let repaired = 0;
const dispatch = async (step) => {
  calls++;
  if (repaired === 0 && step.id === 'interference') return { ok: false, error: 'synthetic interference', durationMs: 1, attempt: 1 };
  return { ok: true, value: { judgement: 'not-excluded' }, durationMs: 1, attempt: 1 };
};
const result = await runTemplateRepairLoop(fit, 'static', () => buildStepContext(project), dispatch, async () => { repaired++; return true; }, { projectRoot: project, deadlineMs: 30_000 });
check(result.status === 'pass' && result.rounds === 1, 'repair run reaches pass after one change', `${result.status}/${result.rounds}`);
check(calls === 4, 'failed round + repaired round both dispatch', String(calls));
const history = await readRepairHistory(project);
check(history.rounds.length >= 1 && history.rounds[0].action === 'continue', 'repair round is persisted', JSON.stringify(history.rounds.map((r) => r.action)));

let stuckCalls = 0;
const stuck = await runTemplateRepairLoop(fit, 'static', () => buildStepContext(project), async (step) => {
  stuckCalls++;
  return { ok: false, error: 'same failure', durationMs: 1, attempt: 1 };
}, async () => true, { projectRoot: project, deadlineMs: 30_000 });
check(stuck.status === 'blocked' && stuck.stoppedBy === 'no-progress', 'same signature stops as no-progress', stuck.stoppedBy);
await rm(base, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
