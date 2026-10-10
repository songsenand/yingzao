// Truth acceptance for `measure_angle` (a NEW op: analytic ground truth).
//
// An angle is where a "your number does not match mine" round trip comes from, so the
// assertions are about CONVENTIONS as much as values:
//
//   1. two vectors 30° apart report angleDeg 30 / acuteDeg 30 / supplementDeg 150 —
//      and flipping one input flips angleDeg to 150 while acuteDeg stays 30. Both
//      numbers travel, so neither side of a conversation has to guess;
//   2. parallel axes report the perpendicular offset as lineDistanceMm;
//   3. skew axes report the closest approach, coplanar:false, and the common normal;
//   4. lines that meet report distance 0 AND the crossing point;
//   5. the three ways of naming a side all work — points, direction+origin, and a
//      PROBE that snaps to the nearest face normal;
//   6. a probe is tolerant: two different points on the same face give the same angle;
//   7. a real 30° wedge: the angle between the slanted face and the bottom is 150°
//      as given and 30° acute, which is exactly the case a single-number report
//      would get wrong half the time;
//   8. a direction with no point on it says `anchoredAtOrigin` (otherwise two
//      direction-only sides always "meet" at (0,0,0) and `coplanar` is an artifact);
//   9. error paths raise instead of guessing.
//
//   node scripts/accept-measure-angle.mjs [--runtime <dir>]

import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensurePythonWorker, resetPythonWorker } from '../src/host/python-worker.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const REPO = resolve(ROOT, '..');
const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
process.env.DSH_CAD_PYTHON_ROOT = resolve(argOf('--runtime', join(REPO, '.tmp-measure-runtime')));

const venvPython = process.platform === 'win32'
  ? join(process.env.DSH_CAD_PYTHON_ROOT, 'venv', 'Scripts', 'python.exe')
  : join(process.env.DSH_CAD_PYTHON_ROOT, 'venv', 'bin', 'python');
if (!existsSync(venvPython)) {
  console.error(`no venv python at ${venvPython} — provision the runtime first (or pass --runtime <dir>)`);
  process.exit(2);
}

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const close = (a, b, tolerance = 1e-3) => Math.abs(a - b) <= tolerance;
const fmt = (value) => (typeof value === 'number' ? value.toFixed(3) : JSON.stringify(value));
const rad = (deg) => (deg * Math.PI) / 180;

const { compileStlOnly } = await import('../src/host/compile.ts');
const dir = await mkdtemp(join(REPO, '.tmp-measure-angle-'));
const write = async (name, code) => {
  const built = await compileStlOnly(code);
  if (!built.success) throw new Error(`${name} did not compile: ${built.errors?.join('; ')}`);
  const path = join(dir, `${name}.stl`);
  await writeFile(path, built.stl);
  return path;
};

const cube = await write('cube', 'cube(20, center=true);');
const tube = await write('tube', 'difference(){ cylinder(h=20, d=24, center=true, $fn=64);'
  + ' cylinder(h=21, d=16, center=true, $fn=64); }');
// A prism whose slanted face rises at 30° from the base. The extrusion has to be
// rotated so the polygon's own y becomes world z — an XY extrusion would make the
// "slant" a VERTICAL wall, whose angle to the base is 90° (measured, then corrected).
const wedge = await write('wedge', `rotate([90,0,0]) linear_extrude(height=10) polygon(points=[[0,0],[20,0],[20,${20 * Math.tan(rad(30))}]]);`);

const worker = await ensurePythonWorker();
const angle = (params) => worker.request('measure_angle', params);

// --- 1. the convention pair --------------------------------------------------
const thirty = await angle({ aDir: [1, 0, 0], bDir: [Math.cos(rad(30)), Math.sin(rad(30)), 0] });
check(close(thirty.angleDeg, 30) && close(thirty.acuteDeg, 30) && close(thirty.supplementDeg, 150),
  '30° apart: as-given 30 / acute 30 / supplement 150',
  `${fmt(thirty.angleDeg)} / ${fmt(thirty.acuteDeg)} / ${fmt(thirty.supplementDeg)}`);
const flipped = await angle({ aDir: [1, 0, 0], bDir: [-Math.cos(rad(30)), -Math.sin(rad(30)), 0] });
check(close(flipped.angleDeg, 150) && close(flipped.acuteDeg, 30) && close(flipped.supplementDeg, 30),
  'the same pair with b reversed: as-given 150, acute still 30 — both numbers are reported',
  `${fmt(flipped.angleDeg)} / ${fmt(flipped.acuteDeg)} / ${fmt(flipped.supplementDeg)}`);
