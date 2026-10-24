// The browse tree the panel consumes: 零件 → 记录(版本 | 运行).
//
// Kept as a pure function so the host route and the UI sandbox build the exact
// same payload from the same stores — the sandbox must not be able to drift from
// what the host actually serves.
//
// TWO SHAPES, on purpose:
//   * `buildProductsWire` — what goes over the network. Every run appears ONCE
//     (`runs`) and each part carries `runIds`, so a multi-part run is not copied
//     into every part it used. Measured on microscope5: 69 stored runs were
//     serialised 438 times (211 KB); with the wire they are serialised once.
//   * `buildProducts` — the inflated tree (`part.runs` full objects), which the
//     tools, the panel's existing reads and every accept script already speak.
//     It is `inflateProducts(buildProductsWire(...))`, so the grouping rule still
//     lives in exactly one place.

import type { PartProduct, ProductsResponse, RunProduct, VersionProduct } from '../shared/types.ts';
import type { PartEntry } from './parts.ts';
import type { RunEntry } from './runs.ts';
import type { VersionManifestEntry } from './version.ts';
import { basename } from 'node:path';
import { mergedInputVersionIds, supersededIn, versionCurrency } from './latest.ts';
import { runSubject } from '../shared/labels.ts';
import { inflateProducts, type PartWire, type ProductsWire } from '../shared/products-wire.ts';

/** Versions without a part id are surfaced here rather than dropped. */
export const UNFILED_PART_ID = 'p000';

const newestFirst = <T extends { timestamp: string }>(list: T[]): T[] =>
  list.slice().sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));

/** The compact tree: every run once, each part carrying the ids it owns. */
export function buildProductsWire(
  versions: VersionManifestEntry[],
  parts: PartEntry[],
  runs: RunEntry[],
): ProductsWire {
  // Build the currency tables ONCE: the question "is this version still current?"
  // is asked for every run and every merged version. Per-call maps made this
  // O(runs × versions) — 2.9 s for a 5 000-run corpus on a 3 s poll.
  const currency = versionCurrency(versions);
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
      source: imported ? 'imported' : v.source?.kind === 'merged' ? 'merged' : 'generated',
      ...(imported ? { origin: basename(imported.file) } : {}),
      // A merged body is derived: it expires when the versions it was made of do.
      ...(v.source?.kind === 'merged'
        ? { staleMergedInputs: supersededIn(currency, mergedInputVersionIds(v)) }
        : {}),
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

  // Newest version per part — ONE rule for the whole harness (src/host/latest.ts).
  // It deliberately does NOT fold versions without a partId into a synthetic part: that
  // made two legacy versions supersede each other (2026-10-23 audit, FIX-C2).
  /** Versions a run cites that a part has since replaced (DESIGN §22). */
  const staleSourceVersions = (r: RunEntry): string[] => supersededIn(currency, r.sourceVersionIds);

  const runIdsOfPart = new Map<string, string[]>();
  const sceneRunIds: string[] = [];
  const runProducts: RunProduct[] = [];
  for (const r of runs) {
    const owners = ownersOfRun(r);
    const stale = staleSourceVersions(r);
    // Title as a human reads it: the parts it is about, not the version ids it
    // cited. Only fills `displayTitle`; the committed `title` is never rewritten.
    const subject = runSubject(r.kind, r.parts, r.sourceVersionIds);
    runProducts.push({
      type: 'run', ...r,
      ...(subject ? { displayTitle: subject } : {}),
      ...(stale.length ? { staleVersionIds: stale } : {}),
    });
    if (owners.length !== 1) {
      // Zero owners (inline SCAD) or a multi-part scene: it belongs to no single
      // part, so it gets the cross-part bucket — and also shows under each part
      // it actually used (by id; the run itself is serialised once).
      sceneRunIds.push(r.id);
      for (const pid of owners) {
        const list = runIdsOfPart.get(pid) ?? [];
        list.push(r.id);
        runIdsOfPart.set(pid, list);
      }
      continue;
    }
    const pid = owners[0]!;
    const list = runIdsOfPart.get(pid) ?? [];
    list.push(r.id);
    runIdsOfPart.set(pid, list);
  }

  const newestIdOrder = (ids: string[]): string[] => {
    const at = new Map(runProducts.map((r) => [r.id, r.timestamp]));
    return ids.slice().sort((a, b) => ((at.get(a) ?? '') < (at.get(b) ?? '') ? 1 : -1));
  };

  const entries: PartWire[] = parts.map((p) => ({
    id: p.id,
    name: p.name,
    nameSource: p.nameSource,
    lastActiveAt: p.lastActiveAt,
    versions: newestFirst(versionsOfPart.get(p.id) ?? []),
    runIds: newestIdOrder(runIdsOfPart.get(p.id) ?? []),
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
      runIds: newestIdOrder(runIdsOfPart.get(pid) ?? []),
    });
  }

  entries.sort((a, b) => (a.lastActiveAt < b.lastActiveAt ? 1 : a.lastActiveAt > b.lastActiveAt ? -1 : 0));
  return { parts: entries, runs: newestFirst(runProducts), sceneRunIds: newestIdOrder(sceneRunIds) };
}

/** The inflated tree (`part.runs` are full objects) — the shape older callers read. */
export function buildProducts(
  versions: VersionManifestEntry[],
  parts: PartEntry[],
  runs: RunEntry[],
): ProductsResponse {
  return inflateProducts(buildProductsWire(versions, parts, runs));
}
