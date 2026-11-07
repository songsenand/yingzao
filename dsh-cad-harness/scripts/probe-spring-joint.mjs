#!/usr/bin/env node
// Probe: what does rapier 0.20's native `JointData.spring` actually do in the
// harness's mm / kg / s unit system?
//
// Not a benchmark. Three questions, each with a configuration whose answer is
// known independently:
//   1. UNIT: a 1 kg mass hung on a 1 N/mm spring must extend 9.81 mm.
//      (rapier is unit-agnostic; force is kg·mm/s² = mN, so k=1 N/mm is 1000
//       internal stiffness units, not 1.)
//   2. UNIT TRAP: passing k=1 (reading "1 N/mm" as the raw number) must fall
//      through by ~1000x; if it settles, the unit story is wrong.
//   3. DAMPING / EQUILIBRIUM: the same spring started at its rest length with
//      c = 2√(km) (critical damping) should settle at -19.81 mm. The probe
//      records where it actually settles, because the solver is a constraint
//      solver, not a validated force element.
//
// Run: cd dsh-cad-harness && node scripts/probe-spring-joint.mjs

import RAPIER from '@dimforge/rapier3d-compat';

await RAPIER.init();

const G = -9810;        // mm/s², the harness default
const DT = 1 / 240;     // s
const MASS_KG = 1;

function run({ k, c, startZ, seconds = 8, g = G, dt = DT, rest = 10 }) {
  const world = new RAPIER.World({ x: 0, y: 0, z: g });
  world.timestep = dt;
  const fixed = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const dyn = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0, startZ).setCanSleep(false),
  );
  // 10 mm cube, density 1e-3 kg/mm³ -> exactly 1 kg.
  world.createCollider(RAPIER.ColliderDesc.cuboid(5, 5, 5).setDensity(1e-3), dyn);
  world.createImpulseJoint(
    RAPIER.JointData.spring(rest, k, c, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }),
    fixed, dyn, true,
  );
  const trace = [];
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    world.step();
    if (i % Math.round(1 / dt) === 0) trace.push(+dyn.translation().z.toFixed(3));
  }
  return {
    massKg: +dyn.mass().toFixed(4),
    finalZmm: +dyn.translation().z.toFixed(3),
    speedMmPerS: +Math.hypot(dyn.linvel().x, dyn.linvel().y, dyn.linvel().z).toFixed(3),
    traceEachSecondMm: trace,
  };
}

const kUnit = 1000;                 // 1 N/mm in mm/kg/s
const cCritical = 2 * Math.sqrt(kUnit * MASS_KG);

const results = {
  units: 'mm, kg, s; force unit = kg·mm/s² = mN; 1 N/mm = 1000 internal stiffness',
  massKg: MASS_KG,
  restLengthMm: 10,
  gravityMmPerS2: G,
  timestepSec: DT,
  expectedStaticExtensionMm: +(MASS_KG * Math.abs(G) / kUnit).toFixed(3),
  cases: [
    {
      id: 'unit-correct',
      note: 'k=1000 (=1 N/mm), c=10, started at rest length',
      ...run({ k: kUnit, c: 10, startZ: 10 }),
    },
    {
      id: 'unit-trap',
      note: 'k=1 (=1/1000 N/mm if read as a raw catalog number), c=0, started at rest length',
      ...run({ k: 1, c: 0, startZ: 10 }),
    },
    {
      id: 'critical-damping-at-rest',
      note: 'k=1000, c=2√(km)=63.2, started at rest length',
      ...run({ k: kUnit, c: cCritical, startZ: 10 }),
    },
    {
      id: 'critical-damping-stretched',
      note: 'k=1000, c=63.2, started stretched at z=20',
      ...run({ k: kUnit, c: cCritical, startZ: 20 }),
    },
    {
      id: 'subcritical-control',
      note: 'k=1000, c=49 (<2√(km)), started at rest length',
      ...run({ k: kUnit, c: 49, startZ: 10 }),
    },
  ],
};

console.log(JSON.stringify(results, null, 2));
