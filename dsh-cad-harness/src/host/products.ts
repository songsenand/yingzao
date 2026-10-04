// The browse tree the panel consumes: 零件 → 记录(版本 | 运行).
//
// Kept as a pure function so the host route and the UI sandbox build the exact
// same payload from the same stores — the sandbox must not be able to drift from
// what the host actually serves.

import type { PartProduct, ProductsResponse, RunProduct, VersionProduct } from '../shared/types.ts';
import type { PartEntry } from './parts.ts';
import type { RunEntry } from './runs.ts';
import type { VersionManifestEntry } from './version.ts';
import { basename } from 'node:path';

/** Versions without a part id are surfaced here rather than dropped. */
export const UNFILED_PART_ID = 'p000';

const newestFirst = <T extends { timestamp: string }>(list: T[]): T[] =>
  list.slice().sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));

export function buildProducts(
  versions: VersionManifestEntry[],
  parts: PartEntry[],
  runs: RunEntry[],
): ProductsResponse {
  const versionProducts: VersionProduct[] = versions.map((v) => {
    const imported = v.source?.kind === 'imported' ? v.source : null;
    return {
      type: 'version',
      id: v.id,
      timestamp: v.timestamp,
      status: v.status,
      title: v.userIntent,
      parentVersion: v.parentVersion ?? null,
      partId: v.partId ?? UNFILED_PART_ID,
      source: imported ? 'imported' : 'generated',
      ...(imported ? { origin: basename(imported.file) } : {}),
      solid: v.solid !== false,
    };
  });
  const versionById = new Map(versionProducts.map((v) => [v.id, v]));
  const partIdOfVersion = (id: string): string => versionById.get(id)?.partId ?? UNFILED_PART_ID;

  const versionsOfPart = new Map<string, VersionProduct[]>();
  for (const v of versionProducts) {
    const list = versionsOfPart.get(v.partId) ?? [];
    list.push(v);
    versionsOfPart.set(v.partId, list);
  }

  /** The parts a run's geometry came from (empty = an inline-SCAD scene). */
  const ownersOfRun = (r: RunEntry): string[] =>
    [...new Set(r.sourceVersionIds.map(partIdOfVersion))];

  // Newest version per part — the yardstick for "is this run's evidence stale".
  const newestOfPart = new Map<string, string>();
  for (const [pid, list] of versionsOfPart) {
    const newest = newestFirst(list)[0];
    if (newest) newestOfPart.set(pid, newest.id);
  }
  /** Versions a run cites that a part has since replaced (DESGIGN §22). */
  const staleSourceVersions = (r: RunEntry): string[] =>
    r.sourceVersionIds.filter((id) => {
      const version = versionById.get(id);
      if (!version) return false; // unknown id: not our call to judge
      return newestOfPart.get(version.partId) !== id;
    });

  const runsOfPart = new Map<string, RunProduct[]>();
  const sceneRuns: RunProduct[] = [];
  for (const r of runs) {
    const owners = ownersOfRun(r);
    const stale = staleSourceVersions(r);
    const product: RunProduct = {
      type: 'run', ...r,
      ...(stale.length ? { staleVersionIds: stale } : {}),
    };
    if (owners.length !== 1) {
      // Zero owners (inline SCAD) or a multi-part scene: it belongs to no single
      // part, so it gets the cross-part bucket — and also shows under each part
      // it actually used.
      sceneRuns.push(product);
      if (owners.length > 1) {
        for (const pid of owners) {
          const list = runsOfPart.get(pid) ?? [];
          list.push(product);
          runsOfPart.set(pid, list);
        }
      }
      continue;
    }
    const pid = owners[0]!;
    const list = runsOfPart.get(pid) ?? [];
    list.push(product);
    runsOfPart.set(pid, list);
  }

  const entries: PartProduct[] = parts.map((p) => ({
    id: p.id,
    name: p.name,
    nameSource: p.nameSource,
    lastActiveAt: p.lastActiveAt,
    versions: newestFirst(versionsOfPart.get(p.id) ?? []),
    runs: newestFirst(runsOfPart.get(p.id) ?? []),
  }));

  // Versions whose partId has no part entry (legacy corpus, older callers).
  const known = new Set(parts.map((p) => p.id));
  for (const [pid, list] of versionsOfPart) {
    if (known.has(pid)) continue;
    entries.push({
      id: pid,
      name: pid === UNFILED_PART_ID ? '未归类' : pid,
      nameSource: 'intent',
      lastActiveAt: newestFirst(list)[0]?.timestamp ?? '',
      versions: newestFirst(list),
      runs: newestFirst(runsOfPart.get(pid) ?? []),
    });
  }

  entries.sort((a, b) => (a.lastActiveAt < b.lastActiveAt ? 1 : a.lastActiveAt > b.lastActiveAt ? -1 : 0));
  return { parts: entries, scene: newestFirst(sceneRuns) };
}
