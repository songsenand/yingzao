// Truth acceptance for `measure_section` (a NEW op: analytic ground truth).
//
// What is asserted, and why:
//
//   1. a plate with two bores, cut at mid-height: ONE material polygon of the right
//      area, TWO holes with the right diameters and centres, the exact
//      segment-to-segment wall from each hole to the outside (4.000 / 6.000), and
//      the hole-to-hole spacing (40 centre / 30 clearance);
//   2. the plane's own frame is reported and is the natural one (a +z cut gives
//      u=x, v=y), so a follow-up measurement can be written in world coordinates;
//   3. an annular cut reports the wall directly: a Ø26/Ø20 tube cut across its axis
//      gives one polygon with one hole whose wallToOuterMm is the 3.000mm wall;
//   4. a rectangular pocket is `non-circular` with ring points instead of a diameter;
//   5. VOIDS ARE NOT MATERIAL: the disc inside a bore comes back as a void region,
//      not as a second polygon (this is the `representative_point` rule, and getting
//      it wrong would report the hole as a part);
//   6. a plane that misses the solid says so instead of returning an empty section
//      that reads like "nothing there";
//   7. `atMm` beats `fraction`, and the valid range is reported;
//   8. a real corpus part sections without error.
//
//   node scripts/accept-measure-section.mjs [--runtime <dir>]

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
const close = (a, b, tolerance = 0.02) => Math.abs(a - b) <= tolerance;
const fmt = (value) => (typeof value === 'number' ? value.toFixed(3) : JSON.stringify(value));

const { compileStlOnly } = await import('../src/host/compile.ts');
const dir = await mkdtemp(join(REPO, '.tmp-measure-section-'));
const write = async (name, code) => {
  const built = await compileStlOnly(code);
  if (!built.success) throw new Error(`${name} did not compile: ${built.errors?.join('; ')}`);
  const path = join(dir, `${name}.stl`);
  await writeFile(path, built.stl);
  return path;
};

const plate = await write('plate', 'difference(){ cube([60,40,10], center=true);'
  + ' translate([-20,0,0]) cylinder(h=20, d=8, center=true, $fn=64);'
  + ' translate([20,0,0]) cylinder(h=20, d=12, center=true, $fn=64); }');
const tube = await write('tube', 'difference(){ cylinder(h=20, d=26, center=true, $fn=64);'
  + ' cylinder(h=21, d=20, center=true, $fn=64); }');
const slot = await write('slot', 'difference(){ cube([40,40,10], center=true);'
  + ' translate([10,0,0]) cube([10,6,20], center=true); }');

const worker = await ensurePythonWorker();
const section = (path, extra = {}) => worker.request('measure_section', { path, ...extra });

// --- 1. the plate, cut at mid-height -----------------------------------------
const out = await section(plate, { axis: 'z' });
check(out.empty === false, 'plate: the plane cuts the solid');
check(out.polygons.length === 1, 'plate: exactly one material polygon', `got ${out.polygons.length}`);
const material = out.polygons[0];
check(close(material?.areaMm2, 2236.9, 0.5),
  'plate: the polygon area is 2400 minus both bores (2236.9mm²)', fmt(material?.areaMm2));
check(material?.outer.pointsUv.length === 4 && material?.outer.closed === true,
  'plate: the outer ring is a closed 4-corner rectangle', `${material?.outer.pointsUv.length} points`);
check(JSON.stringify(material?.outer.segmentsMm) === JSON.stringify([40, 60, 40, 60]),
  'plate: the ring\'s segment lengths are 40/60/40/60', JSON.stringify(material?.outer.segmentsMm));
check(material?.outer.anglesDeg.every((angle) => angle === 0 || angle === 90),
  'plate: every ring segment is axis-aligned in the plane frame', JSON.stringify(material?.outer.anglesDeg));
check(material?.holes.length === 2, 'plate: both holes are found', `got ${material?.holes.length}`);
const big = material?.holes.find((hole) => close(hole.diameterMm, 12, 0.05));
const small = material?.holes.find((hole) => close(hole.diameterMm, 8, 0.05));
check(!!big && !!small, 'plate: the hole diameters are 12 and 8',
  material?.holes.map((hole) => fmt(hole.diameterMm)).join(' / '));
