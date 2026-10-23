// The ONE vocabulary for a delivery judgement (DESIGN §25.7, user-ratified 2026-10-19).
//
// WHY: the corpus had three dialects for the same three states —
//   delivery_audit      blocked / attention / ok
//   check_printability  unprintable / check / ok   (RENAMED to the canonical three, 2026-10-20)
//   check_assembly      fail / check / ok
//   simulate_stress     excluded / difficult / not-excluded  (the canonical one)
// Management cannot answer "is anything excluded?" across tools that spell it differently,
// and "ok" is the worst of the four: it reads as "safe", which no tool here may claim.
//
// The canonical three are NOT symmetric and must not be collapsed (DECISION-LOG 2026-10-11):
//   excluded     a witness contradicts the requirement
//   difficult    the margin is inside the instrument's noise — never a pass
//   not-excluded no counter-example was found — NEVER "ok", NEVER "safe"
//
// `verdict` stays on the tools as a DISPLAY string (the panel and the skills read it);
// `judgement` is the field management and the delivery audit must read.

export type Judgement = 'excluded' | 'difficult' | 'not-excluded';

/** Legacy display values, mapped to the canonical judgement. Kept in one place so a rename
 *  is a one-line change and cannot drift per tool. */
export function asJudgement(legacy: string | undefined | null): Judgement {
  switch (legacy) {
    case 'excluded':
    case 'blocked':
    case 'fail':
    case 'unprintable':
    case 'overstressed':
    case 'hard-violation':
      return 'excluded';
    case 'difficult':
    case 'attention':
    case 'check':
    // Assembly-interface words (2026-10-23): a skipped interface is "nobody evaluated
    // it" and an intent-flag is a soft signal — both are difficult, and NEITHER is a
    // pass. The mapping used to be hand-written at one call site because this function
    // did not know the words, which is how a "single source" grows a second copy.
    case 'skipped':
    case 'intent-flag':
      return 'difficult';
    case 'not-excluded':
    case 'pass':
    case 'ok':
      return 'not-excluded';
    default:
      // An unknown word is NOT a pass: silence about a judgement is the failure mode this
      // whole file exists to prevent.
      return 'difficult';
  }
}

/** Human one-liner for a judgement — the same words everywhere. */
export function judgementLine(j: Judgement): string {
  return j === 'excluded'
    ? 'excluded — a witness contradicts the requirement'
    : j === 'difficult'
      ? 'difficult — the margin is inside the instrument noise, NOT a pass'
      : 'not-excluded — no counter-example was found; this is NOT "ok" and NOT "safe"';
}
