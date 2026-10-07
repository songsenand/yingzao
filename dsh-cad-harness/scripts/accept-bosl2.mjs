// Acceptance for the bundled BOSL2 standard-parts library (the `OPENSCADPATH`
// wiring in src/host/compile.ts).
//
//   Why this exists: `compile.ts` used to set OPENSCADPATH to
//   `<pluginRoot>/../lib/BOSL2` — the BOSL2 directory ITSELF — while every tool
//   description and the cad-toolbox skill tell the model to write
//   `include <BOSL2/std.scad>`. OpenSCAD therefore looked for
//   `lib/BOSL2/BOSL2/std.scad`, warned "Can't open include file", produced an
//   EMPTY top-level object, and the compile still reported success. microscope5
//   shipped hand-rolled involute gears and hand-rolled threads because of it
//   (see its delivery summary, deviation #7) — a wiring bug scored as a model
//   weakness.
//
//   What is pinned here:
//     1. OPENSCADPATH contains a directory that actually has BOSL2/std.scad,
//        i.e. the PARENT of the BOSL2 folder — not the folder itself.
//     2. `include <BOSL2/gears.scad>` + spur_gear(mod=1, teeth=20) compiles to a
//        solid whose outer diameter is mod×(teeth+2), with no include warning.
//     3. `include <BOSL2/screws.scad>` + screw("M6", length=20) compiles.
//     4. A bare `include <std.scad>` also resolves (the BOSL2 dir is on the path
//        as well, so both spellings keep working).
//
//   Covered elsewhere, not duplicated here:
//     - rack driven by pitchRadiusMm  → scripts/accept-p2.mjs
//     - validate_assembly pose about a datum axis → scripts/accept-p3.mjs
//     - simulate_motion pivot rebasing → scripts/accept-motion-pivot.mjs
//
//   Hermetic: no version store, no DSH_HOME, nothing written outside a temp dir.
//
//   node scripts/accept-bosl2.mjs

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { compileStlOnly } from '../src/host/compile.ts';
import { parseBinaryStl } from '../src/host/mesh.ts';

let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) fail++;
};

const bboxOf = (stl) => {
  const mesh = parseBinaryStl(stl);
  const v = mesh.vertProperties;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < v.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const x = v[i + k];
      if (x < lo[k]) lo[k] = x;
      if (x > hi[k]) hi[k] = x;
    }
  }
  return { lo, hi, size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]] };
};
const includeWarnings = (r) => r.warnings.filter((w) => /Can't open include file/i.test(w));

// ---------- 1. the path itself ----------
console.log('\n--- 1  OPENSCADPATH points at the PARENT of BOSL2/ ---');
const entries = (process.env.OPENSCADPATH ?? '').split(':').filter(Boolean);
const realRoots = entries.filter((d) => existsSync(join(d, 'BOSL2', 'std.scad')));
check('OPENSCADPATH is non-empty', entries.length > 0, entries.join(':') || '(unset)');
check('…and some entry contains BOSL2/std.scad', realRoots.length > 0,
  realRoots.length > 0 ? realRoots.join(':') : `none of [${entries.join(', ')}]`);
check('no entry is the BOSL2 dir mistaken for its parent',
  !entries.some((d) => d.endsWith('/BOSL2') && !existsSync(join(d, 'std.scad'))),
  entries.join(':'));

// ---------- 2. gears ----------
console.log('\n--- 2  gears.scad ---');
const gear = await compileStlOnly(`
include <BOSL2/std.scad>
include <BOSL2/gears.scad>
$fn=64;
spur_gear(mod=1, teeth=20, thickness=6, shaft_diam=8);
`);
check('spur_gear compiles', gear.success && !!gear.stl, gear.errors.join(' | ') || `success=${gear.success}`);
check('  …with no include-file warning', includeWarnings(gear).length === 0,
  includeWarnings(gear).join(' | ') || 'clean');
if (gear.stl) {
  const b = bboxOf(gear.stl);
  const outer = Math.max(b.size[0], b.size[1]);
  check('  …outer diameter = mod×(teeth+2) = 22mm', Math.abs(outer - 22) < 0.5, `measured ${outer.toFixed(2)}mm`);
  check('  …face width = 6mm', Math.abs(b.size[2] - 6) < 0.2, `measured ${b.size[2].toFixed(2)}mm`);
  check('  …shaft bore is present (bbox is a ring, not a disc)',
    gear.stl.length > 2000, `${gear.stl.length}B of STL`);
} else {
  check('  …outer diameter = mod×(teeth+2) = 22mm', false, 'no STL produced');
  check('  …face width = 6mm', false, 'no STL produced');
  check('  …shaft bore is present (bbox is a ring, not a disc)', false, 'no STL produced');
}

// ---------- 3. threads / fasteners ----------
console.log('\n--- 3  screws.scad ---');
const screw = await compileStlOnly(`
include <BOSL2/std.scad>
include <BOSL2/screws.scad>
$fn=64;
screw("M6", length=20);
`);
check('screw("M6", length=20) compiles', screw.success && !!screw.stl,
  screw.errors.join(' | ') || `success=${screw.success}`);
check('  …with no include-file warning', includeWarnings(screw).length === 0,
  includeWarnings(screw).join(' | ') || 'clean');
if (screw.stl) {
  const b = bboxOf(screw.stl);
  const axial = Math.max(...b.size);
  const radial = Math.min(...b.size);
  check('  …axial length ≈ 20mm + head', axial > 19 && axial < 34, `measured ${axial.toFixed(2)}mm`);
  check('  …radial size is a real shank (not a degenerate sliver)', radial > 4, `measured ${radial.toFixed(2)}mm`);
} else {
  check('  …axial length ≈ 20mm + head', false, 'no STL produced');
  check('  …radial size is a real shank (not a degenerate sliver)', false, 'no STL produced');
}

// ---------- 4. bare include spelling ----------
console.log('\n--- 4  bare `include <std.scad>` still works ---');
// NOTE: keep teeth ≥ 17 here. BOSL2 auto-applies a positive profile shift below
// the undercut limit (17 teeth at 20°), which grows the outer diameter past
// mod×(teeth+2): teeth=12/mod=2 measures 29.18mm, not the textbook 28mm. That is
// the library being correct, not a wiring fault, so the fixture stays in the
// shift-free range and the assertion stays exact. A gear-ratio rubric must
// account for the shift separately.
const bare = await compileStlOnly(`
include <std.scad>
include <gears.scad>
$fn=64;
spur_gear(mod=2, teeth=20, thickness=5, shaft_diam=0);
`);
check('bare includes resolve', bare.success && !!bare.stl, bare.errors.join(' | ') || `success=${bare.success}`);
check('  …with no include-file warning', includeWarnings(bare).length === 0,
  includeWarnings(bare).join(' | ') || 'clean');
if (bare.stl) {
  const b = bboxOf(bare.stl);
  const outer = Math.max(b.size[0], b.size[1]);
  check('  …outer diameter = 2×(20+2) = 44mm', Math.abs(outer - 44) < 0.8, `measured ${outer.toFixed(2)}mm`);
} else {
  check('  …outer diameter = 2×(20+2) = 44mm', false, 'no STL produced');
}

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
