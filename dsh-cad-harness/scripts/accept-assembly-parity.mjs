// Parity acceptance for the migrated `validate_assembly` (batch 1, third tool).
//
// `validateAssembly` now forwards to the Python worker; `validateAssemblyInTs` is
// the previous implementation, kept as the oracle. This script runs both on the
// same inputs and fails on ANY difference in the report — per-part watertightness,
// volume, bounding box and triangle count, and per-pair status, intersection
// volume and clearance. Two implementations agreeing to the last digit is the
// only acceptable evidence that the move did not change what the tool answers.
//
//   node scripts/accept-assembly-parity.mjs [--runtime <dir>]

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { validateAssembly, validateAssemblyInTs } from '../src/host/assembly.ts';
import { resetPythonWorker } from '../src/host/python-worker.ts';

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

const { compileStlOnly } = await import('../src/host/compile.ts');
const cube = await compileStlOnly('cube(20, center=true);');
const shaft = await compileStlOnly('translate([0,0,31]) cylinder(h=40, d=12, center=true, $fn=64);');
check(cube.success && shaft.success, 'compiled the reference solids (20mm cube, 40mm shaft)');

const parts = (run, name) => join(REPO, 'examples', 'microscope4', 'cad-data', 'runs', run, 'parts', name);
const bytes = (path) => new Uint8Array(readFileSync(path));

const CASES = [
  { label: 'cube ↔ shaft, 1mm gap', parts: [{ name: 'cube', stl: cube.stl }, { name: 'shaft', stl: shaft.stl }] },
  { label: 'cube ↔ shaft, interference', parts: [{ name: 'cube', stl: cube.stl }, { name: 'shaft', stl: shaft.stl, transform: { translate: [0, 0, -31] } }] },
  { label: 'cube ↔ shaft, 0.5mm (too_tight at 0.75)', parts: [{ name: 'cube', stl: cube.stl }, { name: 'shaft', stl: shaft.stl, transform: { translate: [0, 0, -0.5] } }], threshold: 0.75 },
  { label: 'cube ↔ shaft, 0.5mm (ok at 0.25)', parts: [{ name: 'cube', stl: cube.stl }, { name: 'shaft', stl: shaft.stl, transform: { translate: [0, 0, -0.5] } }], threshold: 0.25 },
  { label: 'cube rotated 90° about Z vs shaft', parts: [{ name: 'cube', stl: cube.stl, transform: { rotate: [0, 0, 90] } }, { name: 'shaft', stl: shaft.stl }] },
  { label: 'cube via matrix (pose path)', parts: [{ name: 'cube', stl: cube.stl, transform: { matrix: [[0, -1, 0], [1, 0, 0], [0, 0, 1]] } }, { name: 'shaft', stl: shaft.stl }] },
  { label: '底座 ↔ 上半机 (real parts)', parts: [{ name: '底座', stl: bytes(parts('r020', '底座.stl')) }, { name: '上半机', stl: bytes(parts('r020', '上半机.stl')) }] },
  { label: '整机 ↔ 底座 shifted +40mm in Z', parts: [{ name: '整机', stl: bytes(parts('r024', '整机.stl')) }, { name: '底座', stl: bytes(parts('r020', '底座.stl')), transform: { translate: [0, 0, 40] } }] },
];

console.log('--- full report parity: Python worker vs TS oracle ---');
for (const testCase of CASES) {
  const threshold = testCase.threshold ?? 0.75;
  const tsStart = performance.now();
  const ts = await validateAssemblyInTs(testCase.parts, threshold);
  const tsMs = performance.now() - tsStart;

  const pyStart = performance.now();
  const py = await validateAssembly(testCase.parts, threshold);
  const pyMs = performance.now() - pyStart;

  check(py.overallStatus === ts.overallStatus, `${testCase.label}: overallStatus`, `${py.overallStatus} vs ${ts.overallStatus}`);

  const partsMatch = py.parts.length === ts.parts.length && py.parts.every((part, index) => {
    const other = ts.parts[index];
    return part.name === other.name
      && part.watertight === other.watertight
      && part.triangles === other.triangles
      && close(part.volume, other.volume)
      && part.boundingBox.min.every((v, axis) => close(v, other.boundingBox.min[axis]))
      && part.boundingBox.max.every((v, axis) => close(v, other.boundingBox.max[axis]));
  });
  check(partsMatch, `${testCase.label}: per-part facts (watertight/volume/bbox/triangles)`, `${py.parts.length} parts`);

  const pairsMatch = py.pairs.length === ts.pairs.length && py.pairs.every((pair, index) => {
    const other = ts.pairs[index];
    return pair.partA === other.partA && pair.partB === other.partB
      && pair.status === other.status
      && close(pair.minDistance, other.minDistance, 1e-6)
      && close(pair.intersectionVolume, other.intersectionVolume, 1e-6);
  });
  check(pairsMatch, `${testCase.label}: per-pair verdicts (status/volume/clearance)`, py.pairs.map((p) => `${p.status}@${p.minDistance.toFixed(3)}mm/${p.intersectionVolume.toFixed(1)}mm³`).join(' '));
  console.log(`      timing: TS ${tsMs.toFixed(0)} ms · Python ${pyMs.toFixed(0)} ms (${(pyMs / tsMs).toFixed(2)}×)`);
}

console.log('--- a non-solid must be refused by both, not silently reported ---');
{
  // one triangle: closed surface? no. Both sides must throw.
  const single = new Uint8Array(84 + 50);
  const view = new DataView(single.buffer);
  view.setUint32(80, 1, true);
  [0, 0, 0, 10, 0, 0, 0, 10, 0].forEach((value, index) => view.setFloat32(84 + 12 + index * 4, value, true));
  let tsThrew = false;
  let pyThrew = false;
  let pyMessage = '';
  try { await validateAssemblyInTs([{ name: 'tri', stl: single }]); } catch { tsThrew = true; }
  try { await validateAssembly([{ name: 'tri', stl: single }]); } catch (error) { pyThrew = true; pyMessage = String(error?.message ?? error).split('\n')[0]; }
  check(tsThrew && pyThrew, 'a single triangle is refused on both sides', pyMessage.slice(0, 120));
}

resetPythonWorker();
console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
