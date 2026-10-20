// `preflight`: the mandatory delivery sequence as ONE call (DESIGN §25.7).
//
// WHY: the failure this exists to kill is "the tool that must run before delivery was
// forgotten". A gate nobody calls is not a gate, so the fixed sequence has to be one
// entry point — not six names the model has to remember.
//
// WHAT IT MAY NOT DO: invent coverage. Steps it does not (yet) orchestrate are reported
// as `ran: false` + why, so "not run" is visible instead of reading as green. That is the
// same discipline as `unevaluable` in the stress tool: a missing number is not a pass.

import type { Judgement } from '../shared/judgement.ts';

export interface PreflightStep {
  /** Stable id: printability | assembly | mesh-health | simulation-evidence | render | audit */
  step: string;
  ran: boolean;
  judgement: Judgement;
  /** One line a reader can act on (what was measured, or why it did not run). */
  detail: string;
}

/** excluded beats difficult beats not-excluded. Never the other way round. */
export function worstOf(judgements: readonly Judgement[]): Judgement {
  if (judgements.includes('excluded')) return 'excluded';
  if (judgements.includes('difficult')) return 'difficult';
  return 'not-excluded';
}

/**
 * The report's spine. `judgement` is the WORST of the steps that actually ran; a step
 * that did not run can therefore never be averaged away into a pass.
 */
export function preflightSummary(steps: readonly PreflightStep[]): {
  judgement: Judgement;
  ran: string[];
  notRun: { step: string; why: string }[];
  unevaluable: string[];
} {
  const ran = steps.filter((s) => s.ran).map((s) => s.step);
  const notRun = steps.filter((s) => !s.ran).map((s) => ({ step: s.step, why: s.detail }));
  return {
    judgement: worstOf(steps.map((s) => s.judgement)),
    ran,
    notRun,
    unevaluable: notRun.map((s) => `${s.step}: ${s.why}`),
  };
}
