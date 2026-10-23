// "Which version of this part is current?" — ONE answer for the whole harness.
//
// WHY this module exists: the question "is this run's evidence stale?" (DESIGN §22) was
// answered by FOUR hand-written loops that disagreed, and the disagreement was not
// cosmetic. A version with no `partId` (everything written before parts existed) was:
//
//   * folded into the synthetic part `p000` by `products.ts`  -> two legacy versions
//     made each other "stale";
//   * skipped entirely by `delivery-audit.ts` and by both call sites in
//     `assembly-check.ts` -> the same evidence was stale for the panel and fresh for
//     the contract check.
//
// The rule this module encodes: **a version with no part is not compared.** Its part is
// unknown, so "superseded" is not a thing that can be true of it — and guessing marks
// good evidence stale, which is worse than saying nothing. Legacy versions still appear
// in the browse tree (that is a display question), but they never make a run stale.
//
// (2026-10-23 audit, FIX-C2.)

import type { VersionManifestEntry } from './version.ts';

/** Newest version id per part, from the index. Versions without a partId are excluded. */
export function newestVersionPerPart(versions: readonly VersionManifestEntry[]): Map<string, string> {
  const newest = new Map<string, string>();
  const ts = new Map(versions.map((v) => [v.id, v.timestamp]));
  for (const v of versions) {
    if (!v.partId) continue;
    const cur = newest.get(v.partId);
    if (!cur || (ts.get(cur) ?? '') < v.timestamp) newest.set(v.partId, v.id);
  }
  return newest;
}

/**
 * The ids among `ids` that a part has since replaced.
 *
 * `null`/unknown ids are NOT judged (a citation we cannot resolve is not a staleness
 * finding), and neither are versions without a partId (see the header).
 */
export function supersededVersionIds(
  versions: readonly VersionManifestEntry[],
  ids: readonly string[],
): string[] {
  const byId = new Map(versions.map((v) => [v.id, v]));
  const newest = newestVersionPerPart(versions);
  return ids.filter((id) => {
    const v = byId.get(id);
    if (!v?.partId) return false;
    return newest.get(v.partId) !== id;
  });
}

/**
 * The version ids a merged body was built from (`merge_parts`), ignoring null inputs
 * (inline SCAD contributed no version). Used to decide whether the merged geometry is
 * still current: a derived artifact expires with its inputs.
 */
export function mergedInputVersionIds(v: VersionManifestEntry): string[] {
  if (v.source?.kind !== 'merged') return [];
  return v.source.from.map((f) => f.versionId).filter((id): id is string => typeof id === 'string');
}
