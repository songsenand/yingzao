// Truth acceptance for `measure_thickness` (a NEW op, not a migration — so the
// judgement is analytic ground truth, not parity against a TS oracle).
//
// What is being asserted, and why each case exists:
//
//   1. wall spans on a tube (3.000mm) and a box shell (2.000mm) — the number the
//      tool exists to produce;
//   2. the ray starts INSIDE material — the first span begins at 0 and has no
//      entryNormal (omitted, never fabricated);
//   3. a ray that travels exactly along a triangulation seam/edge reports ONE
//      crossing pair, not two — `sdf.ts` once flipped inside/outside because a
//      shared edge counted twice, so this is the regression that matters most;
//   4. cross-part clearance: a→b is tagged and measures the gap, not the wall;
//   5. an open mesh: watertightA false AND the loud warning, because every span on
//      an open mesh is a number about a shape that is not a body;
//   6. maxSpanMm clips and says so; a miss returns no spans and says why;
//   7. the error paths (zero direction, no mesh) fail loudly instead of guessing.
//
//   node scripts/accept-measure-thickness.mjs [--runtime <dir>]

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
const close = (a, b, tolerance = 0.03) => Math.abs(a - b) <= tolerance;
const fmt = (value) => (typeof value === 'number' ? value.toFixed(3) : JSON.stringify(value));

// --- fixtures: OpenSCAD, because the real corpus is OpenSCAD tessellation -----
const { compileStlOnly } = await import('../src/host/compile.ts');
const dir = await mkdtemp(join(REPO, '.tmp-measure-thickness-'));
const write = async (name, code) => {
  const built = await compileStlOnly(code);
  if (!built.success) throw new Error(`${name} did not compile: ${built.errors?.join('; ')}`);
  const path = join(dir, `${name}.stl`);
  await writeFile(path, built.stl);
  return path;
};

// Wall 3mm (Ø26 outside, Ø20 inside), 20mm tall. Vertex-aligned $fn=128 so the
// +x ray at y=0 passes exactly through cylinder vertices — the seam case.
const tube = await write('tube', 'difference(){ cylinder(h=20, d=26, center=true, $fn=128); cylinder(h=21, d=20, center=true, $fn=128); }');
// Wall 2mm on every side.
const shell = await write('shell', 'difference(){ cube(20, center=true); cube([16,16,16], center=true); }');
const cube = await write('cube', 'cube(20, center=true);');
const far = await write('far', 'translate([25,0,0]) cube(20, center=true);');
// Open mesh: a polyhedron with the +y face omitted.
const open = await write('open',
  'polyhedron(points=[[-10,-10,-10],[10,-10,-10],[10,10,-10],[-10,10,-10],[-10,-10,10],[10,-10,10],[10,10,10],[-10,10,10]],'
  + ' faces=[[0,1,2,3],[4,5,6,7],[0,1,5,4],[2,3,7,6],[1,2,6,5]]);');

const worker = await ensurePythonWorker();
const probe = (params) => worker.request('measure_thickness', params);

// --- 1. the axis argument, parsed in ONE place (the worker) -------------------
// `measure_thickness`, `measure_section` and `measure_extent` all take an axis, so
// the rules live in the worker's `_axis_vector` and the tool layer only forwards the
// argument. This drives the real op, not a copy of the parser.
for (const [input, expected] of [
  ['+x', [1, 0, 0]], ['-x', [-1, 0, 0]], ['+y', [0, 1, 0]],
  ['-y', [0, -1, 0]], ['+z', [0, 0, 1]], ['-z', [0, 0, -1]],
  ['z', [0, 0, 1]], [' X ', [1, 0, 0]], ['y+', [0, 1, 0]], ['y-', [0, -1, 0]],
]) {
  const out = await probe({ meshes: [cube], from: [-30, 0, 0], direction: input });
  check(JSON.stringify(out.direction) === JSON.stringify(expected),
    `direction ${JSON.stringify(input)} → ${expected.join(',')}`, JSON.stringify(out.direction));
}
for (const bad of ['diagonal', [1, 0]]) {
  let rejected = false;
  try {
    await probe({ meshes: [cube], from: [0, 0, 0], direction: bad });
  } catch {
    rejected = true;
  }
  check(rejected, `direction ${JSON.stringify(bad)} is rejected, not guessed`);
}

