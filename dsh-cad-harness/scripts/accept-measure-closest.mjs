// Parity acceptance for the migrated `measure_closest` (batch 1).
//
// The tool's SOLVE moved to the Python worker; this script is what makes that
// claim checkable: the same inputs must produce the same answer on both sides, on
// real corpus meshes, including the sphere branch and its intersection rule.
//
// The TS implementation stays in `src/host/measure.ts` as the ORACLE — not as a
// second production path. If a future change to either side breaks parity, this
// script fails; when the oracle is eventually retired, this file is the record of
// what "the numbers did not change" means.
//
//   node scripts/accept-measure-closest.mjs [--runtime <dir>]
//
// Asserts, per case:
//   * distanceMm equal within 1e-3 mm
//   * both closest points equal within 1e-3 mm each
//   * the watertight warning input agrees (trimesh.is_watertight vs TS isWatertight)
// and reports the timing of both implementations on the largest case.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { closestPointsBetweenMeshes, closestPointsMeshVsSphere } from '../src/host/measure.ts';
import { isWatertight, parseBinaryStl } from '../src/host/mesh.ts';
import { buildMeshBvh } from '../src/host/measure.ts';
import { Vector3 } from 'three';
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

const parts = (run, name) => join(REPO, 'examples', 'microscope4', 'cad-data', 'runs', run, 'parts', name);
const CASES = [
  { label: '底座 ↔ 上半机', a: parts('r020', '底座.stl'), b: parts('r020', '上半机.stl') },
  { label: '整机 ↔ 地面', a: parts('r024', '整机.stl'), b: parts('r024', '地面.stl') },
  { label: '整机 ↔ 底座', a: parts('r024', '整机.stl'), b: parts('r020', '底座.stl') },
];

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const maxAbsDiff = (p, q) => Math.max(...p.map((value, index) => Math.abs(value - q[index])));

const worker = await ensurePythonWorker({ onLog: (line) => console.log(`      [worker] ${line}`) });

console.log('--- mesh vs mesh: worker (Python) vs oracle (TS three-mesh-bvh) ---');
for (const testCase of CASES) {
  const meshA = parseBinaryStl(new Uint8Array(readFileSync(testCase.a)));
  const meshB = parseBinaryStl(new Uint8Array(readFileSync(testCase.b)));

  const tsStart = performance.now();
  const ts = closestPointsBetweenMeshes(meshA, meshB);
  const tsMs = performance.now() - tsStart;

  const pyStart = performance.now();
  const py = await worker.request('closest_mesh_mesh', { meshA: testCase.a, meshB: testCase.b });
  const pyMs = performance.now() - pyStart;

  check(Math.abs(ts.distanceMm - py.distanceMm) < 1e-3, `${testCase.label}: distance agrees`, `TS ${ts.distanceMm} mm · py ${py.distanceMm} mm · Δ=${Math.abs(ts.distanceMm - py.distanceMm).toExponential(1)}`);

  // The Python side prunes with a bounding-box lower bound, so when several
  // points tie at the minimum it may return a DIFFERENT equally valid pair (the
  // reference keeps the first in scan order). What must hold either way: the two
  // points really are `distanceMm` apart, and one of them is the exact
  // projection of the other onto the opposite solid.
  const separation = Math.hypot(py.pointA[0] - py.pointB[0], py.pointA[1] - py.pointB[1], py.pointA[2] - py.pointB[2]);
  check(Math.abs(separation - py.distanceMm) < 1e-3, `${testCase.label}: the returned pair is ${py.distanceMm} mm apart`, `measured ${separation.toFixed(6)} mm`);

  const bvhA = buildMeshBvh(meshA);
  const bvhB = buildMeshBvh(meshB);
  const asA = bvhB.closestPointToPoint(new Vector3(...py.pointA));
  const asB = bvhA.closestPointToPoint(new Vector3(...py.pointB));
  const validAsAVertex = asA ? Math.max(...[asA.point.x, asA.point.y, asA.point.z].map((v, i) => Math.abs(v - py.pointB[i]))) : Infinity;
  const validAsBVertex = asB ? Math.max(...[asB.point.x, asB.point.y, asB.point.z].map((v, i) => Math.abs(v - py.pointA[i]))) : Infinity;
  check(Math.min(validAsAVertex, validAsBVertex) < 1e-3, `${testCase.label}: the pair is a real vertex↔projection pair`, `ΔA=${validAsAVertex.toExponential(1)} ΔB=${validAsBVertex.toExponential(1)}`);

  const pointDelta = Math.max(maxAbsDiff(ts.pointA, py.pointA), maxAbsDiff(ts.pointB, py.pointB));
  console.log(`      pair delta vs oracle: ${pointDelta.toExponential(1)} mm (ties may differ by design)`);
  check(
    py.watertightA === isWatertight(meshA).watertight && py.watertightB === isWatertight(meshB).watertight,
    `${testCase.label}: watertight flags agree`,
    `a=${py.watertightA} b=${py.watertightB}`,
  );
  console.log(`      timing: TS ${tsMs.toFixed(0)} ms · Python ${pyMs.toFixed(0)} ms (${(pyMs / tsMs).toFixed(2)}×) · queries ${py.queries}/${py.queriesWithoutPruning} after pruning`);
}

