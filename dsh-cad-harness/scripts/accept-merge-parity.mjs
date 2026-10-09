// Parity acceptance for the migrated `merge_parts` union (batch 1, fourth tool).
//
// The union is Manifold's on both sides (same C++ kernel), so the interesting
// question is not "is the volume close" but "is the DELIVERABLE the same file".
// This script therefore compares the merged STL BYTES (sha256) between the Python
// worker and the TS oracle, and only if they differ falls back to reporting a
// canonical geometry hash so the difference is visible rather than hand-waved.
//
// It also checks that a part which is not a usable solid is still NAMED in the
// error — `merge_parts` used to say which part failed, and losing that would make
// a broken input harder to fix.
//
//   node scripts/accept-merge-parity.mjs [--runtime <dir>]

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { buildSolid } from '../src/host/assembly.ts';
import { parseBinaryStl, writeBinaryStl } from '../src/host/mesh.ts';
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
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);
/** Order-independent geometry fingerprint: sorted, rounded triangle centroids. */
const geometryHash = (mesh) => {
  const centroids = [];
  for (let t = 0; t < mesh.triVerts.length; t += 3) {
    const point = [0, 1, 2].map((axis) => {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += mesh.vertProperties[mesh.triVerts[t + k] * 3 + axis];
      return (sum / 3).toFixed(4);
    });
    centroids.push(point.join(','));
  }
  return sha(Buffer.from(centroids.sort().join(';')));
};
/** Order-independent vertex fingerprint: the referenced vertices as a sorted set. */
const vertexSetHash = (mesh) => {
  const seen = new Set();
  for (let t = 0; t < mesh.triVerts.length; t++) {
    const index = mesh.triVerts[t];
    seen.add([0, 1, 2].map((axis) => mesh.vertProperties[index * 3 + axis].toFixed(4)).join(','));
  }
  return sha(Buffer.from([...seen].sort().join(';')));
};

const { compileStlOnly } = await import('../src/host/compile.ts');
const lower = await compileStlOnly('cube([40,40,20], center=true);');
const upper = await compileStlOnly('cube([20,20,20], center=true);');
check(lower.success && upper.success, 'compiled the reference solids (40×40×20 base, 20³ column)');

const parts = (run, name) => join(REPO, 'examples', 'microscope4', 'cad-data', 'runs', run, 'parts', name);
const bytes = (path) => new Uint8Array(readFileSync(path));

const CASES = [
  { label: 'touching stack (1 shell)', solids: [{ name: 'base', stl: lower.stl }, { name: 'column', stl: upper.stl, transform: { translate: [0, 0, 20] } }] },
  { label: 'non-touching (2 shells)', solids: [{ name: 'base', stl: lower.stl }, { name: 'column', stl: upper.stl, transform: { translate: [0, 0, 60] } }] },
  { label: 'rotated column', solids: [{ name: 'base', stl: lower.stl }, { name: 'column', stl: upper.stl, transform: { rotate: [0, 0, 45], translate: [0, 0, 20] } }] },
  { label: 'three parts', solids: [{ name: 'base', stl: lower.stl }, { name: 'column', stl: upper.stl, transform: { translate: [0, 0, 20] } }, { name: 'cap', stl: upper.stl, transform: { translate: [0, 0, 40] } }] },
  { label: 'real parts (底座 + 上半机)', solids: [{ name: '底座', stl: bytes(parts('r020', '底座.stl')) }, { name: '上半机', stl: bytes(parts('r020', '上半机.stl')) }] },
];

const worker = await ensurePythonWorker({ onLog: (line) => console.log(`      [worker] ${line}`) });
const dir = mkdtempSync(join(tmpdir(), 'cad-merge-parity-'));

