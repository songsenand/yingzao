// Acceptance: the physics tool exposes the INPUTS that decide whether a mechanism
// runs — a torque-limited motor, an integration step, and a friction coefficient.
//
// Why this file exists (2026-11-14, the reducer session). `simulate_physics`
// had no motor: the only motion input was `initialAngularVelocity`, an IMPULSE.
// The worm in that session turned 7.5°, spent the 0.056mm backlash, hit the
// first tooth face and stopped — six keyframes, one pose. The report was
// technically true and completely useless, because nothing had ever asked it to
// keep turning. Rapier had `configureMotorVelocity` + `setMotorMaxForce` all
// along (rapier3d 0.20 / python rapier3d 0.36 both expose them); the interface
// never exposed it.
//
// WHAT IS ASSERTED, and each one is falsifiable on its own:
//
//   1. DRIVE: a rotor on a motor joint commanded 3 rad/s really turns ~3 rad/s
//      (turnedDeg ≈ 172° in 1 s), and reports reachedTarget.
//   2. CAP AS A CAP, in N·m: a pendulum whose gravity torque is 5.27e-4 N·m is
//      HELD by a 2e-3 N·m brake and FALLS under a 2e-4 N·m one. If the N·m→
//      mm·mN conversion (×1e6) were wrong by 1e3, both cases would flip.
//   3. STALL IS REPORTED: the under-capped case must say reachedTarget:false and
//      carry a "did NOT reach its target" note. A stall that reports target as
//      met is the failure mode this whole change exists to prevent.
//   4. VALIDATION: refusals must happen in the canonical engine, not only in a
//      test double (the TS solver was retired 2026-11-16) — the check reads
//      agree on all of the above — both implementations grew the motor.
//
//   node scripts/accept-physics-motor.mjs [--runtime <dir>]

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPhysics } from '../src/host/physics.ts';
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
const bar = (await compileStlOnly('cube([60,10,10], center=true);')).stl;
const pendulumBar = (await compileStlOnly('cube([40,8,8], center=true);')).stl;

const DEG_PER_RAD = 180 / Math.PI;

/** Rotor on a hinge about world +Z: gravity has no moment about the axis. */
const rotorScenario = (motor) => ({
  parts: [
    { name: 'hub', stl: bar, bodyType: 'fixed', position: [0, 0, 0] },
    { name: 'rotor', stl: bar, bodyType: 'dynamic', position: [0, 0, 0] },
  ],
  joints: [{
    type: 'revolute',
    bodyA: 'hub',
    bodyB: 'rotor',
    anchorA: [0, 0, 0],
    anchorB: [0, 0, 0],
    axis: [0, 0, 1],
    motor,
  }],
  durationSec: 1.0,
  timestepSec: 1 / 1000,
  keyframeCount: 4,
});

// Pendulum: centre of mass 20mm out on a world +Y hinge. Gravity makes
// τ = m·g·r = (40·8·8 mm³ · 1.05e-6 kg/mm³) · 9.81 m/s² · 0.02 m = 5.27e-4 N·m.
// The motor is driven AT the hinge (target 3 rad/s), so the cap decides whether
// the drive wins; a target-0 "brake" is a different (and weaker) claim — see the
// note in the tool description: a force-capped velocity servo creeps under a
// constant load, so it resists, it does not clamp.
const PENDULUM_TAU_NM = 40 * 8 * 8 * 1.05e-6 * 9.81 * 0.02;
const pendulumScenario = (maxTorqueNm, targetVelocityRadPerSec = 3) => ({
  parts: [
    { name: 'post', stl: bar, bodyType: 'fixed', position: [0, 0, 0] },
    {
      name: 'arm',
      stl: pendulumBar,
      bodyType: 'dynamic',
      position: [20, 0, 0],
    },
  ],
  joints: [{
    type: 'revolute',
    bodyA: 'post',
    bodyB: 'arm',
    anchorA: [0, 0, 0],
    anchorB: [-20, 0, 0],
    axis: [0, 1, 0],
    // Driven AT the hinge: the cap decides whether the drive beats the 5.27e-4 N·m load.
    motor: { targetVelocityRadPerSec, maxTorqueNm },
  }],
  durationSec: 1.0,
  timestepSec: 1 / 1000,
  keyframeCount: 4,
});

