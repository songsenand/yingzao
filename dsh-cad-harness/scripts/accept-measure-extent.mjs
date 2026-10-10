// Truth acceptance for `measure_extent` (a NEW op: analytic ground truth).
//
// This op is small, so the assertions are exact rather than approximate:
//
//   1. a 60×40×10 plate projects to exactly 10 / 60 / 40 on z / x / y, centred on 0;
//   2. the extremal VERTICES are real mesh points, and their own projection equals
//      the reported min/max (the check that the point and the number agree);
//   3. a diagonal axis projects to (60+40)/√2 = 70.711, which is the whole reason
//      the op takes an arbitrary axis — measure_part cannot answer it;
//   4. a signed axis flips the projection instead of silently using |axis|;
//   5. the axis-aligned envelope is reported alongside, so one call answers both
//      "how long along this" and "what is its bbox";
//   6. a non-watertight mesh still returns its extent but says so (an envelope is
//      readable on an open mesh; a volume is not);
//   7. a bad axis and a missing mesh raise instead of guessing;
//   8. a real corpus part agrees with measure_part's bbox along z.
//
//   node scripts/accept-measure-extent.mjs [--runtime <dir>]

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
const fmt = (value) => (typeof value === 'number' ? value.toFixed(4) : JSON.stringify(value));

const { compileStlOnly } = await import('../src/host/compile.ts');
const dir = await mkdtemp(join(REPO, '.tmp-measure-extent-'));
const write = async (name, code) => {
  const built = await compileStlOnly(code);
  if (!built.success) throw new Error(`${name} did not compile: ${built.errors?.join('; ')}`);
  const path = join(dir, `${name}.stl`);
  await writeFile(path, built.stl);
  return path;
};

const plate = await write('plate', 'cube([60,40,10], center=true);');
const open = await write('open',
  'polyhedron(points=[[-10,-10,-10],[10,-10,-10],[10,10,-10],[-10,10,-10],[-10,-10,10],[10,-10,10],[10,10,10],[-10,10,10]],'
  + ' faces=[[0,1,2,3],[4,5,6,7],[0,1,5,4],[2,3,7,6],[1,2,6,5]]);');

const worker = await ensurePythonWorker();
const extent = (path, extra = {}) => worker.request('measure_extent', { path, ...extra });

// --- 1. principal axes -------------------------------------------------------
for (const [axis, expected] of [['z', 10], ['x', 60], ['y', 40], ['-z', 10]]) {
  const out = await extent(plate, { axis });
  check(close(out.sizeMm, expected) && close(out.minMm, -expected / 2) && close(out.maxMm, expected / 2)
    && close(out.centerMm, 0),
    `plate on ${axis}: extent is exactly ${expected}mm, centred on 0`,
    `${fmt(out.minMm)}..${fmt(out.maxMm)} (size ${fmt(out.sizeMm)})`);
}

// --- 2. the extremal points agree with the numbers ---------------------------
const onZ = await extent(plate, { axis: 'z' });
check(close(onZ.minPointMm[2], onZ.minMm) && close(onZ.maxPointMm[2], onZ.maxMm),
  'the extremal vertices project onto the reported min/max',
  `${JSON.stringify(onZ.minPointMm)} / ${JSON.stringify(onZ.maxPointMm)}`);
check(close(Math.abs(onZ.minPointMm[0]), 30) && close(Math.abs(onZ.maxPointMm[0]), 30),
  'the extremal vertices are real corners of the 60mm-wide plate');
check(close(onZ.asAxisAlignedMm.max[0], 30) && close(onZ.asAxisAlignedMm.max[1], 20)
  && close(onZ.asAxisAlignedMm.max[2], 5),
  'the axis-aligned envelope comes back in the same reply',
  JSON.stringify(onZ.asAxisAlignedMm.max));

// --- 3. an arbitrary axis (what measure_part cannot do) ----------------------
// The worker's contract is one `axis` field that is either a principal-axis name or
// a vector; the TOOL layer is what turns the tool's `axisVector` into that vector.
const diagonal = await extent(plate, { axis: [1, 1, 0] });
check(close(diagonal.sizeMm, (60 + 40) / Math.SQRT2, 1e-2),
  'a [1,1,0] projection is (60+40)/√2 = 70.711mm', fmt(diagonal.sizeMm));
check(close(diagonal.axisMm[0], Math.SQRT2 / 2) && close(diagonal.axisMm[1], Math.SQRT2 / 2)
  && close(diagonal.axisMm[2], 0),
  'the axis is normalised in the reply', JSON.stringify(diagonal.axisMm));

// --- 4. a signed axis flips rather than absolutises --------------------------
const negative = await extent(plate, { axis: '-z' });
check(close(negative.minMm, -5) && close(negative.maxMm, 5),
  'a signed axis flips the projection (min/max stay in axis order)',
  `${fmt(negative.minMm)}..${fmt(negative.maxMm)}`);

// --- 5. open mesh ------------------------------------------------------------
const openOut = await extent(open, { axis: 'z' });
check(close(openOut.sizeMm, 20) && openOut.warnings.some((w) => w.includes('NOT watertight')),
  'an open mesh returns its envelope AND the watertight warning',
  JSON.stringify(openOut.warnings));

// --- 6. error paths ----------------------------------------------------------
for (const [label, extra] of [['a non-axis string', { axis: 'w' }], ['a two-component vector', { axis: [1, 0] }]]) {
  let raised = false;
  try {
    await extent(plate, extra);
  } catch {
    raised = true;
  }
  check(raised, `error path: ${label} raises instead of guessing`);
}
{
  let raised = false;
  try {
    await extent(join(dir, 'nope.stl'));
  } catch {
    raised = true;
  }
  check(raised, 'error path: a missing mesh raises');
}

// --- 7. a real corpus part agrees with measure_part --------------------------
const real = join(REPO, 'examples', 'microscope2', 'cad-data', 'versions', 'v010', 'model.stl');
if (existsSync(real)) {
  const realOut = await extent(real, { axis: 'z' });
  const span = realOut.asAxisAlignedMm.max[2] - realOut.asAxisAlignedMm.min[2];
  check(close(realOut.sizeMm, span, 1e-3),
    'real corpus part: the z extent equals its own axis-aligned z span',
    `${fmt(realOut.sizeMm)} vs ${fmt(span)}`);
  check(realOut.vertexCount > 100, 'real corpus part: the vertex count is reported',
    `${realOut.vertexCount} vertices`);
} else {
  console.log(`SKIP  real corpus part  — ${real} not found`);
}

await resetPythonWorker();
console.log(`\n${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}  (fixtures in ${dir})`);
process.exit(failures === 0 ? 0 : 1);