console.log('--- union parity: Python worker vs TS oracle ---');
for (const testCase of CASES) {
  // TS oracle: build each solid, add them, write the STL with the same header.
  const tsStart = performance.now();
  let union = null;
  for (const solid of testCase.solids) {
    const built = await buildSolid(solid.stl, solid.transform);
    union = union ? union.add(built.solid) : built.solid;
  }
  const gm = union.getMesh();
  const tsMesh = { vertProperties: gm.vertProperties, triVerts: gm.triVerts };
  const header = `dsh-cad-harness merge of ${testCase.solids.length} parts`;
  const tsStl = writeBinaryStl(tsMesh, header);
  const tsMs = performance.now() - tsStart;

  // Python: same inputs by file, merged STL written by the worker.
  const payload = [];
  for (const [index, solid] of testCase.solids.entries()) {
    const path = join(dir, `${index}.stl`);
    writeFileSync(path, solid.stl);
    payload.push({ name: solid.name, path, transform: solid.transform });
  }
  const out = join(dir, 'merged.stl');
  const pyStart = performance.now();
  const solved = await worker.request('merge_solids', { parts: payload, out, header });
  const pyStl = new Uint8Array(readFileSync(out));
  const pyMs = performance.now() - pyStart;

  const tsParsed = parseBinaryStl(tsStl);
  const pyParsed = parseBinaryStl(pyStl);
  check(solved.triangles === tsMesh.triVerts.length / 3, `${testCase.label}: triangle count`, `${solved.triangles}`);
  check(Math.abs(solved.volumeMm3 - union.volume()) < 1e-6, `${testCase.label}: volume`, `${solved.volumeMm3.toFixed(4)} mm³`);
  const tsBox = union.boundingBox();
  const tsSize = [tsBox.max[0] - tsBox.min[0], tsBox.max[1] - tsBox.min[1], tsBox.max[2] - tsBox.min[2]];
  check(solved.sizeMm.every((value, axis) => Math.abs(value - tsSize[axis]) < 1e-6), `${testCase.label}: bounding size`, solved.sizeMm.map((v) => v.toFixed(2)).join(' × '));

  const bytesEqual = tsStl.length === pyStl.length && sha(tsStl) === sha(pyStl);
  check(tsStl.length === pyStl.length, `${testCase.label}: merged STL has the same size`, `${tsStl.length} vs ${pyStl.length} bytes`);
  check(geometryHash(tsParsed) === geometryHash(pyParsed), `${testCase.label}: geometry fingerprint matches`, `${geometryHash(tsParsed)} vs ${geometryHash(pyParsed)}`);
  check(vertexSetHash(tsParsed) === vertexSetHash(pyParsed), `${testCase.label}: identical vertex set`, vertexSetHash(tsParsed));
  // Byte identity is the strongest form and it HOLDS for two-solid unions. For
  // three solids with coplanar contacts the JS binding emits the same triangles in
  // a different ORDER (verified: every Python call shape — (a+b)+c, a+(b+c),
  // batch_boolean — gives the same bytes, so this is the binding, not our code).
  // Triangle order is not part of what an STL means, so it is reported, not failed.
  if (bytesEqual) console.log(`      merged STL is byte-identical · ${tsStl.length} bytes · sha ${sha(tsStl)}`);
  else console.log(`      note: same geometry, different triangle ORDER (TS sha ${sha(tsStl)} vs py sha ${sha(pyStl)}) — reported, not failed`);
  console.log(`      timing: TS ${tsMs.toFixed(0)} ms · Python ${pyMs.toFixed(0)} ms (${(pyMs / tsMs).toFixed(2)}×) · ${solved.shells} shell(s)`);
}

console.log('--- a non-solid part is still NAMED ---');
{
  const single = new Uint8Array(84 + 50);
  const view = new DataView(single.buffer);
  view.setUint32(80, 1, true);
  [0, 0, 0, 10, 0, 0, 0, 10, 0].forEach((value, index) => view.setFloat32(84 + 12 + index * 4, value, true));
  const good = join(dir, 'good.stl');
  const bad = join(dir, 'bad.stl');
  writeFileSync(good, lower.stl);
  writeFileSync(bad, single);
  let message = '';
  try {
    await worker.request('merge_solids', { parts: [{ name: 'good', path: good }, { name: 'broken-bracket', path: bad }], out: join(dir, 'nope.stl') });
  } catch (error) {
    message = String(error?.message ?? error);
  }
  check(/broken-bracket/.test(message) && /not a usable solid/.test(message), 'the failing part is named in the error', message.split('\n')[0].slice(0, 140));
}

rmSync(dir, { recursive: true, force: true });
resetPythonWorker();
console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
