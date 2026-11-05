// Actual step executor: resolve inputs, dispatch tools (serially or in declared
// parallel groups), apply transient retry, and return the on_fail route.
// Repair itself is external: the executor reports where to go; the agent/project
// changes something and calls again with the previous signatures.

import type { LoadedPearl } from './registry.ts';
import { planPearl } from './plan.ts';
import { resolveStepArgs, type StepContext, MissingStepInput } from './inputs.ts';
import { MAX_TRANSIENT_RETRIES } from './repair.ts';
import type { PearlStatus } from './ledger.ts';
import type { TemplateStep } from './types.ts';

export interface StepOutcome {
  ok: boolean;
  value?: unknown;
  error?: string;
  durationMs: number;
  attempt: number;
}

export type StepDispatcher = (step: TemplateStep, args: Record<string, unknown>, signal: AbortSignal) => Promise<StepOutcome>;

export interface StepTrace {
  id: string;
  tool: string;
  status: 'pass' | 'fail' | 'blocked';
  durationMs: number;
  attempts: number;
  error?: string;
  /** A `difficult`/attention result: not a failure, but the LLM must explain it. */
  explanationRequired?: boolean;
  attention?: string[];
}

export interface TemplateExecution {
  status: PearlStatus | 'repair-needed';
  steps: StepTrace[];
  next?: string;
  kind?: 'transient' | 'repair' | 'unrecoverable';
  error?: string;
  /** Non-blocking `difficult`/attention items that need a written explanation. */
  explanations?: string[];
  /** Outputs keyed by step id, available to later `from: step` bindings. */
  outputs: Record<string, unknown>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Tool success is not geometric success: validators return judgement in the value. */
export function semanticAttention(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const v = value as Record<string, unknown>;
  const out: string[] = [];
  if (v.judgement === 'difficult') out.push('judgement=difficult');
  if (Array.isArray(v.unevaluable) && v.unevaluable.length) out.push(`unevaluable=${v.unevaluable.length}`);
  if (Array.isArray(v.attention) && v.attention.length) out.push(`attention=${v.attention.length}`);
  return out;
}

export function semanticFailure(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  const judgement = typeof v.judgement === 'string' ? v.judgement : undefined;
  const overall = typeof v.overallStatus === 'string' ? v.overallStatus : undefined;
  const detail = semanticDetail(v);
  if (judgement === 'excluded') return `judgement=excluded${overall ? ` (${overall})` : ''}${detail ? `: ${detail}` : ''}`;
  if (overall === 'fail') return `overallStatus=fail${judgement ? ` (${judgement})` : ''}${detail ? `: ${detail}` : ''}`;
  if (v.ok === false || v.pass === false || v.passed === false) return `value says not ok${detail ? `: ${detail}` : ''}`;
  return undefined;
}

/** Pull the first witness out of a tool value so the step error is actionable. */
export function semanticDetail(v: Record<string, unknown>): string | undefined {
  const events = Array.isArray(v.interferenceEvents) ? v.interferenceEvents : [];
  if (events.length) {
    const e = events[0] as Record<string, unknown>;
    const pair = `${String(e.partA ?? '?')}↔${String(e.partB ?? '?')}`;
    const vol = typeof e.volumeMm3 === 'number' ? ` ${e.volumeMm3.toFixed(3)}mm³` : '';
    return `${pair}${vol}${typeof e.timeSec === 'number' ? ` @ t=${e.timeSec.toFixed(3)}s` : ''} (${events.length} event(s))`;
  }
  const offenders = Array.isArray(v.offenders) ? v.offenders : [];
  if (offenders.length) {
    const o = offenders[0] as Record<string, unknown>;
    return `${String(o.partA ?? '?')}↔${String(o.partB ?? '?')}${typeof o.intersectionVolume === 'number' ? ` ${o.intersectionVolume.toFixed(3)}mm³` : ''} (${offenders.length} offender(s))`;
  }
  if (Array.isArray(v.blocking) && v.blocking.length) return String(v.blocking[0]);
  if (Array.isArray(v.hardViolations) && v.hardViolations.length) {
    const h = v.hardViolations[0] as Record<string, unknown>;
    return `${String(h.code ?? h.id ?? 'hard violation')}`;
  }
  return undefined;
}

function onFailFor(template: ReturnType<LoadedPearl['templates'][number]['manifest'] extends never ? never : any>, stepId: string) {
  return template.on_fail.find((e: any) => e.when.startsWith(`${stepId}.`));
}

async function runOne(
  step: TemplateStep,
  context: StepContext,
  dispatch: StepDispatcher,
  signal: AbortSignal,
  kind: 'transient' | 'repair' | 'unrecoverable',
): Promise<StepTrace & { value?: unknown }> {
  let args: Record<string, unknown>;
  try { args = resolveStepArgs(step, context); }
  catch (e) {
    if (e instanceof MissingStepInput) return { id: step.id, tool: step.tool, status: 'blocked', durationMs: 0, attempts: 0, error: String(e) };
    throw e;
  }
  let last: StepOutcome | null = null;
  const max = kind === 'transient' ? MAX_TRANSIENT_RETRIES + 1 : 1;
  for (let attempt = 1; attempt <= max; attempt++) {
    if (signal.aborted) return { id: step.id, tool: step.tool, status: 'blocked', durationMs: 0, attempts: attempt - 1, error: 'deadline aborted' };
    last = await dispatch(step, args, signal);
    if (last.ok) {
      const semantic = semanticFailure(last.value);
      if (!semantic) {
        const attention = semanticAttention(last.value);
        return {
          id: step.id, tool: step.tool, status: 'pass', durationMs: last.durationMs, attempts: attempt, value: last.value,
          ...(attention.length ? { explanationRequired: true, attention } : {}),
        };
      }
      last = { ...last, ok: false, error: `tool returned ${semantic}` };
    }
    if (kind !== 'transient' || attempt === max) break;
    await sleep(100 * attempt);
  }
  return { id: step.id, tool: step.tool, status: 'fail', durationMs: last?.durationMs ?? 0, attempts: max, error: last?.error ?? 'step failed' };
}

function shouldRun(step: TemplateStep, context: StepContext, outputs: Record<string, unknown>): boolean {
  if (!step.when) return true;
  const m = /^([a-z0-9-]+)\.(fail|pass|blocked)$/.exec(step.when);
  if (m) {
    const prior = outputs[m[1]] as { status?: string } | undefined;
    if (m[2] === 'fail') return prior === undefined ? false : false; // a failed step already returns the branch
    if (m[2] === 'pass') return prior !== undefined;
    return false;
  }
  if (step.when === 'contract exists') {
    const assembly = (context.project as any)?.assembly;
    return !!assembly?.manifest;
  }
  return true;
}

export async function executeTemplate(
  pearl: LoadedPearl,
  templateId: string,
  context: StepContext,
  dispatch: StepDispatcher,
  options: { deadlineMs?: number } = {},
): Promise<TemplateExecution> {
  const plan = planPearl(pearl, templateId);
  if (plan.status === 'blocked') return { status: 'blocked', steps: [], outputs: {}, error: plan.issues.map((i) => i.message).join('; ') };
  const template = pearl.templates.find((t) => t.manifest.id === templateId)!.manifest;
  const deadlineMs = options.deadlineMs ?? plan.budget.maxCostSeconds * 1000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  const traces: StepTrace[] = [];
  const outputs: Record<string, unknown> = {};
  const byId = new Map(template.steps.map((s) => [s.id, s]));
  const done = new Set<string>();
  const groups = template.parallel ?? [];
  try {
    for (const step of template.steps) {
      if (done.has(step.id)) continue;
      if (!shouldRun(step, context, outputs)) { done.add(step.id); continue; }
      const group = groups.find((g) => g.includes(step.id));
      const batch = group ? group.map((id) => byId.get(id)!).filter(Boolean) : [step];
      const kinds = batch.map((s) => onFailFor(template, s.id)?.kind ?? 'repair');
      const tracesBatch = await Promise.all(batch.map((s, i) => runOne(s, { ...context, outputs }, dispatch, controller.signal, kinds[i])));
      for (const t of tracesBatch) {
        traces.push(t);
        done.add(t.id);
        if (t.status === 'pass') outputs[t.id] = t.value;
      }
      const failed = tracesBatch.find((t) => t.status !== 'pass');
      if (failed) {
        const edge = onFailFor(template, failed.id);
        return {
          status: controller.signal.aborted || failed.status === 'blocked' ? 'blocked' : 'repair-needed',
          steps: traces,
          ...(edge ? { next: edge.goto, kind: edge.kind ?? 'repair' } : {}),
          error: failed.error,
          outputs,
        };
      }
      if (controller.signal.aborted) return { status: 'blocked', steps: traces, outputs, error: `deadline ${deadlineMs}ms exceeded` };
    }
    const explanations = traces.flatMap((t) => (t.explanationRequired ? [`${t.id}: ${(t.attention ?? []).join(', ')}`] : []));
    return { status: 'pass', steps: traces, outputs, ...(explanations.length ? { explanations } : {}) };
  } finally {
    clearTimeout(timer);
  }
}
