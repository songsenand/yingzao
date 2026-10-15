// Truth acceptance for `list_features` (a NEW op: analytic ground truth, not parity).
//
// What is asserted, and why:
//
//   1. a plate with two bores — the exact face list (6 faces, right normals and
//      areas), the exact holes (Ø8 / Ø12, centres, through), and the exact
//      cylinders (bore, axis z, length 10). This is the fixture that makes
//      "the tool tells you where the holes are" a checkable claim;
//   2. bore quads must NOT appear as faces — every listed face's smooth region is
//      planar, and the curved facets are counted, not listed;
//   3. a BLIND hole reports its depth and through:false (the depth probe);
//   4. a shaft is a `boss`, not a `bore` (the normal-sign test);
//   5. a rectangular pocket is `non-circular` with no diameter invented for it;
//   6. an open mesh says so loudly;
//   7. a real corpus part yields features, and every listed face is planar;
//   8. a missing mesh raises instead of returning an empty inventory.
//
//   node scripts/accept-list-features.mjs [--runtime <dir>]

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
const close = (a, b, tolerance = 0.05) => Math.abs(a - b) <= tolerance;
const fmt = (value) => (typeof value === 'number' ? value.toFixed(3) : JSON.stringify(value));
const findFace = (out, normal, area) => out.faces.find((f) => f.normalMm.every((v, i) => close(v, normal[i], 0.02)) && close(f.areaMm2, area, 0.5));
const diameters = (out) => out.faces.flatMap((f) => f.holes).map((h) => h.diameterMm).filter((d) => d !== undefined).sort((a, b) => a - b);

const { compileStlOnly } = await import('../src/host/compile.ts');
const dir = await mkdtemp(join(REPO, '.tmp-list-features-'));
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
// Blind hole: outer z ∈ [-5,5], bore z ∈ [-1,7] ⇒ 6mm of material left under it.
const blind = await write('blind', 'difference(){ cube([40,40,10], center=true);'
  + ' translate([0,0,3]) cylinder(h=8, d=6, center=true, $fn=64); }');
const boss = await write('boss', 'union(){ cube([40,40,6], center=true);'
  + ' translate([0,0,8]) cylinder(h=10, d=10, center=true, $fn=64); }');
const slot = await write('slot', 'difference(){ cube([40,40,10], center=true);'
  + ' translate([10,0,0]) cube([10,6,20], center=true); }');
const open = await write('open',
  'polyhedron(points=[[-10,-10,-10],[10,-10,-10],[10,10,-10],[-10,10,-10],[-10,-10,10],[10,-10,10],[10,10,10],[-10,10,10]],'
  + ' faces=[[0,1,2,3],[4,5,6,7],[0,1,5,4],[2,3,7,6],[1,2,6,5]]);');

const worker = await ensurePythonWorker();
const features = (path, extra = {}) => worker.request('list_features', { path, ...extra });

// --- 1. the plate: faces, holes, cylinders -----------------------------------
const out = await features(plate);
check(out.watertight === true, 'plate: watertight');
check(out.faceCount === 6, 'plate: exactly six planar faces', `got ${out.faceCount}`);
const top = findFace(out, [0, 0, 1], 2236.9);
const bottom = findFace(out, [0, 0, -1], 2236.9);
check(!!top && !!bottom, 'plate: the two 60×40 faces come back with the right areas',
  `top=${fmt(top?.areaMm2)} bottom=${fmt(bottom?.areaMm2)}`);
check(top?.originMm[2] === 5 && bottom?.originMm[2] === -5, 'plate: those faces sit at z=+5 and z=-5',
  `top z=${top?.originMm[2]} bottom z=${bottom?.originMm[2]}`);
check(findFace(out, [1, 0, 0], 400) && findFace(out, [-1, 0, 0], 400)
  && findFace(out, [0, 1, 0], 600) && findFace(out, [0, -1, 0], 600),
  'plate: all four side faces come back with the right normals and areas');
check(top?.holes.length === 2 && bottom?.holes.length === 2, 'plate: each flat face carries two holes',
  `top=${top?.holes.length} bottom=${bottom?.holes.length}`);
check(JSON.stringify(diameters(out)) === JSON.stringify([8, 8, 12, 12]),
  'plate: the hole diameters are exactly 8/8/12/12', JSON.stringify(diameters(out)));
const centres = top?.holes.map((h) => h.centerMm.map((v) => Math.round(v))).map((c) => `${c[0]},${c[1]}`).sort();
check(JSON.stringify(centres) === JSON.stringify(['-20,0', '20,0']),
  'plate: the hole centres are at x=-20 and x=+20', JSON.stringify(centres));
check(top?.holes.every((h) => h.kind === 'round' && h.through === true && h.depthMm === undefined),
  'plate: both holes are round AND through (no depth invented)');