// --- 2. walls ----------------------------------------------------------------
// NOTE: this first case is ALSO the degeneracy regression. `+x` at y=0 runs along
// the vertex line of the $fn=128 cylinders, and a single ray cast on that exact
// line was measured to return ZERO crossings where four exist (the bore and even
// the outer wall vanish). The multi-probe vote is what makes this line answerable.
const tubeOut = await probe({ meshes: [tube], from: [-20, 0, 0], direction: [1, 0, 0] });
check(tubeOut.spans.length === 2, 'tube: the +x ray finds two wall spans', `got ${tubeOut.spans.length}`);
check(tubeOut.spans.every((s) => close(s.thicknessMm, 3.0)), 'tube: both walls are 3.000mm',
  tubeOut.spans.map((s) => fmt(s.thicknessMm)).join(' / '));
check(tubeOut.nudgedMm > 0 && tubeOut.probeAgreement < 1,
  'tube: the vertex-line ray says it leaned on a nudged line, and how many probes agreed',
  `nudged=${tubeOut.nudgedMm}mm agreement=${fmt(tubeOut.probeAgreement)}`);
check(tubeOut.warnings.some((w) => w.includes('close to tangent')),
  'tube: the near-tangency warning is present, not swallowed');
check(tubeOut.spans.every((s) => s.entryNormal && s.exitNormal
  && s.entryNormal[0] * s.exitNormal[0] + s.entryNormal[1] * s.exitNormal[1] + s.entryNormal[2] * s.exitNormal[2] < 0),
  'tube: entry and exit normals oppose each other (this is a wall, not a slot)');
check(close(tubeOut.gaps[0]?.gapMm, 20.0), 'tube: the bore between the walls is 20.000mm', fmt(tubeOut.gaps[0]?.gapMm));
check(tubeOut.fromInsideSolid === false && tubeOut.watertightA === true, 'tube: start outside, mesh watertight');

const shellOut = await probe({ meshes: [shell], from: [0, 0, -30], direction: [0, 0, 1] });
check(shellOut.spans.length === 2 && shellOut.spans.every((s) => close(s.thicknessMm, 2.0)),
  'box shell: the +z ray finds two 2.000mm walls', shellOut.spans.map((s) => fmt(s.thicknessMm)).join(' / '));
check(close(shellOut.spans[0]?.enterMm, 20.0) && close(shellOut.spans[1]?.enterMm, 38.0),
  'box shell: the walls sit at 20mm and 38mm from the start',
  shellOut.spans.map((s) => fmt(s.enterMm)).join(' / '));

// --- 3. the start point is inside material -----------------------------------
const insideOut = await probe({ meshes: [tube], from: [11, 0, 0], direction: [1, 0, 0] });
check(insideOut.fromInsideSolid === true, 'start inside material: reported as inside');
check(insideOut.spans.length === 1 && close(insideOut.spans[0].enterMm, 0) && close(insideOut.spans[0].thicknessMm, 2.0),
  'start inside material: the first span begins at 0 and is 2.000mm',
  JSON.stringify(insideOut.spans.map((s) => [s.enterMm, s.thicknessMm])));
check(insideOut.spans[0] && !('entryNormal' in insideOut.spans[0]),
  'start inside material: entryNormal is OMITTED, not fabricated');
check(!insideOut.warnings.some((w) => w.includes('odd number of crossings')),
  'start inside material: an odd crossing count is not called a mesh defect');

// --- 4. seam / vertex / tangency ---------------------------------------------
// The vertex case is the TUBE above (a transversal crossing that happens to land
// on a tessellation vertex: it must give the right number). These two are different:
// a ray that lies exactly IN a face plane is tangential, and "how much material
// does it cross" has no defined answer — so the tool must SAY SO, not pick one.
const interior = await probe({ meshes: [cube], from: [-30, -3, -7], direction: [1, 0, 0] });
check(interior.spans.length === 1 && close(interior.spans[0].thicknessMm, 20.0),
  'interior off-axis ray: ONE 20.000mm span', `${interior.spans.length} span(s)`);
check(interior.nudgedMm === 0 && interior.probeAgreement === 1,
  'interior off-axis ray: no nudge needed and every probe agreed',
  `nudged=${interior.nudgedMm} agreement=${fmt(interior.probeAgreement)}`);

const diagonal = await probe({ meshes: [cube], from: [-30, -10, 0], direction: [1, 0, 0] });
check(diagonal.spans.length === 1 && close(diagonal.spans[0].thicknessMm, 20.0),
  'ray along a face diagonal: ONE 20.000mm span', `${diagonal.spans.length} span(s)`);

