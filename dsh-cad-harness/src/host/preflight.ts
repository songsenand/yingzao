// `preflight`: the mandatory delivery sequence as ONE call (DESIGN §25.7).
//
// WHY: the failure this exists to kill is "the tool that must run before delivery was
// forgotten". A gate nobody calls is not a gate, so the fixed sequence has to be one
// entry point — not six names the model has to remember.
//
// WHAT IT MAY NOT DO: invent coverage. There are two DIFFERENT kinds of "did not run", and
// collapsing them is what made the judgement uninformative (2026-10-23 audit, FIX-B8):
//
//   * ATTEMPTED AND FAILED (a deadline, a missing input): it belongs in `steps` with
//     `ran: false` and it makes the judgement `difficult`. It must never be averaged away.
//   * NOT ORCHESTRATED AT ALL (simulation evidence, the assembly render): this cut simply
//     does not run it. It belongs in `coverage.notCovered`, and it does NOT enter the
//     judgement — because a permanent "difficult" is not a signal, it is a constant. The
//     reader still sees it, named, in every reply; the machine reading `judgement` gets an
//     answer that can differ between "everything that runs came back clean" and "nothing
//     ran at all".
//
// That keeps both original properties: a failed step can never read as a pass, and a
// judgement of `not-excluded` can actually be reached (otherwise the vocabulary dies the
// death DESIGN §25.7 warns about: "每个真实语料都变 difficult，信号就死了").

import type { Judgement } from '../shared/judgement.ts';

export interface PreflightStep {
  /** Stable id: printability:<part> | assembly | mesh-health:<part> | support:<part> | audit */
  step: string;
  /** False = it was attempted and failed; this forces `difficult`. */
  ran: boolean;
  judgement: Judgement;
  /** One line a reader can act on (what was measured, or why it did not run). */
  detail: string;
}

/** A step this cut does not orchestrate at all — named, never silently green. */
export interface PreflightGap {
  step: string;
  why: string;
}

/** excluded beats difficult beats not-excluded. Never the other way round. */
export function worstOf(judgements: readonly Judgement[]): Judgement {
  if (judgements.includes('excluded')) return 'excluded';
  if (judgements.includes('difficult')) return 'difficult';
  return 'not-excluded';
}

/**
 * The report's spine.
 *
 * `judgement` is the worst of the steps that RAN; a step that was attempted and failed
 * forces `difficult`; a run where nothing ran at all is `difficult` (an empty report is not
 * a pass). Steps that this cut does not orchestrate are reported in `coverage.notCovered`
 * and are kept out of the judgement — see the header for why.
 */
export function preflightSummary(
  steps: readonly PreflightStep[],
  notCovered: readonly PreflightGap[] = [],
): {
  judgement: Judgement;
  ran: string[];
  notRun: { step: string; why: string }[];
  unevaluable: string[];
  coverage: { ran: string[]; notRun: string[]; notCovered: PreflightGap[] };
} {
  const ran = steps.filter((s) => s.ran).map((s) => s.step);
  const notRun = steps.filter((s) => !s.ran).map((s) => ({ step: s.step, why: s.detail }));
  const failed = notRun.length > 0;
  const judgement: Judgement = failed
    ? 'difficult'
    : steps.length === 0
      ? 'difficult'              // nothing was checked; that is not a clean report
      : worstOf(steps.map((s) => s.judgement));
  return {
    judgement,
    ran,
    notRun,
    unevaluable: notRun.map((s) => `${s.step}: ${s.why}`),
    coverage: {
      ran,
      notRun: notRun.map((s) => s.step),
      notCovered: [...notCovered],
    },
  };
}
