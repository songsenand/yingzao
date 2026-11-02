// Human-facing names for runs — ONE source for the host and the panel.
//
// WHY this module exists: every run title used to be `kind · v014+v025+v026`
// (`provenanceLabel(ids)` = `ids.join('+')`). It is precise and unreadable: in
// microscope5 fifteen motion runs about the SAME mechanism (齿轮轴 + 调焦滑座 +
// 弯臂) differ only in version numbers, so the browse list cannot answer
// "which one is the focus-mechanism run?" — the question a human actually has.
//
// The version ids are not lost: they stay on `RunProduct.sourceVersionIds` (and
// in the tooltip/evidence table). What the title carries is the thing a human
// scans for: WHAT the run is about.
//
// Two rules, because one part and many parts are different questions:
//   * many parts  -> `机构运动 · 弯臂 + 调焦滑座 + 齿轮轴`   (versions are noise)
//   * one part    -> `刚体物理 · 整机 v051`                  (the revision matters)
// Kinds with no real parts (fluid's synthetic `wall`, a manifest check) return
// null so the caller keeps whatever title it committed.

import type { RunKind } from './types.ts';

/** Chinese labels for run kinds. The panel and the host author titles from this. */
export const RUN_KIND_LABEL: Record<RunKind, string> = {
  assembly: '装配间隙',
  'assembly-check': '清单检查',
  physics: '刚体物理',
  motion: '机构运动',
  fluid: '流体仿真',
  printability: '制造筛查',
  stress: '应力分析',
  analyze: '风险图',
  appearance: '外观检查',
};

/** The synthetic geometry name a fluid run stores for its pipe wall. */
const NON_PART_NAMES = new Set(['wall']);

/**
 * What a run is about, in words — or null when the run has no user-named parts.
 *
 * @param kind - run kind, for its label
 * @param parts - the geometry names stored on the run (user-chosen part names)
 * @param sourceVersionIds - the versions it cited; only used for a single part
 * @returns e.g. `机构运动 · 弯臂 + 调焦滑座 + 齿轮轴`, or null
 */
export function runSubject(
  kind: RunKind,
  parts: readonly string[],
  sourceVersionIds: readonly string[],
): string | null {
  const names = [...new Set(parts.filter((p) => typeof p === 'string' && p.trim() && !NON_PART_NAMES.has(p)))];
  if (names.length === 0) return null;
  const head = `${RUN_KIND_LABEL[kind]} · ${names.join(' + ')}`;
  // One part: which revision was posed is part of the answer.
  return names.length === 1 && sourceVersionIds.length === 1 ? `${head} ${sourceVersionIds[0]}` : head;
}