check(big && close(big.enclosingDiameterMm, 12.0, 0.01),
  'plate: the circumscribed Ø12.000 is reported beside the least-squares fit',
  `fit ${fmt(big?.diameterMm)} vs enclosing ${fmt(big?.enclosingDiameterMm)}`);
check(big && close(big.centerUv[0], 20) && close(big.centerUv[1], 0),
  'plate: the Ø12 hole is centred at (20, 0) in the plane frame', JSON.stringify(big?.centerUv));
check(small && close(small.centerUv[0], -20) && close(small.centerUv[1], 0),
  'plate: the Ø8 hole is centred at (-20, 0)', JSON.stringify(small?.centerUv));
check(big && close(big.wallToOuterMm, 4.0) && small && close(small.wallToOuterMm, 6.0),
  'plate: the wall from each hole to the outside is 4.000 / 6.000mm',
  `${fmt(big?.wallToOuterMm)} / ${fmt(small?.wallToOuterMm)}`);
check(material?.holes.every((hole) => hole.kind === 'round' && hole.areaRatioToCircle > 0.99),
  'plate: both holes read as round with a near-unit area ratio');
const spacing = out.holeSpacing[0];
check(out.holeSpacing.length === 1 && close(spacing?.centerDistanceMm, 40) && close(spacing?.clearanceMm, 30),
  'plate: hole spacing is 40.000 centre-to-centre and 30.000 clear',
  JSON.stringify(spacing && { c: spacing.centerDistanceMm, g: spacing.clearanceMm }));

// --- 2. the plane frame and the void accounting ------------------------------
check(JSON.stringify(out.uAxisMm) === JSON.stringify([1, 0, 0]) && JSON.stringify(out.vAxisMm) === JSON.stringify([0, 1, 0]),
  'plate: a +z cut reports u=x, v=y (a natural frame, not an arbitrary one)',
  `${JSON.stringify(out.uAxisMm)} ${JSON.stringify(out.vAxisMm)}`);
check(JSON.stringify(out.axisMm) === JSON.stringify([0, 0, 1]) && close(out.atMm, 0),
  'plate: the section plane is z=0 by default (mid-height)', `at=${out.atMm}`);
check(JSON.stringify(out.planeRangeMm) === JSON.stringify([-5, 5]),
  'plate: the valid atMm range is reported as [-5, 5]', JSON.stringify(out.planeRangeMm));
check(out.voidRegions === 2,
  'plate: the two bore discs are VOIDS, not material polygons', `voidRegions=${out.voidRegions}`);
const world = big?.centerWorldMm;
check(!!world && close(world[2], 0) && close(world[0], 20),
  'plate: the hole centre is also given in world coordinates', JSON.stringify(world));

// --- 3. the annular cut: wall thickness for free ------------------------------
const tubeOut = await section(tube, { axis: 'z' });
const tubePoly = tubeOut.polygons[0];
check(tubeOut.polygons.length === 1 && tubeOut.voidRegions === 1,
  'tube: one material ring plus the bore as a void',
  `polys=${tubeOut.polygons.length} voids=${tubeOut.voidRegions}`);
check(tubePoly && close(tubePoly.areaMm2, Math.PI * (13 * 13 - 10 * 10), 1.0),
  'tube: the annulus area is π(13²−10²) ≈ 216.8mm²', fmt(tubePoly?.areaMm2));
check(tubePoly && close(tubePoly.holes[0]?.wallToOuterMm, 3.0),
  'tube: the section reports the 3.000mm wall directly', fmt(tubePoly?.holes[0]?.wallToOuterMm));
check(tubePoly && close(tubePoly.holes[0]?.enclosingDiameterMm, 20.0, 0.002),
  'tube: the bore is Ø20.000 circumscribed', fmt(tubePoly?.holes[0]?.enclosingDiameterMm));

