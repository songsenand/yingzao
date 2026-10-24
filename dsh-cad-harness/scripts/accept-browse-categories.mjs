// Acceptance for the browse categories (DESIGN §20.4).
//
// Two user-visible bugs lived in the category lists, both invisible until the
// panel looked empty or doubled:
//
//   1. duplication — a multi-part run appears in `scene` AND under every part
//      that used it, so a flat list without de-duplication shows copies
//      (microscope5: 213 contract rows for 22 real runs);
//   2. category bleed — 组件 ∪ 装配契约 made 组件 open on a report-only run and
//      render it as an empty "no geometry" card.
//
// The logic now lives in src/client/browse.ts, so it is checked here with real
// corpus SHAPES (a multi-part run under three owners, like microscope5's r063).
//
//   node scripts/accept-browse-categories.mjs

import { browseCategories, flattenRuns } from '../src/client/browse.ts';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const run = (id, kind, timestamp, extra = {}) => ({
  type: 'run', id, kind, timestamp,
  title: id, status: 'pass', summary: '',
  sourceVersionIds: [], hasGeometry: kind !== 'assembly-check',
  parts: kind === 'assembly' ? ['a', 'b'] : [], ...extra,
});
const part = (id, name, runs) => ({ id, name, nameSource: 'agent', lastActiveAt: '2026-10-04T00:00:00.000Z', versions: [], runs });

// A multi-part assembly appearing in the scene bucket AND under two parts,
// plus the other kinds — the microscope5 shape.
const shared = run('r063', 'assembly', '2026-10-04T03:00:00.000Z');
const parts = [
  part('p1', '齿轮轴', [
    shared,                                                    // owned by p1, p2 AND the scene
    run('sim-2', 'motion', '2026-10-04T04:00:00.000Z'),        // single-owner motion
    run('v-y', 'physics', '2026-10-04T01:00:00.000Z'),         // single-owner physics
    run('chk-2', 'printability', '2026-10-04T00:30:00.000Z'),  // per-part evidence (检查)
    run('an-1', 'analyze', '2026-10-04T00:20:00.000Z'),        // a risk map of one part
  ]),
  part('p2', '轴承座', [shared]),
];
const scene = [
  shared,                                                      // multi-part → also in the scene
  run('chk-1', 'assembly-check', '2026-10-04T02:00:00.000Z'),  // contract report (no geometry)
  run('sim-1', 'fluid', '2026-10-04T00:00:00.000Z'),           // inline-scene fluid
];

// ── 1. de-duplication ────────────────────────────────────────────────────────
const flat = flattenRuns(parts, scene);
check(flat.length === new Set(flat.map((r) => r.id)).size,
  'the flat pool contains every run AT MOST once',
  `${flat.length} entries for ${new Set(flat.map((r) => r.id)).size} ids`);
check(flat.filter((r) => r.id === 'r063').length === 1,
  'a run cited by three owners appears exactly once',
  `${flat.filter((r) => r.id === 'r063').length} copies`);
check(flat[0].id === 'sim-2',
  'newest first, so "land on the first entry" means "land on the latest"', flat[0].id);
check(flat.find((r) => r.id === 'r063')?.owner === '跨零件场景',
  'a scene run keeps its cross-part label', String(flat.find((r) => r.id === 'r063')?.owner));

// ── 2. category boundaries ───────────────────────────────────────────────────
const cats = browseCategories(parts, scene);
check(cats.sim.map((r) => r.id).sort().join(',') === 'sim-1,sim-2,v-y',
  '仿真 holds motion / physics / fluid only', cats.sim.map((r) => r.id).join(','));
check(cats.assembly.map((r) => r.id).join(',') === 'r063',
  '组件 holds assembled BODIES only (no check reports)', cats.assembly.map((r) => r.id).join(','));
check(cats.contract.map((r) => r.id).join(',') === 'chk-1',
  '装配契约 holds manifest CHECK reports only', cats.contract.map((r) => r.id).join(','));
check(cats.assembly.every((r) => r.hasGeometry),
  'every 组件 entry carries geometry (its viewport can actually draw)', 'ok');
check(cats.check.map((r) => r.id).sort().join(',') === 'an-1,chk-2',
  '检查 holds per-part evidence (printability / stress / analyze) — it had NO home before',
  cats.check.map((r) => r.id).join(','));
check(cats.check.every((r) => r.kind === 'printability' || r.kind === 'stress' || r.kind === 'analyze'),
  '检查 never swallows a mechanism or a contract report', 'ok');
check(cats.sim.length + cats.assembly.length + cats.contract.length + cats.check.length === cats.all.length,
  'the four categories partition the pool (no run is hidden or doubled)',
  `${cats.sim.length}+${cats.assembly.length}+${cats.contract.length}+${cats.check.length} vs ${cats.all.length}`);

// ── 3. empty corpora stay empty (no crash, no phantom entry) ─────────────────
{
  const empty = browseCategories([], []);
  check(empty.all.length === 0 && empty.sim.length === 0 && empty.assembly.length === 0
    && empty.contract.length === 0 && empty.check.length === 0,
    'an empty corpus yields four empty lists');
}

console.log(`\n${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
