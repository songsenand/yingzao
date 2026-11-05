// Executable step inputs: resolve literal args plus bindings from project/input/
// previous step/contract/failure. Missing inputs are errors, never guesses.

import type { StepBinding, TemplateStep } from './types.ts';

export interface StepContext {
  project?: Record<string, unknown>;
  input?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  contract?: Record<string, unknown>;
  failure?: Record<string, unknown>;
}

export class MissingStepInput extends Error {
  readonly stepId: string;
  readonly field: string;
  readonly source: string;
  readonly path: string;
  constructor(stepId: string, field: string, source: string, path: string) {
    super(`${stepId}.${field}: no value at ${source}:${path}`);
    this.name = 'MissingStepInput';
    this.stepId = stepId;
    this.field = field;
    this.source = source;
    this.path = path;
  }
}

function getPath(value: unknown, path: string): unknown {
  let cur = value;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function sourceOf(ctx: StepContext, b: StepBinding): unknown {
  switch (b.from) {
    case 'project': return ctx.project;
    case 'input': return ctx.input;
    case 'step': return ctx.outputs;
    case 'contract': return ctx.contract;
    case 'failure': return ctx.failure;
  }
}

export function resolveStepArgs(step: TemplateStep, ctx: StepContext): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(step.args ?? {}) };
  for (const [field, binding] of Object.entries(step.bind ?? {})) {
    const value = getPath(sourceOf(ctx, binding), binding.path);
    if (value === undefined) {
      if (binding.optional) continue;
      throw new MissingStepInput(step.id, field, binding.from, binding.path);
    }
    out[field] = value;
  }
  return out;
}

/** True when every binding can resolve; useful for a pre-execution plan. */
export function checkStepInputs(step: TemplateStep, ctx: StepContext): string[] {
  const missing: string[] = [];
  for (const [field, binding] of Object.entries(step.bind ?? {})) {
    if (!binding.optional && getPath(sourceOf(ctx, binding), binding.path) === undefined) missing.push(`${field} (${binding.from}:${binding.path})`);
  }
  return missing;
}
