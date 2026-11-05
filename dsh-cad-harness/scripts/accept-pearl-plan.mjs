// Acceptance for the read-only planner: every template plans cleanly within budget,
// a too-small budget is visible, and a missing template is not a pass.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPearlSet } from '../src/host/pearls/registry.ts';
import { planPearl } from '../src/host/pearls/plan.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (ok, label, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };

const pearls = await loadPearlSet(join(ROOT, 'pearls'));
for (const pearl of pearls) {
  for (const t of pearl.templates) {
    const plan = planPearl(pearl, t.manifest.id);
    check(plan.issues.length === 0, `${pearl.manifest.id}/${t.manifest.id}: plan has no issues`, plan.issues.map((i) => i.code).join(','));
    check(plan.status === 'planned', `${pearl.manifest.id}/${t.manifest.id}: status is planned`, plan.status);
    check(plan.budgetUsed.probe === 0, `${pearl.manifest.id}/${t.manifest.id}: probe slot unused at plan time`);
    check(plan.distinctTools <= pearl.manifest.budget.maxDistinctTools, `${pearl.manifest.id}/${t.manifest.id}: distinct tools within budget`, `${plan.distinctTools}/${pearl.manifest.budget.maxDistinctTools}`);
    check(plan.calls <= pearl.manifest.budget.maxCalls, `${pearl.manifest.id}/${t.manifest.id}: calls within budget`, `${plan.calls}/${pearl.manifest.budget.maxCalls}`);
    for (const step of plan.steps) {
      if (step.parallelWith.length) {
        check(step.parallelWith.includes(step.id) === false, `${pearl.manifest.id}/${t.manifest.id}: ${step.id} not parallel with itself`);
      }
    }
  }
}

const tight = {
  ...pearls.find((p) => p.manifest.id === 'fit'),
  manifest: {
    ...pearls.find((p) => p.manifest.id === 'fit').manifest,
    budget: { maxDistinctTools: 1, maxCalls: 30, maxCostSeconds: 600, maxProbe: 1 },
  },
};
const tightPlan = planPearl(tight, 'static');
check(tightPlan.issues.some((i) => i.code === 'budget-tools'), 'a too-tight soft budget is reported', tightPlan.issues.map((i) => i.code).join(','));
check(tightPlan.status === 'blocked', 'plan overrun blocks at plan time', tightPlan.status);

const missing = planPearl(pearls[0], 'does-not-exist');
check(missing.issues.some((i) => i.code === 'template-not-found'), 'a missing template is blocked, not passed');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
