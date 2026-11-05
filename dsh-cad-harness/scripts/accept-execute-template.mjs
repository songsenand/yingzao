// Template dispatcher: resolves inputs, runs parallel groups, returns on_fail.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPearl } from '../src/host/pearls/registry.ts';
import { buildStepContext } from '../src/host/pearls/context.ts';
import { executeTemplate } from '../src/host/pearls/execute-template.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (ok, label, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };

const fit = await loadPearl(join(ROOT, 'pearls/fit'));
const context = await buildStepContext(join(ROOT, '../examples/roberval-balance'));
const calls = [];
const okDispatcher = async (step, args, _signal) => {
  calls.push(step.tool);
  check(args !== undefined, `${step.id}: args resolved`);
  return { ok: true, value: { step: step.id }, durationMs: 1, attempt: 1 };
};
const pass = await executeTemplate(fit, 'static', context, okDispatcher);
check(pass.status === 'pass' && pass.steps.length === 2, 'fit/static executes both non-failing steps', JSON.stringify(pass.steps.map((s) => s.id)));
check(calls.join(',') === 'validate_assembly,check_assembly', 'parallel group dispatches both tools', calls.join(','));

const failDispatcher = async (step, _args, _signal) => ({
  ok: false, error: `${step.tool} failed`, durationMs: 1, attempt: 1,
});
const difficultDispatcher = async (step, _args, _signal) => ({ ok: true, value: { judgement: 'difficult' }, durationMs: 1, attempt: 1 });
const difficult = await executeTemplate(fit, 'static', context, difficultDispatcher);
check(difficult.status === 'pass' && (difficult.explanations?.length ?? 0) >= 1, 'difficult passes but requires explanation', JSON.stringify(difficult.explanations));
const semanticDispatcher = async (step, _args, _signal) => ({ ok: true, value: { judgement: 'excluded', offenders: [{ partA: 'cam', partB: 'slider', intersectionVolume: 1.2 }] }, durationMs: 1, attempt: 1 });
const semantic = await executeTemplate(fit, 'static', context, semanticDispatcher);
check(semantic.status === 'repair-needed' && semantic.steps[0]?.error?.includes('judgement=excluded') && semantic.steps[0]?.error?.includes('cam↔slider'), 'semantic failure carries the pair witness', semantic.steps[0]?.error);
const failed = await executeTemplate(fit, 'static', context, failDispatcher);
check(failed.status === 'repair-needed' && failed.next === 'model', 'failure returns on_fail route', `${failed.status}/${failed.next}`);
check(failed.steps.some((s) => s.status === 'fail'), 'failure is in trace');

const model = await loadPearl(join(ROOT, 'pearls/model'));
const blocked = await executeTemplate(model, 'assembly', context, okDispatcher);
check(blocked.status === 'blocked' && blocked.steps[0]?.error?.includes('datums.versionId'), 'missing caller input blocks before dispatch', blocked.steps[0]?.error?.slice(0, 80));

const slow = async (step, _args, _signal) => {
  await new Promise((r) => setTimeout(r, 30));
  return { ok: true, value: step.id, durationMs: 30, attempt: 1 };
};
const deadline = await executeTemplate(fit, 'static', context, slow, { deadlineMs: 1 });
check(deadline.status === 'blocked', 'template deadline blocks', deadline.status);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
