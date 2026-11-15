// Acceptance: `gear` — a ratio coupling between two shafts.
//
// WHY THIS EXISTS. Two projects hit the same wall from opposite sides: the
// reducer's 12:1 worm gear could not be driven by tooth contact (the worm
// stalled at 0.4–1.35 rad/s against a 2 rad/s target, even at μ=0 and a fine
// timestep), and the windup frog's "perfect" numbers were kinematic sweeps at
// prescribed poses — a gear train was never actually driven. Asking a contact
// solver to rediscover a ratio that is a design fact is the wrong division of
// labour: the ratio belongs to a constraint, contact belongs to "do the teeth
// collide / is it jammed".
//
// WHAT IS ASSERTED, each falsifiable on its own:
//
//   1. The ratio is EXACT and TIMESTEP-INDEPENDENT: a real 30T→10T pair modelled
//      with ratio -3 reports measuredRatio = -3.0000 at both 1/60 and 1/1000.
//      (An earlier impulse-based coupling measured -2.97 / -2.53 — that is why
//      this one is a projection, and why the report says PRESCRIBED.)
//   2. The two bodies of a gear pair do not collide: two deliberately OVERLAPPING
//      parts coupled by `gear` report 0 penetration. Without the isolation they
//      would report the whole overlap.
//   3. The worm case works: the reducer's real 1:12 pair reports -1/12 with the
//      worm driven at 2 rad/s (skipped when that corpus is absent).
//   4. The coupling refuses what it cannot mean: ratio 0 / missing is refused.
//
//   node scripts/accept-physics-gear.mjs [--runtime <dir>]

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPhysics, runPhysicsInTs } from '../src/host/physics.ts';
import { resetPythonWorker } from '../src/host/python-worker.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const REPO = resolve(ROOT, '..');
const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const runtime = resolve(argOf('--runtime', join(REPO, '.tmp-measure-runtime')));
const venvPython = process.platform === 'win32'
  ? join(runtime, 'venv', 'Scripts', 'python.exe')
  : join(runtime, 'venv', 'bin', 'python');
const havePython = existsSync(venvPython);
if (havePython) process.env.DSH_CAD_PYTHON_ROOT = runtime;

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const { compileStlOnly } = await import('../src/host/compile.ts');
const cube = (await compileStlOnly('cube([4,4,4], center=true);')).stl;

const run = async (scenario) => ({
  py: havePython ? await runPhysics(scenario) : null,
  ts: await runPhysicsInTs(scenario),
});

// ---- 1/2. a real spur pair: exact ratio, dt-independent, and isolated -------
{
  const FROG = join(REPO, 'examples', 'windup-frog', 'cad-data', 'versions');
  const drum = join(FROG, 'v043', 'model.stl');
  const gearB = join(FROG, 'v045', 'model.stl');
  if (!existsSync(drum) || !existsSync(gearB)) {
    console.log(`SKIP  no frog corpus at ${FROG}`);
  } else {
    const { readFileSync } = await import('node:fs');
    const drumStl = new Uint8Array(readFileSync(drum));
    const gearBStl = new Uint8Array(readFileSync(gearB));
    const pair = (dt, overlap) => ({
      parts: [
        { name: 'hubA', stl: cube, bodyType: 'fixed', position: [4, 0, 10] },
        { name: 'hubB', stl: cube, bodyType: 'fixed', position: [15.691, 8.183, 15] },
        { name: 'drum', stl: drumStl, bodyType: 'dynamic', position: overlap ? [3, 0, 0] : [0, 0, 0] },
        { name: 'gearB', stl: gearBStl, bodyType: 'dynamic', position: [0, 0, 0] },
      ],
      joints: [
        { type: 'revolute', bodyA: 'hubA', bodyB: 'drum', anchorA: [0, 0, 0], anchorB: [4 - (overlap ? 3 : 0), 0, 10], axis: [0, 0, 1],
          motor: { targetVelocityRadPerSec: 2, maxTorqueNm: 1 } },
        { type: 'revolute', bodyA: 'hubB', bodyB: 'gearB', anchorA: [0, 0, 0], anchorB: [15.691, 8.183, 15], axis: [0, 0, 1] },
        { type: 'gear', bodyA: 'drum', bodyB: 'gearB', ratio: -3, axis: [0, 0, 1] },
      ],
      durationSec: 0.5,
      timestepSec: dt,
      keyframeCount: 4,
      gravity: [0, 0, 0],
    });

    for (const dt of [1 / 60, 1 / 1000]) {
      const r = await run(pair(dt, false));
      for (const [name, result] of [['TS', r.ts], ['py', r.py]]) {
        if (!result) continue;
        const g = result.metrics.gears?.[0];
        check(!!g, `${name} dt=${(1 / dt).toFixed(0)}Hz: gears present`);
        if (!g) continue;
        // 30T driving 10T: three turns per turn, opposite sign.
        check(near(g.measuredRatio, -3, 5e-3), `${name} dt=${(1 / dt).toFixed(0)}Hz: measuredRatio = -3`, `${g.measuredRatio}`);
        check(near(g.turnedBDeg, -3 * g.turnedADeg, 0.1), `${name}: turnedB = 3x turnedA`, `${g.turnedBDeg} vs ${g.turnedADeg}`);
        check(result.metrics.contactsDisabled?.includes('drum~gearB'), `${name}: the pair is isolated from contacts`);
      }
    }

    // Overlapping on purpose: with isolation the run must still be clean.
    const r = await run(pair(1 / 1000, true));
    for (const [name, result] of [['TS', r.ts], ['py', r.py]]) {
      if (!result) continue;
      check(result.metrics.maxPenetrationMm === 0, `${name}: overlapping gear pair reports 0 penetration (isolation works)`, `${result.metrics.maxPenetrationMm}mm`);
    }
  }
}