check(out.cylinderCount === 2, 'plate: exactly two cylindrical surfaces', `got ${out.cylinderCount}`);
const bores = out.cylinders.filter((c) => c.kind === 'bore');
check(bores.length === 2, 'plate: both cylinders are bores (not bosses)', JSON.stringify(out.cylinders.map((c) => c.kind)));
check(bores.every((c) => close(c.axisMm[2], 1, 0.01) && close(c.lengthMm, 10, 0.05)),
  'plate: both bores have the +z axis and length 10',
  bores.map((c) => `${JSON.stringify(c.axisMm)}/${fmt(c.lengthMm)}`).join(' '));
check(bores.some((c) => close(c.diameterMm, 8) && close(c.centerMm[0], -20) && close(c.centerMm[1], 0))
  && bores.some((c) => close(c.diameterMm, 12) && close(c.centerMm[0], 20) && close(c.centerMm[1], 0)),
  'plate: the bores are Ø8 at (-20,0) and Ø12 at (20,0)',
  bores.map((c) => `Ø${fmt(c.diameterMm)}@${c.centerMm.slice(0, 2).join(',')}`).join(' '));

// --- 2. bore quads are not faces ---------------------------------------------
check(out.faces.every((f) => f.smoothRegion.planar === true),
  'plate: every listed face belongs to a PLANAR smooth region');
check(out.curvedSegmentFacets === 64
  && out.cylinders.every((c) => close(c.areaMm2, Math.PI * c.diameterMm * c.lengthMm, 3)),
  'plate: curved segments are COUNTED, not listed as faces — and each bore\'s area is π·d·L',
  `curvedSegmentFacets=${out.curvedSegmentFacets} (Ø12 quads 5.89mm² ≥ 4, Ø8 quads 3.93mm² < 4); `
  + out.cylinders.map((c) => `Ø${fmt(c.diameterMm)} area ${fmt(c.areaMm2)} vs πdL ${fmt(Math.PI * c.diameterMm * c.lengthMm)}`).join('; '));
check(out.thresholds.minFaceAreaMm2 === 4 && out.thresholds.maxFaces === 40,
  'plate: the thresholds used are echoed back', JSON.stringify(out.thresholds));

// --- 3. blind hole -----------------------------------------------------------
const blindOut = await features(blind);
const blindHole = blindOut.faces.flatMap((f) => f.holes)[0];
check(!!blindHole && blindHole.through === false, 'blind hole: reported as NOT through');
check(close(blindHole?.depthMm, 6.0, 0.05), 'blind hole: depth is 6.000mm', fmt(blindHole?.depthMm));
check(close(blindHole?.diameterMm, 6.0), 'blind hole: diameter is 6.000mm', fmt(blindHole?.diameterMm));

// --- 4. boss vs bore ---------------------------------------------------------
const bossOut = await features(boss);
const shaft = bossOut.cylinders.find((c) => close(c.diameterMm, 10));
check(!!shaft && shaft.kind === 'boss', 'a shaft is a "boss", not a "bore"', JSON.stringify(bossOut.cylinders.map((c) => c.kind)));
check(close(shaft?.lengthMm, 10.0), 'shaft length is 10.000mm', fmt(shaft?.lengthMm));

// --- 5. a non-circular pocket ------------------------------------------------
const slotOut = await features(slot);
const pocket = slotOut.faces.flatMap((f) => f.holes)[0];
check(!!pocket && pocket.kind === 'non-circular',
  'a rectangular pocket is "non-circular" rather than a circle it is not',
  JSON.stringify(pocket && { kind: pocket.kind, ratio: pocket.areaRatioToCircle, residual: pocket.circularityResidualMm }));
check(pocket && pocket.diameterMm === undefined, 'a non-circular pocket invents no diameter');
check(pocket && pocket.through === true, 'the pocket goes through the plate');
check(pocket && pocket.areaRatioToCircle < 0.7,
  'a 10×6 pocket keeps only ~0.56 of its fitted circle — the number that unmasks it',
  fmt(pocket?.areaRatioToCircle));

// --- 5b. NON-CONVEX opening: the fitted-circle centre is not inside the opening --
// The depth probe used to start from the FITTED-CIRCLE centre, which on a non-convex
// opening lands in the material filling the missing corner: the probe hit material
// 25/25 times along the wall thickness and a genuinely THROUGH hole was reported blind.
// Measured 2026-10-13 with this exact fixture (a 40×40×6 plate with a through L slot):
// fitted centre -> through false, depthMm 0.001; an interior point -> through true.
const lSlot = await write('l-slot', 'difference(){ cube([40,40,6], center=true);'
  + ' cube([30,6,20], center=true);'
  + ' translate([-12,6,0]) cube([6,24,20], center=true); }');
const lOut = await features(lSlot);
const lHoles = lOut.faces.flatMap((f) => f.holes);
check(lHoles.length === 2 && lHoles.every((h) => h.kind === 'non-circular'),
  'L-shaped slot: both openings are reported, as non-circular',
  JSON.stringify(lHoles.map((h) => h.kind)));
