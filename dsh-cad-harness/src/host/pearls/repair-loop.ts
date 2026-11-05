// Repair orchestration, not geometry repair: run a template, ask the caller's
// repair function to change something, re-run, and stop on no-progress/exhaustion.
// The caller supplies `repair`; the executor never invents a geometric fix.

import { executeTemplate, type StepDispatcher, type TemplateExecution } from './execute-template.ts';
import { decideRepair, MAX_REPAIR_ROUNDS } from './repair.ts';
import { appendRepairHistory, type RepairHistoryRound } from './repair-history.ts';
import type { LoadedPearl } from './registry.ts';
import type { StepContext } from './inputs.ts';
import type { PearlFailure } from './failure.ts';

export interface RepairInput {
  round: number;
  route: string;
  failures: PearlFailure[];
  signatures: string[];
}

export type RepairFn = (input: RepairInput) => Promise<boolean>;

export interface RepairLoopResult {
  status: 'pass' | 'repair-needed' | 'blocked';
  rounds: number;
  history: RepairHistoryRound[];
  last: TemplateExecution;
  stoppedBy: 'pass' | 'no-progress' | 'exhausted' | 'deadline' | 'repair-declined';
}

function failuresOf(exec: TemplateExecution): PearlFailure[] {
  return exec.steps.filter((s) => s.status !== 'pass').map((s) => ({
    code: `template.${s.id}`,
    severity: 'hard',
    what: s.error ?? `${s.tool} failed`,
    why: ['template step failed', `tool ${s.tool}`],
    location: { kind: 'unknown', note: `step ${s.id}`, approximate: true },
    evidence: { step: s.id, tool: s.tool, durationMs: s.durationMs },
    next: ['inspect the step error', 'change the project or inputs', 're-run the template'],
  }));
}

export async function runTemplateRepairLoop(
  pearl: LoadedPearl,
  templateId: string,
  contextFactory: () => Promise<StepContext>,
  dispatch: StepDispatcher,
  repair: RepairFn,
  options: { deadlineMs?: number; projectRoot: string },
): Promise<RepairLoopResult> {
  const deadlineAt = Date.now() + (options.deadlineMs ?? 900_000);
  const history: RepairHistoryRound[] = [];
  const previous: string[] = [];
  let round = 0;
  let last: TemplateExecution | null = null;
  while (round <= MAX_REPAIR_ROUNDS) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      const stopped: RepairHistoryRound = { round, at: new Date().toISOString(), action: 'exhausted', signatures: previous, repeated: [], reason: 'overall repair deadline exceeded' };
      history.push(stopped); await appendRepairHistory(options.projectRoot, stopped);
      return { status: 'blocked', rounds: round, history, last: last ?? { status: 'blocked', steps: [], outputs: {}, error: 'deadline' }, stoppedBy: 'deadline' };
    }
    last = await executeTemplate(pearl, templateId, await contextFactory(), dispatch, { deadlineMs: remaining });
    if (last.status === 'pass') {
      return { status: 'pass', rounds: round, history, last, stoppedBy: 'pass' };
    }
    const decision = decideRepair(round, failuresOf(last), previous, {}, MAX_REPAIR_ROUNDS);
    const entry: RepairHistoryRound = {
      round, at: new Date().toISOString(), action: decision.action,
      signatures: decision.signatures, repeated: decision.repeated,
      ...(last.next ? { next: last.next } : {}), reason: decision.reason,
    };
    history.push(entry);
    await appendRepairHistory(options.projectRoot, entry);
    if (decision.action !== 'continue') {
      return { status: 'blocked', rounds: round, history, last, stoppedBy: decision.action };
    }
    const changed = await repair({ round, route: last.next ?? '', failures: failuresOf(last), signatures: decision.signatures });
    if (!changed) return { status: 'repair-needed', rounds: round, history, last, stoppedBy: 'repair-declined' };
    previous.push(...decision.signatures);
    round++;
  }
  return { status: 'blocked', rounds: round, history, last: last!, stoppedBy: 'exhausted' };
}