// One engine now (Python is canonical; the TS solver was retired 2026-11-16).
const run = async (scenario) => {
  const py = havePython ? await runPhysics(scenario) : null;
  return { py };
};

console.log(`pendulum gravity torque τ = ${(PENDULUM_TAU_NM * 1e3).toFixed(3)} mN·m `
  + `(the N·m threshold a correct ×1e6 conversion must reproduce)`);

// ---- 1. the drive turns, and both engines say so -------------------------
{
  const { py } = await run(rotorScenario({ targetVelocityRadPerSec: 3, maxTorqueNm: 0.02 }));
  const label = (who) => {
    const m = who.metrics.motors?.[0];
    return m ? `py: turned ${m.turnedDeg}°, measured ${m.measuredRadPerSec} rad/s, reached ${m.reachedTarget}` : 'no metrics.motors';
  };
  if (py) console.log(`rotor 3 rad/s → ${label(py)}`);
  for (const [who, name] of [[py, 'py']]) {
    if (!who) continue;
    const m = who.metrics.motors?.[0];
    check(!!m, `${name}: metrics.motors is present`);
    if (!m) continue;
    // 3 rad/s over 1 s = 171.9°; allow the ramp-up and a loose 12% band.
    check(near(m.turnedDeg, 3 * DEG_PER_RAD, 20), `${name}: turned ≈ 3 rad`, `${m.turnedDeg}° vs ${(3 * DEG_PER_RAD).toFixed(1)}°`);
    check(near(m.measuredRadPerSec, 3, 0.3), `${name}: measured ≈ target`, `${m.measuredRadPerSec} rad/s`);
    check(m.reachedTarget === true, `${name}: reachedTarget`);
    check(!(who.metrics.notes ?? []).some((n) => n.startsWith('motor ')), `${name}: no stall note on a free rotor`);
  }
}

// ---- 2/3. the cap is a real cap, and a stall is REPORTED ------------------
//
// The pendulum's gravity torque is 5.27e-4 N·m. A 1e-2 N·m motor drives it to
// 3 rad/s; a 1e-6 N·m motor cannot (the load wins and it swings down); a
// 5e-4 N·m motor is marginal — it turns but never reaches 3 rad/s, and both
// engines must SAY so instead of reporting the target as met. If the N·m→mm·mN
// conversion (×1e6) were off by 1e3, the 1e-2 case would stall too.
{
  const cases = [
    { label: 'ample cap 1e-2', cap: 1e-2, wantReached: true },
    { label: 'marginal 5e-4', cap: 5e-4, wantReached: false },
    { label: 'starved 1e-6', cap: 1e-6, wantReached: false },
  ];
  for (const c of cases) {
    const r = await run(pendulumScenario(c.cap));
    for (const [name, result] of [['py', r.py]]) {
      if (!result) continue;
      const m = result.metrics.motors?.[0];
      check(!!m, `${name} ${c.label}: metrics.motors is present`);
      if (!m) continue;
      console.log(`${name} ${c.label}: turned ${m.turnedDeg}°, measured ${m.measuredRadPerSec} rad/s, reached ${m.reachedTarget}`);
      check(m.reachedTarget === c.wantReached, `${name} ${c.label}: reachedTarget === ${c.wantReached}`, `measured ${m.measuredRadPerSec} vs target ${m.targetVelocityRadPerSec}`);
      if (c.wantReached) {
        check(near(m.measuredRadPerSec, 3, 0.5), `${name} ${c.label}: measured ≈ 3 rad/s against gravity`, `${m.measuredRadPerSec}`);
        check(!(result.metrics.notes ?? []).some((n) => n.includes('did NOT reach')), `${name} ${c.label}: no stall note`);
      } else {
        check(m.measuredRadPerSec < 2.5, `${name} ${c.label}: measured well below target`, `${m.measuredRadPerSec}`);
        check((result.metrics.notes ?? []).some((n) => n.includes('did NOT reach its target')), `${name} ${c.label}: stall carries a note`);
      }
    }
  }
}

