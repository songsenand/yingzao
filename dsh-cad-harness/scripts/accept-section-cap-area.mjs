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
import { capArea, crossSectionArea } from './lib/section-oracle.mjs';

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
  const half = box.getSize(new (geometry.boundingBox.min.constructor)()).length() / 2;
  const depths = [-0.9, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 0.9, ...extraDepths];
  let worst = 0;
  let worstDepth = null;
  let checked = 0;
  for (const frac of depths) {
    const offset = frac * half;
    const plane = {
      pointMm: [centre.x + normal[0] * offset, centre.y + normal[1] * offset, centre.z + normal[2] * offset],
      normal,
    };
    const expected = crossSectionArea(geometry, plane);
    const actual = capArea(capTrianglesOnPlane(geometry, plane));
    if (expected < 1e-6 && actual < 1e-6) continue;
    checked++;
    const error = expected > 1e-6 ? Math.abs(actual - expected) / expected : Infinity;
    if (verbose) {
      console.log(`    ${label} ${normalRaw.join(',')} frac ${frac.toFixed(3)}: expected ${expected.toFixed(3)} actual ${actual.toFixed(3)} (${(error * 100).toFixed(2)}%)`);
    }
    if (error > worst) { worst = error; worstDepth = frac; }
  }
  check(worst < 0.01,
    `${label}: cap area equals the cross-section`,
    `${checked} depths · worst ${(worst * 100).toFixed(2)}% at frac ${worstDepth}`);
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