check(lHoles.length === 2 && lHoles.every((h) => h.through === true),
  'THROUGH L-shaped slot is NOT called blind (the probe starts inside the opening)',
  JSON.stringify(lHoles.map((h) => ({ through: h.through, depthMm: h.depthMm }))));
check(lHoles.every((h) => h.depthMm === undefined),
  'THROUGH L-shaped slot reports no depth at all', JSON.stringify(lHoles.map((h) => h.depthMm)));

// --- 6. open mesh ------------------------------------------------------------
const openOut = await features(open);
check(openOut.watertight === false && openOut.warnings.some((w) => w.includes('NOT watertight')),
  'open mesh: watertight false plus the loud warning', JSON.stringify(openOut.warnings));

// --- 7. a real corpus part ---------------------------------------------------
const real = join(REPO, 'examples', 'microscope2', 'cad-data', 'versions', 'v010', 'model.stl');
if (existsSync(real)) {
  const realOut = await features(real);
  check(realOut.watertight === true && realOut.faceCount > 0 && realOut.cylinderCount > 0,
    'real corpus part: faces and cylinders found',
    `faces=${realOut.faceCount} holes=${realOut.holeCount} cyls=${realOut.cylinderCount}`);
  check(realOut.faces.every((f) => f.smoothRegion.planar === true),
    'real corpus part: every listed face is planar');
  check(realOut.cylinders.some((c) => c.kind === 'bore') && realOut.cylinders.every((c) => c.fitResidualMm <= 0.2),
    'real corpus part: at least one bore, and every cylinder fit is tight',
    realOut.cylinders.map((c) => `${c.kind}:Ø${fmt(c.diameterMm)}/${fmt(c.fitResidualMm)}`).slice(0, 4).join(' '));
  const sized = await features(real, { minFaceAreaMm2: 100 });
  check(sized.faces.length > 0 && sized.faces.every((f) => f.areaMm2 >= 100)
    && sized.thresholds.minFaceAreaMm2 === 100,
    'raising minFaceAreaMm2 filters the list and is reported back',
    `${realOut.faceCount} → ${sized.faceCount} faces, smallest listed ${fmt(Math.min(...sized.faces.map((f) => f.areaMm2)))}mm²`);
} else {
  console.log(`SKIP  real corpus part  — ${real} not found`);
}

// --- 7b. faces that trimesh's coplanar-facet pass leaves out ------------------
// REGRESSION for a real crash. The op built its face-to-facet map with `np.empty`, so
// a face that trimesh's facet pass leaves out carried UNINITIALISED memory into the
// connectivity graph and the run died with
//   `ValueError: axis 0 index 281479271743489 exceeds matrix dimension 84`
// (measured on a rackstack connector: 64 of 444 faces, all chamfer strips).
//
// The condition needs faces that BOTH fall outside the facet groups AND still appear
// in face_adjacency. Hand-built fixtures did not reproduce it: a coplanar micro-patch
// groups with its neighbours, a narrow strip is coplanar and groups too, and a
// degenerate triangle is dropped from the adjacency graph entirely (the old code
// survived that one). So the fixture is the REAL part, materialised on demand — and
// when it is absent this check SKIPS loudly rather than passing silently. To create it:
//
//   cd /home/songsenand/Project/ToyMarker/.tmp-04-corpus
//   git init rs && cd rs && git remote add origin https://github.com/jazwa/rackstack \
//     && git config core.sparseCheckout true && printf '*.scad\n' > .git/info/sparse-checkout \
//     && git fetch --depth 1 --filter=blob:none origin 8e296e935aad89a6d1a5023da79becc634c10c2d \
//     && git checkout FETCH_HEAD
//   openscad --export-format binstl -o ../out/stackConnectorBottom_P.bin.stl \
//     rack/print/stackConnectorBottom_P.scad
const corpusPart = join(REPO, '.tmp-04-corpus', 'out', 'stackConnectorBottom_P.bin.stl');
if (existsSync(corpusPart)) {
  const third = await features(corpusPart);
  check(third.warnings.some((w) => /no coplanar facet region/.test(w)),
    'a real third-party part with chamfer strips outside the facet groups: no crash, and it says so',
    third.warnings.find((w) => /coplanar facet/.test(w))?.slice(0, 84) ?? 'no such warning');
} else {
  console.log('SKIP  real third-party part (chamfer strips outside facet groups)'
    + ` — ${corpusPart} not materialised; the command is in this file`);
}

// --- 8. error path -----------------------------------------------------------
let raised = false;
try {
  await features(join(dir, 'does-not-exist.stl'));
} catch {
  raised = true;
}
check(raised, 'a missing mesh raises instead of returning an empty inventory');

await resetPythonWorker();
console.log(`\n${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}  (fixtures in ${dir})`);
process.exit(failures === 0 ? 0 : 1);
