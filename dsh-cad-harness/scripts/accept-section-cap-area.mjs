// Does the cut face equal the cross-section? — measured against an independent oracle.
//
// The acceptance that existed before this script only asked "is the cap non-empty",
// "is it smaller than its own hull". A cap with spikes, a gap, or a bore punched out by
// a mis-nested loop passes both. This one compares the cap's AREA with the area
// computed from the intersection segments without building loops (see
// `scripts/lib/section-oracle.mjs`, which self-tests against closed-form cube values
// before it judges anything).
//
// Geometry: the probe parts in `examples/section-probe/` (built by
// `scripts/lib/section-probe.mjs`) plus the corpus parts, because the probe carries the
// specific hazards (a flat face flush with the plane, a boss wall, a fork, holes, a
// thin web) that the corpus parts do not.
//
// The sweep deliberately includes planes that COINCIDE with a flat face: the cut plane
// lands exactly on the slab's top (z = 3) and on the knuckle's plate top (z = 6), which
// is the case that produced the user's "black crack" screenshots.
//
//   node scripts/accept-section-cap-area.mjs            # probes + corpus
//   node scripts/accept-section-cap-area.mjs --verbose

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { capTrianglesOnPlane } from '../src/client/section.ts';
import { capArea, capCentroid, crossSectionArea, crossSectionCentroid } from './lib/section-oracle.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const verbose = process.argv.includes('--verbose');
const loader = new STLLoader();

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

function load(file) {
  const stl = readFileSync(file);
  const geometry = loader.parse(stl.buffer.slice(stl.byteOffset, stl.byteOffset + stl.byteLength));
  geometry.computeBoundingBox();
  return geometry;
}

/** Sweep one geometry with a normal, at depths INCLUDING the faces a cut can land on. */
function sweep(label, geometry, normalRaw, extraDepths = []) {
  const length = Math.hypot(...normalRaw);
  const normal = normalRaw.map((v) => v / length);
  const box = geometry.boundingBox;
  const centre = box.getCenter(new (geometry.boundingBox.min.constructor)());
  const size = box.getSize(new (geometry.boundingBox.min.constructor)()).length();
  const half = size / 2;
  const depths = [-0.9, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 0.9, ...extraDepths];
  let worst = 0;
  let worstDepth = null;
  // The area check is translation-invariant: a cap of the right shape floating
  // 40 mm inside the plane passes it (that WAS the 2026-11-27 bug). The centroid
  // is the assertion that can tell "on the cut" from "near the cut".
  let worstCentreMm = 0;
  let worstCentreDepth = null;
  let checked = 0;
  for (const frac of depths) {
    const offset = frac * half;
    const plane = {
      pointMm: [centre.x + normal[0] * offset, centre.y + normal[1] * offset, centre.z + normal[2] * offset],
      normal,
    };
    const cap = capTrianglesOnPlane(geometry, plane);
    const expected = crossSectionArea(geometry, plane);
    const actual = capArea(cap);
    if (expected < 1e-6 && actual < 1e-6) continue;
    checked++;
    const error = expected > 1e-6 ? Math.abs(actual - expected) / expected : Infinity;
    const expectedCentre = crossSectionCentroid(geometry, plane);
    const actualCentre = capCentroid(cap);
    // A grazing plane's centroid is numerically meaningless (area → 0) and a plane
    // ON a flat face has a cap the oracle area cannot describe; both are the area
    // check's business, not the centroid's.
    const centreError = expected >= 1 && expectedCentre && actualCentre
      ? Math.hypot(
        actualCentre[0] - expectedCentre[0],
        actualCentre[1] - expectedCentre[1],
        actualCentre[2] - expectedCentre[2],
      )
      : 0;
    if (verbose) {
      console.log(`    ${label} ${normalRaw.join(',')} frac ${frac.toFixed(3)}: expected ${expected.toFixed(3)} actual ${actual.toFixed(3)} (${(error * 100).toFixed(2)}%), centroid off ${centreError.toFixed(4)} mm`);
    }
    if (error > worst) { worst = error; worstDepth = frac; }
    if (centreError > worstCentreMm) { worstCentreMm = centreError; worstCentreDepth = frac; }
  }
  check(worst < 0.01,
    `${label}: cap area equals the cross-section`,
    `${checked} depths · worst ${(worst * 100).toFixed(2)}% at frac ${worstDepth}`);
  // 0.05 mm on a 200 mm part is 0.025 % — far looser than the arithmetic (float64
  // moments agree to ~1e-9) and far tighter than any real translation (the bug
  // moved caps by tens of millimetres). The size-scaled floor keeps it honest for
  // a part whose coordinates are large.
  check(worstCentreMm <= Math.max(0.05, size * 1e-4),
    `${label}: the cap SITS ON the cross-section (centroid, not just area)`,
    `${checked} depths · worst ${worstCentreMm.toFixed(4)} mm at frac ${worstCentreDepth}`);
}

console.log('section cap area acceptance\n');

// The probes: the hazards the corpus lacks.
for (const name of ['slab', 'knuckle']) {
  const geometry = load(join(REPO, 'examples', 'section-probe', `${name}.stl`));
  // Depths chosen so the plane lands exactly ON the flat faces of each probe:
  // slab top rim z = 3, knuckle plate top z = 6 (its normal-z sweep includes both once
  // the bbox is known, so these are stated as fractions of the bbox diagonal).
  for (const [label, normal] of [
    ['z', [0, 0, 1]],
    ['view-like', [0.858, 0.111, -0.502]],
    ['iso', [0.577, 0.577, 0.577]],
    ['grazing', [0.99, 0.05, 0.1]],
  ]) {
    sweep(`${name} ${label}`, geometry, normal);
  }
}

// The same probe, moved 150 mm off the origin. A plane that is not parallel to an
// axis has a point with a component along u and v, and the 2026-11-27 bug projected
// the cut to (point·u, point·v) even when it was already in the plane's frame: the
// cap was the right size in the wrong place. At the origin that projection is zero,
// which is why every probe and corpus test above can be blind to it.
{
  const geometry = load(join(REPO, 'examples', 'section-probe', 'knuckle.stl'));
  geometry.translate(120, -80, 60);
  for (const [label, normal] of [
    ['view-like', [0.858, 0.111, -0.502]],
    ['iso', [0.577, 0.577, 0.577]],
  ]) {
    sweep(`knuckle moved +120,−80,+60 ${label}`, geometry, normal);
  }
}

// The corpus parts, for real tessellation.
const DATA = join(REPO, 'examples', 'microscope5', 'cad-data');
let versions = [];
try {
  versions = JSON.parse(readFileSync(join(DATA, 'manifest.json'), 'utf8')).versions;
} catch {
  versions = [];
}
for (const partId of ['p010', 'p005', 'p003', 'p011']) {
  const own = versions.filter((v) => v.partId === partId);
  if (own.length === 0) continue;
  const version = own[own.length - 1];
  const file = join(DATA, 'versions', version.id, 'model.stl');
  let geometry;
  try {
    geometry = load(file);
  } catch {
    continue;
  }
  for (const [label, normal] of [
    ['z', [0, 0, 1]],
    ['view-like', [0.858, 0.111, -0.502]],
  ]) {
    sweep(`${partId} ${version.id} ${label}`, geometry, normal);
  }
}

console.log(failures ? `\naccept-section-cap-area: ${failures} FAILURE(S)` : '\naccept-section-cap-area: PASS');
process.exit(failures ? 1 : 0);