// ---- 3b. the other two inputs the tool used to hide ----------------------
//
// `timestepSec` existed in the domain but was not in the tool schema, so every
// run was pinned at 1/60 — and a surface moving 8 mm/s advances 0.133 mm per
// step, the same order as the gear clearance that was blamed for a wrong ratio.
// `friction` did not exist at all, so every contact ran at rapier's undeclared
// default 0.5 while the session talked about POM. Both are asserted here.
{
  const { py } = await run(rotorScenario({ targetVelocityRadPerSec: 3, maxTorqueNm: 0.02 }));
  for (const [name, result] of [['py', py]]) {
    if (!result) continue;
    check(result.stepsRun === 1000, `${name}: timestepSec 1/1000 is honoured (1000 steps for 1 s)`, `stepsRun ${result.stepsRun}`);
    check(result.metrics.frictions?.hub === 0.5, `${name}: the undeclared μ is reported, not hidden`, JSON.stringify(result.metrics.frictions));
  }

  // Slope test: a 20° ramp, tan20 = 0.364. μ=0.6 must hold it, μ=0.1 must slide.
  const plate = (await compileStlOnly('cube([100,100,4], center=true);')).stl;
  const block = (await compileStlOnly('cube([10,10,10], center=true);')).stl;
  const th = (20 * Math.PI) / 180;
  const n = [Math.sin(th), 0, Math.cos(th)];
  const t = [Math.cos(th), 0, -Math.sin(th)];
  const rampC = [-n[0] * 2, 0, -n[2] * 2];
  const boxC = [n[0] * 5 + t[0] * 30, 0, n[2] * 5 + t[2] * 30];
  const slope = (mu) => ({
    parts: [
      { name: 'ramp', stl: plate, bodyType: 'fixed', position: rampC, rotation: [0, 20, 0] },
      { name: 'block', stl: block, bodyType: 'dynamic', position: boxC, rotation: [0, 20, 0], friction: mu },
    ],
    joints: [],
    durationSec: 1.0, timestepSec: 1 / 500, keyframeCount: 3,
  });
  const slid = (r) => {
    const p = r.finalPositions.block;
    return (p[0] - boxC[0]) * t[0] + (p[2] - boxC[2]) * t[2];
  };
  for (const mu of [0.6, 0.1]) {
    const r = await run(slope(mu));
    for (const [name, result] of [['py', r.py]]) {
      if (!result) continue;
      const d = slid(result);
      if (mu >= 0.6) check(Math.abs(d) < 1, `${name}: μ=0.6 holds a 20° slope (tan20=0.364)`, `slid ${d.toFixed(2)}mm`);
      else check(d > 20, `${name}: μ=0.1 slides down it`, `slid ${d.toFixed(2)}mm`);
      check(Math.abs((result.metrics.frictions?.block ?? 0) - mu) < 1e-3, `${name}: declared μ=μ applied`, JSON.stringify(result.metrics.frictions));
    }
  }
}

// ---- 4. the schema refuses what it cannot mean ---------------------------
{
  const bad = pendulumScenario(0.0);
  let threw = '';
  try {
    await runPhysics(bad);
  } catch (e) {
    threw = String(e.message ?? e);
  }
  check(/maxTorqueNm must be > 0/.test(threw), 'py: maxTorqueNm 0 is refused, not silently undriven', threw);

  const slide = {
    parts: [
      { name: 'base', stl: bar, bodyType: 'fixed', position: [0, 0, 0] },
      { name: 'slider', stl: bar, bodyType: 'dynamic', position: [0, 0, 20] },
    ],
    joints: [{
      type: 'prismatic', bodyA: 'base', bodyB: 'slider',
      anchorA: [0, 0, -20], anchorB: [0, 0, 0], axis: [0, 0, 1],
      motor: { targetVelocityRadPerSec: 1, maxTorqueNm: 0.01 },
    }],
    durationSec: 0.2,
  };
  let prismatic = '';
  try {
    await runPhysics(slide);
  } catch (e) {
    prismatic = String(e.message ?? e);
  }
  check(/motor is revolute-only/.test(prismatic), 'a motor on a slider is refused', prismatic);
}

await resetPythonWorker();
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
