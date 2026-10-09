// Parity acceptance for the migrated `measure_distance` (batch 1, fifth tool).
//
// The tool snaps each input point onto its part's surface and reports where it
// landed, how far the guess was, and whether it was INSIDE the solid. Three things
// could quietly change in a migration and are therefore asserted per case:
//
//   1. the snapped coordinates and the snap distance,
//   2. the inside/outside verdict (face-normal sign test),
//   3. the watertight flag that drives the "snapping on an open mesh is
//      unreliable" warning — it must stay the STRICT manifold test, because
//      trimesh's own `is_watertight` is laxer and would silence that warning.
//
//   node scripts/accept-measure-distance-parity.mjs [--runtime <dir>]

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { measureDistance } from '../src/host/measure.ts';
import { isWatertight, parseBinaryStl } from '../src/host/mesh.ts';
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
const close = (a, b, tolerance = 1e-6) => Math.abs(a - b) <= tolerance;
const closePoint = (p, q, tolerance = 1e-6) => p.every((value, axis) => close(value, q[axis], tolerance));

const { compileStlOnly } = await import('../src/host/compile.ts');
const cube = await compileStlOnly('cube(20, center=true);');
const shaft = await compileStlOnly('translate([0,0,31]) cylinder(h=40, d=12, center=true, $fn=64);');
check(cube.success && shaft.success, 'compiled a 20mm cube and a 40mm shaft (1mm above the cube)');

const parts = (run, name) => join(REPO, 'examples', 'microscope4', 'cad-data', 'runs', run, 'parts', name);
const dir = await import('node:fs/promises').then((fs) => fs.mkdtemp(join(REPO, '.tmp-measure-distance-')));
const { writeFile } = await import('node:fs/promises');
const cubePath = join(dir, 'cube.stl');
const shaftPath = join(dir, 'shaft.stl');
await writeFile(cubePath, cube.stl);
await writeFile(shaftPath, shaft.stl);

const CASES = [
  { label: 'on the cube surface', a: [10, 0, 0], b: [0, 10, 0] },
  { label: 'inside the cube (nearest face is unique)', a: [7, 1, 0], b: [0, 0, 9] },
  { label: 'far outside', a: [40, 0, 0], b: [0, 0, 40] },
  { label: 'cross-part (cube → shaft)', a: [0, 0, 10], b: [0, 0, 11], meshB: 'shaft' },
  { label: 'snap disabled (raw coordinates)', a: [3, 4, 5], b: [1, 2, 3], snap: false },
  { label: 'snap only a', a: [30, 0, 0], b: [1, 2, 3], snap: { snapA: true, snapB: false } },
];

const worker = await ensurePythonWorker({ onLog: (line) => console.log(`      [worker] ${line}`) });
// Warm-up: the first request pays trimesh's import and the mesh load, which would
// otherwise show up as a 165× "regression" on a sub-millisecond operation.
await worker.request('stl_stats', { path: join(REPO, 'examples', 'microscope4', 'cad-data', 'runs', 'r024', 'parts', '地面.stl') });
const cubeMesh = parseBinaryStl(cube.stl);
const shaftMesh = parseBinaryStl(shaft.stl);

console.log('--- measure_distance parity: Python worker vs TS oracle ---');
for (const testCase of CASES) {
  const meshA = cubeMesh;
  const meshB = testCase.meshB === 'shaft' ? shaftMesh : null;
  const snapOption = testCase.snap === false ? false : (testCase.snap ?? true);

  const tsStart = performance.now();
  const ts = measureDistance(meshA, meshB, testCase.a, testCase.b, snapOption);
  const tsMs = performance.now() - tsStart;

  const pyStart = performance.now();
  const py = await worker.request('measure_distance', {
    meshA: cubePath,
    meshB: testCase.meshB === 'shaft' ? shaftPath : null,
    a: testCase.a,
    b: testCase.b,
    snapA: typeof snapOption === 'object' ? snapOption.snapA : snapOption,
    snapB: typeof snapOption === 'object' ? snapOption.snapB : snapOption,
  });
  const pyMs = performance.now() - pyStart;

  check(close(ts.distanceMm, py.distanceMm, 1e-4), `${testCase.label}: distance`, `${ts.distanceMm} vs ${py.distanceMm} mm`);
  check(closePoint(ts.aSnapped, py.aSnapped) && closePoint(ts.bSnapped, py.bSnapped), `${testCase.label}: snapped coordinates`, `a ${py.aSnapped.map((v) => v.toFixed(3)).join(',')} · b ${py.bSnapped.map((v) => v.toFixed(3)).join(',')}`);
  check(close(ts.aSnapDistanceMm, py.aSnapDistanceMm, 1e-4) && close(ts.bSnapDistanceMm, py.bSnapDistanceMm, 1e-4), `${testCase.label}: snap distances`, `${py.aSnapDistanceMm} / ${py.bSnapDistanceMm} mm`);
  check(ts.aOutside === py.aOutside && ts.bOutside === py.bOutside, `${testCase.label}: inside/outside verdicts`, `a=${py.aOutside} b=${py.bOutside}`);
  check(close(ts.dxMm, py.dxMm, 1e-4) && close(ts.dyMm, py.dyMm, 1e-4) && close(ts.dzMm, py.dzMm, 1e-4), `${testCase.label}: components`, `${py.dxMm}, ${py.dyMm}, ${py.dzMm}`);
  console.log(`      timing: TS ${tsMs.toFixed(1)} ms · Python ${pyMs.toFixed(1)} ms (${(pyMs / Math.max(tsMs, 0.01)).toFixed(2)}×)`);
}