const centre = await probe({ meshes: [cube], from: [0, 0, 0], direction: [1, 0, 0] });
check(centre.fromInsideSolid === true && close(centre.spans[0]?.thicknessMm, 10.0),
  'ray from the cube centre: inside, and exactly 10.000mm of material to the +x face',
  `${centre.fromInsideSolid} ${fmt(centre.spans[0]?.thicknessMm)}`);

// Lying exactly in the cube's face plane: the probes disagree by construction, and
// that disagreement IS the answer — a confident number here would be a lie.
const tangent = await probe({ meshes: [cube], from: [-30, -10, -10], direction: [1, 0, 0] });
check(tangent.probeAgreement < 1 && tangent.warnings.some((w) => w.includes('close to tangent')),
  'tangential ray (lying in a face plane): declared as ambiguous instead of answered',
  `agreement=${fmt(tangent.probeAgreement)} spans=${tangent.spans.length}`);

// --- 5. cross-part clearance -------------------------------------------------
const cross = await probe({ meshes: [shell, far], from: [-30, 0, 0], direction: [1, 0, 0] });
check(cross.watertightA === true && cross.watertightB === true, 'cross-part: both solids watertight');
check(cross.spans.length === 3, 'cross-part: three spans along the line', `got ${cross.spans.length}`);
check(close(cross.spans[2]?.thicknessMm, 20.0), 'cross-part: part b is the full 20.000mm cube', fmt(cross.spans[2]?.thicknessMm));
const crossGap = cross.gaps.find((g) => g.between === 'a→b');
check(close(crossGap?.gapMm, 5.0), 'cross-part: the a→b gap is 5.000mm', fmt(crossGap?.gapMm));
check(cross.gaps.some((g) => g.between === 'same-part' && close(g.gapMm, 16.0)),
  'cross-part: the cavity inside part a is still tagged same-part');

// --- 6. open mesh ------------------------------------------------------------
const openOut = await probe({ meshes: [open], from: [-30, 0, 0], direction: [1, 0, 0] });
check(openOut.watertightA === false, 'open mesh: watertightA is false');
check(openOut.warnings.some((w) => w.includes('NOT watertight')),
  'open mesh: the loud warning is present', JSON.stringify(openOut.warnings));

// --- 7. clipping, miss, error paths ------------------------------------------
const clipped = await probe({ meshes: [shell], from: [-30, 0, 0], direction: [1, 0, 0], maxSpanMm: 21 });
check(clipped.clipped === true && clipped.spans.length === 1 && clipped.spans[0].clipped === true,
  'maxSpanMm: the walk stops at 21mm and the cut span is flagged',
  JSON.stringify(clipped.spans.map((s) => [s.enterMm, s.exitMm, !!s.clipped])));

const miss = await probe({ meshes: [tube], from: [-20, 0, 500], direction: [1, 0, 0] });
check(miss.spans.length === 0 && miss.warnings.some((w) => w.includes('crosses no material')),
  'a ray that misses: no spans, and a warning that says how to fix the aim');

for (const [label, params] of [
  ['zero direction', { meshes: [cube], from: [0, 0, 0], direction: [0, 0, 0] }],
  ['no mesh', { meshes: [], from: [0, 0, 0], direction: [1, 0, 0] }],
]) {
  let failed = false;
  try {
    await probe(params);
  } catch {
    failed = true;
  }
  check(failed, `error path: ${label} raises instead of returning a made-up number`);
}

// --- 8. a real corpus part ---------------------------------------------------
const real = join(REPO, 'examples', 'microscope2', 'cad-data', 'versions', 'v010', 'model.stl');
if (existsSync(real)) {
  const realOut = await probe({ meshes: [real], from: [0, 0, 400], direction: [0, 0, -1] });
  check(realOut.spans.length > 0, 'real corpus part: a -z probe finds material',
    `${realOut.spans.length} span(s), thinnest ${fmt(realOut.thinnestSpanMm)}mm`);
  check(realOut.watertightA === true, 'real corpus part: watertight');
} else {
  console.log(`SKIP  real corpus part  — ${real} not found`);
}

await resetPythonWorker();
console.log(`\n${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}  (fixtures in ${dir})`);
process.exit(failures === 0 ? 0 : 1);
