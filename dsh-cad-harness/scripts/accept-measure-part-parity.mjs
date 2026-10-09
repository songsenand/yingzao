// Parity acceptance for the migrated `measure_part` (whole-part ground truth).
//
// `measureVersion` now reads the stored STL by path and asks the worker; the old TS
// implementation is kept as `measureVersionInTs`. This one is expected to be
// BIT-EXACT: it is the same algorithm on the same Manifold library, so anything
// other than equality is a defect, not engine drift.
//
// Covered: a plain cube (volume 8000, genus 0), a plate with a through hole
// (genus 1), two disjoint shells in one mesh, a real 28,830-triangle part, and the
// `-0` centroid trap (a symmetric part whose centroid rounds to -0 — that used to
// make the tool fail the harness's lossless-JSON check on every symmetric part).
//
//   node scripts/accept-measure-part-parity.mjs [--runtime <dir>]

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { measureVersion, measureVersionInTs } from '../src/host/inspect.ts';
import { resetPythonWorker } from '../src/host/python-worker.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const REPO = resolve(ROOT, '..');
const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const index = args.indexOf(flag);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  return fallback;
};
process.env.DSH_CAD_PYTHON_ROOT = resolve(argOf('--runtime', join(REPO, '.tmp-measure-runtime')));

const venvPython = process.platform === 'win32'
  ? join(process.env.DSH_CAD_PYTHON_ROOT, 'venv', 'Scripts', 'python.exe')
  : join(process.env.DSH_CAD_PYTHON_ROOT, 'venv', 'bin', 'python');
if (!existsSync(venvPython)) {
  console.error(`no venv python at ${venvPython}`);
  process.exit(2);
}

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const { compileStlOnly } = await import('../src/host/compile.ts');
const storeRoot = mkdtempSync(join(tmpdir(), 'cad-measure-store-'));
const store = { root: storeRoot };

const PARTS = [
  { id: 'v001', label: 'plain cube (8000 mm³, genus 0)', scad: 'cube([20,20,20], center=true);' },
  { id: 'v002', label: 'plate with a through hole (genus 1)', scad: 'difference() { cube([40,40,10], center=true); cylinder(h=30, r=5, center=true, $fn=64); }' },
  { id: 'v003', label: 'two disjoint shells in one mesh', scad: 'union() { translate([-20,0,0]) cube([20,20,20], center=true); translate([20,0,0]) cube([20,20,20], center=true); }' },
  { id: 'v004', label: 'symmetric part (the -0 centroid trap)', scad: 'sphere(r=12, $fn=96);' },
];

for (const part of PARTS) {
  const compiled = await compileStlOnly(part.scad);
  if (!compiled.success) {
    console.error(`compile failed for ${part.id}: ${compiled.errors.join('; ')}`);
    process.exit(1);
  }
  mkdirSync(join(storeRoot, 'versions', part.id), { recursive: true });
  writeFileSync(join(storeRoot, 'versions', part.id, 'model.stl'), compiled.stl);
}

// A real part: 28,830 triangles, 26 shells, known volume 710012.9981 mm³.
const realPath = join(REPO, 'examples', 'microscope4', 'cad-data', 'runs', 'r024', 'parts', '整机.stl');
if (existsSync(realPath)) {
  const { readFileSync } = await import('node:fs');
  mkdirSync(join(storeRoot, 'versions', 'v900'), { recursive: true });
  writeFileSync(join(storeRoot, 'versions', 'v900', 'model.stl'), readFileSync(realPath));
  PARTS.push({ id: 'v900', label: 'real part: 整机.stl (28,830 tris)' });
} else {
  console.log(`      (skipping the real part: ${realPath} not present)`);
}

console.log('--- measure_part parity: Python worker vs TS oracle (expect bit-exact) ---');
for (const part of PARTS) {
  const ts = await measureVersionInTs(store, part.id);
  const py = await measureVersion(store, part.id);
  const same = JSON.stringify(py) === JSON.stringify(ts);
  check(same, `${part.label}: every measured field identical`, same ? '' : `\n        TS ${JSON.stringify(ts)}\n        py ${JSON.stringify(py)}`);
  if (same) {
    console.log(`      volume ${py.volumeMm3} mm³ · area ${py.surfaceAreaMm2} mm² · triangles ${py.triangles} · genus ${py.genus} · watertight ${py.watertight}`);
    console.log(`      bbox ${JSON.stringify(py.boundingBoxMm.size)} · com ${JSON.stringify(py.centerOfMassMm)}`);
  }
  // JSON round-trip: -0 must never appear (the harness rejects non-lossless JSON).
  check(!JSON.stringify(py).includes('-0,'), `${part.label}: no -0 in the JSON`, JSON.stringify(py.centerOfMassMm));
}

// The error path: a non-manifold mesh must FAIL on both sides rather than report a
// plausible-looking volume.
{
  const broken = join(storeRoot, 'versions', 'v998');
  mkdirSync(broken, { recursive: true });
  // One triangle only: not a solid.
  const header = Buffer.alloc(84);
  header.writeUInt32LE(1, 80);
  const triangle = Buffer.alloc(50);
  triangle.writeFloatLE(3, 0); triangle.writeFloatLE(0, 4); triangle.writeFloatLE(0, 8);
  for (let v = 0; v < 3; v++) {
    triangle.writeFloatLE(v * 10, 12 + v * 12);
    triangle.writeFloatLE(v * 10, 16 + v * 12);
    triangle.writeFloatLE(0, 20 + v * 12);
  }
  writeFileSync(join(broken, 'model.stl'), Buffer.concat([header, triangle]));
  let tsFailed = false;
  let pyFailed = false;
  try { await measureVersionInTs(store, 'v998'); } catch { tsFailed = true; }
  try { await measureVersion(store, 'v998'); } catch { pyFailed = true; }
  check(tsFailed && pyFailed, 'a one-triangle "solid" fails on both sides (no invented volume)', `TS ${tsFailed} · py ${pyFailed}`);
}

rmSync(storeRoot, { recursive: true, force: true });
resetPythonWorker();
console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