// ---- 2b. more than a full turn must not alias -------------------------------
//
// The first version computed A's angle from the total rotation with 2·atan2,
// whose range is (−π, π]: past HALF a turn the follower jumped to the other
// side. The 64:1 gearbox saw its output "shake in place" at 6400 rpm. A run
// longer than a revolution is now the regression test.
{
  const FROG = join(REPO, 'examples', 'windup-frog', 'cad-data', 'versions');
  const drum = join(FROG, 'v043', 'model.stl');
  const gearB = join(FROG, 'v045', 'model.stl');
  if (!existsSync(drum) || !existsSync(gearB)) {
    console.log(`SKIP  no frog corpus at ${FROG}`);
  } else {
    const { readFileSync } = await import('node:fs');
    const drumStl = new Uint8Array(readFileSync(drum));
    const gearBStl = new Uint8Array(readFileSync(gearB));
    const scenario = {
      parts: [
        { name: 'hubA', stl: cube, bodyType: 'fixed', position: [4, 0, 10] },
        { name: 'hubB', stl: cube, bodyType: 'fixed', position: [15.691, 8.183, 15] },
        { name: 'drum', stl: drumStl, bodyType: 'dynamic', position: [0, 0, 0] },
        { name: 'gearB', stl: gearBStl, bodyType: 'dynamic', position: [0, 0, 0] },
      ],
      joints: [
        { type: 'revolute', bodyA: 'hubA', bodyB: 'drum', anchorA: [0, 0, 0], anchorB: [4, 0, 10], axis: [0, 0, 1],
          motor: { targetVelocityRadPerSec: 3, maxTorqueNm: 1 } },
        { type: 'revolute', bodyA: 'hubB', bodyB: 'gearB', anchorA: [0, 0, 0], anchorB: [15.691, 8.183, 15], axis: [0, 0, 1] },
        { type: 'gear', bodyA: 'drum', bodyB: 'gearB', ratio: -3, axis: [0, 0, 1] },
      ],
      durationSec: 2.5, // 3 rad/s × 2.5 s ≈ 430° — past the old ±180° boundary, twice
      timestepSec: 1 / 1000,
      keyframeCount: 4,
      gravity: [0, 0, 0],
    };
    const r = await run(scenario);
    for (const [name, result] of [['TS', r.ts], ['py', r.py]]) {
      if (!result) continue;
      const g = result.metrics.gears?.[0];
      check(!!g, `${name}: >360° run has a gear entry`);
      if (!g) continue;
      check(Math.abs(g.turnedADeg) > 400, `${name}: the driver really turned past a revolution`, `${g.turnedADeg}°`);
      check(near(g.measuredRatio, -3, 5e-3), `${name}: ratio stays exact past 360° (no aliasing)`, `${g.measuredRatio}`);
      check(!(result.metrics.notes ?? []).some((n) => n.includes('per step')), `${name}: no aliasing note at 1/1000`, (result.metrics.notes ?? []).join(' | '));
    }
  }
}

