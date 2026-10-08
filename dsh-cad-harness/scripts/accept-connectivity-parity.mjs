// Parity acceptance for the migrated `check_connectivity` (batch 1, second tool).
//
// What could silently change in this migration — and therefore what is asserted:
//
//   1. BODY COUNT and the per-body bounding boxes: the TS implementation joins
//      triangles through SHARED EDGES (a vertex-only touch is two bodies), so a
//      vertex-touching pair must stay two bodies here as well.
//   2. THE STRICT WATERTIGHT TEST. `tools.ts` reports this flag next to a "a part
//      MUST be a single connected solid" verdict, and it means "every directed
//      edge appears exactly once AND its reverse exists". trimesh's own
//      `is_watertight` is laxer (undirected edge sharing only), so a cube with one
//      face's winding flipped would have flipped the flag silently. The flipped
//      cube case below is the discriminator: both the worker and the TS oracle
//      must call it NOT watertight, while trimesh's own test says it is.
//   3. BODY ORDER: the tool emits `bodySizes`/`bodyCenters` in body order, so the
//      order (XY bbox area descending, ties by first triangle) is part of the
//      output contract.
//
//   node scripts/accept-connectivity-parity.mjs [--runtime <dir>]

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { connectedBodies, isWatertight, parseBinaryStl, writeBinaryStl } from '../src/host/mesh.ts';
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

const parts = (run, name) => join(REPO, 'examples', 'microscope4', 'cad-data', 'runs', run, 'parts', name);
const CORPUS = [
  ['整机', parts('r024', '整机.stl')],
  ['上半机', parts('r020', '上半机.stl')],
  ['底座', parts('r020', '底座.stl')],
  ['地面', parts('r024', '地面.stl')],
];

const worker = await ensurePythonWorker({ onLog: (line) => console.log(`      [worker] ${line}`) });
// Warm-up: the FIRST request pays trimesh/numpy imports (~0.3 s). Without this the
// first timing would be an import measurement dressed up as a comparison.
await worker.request('stl_stats', { path: CORPUS[3][1] });

console.log('--- real meshes: worker (Python) vs oracle (TS union-find) ---');
for (const [label, path] of CORPUS) {
  const mesh = parseBinaryStl(new Uint8Array(readFileSync(path)));
  const tsStart = performance.now();
  const ts = connectedBodies(mesh);
  const tsWatertight = isWatertight(mesh).watertight;
  const tsMs = performance.now() - tsStart;

  const pyStart = performance.now();
  const py = await worker.request('connectivity', { path });
  const pyMs = performance.now() - pyStart;

  check(py.count === ts.count, `${label}: body count agrees`, `TS ${ts.count} · py ${py.count}`);
  check(py.triangles === mesh.triVerts.length / 3, `${label}: triangle count agrees`, `${py.triangles}`);
  check(py.watertight === tsWatertight, `${label}: watertight verdict agrees`, `TS ${tsWatertight} · py ${py.watertight}`);
  const sameOrder = ts.bodies.every((body, index) => {
    const other = py.bodies[index];
    return other && Math.max(...body.min.map((v, axis) => Math.abs(v - other.min[axis])), ...body.max.map((v, axis) => Math.abs(v - other.max[axis]))) < 1e-6;
  });
  check(sameOrder, `${label}: bodies agree in order and in bbox`, `${ts.bodies.length} bodies`);
  console.log(`      timing: TS ${tsMs.toFixed(0)} ms · Python ${pyMs.toFixed(0)} ms (${(pyMs / tsMs).toFixed(2)}×)`);
}

console.log('--- discriminating cases (hand-built meshes) ---');
{
  const { compileStlOnly } = await import('../src/host/compile.ts');
  const cube = await compileStlOnly('cube(20, center=true);');
  check(cube.success, 'compiled a reference cube');
  if (cube.success) {
    const dir = mkdtempSync(join(tmpdir(), 'cad-connectivity-'));
    const write = (name, mesh) => {
      const path = join(dir, `${name}.stl`);
      writeFileSync(path, writeBinaryStl(mesh));
      return path;
    };

    // (a) winding flipped on one triangle: still edge-2-manifold, but no longer
    //     consistently oriented — the strict test must reject it.
    const flipped = { vertProperties: cube.stl ? parseBinaryStl(cube.stl).vertProperties : new Float32Array(), triVerts: parseBinaryStl(cube.stl).triVerts.slice() };
    const tmp = flipped.triVerts[1];
    flipped.triVerts[1] = flipped.triVerts[2];
    flipped.triVerts[2] = tmp;
    const flippedPath = write('flipped', flipped);
    const oracleFlipped = isWatertight(parseBinaryStl(new Uint8Array(readFileSync(flippedPath)))).watertight;
    const workerFlipped = await worker.request('connectivity', { path: flippedPath });
    check(oracleFlipped === false && workerFlipped.watertight === false, 'a winding-flipped cube is NOT watertight on both sides', `TS ${oracleFlipped} · py ${workerFlipped.watertight}`);
    const trimeshLax = await worker.request('stl_stats', { path: flippedPath });
    check(trimeshLax.watertight === true, 'and trimesh\'s own (laxer) test would have said it IS watertight — the trap the strict test avoids', `trimesh ${trimeshLax.watertight}`);

    // (b) two cubes that touch at a single vertex: no shared edge → two bodies.
    const vertexTouch = new Float32Array([...parseBinaryStl(cube.stl).vertProperties]);
    const base = parseBinaryStl(cube.stl);
    const verts = Array.from({ length: base.vertProperties.length / 3 }, (_, i) => [base.vertProperties[i * 3], base.vertProperties[i * 3 + 1], base.vertProperties[i * 3 + 2]]);
    const tris = Array.from({ length: base.triVerts.length / 3 }, (_, i) => [base.triVerts[i * 3], base.triVerts[i * 3 + 1], base.triVerts[i * 3 + 2]]);
    // shift by +20 on every axis: the +10 corner of the first cube meets the -10
    // corner of the second at (10,10,10)
    const shiftedVerts = verts.concat(verts.map(([x, y, z]) => [x + 20, y + 20, z + 20]));
    const shiftedTris = tris.concat(tris.map(([a, b, c]) => [a + verts.length, b + verts.length, c + verts.length]));
    const vertexMesh = {
      vertProperties: new Float32Array(shiftedVerts.flat()),
      triVerts: new Uint32Array(shiftedTris.flat()),
    };
    const vertexPath = write('vertex-touch', vertexMesh);
    const oracleVertex = connectedBodies(vertexMesh);
    const workerVertex = await worker.request('connectivity', { path: vertexPath });
    check(oracleVertex.count === 2 && workerVertex.count === 2, 'two cubes touching at one vertex stay TWO bodies (edge-based connectivity)', `TS ${oracleVertex.count} · py ${workerVertex.count}`);

    // (c) an open surface (one triangle removed) → not watertight, still 1 body.
    const openMesh = { vertProperties: base.vertProperties, triVerts: base.triVerts.slice(0, base.triVerts.length - 3) };
    const openPath = write('open', openMesh);
    const oracleOpen = isWatertight(openMesh).watertight;
    const workerOpen = await worker.request('connectivity', { path: openPath });
    check(oracleOpen === false && workerOpen.watertight === false && workerOpen.count === 1, 'an open cube is not watertight but is still one body', `TS ${oracleOpen} · py ${workerOpen.watertight}/${workerOpen.count}`);

    rmSync(dir, { recursive: true, force: true });
  }
}

resetPythonWorker();
console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
