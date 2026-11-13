// The browse categories: 零件 / 组件 / 整体及仿真 / 装配契约 (DESIGN §20).
//
// Pure, and therefore testable: the panel's three-column browser is driven by
// these lists, and getting them wrong is invisible until someone notices an
// empty viewport or a dropdown full of copies. Two rules live here:
//
//   * **de-duplicate**: `buildProducts` surfaces a multi-part run BOTH in
//     `scene` and under every part it used (that is the browse tree's design),
//     so a flat list must keep one entry per run id. Measured on microscope5:
//     213 contract rows for 22 real runs before this rule existed.
//   * **categories do not overlap**: 组件 = assembled BODIES
//     (`validate_assembly` runs, with geometry); 装配契约 = manifest CHECK
//     reports (`assembly-check`, no geometry). Mixing them made 组件 open on a
//     report-only run and render an empty "no geometry" card.
//
// Newest first, so "land on the first entry" means "land on the latest result".

import type { PartProduct, RunProduct } from '../shared/types.ts';
import { t as tr } from './i18n.ts';

/** A run plus the part it is being shown under (scene entries say so). */
export interface BrowseRun extends RunProduct {
  owner?: string;
}

export interface BrowseCategories {
  /** Every run once, newest first. */
  all: BrowseRun[];
  /** 整体及仿真: motion / physics / fluid. */
  sim: BrowseRun[];
  /** 组件: assembled bodies with geometry. */
  assembly: BrowseRun[];
  /** 装配契约: manifest check reports. */
  contract: BrowseRun[];
  /**
   * 检查: per-part evidence that is not a mechanism (`printability` / `stress` /
   * `analyze`). These runs had NO flat home before — they were reachable only
   * from a version's 验证 tab, whose click set a record id the part category
   * could not resolve.
   */
  check: BrowseRun[];
}

const newestFirst = (runs: BrowseRun[]): BrowseRun[] =>
  runs.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));

/** One entry per run id: the scene bucket wins (it carries the cross-part label). */
export function flattenRuns(parts: readonly PartProduct[], scene: readonly RunProduct[]): BrowseRun[] {
  const byId = new Map<string, BrowseRun>();
  for (const r of scene) if (!byId.has(r.id)) byId.set(r.id, { ...r, owner: tr('ui.owner.crossPart') });
  for (const p of parts) {
    for (const r of p.runs) if (!byId.has(r.id)) byId.set(r.id, { ...r, owner: p.name });
  }
  return newestFirst([...byId.values()]);
}

export function browseCategories(
  parts: readonly PartProduct[],
  scene: readonly RunProduct[],
): BrowseCategories {
  const all = flattenRuns(parts, scene);
  return {
    all,
    sim: all.filter((r) => r.kind === 'motion' || r.kind === 'physics' || r.kind === 'fluid'),
    assembly: all.filter((r) => r.kind === 'assembly'),
    contract: all.filter((r) => r.kind === 'assembly-check'),
    check: all.filter((r) => r.kind === 'printability' || r.kind === 'sheet2d' || r.kind === 'turning' || r.kind === 'machinability' || r.kind === 'edm' || r.kind === 'stress' || r.kind === 'analyze'),
  };
}