check(thirty.anchoredAtOrigin === true && thirty.warnings.some((w) => w.includes('anchored at the ORIGIN')),
  'a direction with no point on it is flagged as anchored at the origin',
  JSON.stringify(thirty.warnings[0]?.slice(0, 60)));

// --- 2. parallel and skew ----------------------------------------------------
const parallel = await angle({ aDir: [0, 0, 1], aOrigin: [0, 0, 0], bDir: [0, 0, 1], bOrigin: [5, 0, 2] });
check(parallel.parallel === true && close(parallel.lineDistanceMm, 5),
  'parallel axes 5mm apart: parallel, lineDistanceMm = 5', fmt(parallel.lineDistanceMm));
check(close(parallel.angleDeg, 0) && close(parallel.supplementDeg, 180),
  'parallel reports 0 as-given and 180 as the supplement', `${fmt(parallel.angleDeg)} / ${fmt(parallel.supplementDeg)}`);

const skew = await angle({ aDir: [1, 0, 0], aOrigin: [0, 0, 0], bDir: [0, 1, 0], bOrigin: [0, 0, 3] });
check(skew.perpendicular === true && skew.coplanar === false && close(skew.lineDistanceMm, 3),
  'skew axes: perpendicular, NOT coplanar, closest approach 3mm',
  `${fmt(skew.lineDistanceMm)} coplanar=${skew.coplanar}`);
check(JSON.stringify(skew.commonNormalMm) === JSON.stringify([0, 0, 1]),
  'the common normal of those two lies along z', JSON.stringify(skew.commonNormalMm));
check(skew.crossingPointMm === undefined, 'skew lines report no crossing point');

const meeting = await angle({ aDir: [1, 0, 0], aOrigin: [0, 0, 0], bDir: [0, 1, 0], bOrigin: [0, 0, 0] });
check(meeting.coplanar === true && close(meeting.lineDistanceMm, 0)
  && JSON.stringify(meeting.crossingPointMm) === JSON.stringify([0, 0, 0]),
  'lines that meet: distance 0, coplanar, and the crossing point',
  JSON.stringify(meeting.crossingPointMm));

// --- 2b. ASYMMETRIC skew cases, with a closed-form distance -------------------
// The axis-aligned cases above are too symmetric to catch a sign slip in the
// closest-pair solution: the first version of the worker port measured the FARTHEST
// pair and still passed every one of them. These have a closed form:
//   |w · (u1 × u2)| / |u1 × u2|
// and none of them is axis-aligned on both sides.
const skewA = await angle({ aDir: [1, 0, 0], aOrigin: [0, 0, 0], bDir: [0, 1, 1], bOrigin: [0, 0, 3] });
check(close(skewA.lineDistanceMm, 3 / Math.SQRT2, 1e-3) && close(skewA.acuteDeg, 90),
  'asymmetric skew: 3/√2mm apart at 90° (closed form |w·(u1×u2)|/|u1×u2|)',
  `${fmt(skewA.lineDistanceMm)} vs ${fmt(3 / Math.SQRT2)}`);
// Both lines here are HORIZONTAL (neither direction has a z component), so the
// closest approach is the 7mm vertical gap. The closed form divides by |u1 × u2| =
// sin(45°) = 1/√2 — remembering that factor is not optional: the first version of
// this assertion demanded 7/√2 and was wrong by exactly that factor.
const skewB = await angle({ aDir: [1, 0, 0], aOrigin: [0, 0, 0], bDir: [1, 1, 0], bOrigin: [0, 0, 7] });
check(close(skewB.lineDistanceMm, 7, 1e-3) && close(skewB.acuteDeg, 45),
  'two horizontal but 45°-crossed lines: the 7mm vertical gap',
  `${fmt(skewB.lineDistanceMm)} vs 7.000`);
const skewC = await angle({ aDir: [1, 0, 0], aOrigin: [0, 0, 0], bDir: [0, 1, 1], bOrigin: [5, 0, 0] });
check(close(skewC.lineDistanceMm, 0) && skewC.coplanar === true
  && JSON.stringify(skewC.crossingPointMm) === JSON.stringify([5, 0, 0]),
  'asymmetric but meeting: they cross at (5,0,0)', JSON.stringify(skewC.crossingPointMm));

