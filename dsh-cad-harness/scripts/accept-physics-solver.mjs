// Acceptance: gear contact isolation is REPORTED as such, and solver knobs take effect.
//
// Two things the 64:1 gearbox session exposed:
//  1. A gear-joint run reports "penetration 0" because the pair's contact is
//     DISABLED by the coupling — that is not evidence about the teeth, and the
//     note used to lump gear pairs in with "bearing clearance is design intent".
//  2. The solver knobs (iterations, CCD substeps) did not exist, so the only
//     visible lever was timestepSec — and `metrics` did not even record the
//     settings a penetration number was produced with.
//
//   node scripts/accept-physics-solver.mjs [--runtime <dir>]

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runPhysics } from '../src/host/physics.ts';
import { compileStlOnly } from '../src/host/compile.ts';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const REPO = resolve(import.meta.dirname, '..', '..');
const args = process.argv.slice(2);
const ri = args.indexOf('--runtime');
if (ri >= 0) process.env.DSH_CAD_PYTHON_ROOT = resolve(args[ri + 1]);

const FROG = join(REPO, 'examples', 'windup-frog', 'cad-data', 'versions');
const drumPath = join(FROG, 'v043', 'model.stl');
const gearPath = join(FROG, 'v045', 'model.stl');
const haveFrog = existsSync(drumPath) && existsSync(gearPath);
const cube = (await compileStlOnly('cube([4,4,4], center=true);')).stl;

const scene = async (extra = {}) => ({
  parts: [
    { name: 'hubA', stl: cube, bodyType: 'fixed', position: [4, 0, 10] },
    { name: 'hubB', stl: cube, bodyType: 'fixed', position: [15.691, 8.183, 15] },
    { name: 'drum', stl: new Uint8Array(await readFile(drumPath)), bodyType: 'dynamic', position: [0, 0, 0] },
    { name: 'gearB', stl: new Uint8Array(await readFile(gearPath)), bodyType: 'dynamic', position: [0, 0, 0] },
  ],
  joints: [
    { type: 'revolute', bodyA: 'hubA', bodyB: 'drum', anchorA: [0, 0, 0], anchorB: [4, 0, 10], axis: [0, 0, 1],
      motor: { targetVelocityRadPerSec: 2, maxTorqueNm: 1 } },
    { type: 'revolute', bodyA: 'hubB', bodyB: 'gearB', anchorA: [0, 0, 0], anchorB: [15.691, 8.183, 15], axis: [0, 0, 1] },
    { type: 'gear', bodyA: 'drum', bodyB: 'gearB', ratio: -3, axis: [0, 0, 1] },
  ],
  durationSec: 0.2,
  timestepSec: 1 / 500,
  keyframeCount: 2,
  gravity: [0, 0, 0],
  ...extra,
});

if (!haveFrog) {
  console.log(`SKIP  no frog corpus at ${FROG}`);
} else {
  // ---- 1. a gear pair is isolated, and the report says WHY -----------------
  for (const [name, fn] of [['py', runPhysics]]) {
    const r = await fn(await scene());
    const gearNote = (r.metrics.notes ?? []).find((n) => /gear pair/i.test(n));
    check(r.metrics.gearContactsDisabled?.includes('drum~gearB') === true,
      `${name}: the gear pair is listed as isolated BY THE COUPLING`,
      JSON.stringify(r.metrics.gearContactsDisabled));
    check(Boolean(gearNote), `${name}: a gear-specific note is emitted`);
    check(Boolean(gearNote) && /contact DISABLED/.test(gearNote) && /not evidence that the teeth clear/.test(gearNote),
      `${name}: the note says 0 penetration is not tooth evidence`);
    check(Boolean(gearNote) && !/bearing clearance/.test(gearNote),
      `${name}: it is NOT described as a designed bearing clearance`);
    check(!(r.metrics.notes ?? []).some((n) => /jointed pairs do not collide/.test(n) && /drum~gearB/.test(n)),
      `${name}: the bearing-clearance note no longer claims the gear pair`);
  }

  // ---- 2. solver knobs are applied AND recorded ---------------------------
  for (const [name, fn] of [['py', runPhysics]]) {
    const def = await fn(await scene());
    check(def.metrics.solver?.solverIterations === 4 && def.metrics.solver?.ccdSubsteps === 1,
      `${name}: defaults are echoed (4 iterations, 1 CCD substep)`, JSON.stringify(def.metrics.solver));
    const tuned = await fn(await scene({ solverIterations: 16, ccdSubsteps: 4 }));
    check(tuned.metrics.solver?.solverIterations === 16 && tuned.metrics.solver?.ccdSubsteps === 4,
      `${name}: raised settings are echoed, so the run is reproducible`, JSON.stringify(tuned.metrics.solver));
    const clamped = await fn(await scene({ solverIterations: 0, ccdSubsteps: 0 }));
    check(clamped.metrics.solver?.solverIterations === 1 && clamped.metrics.solver?.ccdSubsteps === 1,
      `${name}: out-of-range values clamp instead of being ignored`, JSON.stringify(clamped.metrics.solver));
  }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
