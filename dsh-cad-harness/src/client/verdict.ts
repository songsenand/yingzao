// What a run JUDGED — the one place the panel is allowed to decide that.
//
// WHY this is a module and not three lines inside panel.ts: it is the rule that decides
// whether a revision reads as 否决 / 困难 / 不排除可行 / 未验证, and it had a bug worth a
// test (2026-10-23 audit, FIX-B5): the band derived its word from `status`, so a risk map
// that found nothing (`status: 'pass'`) rendered as 通过 for the revision it merely
// looked at. `status` is the tool's own outcome word; only `judgement` is a delivery
// statement (DESIGN §25.7).
//
// Legacy corpora predate the `judgement` field. Their runs still carry `status`, and the
// conservative reading is kept: a `fail` was somebody's witness and must still veto; a
// `check` is unevaluable; a bare `pass` contributes NOTHING — "the tool ran" is not
// "nothing was found wrong with the design".

import type { RunJudgement, RunProduct } from '../shared/types';

/** The judgement one run carries, or the conservative reading of a legacy status. */
export function judgementOf(run: RunProduct): RunJudgement | null {
  if (run.judgement) return run.judgement;
  if (run.status === 'fail') return 'excluded';
  if (run.status === 'check') return 'difficult';
  return null;
}

/**
 * The worst judgement among the runs that named a revision.
 *
 * `null` means **no run judged anything** — the honest answer is 未验证, not 通过.
 */
export function versionVerdict(runs: readonly RunProduct[]): RunJudgement | null {
  const judged = runs.map(judgementOf).filter((j): j is RunJudgement => j !== null);
  if (judged.length === 0) return null;
  if (judged.includes('excluded')) return 'excluded';
  if (judged.includes('difficult')) return 'difficult';
  return 'not-excluded';
}