// --- 3. tolerance ------------------------------------------------------------
const nearlyParallel = await angle({ aDir: [0, 0, 1], bDir: [Math.sin(rad(0.2)), 0, Math.cos(rad(0.2))] });
check(nearlyParallel.parallel === true,
  '0.2° apart counts as parallel at the default 0.5° tolerance', fmt(nearlyParallel.acuteDeg));
const strict = await angle({ aDir: [0, 0, 1], bDir: [Math.sin(rad(0.2)), 0, Math.cos(rad(0.2))], parallelToleranceDeg: 0.05 });
check(strict.parallel === false, 'the same pair is NOT parallel at a 0.05° tolerance');

// --- 4. points and probes ----------------------------------------------------
const byPoints = await angle({ aPoints: [[0, 0, 0], [1, 1, 0]], bPoints: [[0, 0, 0], [1, 0, 0]] });
check(close(byPoints.acuteDeg, 45), 'aPoints: the segment [apex → arm] gives 45°', fmt(byPoints.acuteDeg));

const probeCube = await angle({ meshes: [cube, cube], aProbe: [10, 0, 6], bProbe: [6, 0, 10] });
check(close(probeCube.acuteDeg, 90) && probeCube.perpendicular === true,
  'probes on a cube: the +x face and the +z face are perpendicular', fmt(probeCube.acuteDeg));
check(probeCube.aSource.includes('nearest face normal'),
  'the report says the direction came from a face normal', probeCube.aSource);
const probeMoved = await angle({ meshes: [cube, cube], aProbe: [14, 3, 6], bProbe: [6, -4, 14] });
check(close(probeMoved.acuteDeg, probeCube.acuteDeg),
  'a probe is tolerant: a different point on the same face gives the same angle',
  `${fmt(probeMoved.acuteDeg)} vs ${fmt(probeCube.acuteDeg)}`);

// Probe positions must be nearest to the face you MEAN: [12,0,0] is on the outer wall
// (radius 12), and (10,0,12) is above the annular top face — while (0,0,10) would be
// nearest the BORE wall, because the centre of that face is a hole.
const tubeProbe = await angle({ meshes: [tube, tube], aProbe: [14, 0, 0], bProbe: [10, 0, 12] });
check(Math.abs(tubeProbe.acuteDeg - 90) <= 1.5,
  'the tube outer wall against the end face: 90° (within one facet of the tessellation)',
  fmt(tubeProbe.acuteDeg));

// --- 5. a real 30° wedge -----------------------------------------------------
// The slant runs from (0,0,0) to (20,0,11.547): its outward normal is (-0.5, 0, 0.866),
// so the probe sits 3mm along that normal from the face's midpoint.
const wedgeFaces = await angle({ meshes: [wedge, wedge], aProbe: [10, -5, -4], bProbe: [8.5, -5, 8.37] });
check(close(wedgeFaces.acuteDeg, 30, 0.6),
  'the wedge: acute angle between the base and the slanted face is 30°', fmt(wedgeFaces.acuteDeg));
check(close(wedgeFaces.angleDeg + wedgeFaces.supplementDeg, 180) && close(wedgeFaces.acuteDeg, Math.min(wedgeFaces.angleDeg, wedgeFaces.supplementDeg)),
  'and the three reported numbers are internally consistent',
  `${fmt(wedgeFaces.angleDeg)} + ${fmt(wedgeFaces.supplementDeg)} → acute ${fmt(wedgeFaces.acuteDeg)}`);

// --- 6. error paths ----------------------------------------------------------
const solids = [
  ['no direction on side a', { bDir: [1, 0, 0] }],
  ['no direction on side b', { aDir: [1, 0, 0] }],
  ['a zero direction', { aDir: [0, 0, 0], bDir: [1, 0, 0] }],
  ['a two-component direction', { aDir: [1, 0], bDir: [1, 0, 0] }],
  ['malformed aPoints', { aPoints: [[0, 0, 0]], bDir: [1, 0, 0] }],
  ['a probe with no mesh', { aProbe: [1, 2, 3], bDir: [1, 0, 0] }],
];
for (const [label, params] of solids) {
  let raised = false;
  try {
    await angle(params);
  } catch {
    raised = true;
  }
  check(raised, `error path: ${label} raises instead of guessing`);
}

await resetPythonWorker();
console.log(`\n${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}  (fixtures in ${dir})`);
process.exit(failures === 0 ? 0 : 1);
