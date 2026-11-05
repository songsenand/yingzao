// Read-only planner: compute steps, budget and coverage for a pearl template.
//
// It does NOT execute tools. Phase 3b will turn the same plan into a run; M1 only
// proves the manifests are coherent and the budget is derivable.

import type { LoadedPearl } from './registry.ts';
import type { PearlBudget, PearlPlan, PlanIssue } from './types.ts';

export function planPearl(pearl: LoadedPearl, templateId: string, budgetOverride?: PearlBudget): PearlPlan {
  const budget = budgetOverride ?? pearl.manifest.budget;
  const template = pearl.templates.find((t) => t.manifest.id === templateId)?.manifest;
  const issues: PlanIssue[] = [];
  if (!template) {
    issues.push({ code: 'template-not-found', message: `no template "${templateId}" in pearl "${pearl.manifest.id}"` });
    return {
      pearl: pearl.manifest.id,
      template: templateId,
      status: 'blocked',
      budgetUsed: { distinctTools: 0, calls: 0, probe: 0 },
      steps: [],
      distinctTools: 0,
      calls: 0,
      budget,
      issues,
    };
  }

  const parallel = new Map<string, string[]>();
  for (const group of template.parallel ?? []) {
    for (const id of group) parallel.set(id, group.filter((x) => x !== id));
  }
  const steps = template.steps.map((s) => ({
    id: s.id,
    tool: s.tool,
    ...(s.when ? { when: s.when } : {}),
    ...(s.args ? { args: s.args } : {}),
    ...(s.bind ? { bind: s.bind } : {}),
    parallelWith: parallel.get(s.id) ?? [],
  }));
  const distinctTools = new Set(steps.map((s) => s.tool)).size;
  const calls = steps.length;

  if (distinctTools > budget.maxDistinctTools) {
    issues.push({
      code: 'budget-tools',
      message: `template uses ${distinctTools} distinct tools, soft budget is ${budget.maxDistinctTools}`,
    });
  }
  if (calls > budget.maxCalls) {
    issues.push({
      code: 'budget-calls',
      message: `template has ${calls} calls, soft budget is ${budget.maxCalls}`,
    });
  }
  if (!template.steps.some((s) => template.on_fail.some((e) => e.when.startsWith(`${s.id}.`)))) {
    issues.push({ code: 'no-failure-edge', message: 'on_fail does not reference any step id' });
  }
  if (pearl.manifest.probe.required && pearl.manifest.probe.allowed.length === 0) {
    issues.push({ code: 'no-probe', message: 'probe is required but probe.allowed is empty' });
  }

  return {
    pearl: pearl.manifest.id,
    template: template.id,
    status: issues.length ? 'blocked' : 'planned',
    budgetUsed: { distinctTools, calls, probe: 0 },
    steps,
    distinctTools,
    calls,
    budget,
    issues,
  };
}

export function describePearl(pearl: LoadedPearl): Record<string, unknown> {
  return {
    id: pearl.manifest.id,
    version: pearl.manifest.version,
    guide: pearl.manifest.guide ?? null,
    undeclaredPolicy: pearl.manifest.undeclaredPolicy ?? 'warn',
    question: pearl.manifest.question,
    exit: pearl.manifest.exit,
    not: pearl.manifest.not,
    budget: pearl.manifest.budget,
    probe: pearl.manifest.probe,
    templates: pearl.templates.map((t) => ({
      id: t.manifest.id,
      version: t.manifest.version,
      when: t.manifest.when,
      steps: t.manifest.steps.map((s) => s.tool),
      on_fail: t.manifest.on_fail,
    })),
  };
}