console.log('--- an exact tie is a tie, not a disagreement ---');
{
  // The cube's CENTRE is 10 mm from all six faces. three-mesh-bvh picks the -Z
  // face, trimesh the -X face: both are correct closest points, so the snapped
  // coordinates and everything derived from them legitimately differ. What must
  // still agree is the snap distance, the inside/outside verdict, and the fact
  // that the snapped point really lies on the surface.
  const ts = measureDistance(cubeMesh, null, [0, 0, 0], [0, 0, 9], true);
  const py = await worker.request('measure_distance', { meshA: cubePath, meshB: null, a: [0, 0, 0], b: [0, 0, 9], snapA: true, snapB: true });
  check(close(ts.aSnapDistanceMm, py.aSnapDistanceMm, 1e-4), 'tie: the snap distance agrees', `${ts.aSnapDistanceMm} vs ${py.aSnapDistanceMm} mm`);
  check(ts.aOutside === py.aOutside, 'tie: the inside/outside verdict agrees', `a=${py.aOutside}`);
  const onSurface = (point) => Math.abs(Math.max(...point.map(Math.abs)) - 10) < 1e-4;
  check(onSurface(ts.aSnapped) && onSurface(py.aSnapped), 'tie: both snapped points lie on the cube surface', `TS ${ts.aSnapped.join(',')} · py ${py.aSnapped.join(',')}`);
  console.log('      (coordinates differ by design when several surface points tie)');
}

console.log('--- the warning flag keeps the STRICT manifold test ---');
{
  const py = await worker.request('measure_distance', { meshA: cubePath, a: [10, 0, 0], b: [0, 10, 0], snapA: true, snapB: true });
  check(py.watertightA === isWatertight(cubeMesh).watertight, 'watertight flag agrees with the TS strict test on a closed cube', `py ${py.watertightA} · TS ${isWatertight(cubeMesh).watertight}`);

  // Winding flipped on one triangle: edge-2-manifold but not consistently oriented.
  const flipped = { vertProperties: cubeMesh.vertProperties, triVerts: cubeMesh.triVerts.slice() };
  const swap = flipped.triVerts[1];
  flipped.triVerts[1] = flipped.triVerts[2];
  flipped.triVerts[2] = swap;
  const { writeBinaryStl } = await import('../src/host/mesh.ts');
  const flippedPath = join(dir, 'flipped.stl');
  await writeFile(flippedPath, writeBinaryStl(flipped));
  const flippedResult = await worker.request('measure_distance', { meshA: flippedPath, a: [10, 0, 0], b: [0, 10, 0], snapA: true, snapB: true });
  check(flippedResult.watertightA === false, 'a winding-flipped cube is NOT watertight (trimesh would say it is)', `py ${flippedResult.watertightA}`);
  const stats = await worker.request('stl_stats', { path: flippedPath });
  check(stats.watertight === true, 'and trimesh\'s laxer test would have silenced the warning', `trimesh ${stats.watertight}`);
}

console.log('--- a real part ---');
{
  const stl = parts('r024', '整机.stl');
  const mesh = parseBinaryStl(new Uint8Array(readFileSync(stl)));
  const a = [0, 0, 0];
  const b = [0, 0, 300];
  const ts = measureDistance(mesh, null, a, b, true);
  const py = await worker.request('measure_distance', { meshA: stl, meshB: null, a, b, snapA: true, snapB: true });
  check(close(ts.distanceMm, py.distanceMm, 1e-4), '整机: distance', `${ts.distanceMm} vs ${py.distanceMm} mm`);
  check(closePoint(ts.aSnapped, py.aSnapped) && closePoint(ts.bSnapped, py.bSnapped), '整机: snapped coordinates');
  check(ts.aOutside === py.aOutside && ts.bOutside === py.bOutside, '整机: inside/outside verdicts', `a=${py.aOutside} b=${py.bOutside}`);
  check(py.watertightA === isWatertight(mesh).watertight, '整机: watertight flag');
}

await import('node:fs/promises').then((fs) => fs.rm(dir, { recursive: true, force: true }));
resetPythonWorker();
console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