// --- 4. a rectangular pocket -------------------------------------------------
const slotOut = await section(slot, { axis: 'z' });
const pocket = slotOut.polygons[0]?.holes[0];
check(!!pocket && pocket.kind === 'non-circular' && pocket.diameterMm === undefined,
  'slot: reported as non-circular, with no diameter invented', JSON.stringify(pocket && { kind: pocket.kind }));
check(pocket && Array.isArray(pocket.pointsUv) && pocket.pointsUv.length === 4,
  'slot: a non-circular hole carries its own ring points', `${pocket?.pointsUv?.length} points`);
check(pocket && close(pocket.wallToOuterMm, 5.0),
  'slot: the wall from the pocket to the outside is 5.000mm', fmt(pocket?.wallToOuterMm));
check(slotOut.voidRegions === 1, 'slot: the pocket interior is a void, not a polygon',
  `voids=${slotOut.voidRegions}`);

// --- 5. a plane that misses, and atMm vs fraction -----------------------------
const miss = await section(plate, { axis: 'z', atMm: 100 });
check(miss.empty === true && miss.polygons.length === 0
  && miss.warnings.some((w) => w.includes('does not cut')),
  'an off-part plane is empty AND says why', JSON.stringify(miss.warnings));
const near = await section(plate, { axis: 'z', fraction: 0.4 });
check(close(near.atMm, -1), 'fraction 0.4 of [-5, 5] cuts at z=-1', fmt(near.atMm));
const explicit = await section(plate, { axis: 'z', atMm: 3 });
check(close(explicit.atMm, 3), 'atMm beats fraction', fmt(explicit.atMm));
const fromX = await section(plate, { axis: 'x' });
check(fromX.polygons.length === 1 && close(fromX.polygons[0].areaMm2, 400)
  && fromX.polygons[0].holes.length === 0,
  'a side cut (x=0) misses the bores and reports the 40×10 face',
  `area=${fmt(fromX.polygons[0]?.areaMm2)} holes=${fromX.polygons[0]?.holes.length}`);
const signed = await section(plate, { axis: '-z' });
check(JSON.stringify(signed.axisMm) === JSON.stringify([0, 0, -1]) && close(signed.atMm, 0),
  'a signed axis flips the normal', JSON.stringify(signed.axisMm));

// --- 6. error paths ----------------------------------------------------------
for (const [label, extra] of [['a non-axis string', { axis: 'diagonal' }], ['a fraction of 2', { fraction: 2 }]]) {
  let raised = false;
  try {
    await section(plate, extra);
  } catch {
    raised = true;
  }
  check(raised, `error path: ${label} raises instead of guessing`);
}

// --- 7. a real corpus part ---------------------------------------------------
const real = join(REPO, 'examples', 'microscope2', 'cad-data', 'versions', 'v010', 'model.stl');
if (existsSync(real)) {
  const realOut = await section(real, { axis: 'z' });
  check(realOut.empty === false && realOut.polygons.length > 0,
    'real corpus part: a mid-height cut yields material polygons',
    `polys=${realOut.polygons.length} holes=${realOut.holeCount} voids=${realOut.voidRegions}`);
  check(realOut.polygons.every((polygon) => polygon.outer.pointsUv.length === polygon.outer.segmentsMm.length),
    'real corpus part: every ring point has its segment length recorded');
  // A single height can legitimately miss every bore, so the claim under test is
  // "some cut through this part finds its holes", swept rather than assumed.
  const swept = [];
  for (const fraction of [0.15, 0.3, 0.45, 0.6, 0.75, 0.9]) {
    swept.push(await section(real, { axis: 'z', fraction }));
  }
  const withHoles = swept.filter((cut) => cut.holeCount > 0);
  check(withHoles.length > 0,
    'real corpus part: swept cuts find holes with walls to the outside',
    withHoles.map((cut) => `${cut.holeCount} hole(s), min wall ${fmt(Math.min(...cut.polygons.flatMap((p) => p.holes.map((h) => h.wallToOuterMm))))}`).join(' | ') || 'none found');
} else {
  console.log(`SKIP  real corpus part  — ${real} not found`);
}

await resetPythonWorker();
console.log(`\n${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}  (fixtures in ${dir})`);
process.exit(failures === 0 ? 0 : 1);
