// Acceptance for the pure 2D cut analysis (`analyzeSheet2d`).
//
// The tool calls `measure_section`; this script accepts the arithmetic that turns
// a section into witnesses, without the Python worker. Each case is a counter-
// example the screen must produce (or must NOT produce).

import { analyzeSheet2d } from '../src/host/sheet2d.ts';

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const section = (holes, spacing = []) => ({
  polygons: [{ id: 'p1', holes }],
  holeSpacing: spacing,
  holeCount: holes.length,
});
const hole = (id, d, wall = 3) => ({
  id, kind: 'round', diameterMm: d, wallToOuterMm: wall, centerWorldMm: [0, 0, 0],
});
const params = { kerfMm: 0.2, minHoleMm: 3, minFeatureMm: 0.8, minSpacingMm: 1 };

console.log('sheet2d acceptance\n');

// 1. clean
{
  const r = analyzeSheet2d(section([hole('h1', 6, 3)], [{ from: 'h1', to: 'h2', clearanceMm: 2 }]), params);
  check('clean section is not-excluded', r.verdict === 'not-excluded', r.verdict);
  check('clean section has no witnesses', r.witnesses.length === 0, String(r.witnesses.length));
  check('kerf is reported in metrics', r.metrics.kerfMm === 0.2);
}

// 2. round hole after kerf
{
  const r = analyzeSheet2d(section([hole('h1', 3.1, 3)]), params);
  check('Ø3.1 − 0.2 kerf = Ø2.9 < 3 → excluded', r.verdict === 'excluded', r.verdict);
  check('witness is min-hole', r.witnesses.some((w) => w.rule === 'min-hole' && w.measured === 2.9 && w.required === 3),
    JSON.stringify(r.witnesses));
}

// 3. wall after kerf
{
  const r = analyzeSheet2d(section([hole('h1', 6, 0.9)]), params);
  check('wall 0.9 − 0.2 = 0.7 < 0.8 → excluded', r.verdict === 'excluded', r.verdict);
  check('witness is min-feature', r.witnesses.some((w) => w.rule === 'min-feature' && w.measured === 0.7),
    JSON.stringify(r.witnesses));
}

// 4. spacing after kerf
{
  const r = analyzeSheet2d(section([hole('h1', 6), hole('h2', 6)], [{ from: 'h1', to: 'h2', clearanceMm: 0.9 }]), params);
  check('spacing 0.9 − 0.2 = 0.7 < 1 → excluded', r.verdict === 'excluded', r.verdict);
  check('witness is min-spacing', r.witnesses.some((w) => w.rule === 'min-spacing' && w.measured === 0.7),
    JSON.stringify(r.witnesses));
}

// 5. non-circular hole is not forced through a diameter
{
  const r = analyzeSheet2d({
    polygons: [{ id: 'p1', holes: [{ id: 'slot', kind: 'non-circular', wallToOuterMm: 3, centerWorldMm: [0, 0, 0] }] }],
    holeSpacing: [], holeCount: 1,
  }, params);
  check('a non-circular hole does not produce a min-hole witness', !r.witnesses.some((w) => w.rule === 'min-hole'));
  check('a non-circular hole is disclosed as unevaluable', r.unevaluable.some((s) => s.includes('非圆孔')));
}

// 6. empty section
{
  const r = analyzeSheet2d({ polygons: [], holeSpacing: [], holeCount: 0, empty: true }, params);
  check('an empty section is not a pass', r.verdict === 'not-excluded' && r.unevaluable.includes('empty section'));
}

// 7. bend checks (optional bendLines in the section u/v frame)
{
  const plate = (holes, bendLines) => analyzeSheet2d({
    polygons: [{ id: 'p1', holes, outer: { pointsUv: [[0, 0], [40, 0], [40, 20], [0, 20]] } }],
    holeSpacing: [], holeCount: holes.length,
  }, { ...params, bendLines, minHoleToBendMm: 6, minFlangeMm: 12, minBendReliefMm: 1 });
  const h = { id: 'h1', kind: 'round', diameterMm: 6, wallToOuterMm: 5, centerWorldMm: [0, 0, 0], centerUv: [5, 10] };
  const r1 = plate([h], [{ from: [10, 0], to: [10, 20] }]);
  check('hole centre 5mm from bend < 6 → hole-to-bend witness', r1.witnesses.some((w) => w.rule === 'hole-to-bend' && w.measured === 5));
  check('bend line 10mm from edge < 12 → min-flange witness', r1.witnesses.some((w) => w.rule === 'min-flange' && w.measured === 10));
  const r2 = plate([h], [{ from: [10, 5], to: [10, 15] }]);
  check('bend end inside material > 1mm from boundary → bend-relief witness', r2.witnesses.some((w) => w.rule === 'bend-relief' && w.measured > 1));
  check('K-factor/flat pattern is disclosed as unevaluable', r2.unevaluable.some((s) => s.includes('K-factor')));
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