// ---- 3. the 1:12 worm pair that started this ---------------------------------
{
  const P = '/home/songsenand/Project/reducer/cad-data/versions';
  const worm = join(P, 'v016', 'model.stl');
  const wheel = join(P, 'v014', 'model.stl');
  if (!existsSync(worm) || !existsSync(wheel)) {
    console.log(`SKIP  no reducer corpus at ${P} (external project)`);
  } else {
    const { readFileSync } = await import('node:fs');
    const wormStl = new Uint8Array(readFileSync(worm));
    const wheelStl = new Uint8Array(readFileSync(wheel));
    const scenario = {
      parts: [
        { name: 'hubWorm', stl: cube, bodyType: 'fixed', position: [0, 0, 21.5] },
        { name: 'hubWheel', stl: cube, bodyType: 'fixed', position: [0, 0, 11.5] },
        { name: 'worm', stl: wormStl, bodyType: 'dynamic', position: [0, 0, 0] },
        { name: 'wheel', stl: wheelStl, bodyType: 'dynamic', position: [0, 0, 0] },
      ],
      joints: [
        { type: 'revolute', bodyA: 'hubWorm', bodyB: 'worm', anchorA: [0, 0, 0], anchorB: [0, 0, 21.5], axis: [1, 0, 0],
          motor: { targetVelocityRadPerSec: 2, maxTorqueNm: 0.5 } },
        { type: 'revolute', bodyA: 'hubWheel', bodyB: 'wheel', anchorA: [0, 0, 0], anchorB: [0, 0, 11.5], axis: [0, 1, 0] },
        { type: 'gear', bodyA: 'worm', bodyB: 'wheel', ratio: -1 / 12, axisA: [1, 0, 0], axisB: [0, 1, 0] },
      ],
      durationSec: 1.0,
      timestepSec: 1 / 1000,
      keyframeCount: 4,
      gravity: [0, 0, 0],
    };
    const r = await run(scenario);
    for (const [name, result] of [['TS', r.ts], ['py', r.py]]) {
      if (!result) continue;
      const g = result.metrics.gears?.[0];
      check(!!g, `${name}: worm pair gears present`);
      if (!g) continue;
      check(near(g.measuredRatio, -1 / 12, 1e-4), `${name}: worm pair measuredRatio = -1/12`, `${g.measuredRatio}`);
      check(result.metrics.maxPenetrationMm === 0, `${name}: worm/wheel mesh reports 0 penetration while coupled`);
      check(result.metrics.motors?.[0]?.reachedTarget === true, `${name}: the worm holds its commanded speed`, `${result.metrics.motors?.[0]?.measuredRadPerSec}`);
    }
  }
}

// ---- 4. refusals -------------------------------------------------------------
{
  const base = {
    parts: [
      { name: 'hubA', stl: cube, bodyType: 'fixed', position: [0, 0, 0] },
      { name: 'a', stl: cube, bodyType: 'dynamic', position: [0, 0, 0] },
      { name: 'b', stl: cube, bodyType: 'dynamic', position: [10, 0, 0] },
    ],
    joints: [
      { type: 'revolute', bodyA: 'hubA', bodyB: 'a', anchorA: [0, 0, 0], anchorB: [0, 0, 0], axis: [0, 0, 1] },
      { type: 'gear', bodyA: 'a', bodyB: 'b', ratio: 0, axis: [0, 0, 1] },
    ],
    durationSec: 0.2,
  };
  let threw = '';
  try {
    await runPhysicsInTs(base);
  } catch (e) {
    threw = String(e.message ?? e);
  }
  check(/non-zero ratio/.test(threw), 'ratio 0 is refused', threw);
}

await resetPythonWorker();
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