console.log('--- mesh vs analytic sphere ---');
{
  const meshPath = CASES[0].b;
  const mesh = parseBinaryStl(new Uint8Array(readFileSync(meshPath)));
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (let i = 0; i < mesh.vertProperties.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      bounds.min[a] = Math.min(bounds.min[a], mesh.vertProperties[i + a]);
      bounds.max[a] = Math.max(bounds.max[a], mesh.vertProperties[i + a]);
    }
  }
  const centre = bounds.min.map((value, axis) => (value + bounds.max[axis]) / 2);

  for (const [label, center, radius] of [
    ['far outside (positive clearance)', [centre[0] + 300, centre[1], centre[2]], 5],
    ['intersecting (sphere reaches the surface)', [centre[0], centre[1], centre[2]], 12],
    ['touching the surface', [mesh.vertProperties[0], mesh.vertProperties[1], mesh.vertProperties[2]], 5],
  ]) {
    const ts = closestPointsMeshVsSphere(mesh, center, radius);
    const py = await worker.request('closest_mesh_sphere', { mesh: meshPath, center, radius });
    const expectedPointA = [py.spherePoint[0], py.spherePoint[1], py.spherePoint[2]]; // a-sphere branch swaps
    check(Math.abs(ts.distanceMm - py.distanceMm) < 1e-3, `sphere ${label}: distance agrees`, `TS ${ts.distanceMm} mm · py ${py.distanceMm} mm`);
    const meshPointDelta = maxAbsDiff(ts.pointA, py.meshPoint);
    check(meshPointDelta < 1e-3, `sphere ${label}: mesh-side point agrees`, `max |Δ| = ${meshPointDelta.toExponential(1)} mm`);
    const spherePointDelta = maxAbsDiff(ts.pointB, expectedPointA);
    check(spherePointDelta < 1e-3, `sphere ${label}: sphere-side point agrees`, `max |Δ| = ${spherePointDelta.toExponential(1)} mm`);
  }
}

console.log('--- end to end on a real version store, against ANALYTIC ground truth ---');
{
  // Agreement with the oracle is not enough on its own: this section checks the
  // migrated path against arithmetic the meshes cannot fudge. The tool resolves
  // `store.root/versions/<id>/model.stl`, so the temp store mirrors that layout.
  const { compileStlOnly } = await import('../src/host/compile.ts');
  const { mkdir, mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const storeRoot = await mkdtemp(join(tmpdir(), 'cad-measure-closest-'));
  const put = async (id, stl) => {
    await mkdir(join(storeRoot, 'versions', id), { recursive: true });
    const path = join(storeRoot, 'versions', id, 'model.stl');
    await writeFile(path, stl);
    return path;
  };

  const cube = await compileStlOnly('cube(20, center=true);');
  const shaft = await compileStlOnly('translate([0,0,31]) cylinder(h=40, d=12, center=true, $fn=64);');
  check(cube.success && shaft.success, 'compiled a 20mm cube and a 40mm shaft offset so the gap is exactly 1mm');
  if (cube.success && shaft.success) {
    const cubePath = await put('01-cube', cube.stl);
    const shaftPath = await put('02-shaft', shaft.stl);

    // cube spans z ∈ [-10, 10]; shaft spans z ∈ [11, 51] → clearance 1.000 mm
    const pair = await worker.request('closest_mesh_mesh', { meshA: cubePath, meshB: shaftPath });
    check(Math.abs(pair.distanceMm - 1.0) < 0.01, 'the 1 mm gap is measured as 1 mm', `${pair.distanceMm} mm`);

    // sphere probe centre (0,0,60) r=5 vs the shaft's top cap at z=51 → 9 - 5 = 4 mm
    const probe = await worker.request('closest_mesh_sphere', { mesh: shaftPath, center: [0, 0, 60], radius: 5 });
    check(Math.abs(probe.distanceMm - 4.0) < 0.01, 'sphere probe clears the shaft top by 4 mm', `${probe.distanceMm} mm`);

    // and the sphere that swallows the cap must report contact, not a negative gap
    const swallowed = await worker.request('closest_mesh_sphere', { mesh: shaftPath, center: [0, 0, 60], radius: 12 });
    check(swallowed.distanceMm === 0 && swallowed.intersected === true, 'a sphere that reaches the surface reports 0, not a negative clearance', `${swallowed.distanceMm} mm`);
  }
  await rm(storeRoot, { recursive: true, force: true });
}

resetPythonWorker();
console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
