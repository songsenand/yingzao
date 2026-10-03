// M3.6 step-1 probe: slider-crank mechanism smoke (rapier revolute+prismatic+motor).
//
// Pure mechanism, no gravity, no part-part contacts: crank spins via a joint
// velocity motor, the rod and piston FOLLOW through the constraint chain —
// piston motion must emerge as correct slider-crank kinematics:
//   x(θ) = R·cosθ + √(L² − R²sin²θ),  travel = 2R, period = 2π/ω.
//
// Asserts: travel ≈ 2R, x-range ≈ [L−R, L+R], crank ω on target, piston
// period matches crank, joint anchor drift < 1mm, piston stays on axis.

import RAPIER from '@dimforge/rapier3d-compat';
await RAPIER.init();

const R = 20, L = 60, OMEGA = 10;          // crank radius / rod length (mm), rad/s
const DT = 1 / 2000, SIM = 1.5, STEPS = Math.round(SIM / DT);
const V = (x, y, z) => ({ x, y, z });

const world = new RAPIER.World(V(0, 0, 0)); // no gravity — mechanism, not dynamics
world.timestep = DT;

const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
// Drive: kinematic velocity crank — exact ω, infinite inertia, joints follow.
// (Joint motor with configureMotorVelocity works but saturates under load at
// ~3-4.6 rad/s regardless of factor in this unit scale; kept as the optional
// torque-limited/jam-detection mode for later steps. Measured empirically.)
const crank = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicVelocityBased().setTranslation(0, 0, 0));
crank.setAngvel(V(0, 0, OMEGA));
const rod = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(R + L / 2, 0, 0).setCanSleep(false));
world.createCollider(RAPIER.ColliderDesc.cuboid(L / 2, 2, 2).setDensity(0.01), rod);
const piston = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(R + L, 0, 0).setCanSleep(false));
world.createCollider(RAPIER.ColliderDesc.cuboid(5, 8, 8).setDensity(0.01), piston);

const j1 = world.createImpulseJoint(RAPIER.JointData.revolute(V(0, 0, 0), V(0, 0, 0), V(0, 0, 1)), ground, crank, true);
const j2 = world.createImpulseJoint(RAPIER.JointData.revolute(V(R, 0, 0), V(-L / 2, 0, 0), V(0, 0, 1)), crank, rod, true);
const j3 = world.createImpulseJoint(RAPIER.JointData.revolute(V(0, 0, 0), V(L / 2, 0, 0), V(0, 0, 1)), piston, rod, true);
const j4 = world.createImpulseJoint(RAPIER.JointData.prismatic(V(R + L, 0, 0), V(0, 0, 0), V(1, 0, 0)), ground, piston, true);
for (const j of [j1, j2, j3, j4]) if (typeof j.setContactsEnabled === 'function') j.setContactsEnabled(false);

const driveMode = 'kinematicVelocityBased crank (exact ω)';
console.log(`drive: ${driveMode}`);

// quat rotate helper (v' = q v q*)
const rot = (q, v) => {
  const { x, y, z, w } = q;
  const ux = y * v.z - z * v.y, uy = z * v.x - x * v.z, uz = x * v.y - y * v.x;
  return {
    x: v.x + 2 * (w * ux + (y * uz - z * uy)),
    y: v.y + 2 * (w * uy + (z * ux - x * uz)),
    z: v.z + 2 * (w * uz + (x * uy - y * ux)),
  };
};
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

const xs = [];
// unwrap the HALF-angle (atan2 ∈ (-π,π]) then double — unwrapping 2*atan2
// directly loses 2π per revolution (d jumps by 4π at the branch cut).
let hPrev = 0, thetaAcc = 0, thetaAt30 = 0;
const tailFrom = Math.floor(STEPS * 0.4);

for (let i = 0; i < STEPS; i++) {
  world.step();
  xs.push(piston.translation().x);
  const q = crank.rotation();
  const h = Math.atan2(q.z, q.w);
  let d = h - hPrev;
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  thetaAcc += 2 * d;
  hPrev = h;
  if (i === tailFrom) thetaAt30 = thetaAcc;
}

// measurements over the tail (post spin-up)
const tail = xs.slice(tailFrom);
const xmax = Math.max(...tail), xmin = Math.min(...tail);
const travel = xmax - xmin;
const tTail = (STEPS - tailFrom) * DT;
const omegaMeas = (thetaAcc - thetaAt30) / tTail;
const Tref = 2 * Math.PI / omegaMeas;
// piston period via mean gap between local maxima in the tail
const maxima = [];
for (let i = 1; i < tail.length - 1; i++) {
  if (tail[i] > tail[i - 1] && tail[i] >= tail[i + 1]) maxima.push(i);
}
const gaps = [];
for (let k = 1; k < maxima.length; k++) gaps.push((maxima[k] - maxima[k - 1]) * DT);
const Tmeas = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : NaN;

// joint anchor drift at the end
const pinCrank = add(crank.translation(), rot(crank.rotation(), V(R, 0, 0)));
const pinRodA = add(rod.translation(), rot(rod.rotation(), V(-L / 2, 0, 0)));
const pinRodB = add(rod.translation(), rot(rod.rotation(), V(L / 2, 0, 0)));
const pinPiston = piston.translation();
const drift1 = dist(pinCrank, pinRodA);
const drift2 = dist(pinRodB, pinPiston);
const p = piston.translation();

console.log(`travel=${travel.toFixed(2)}mm (expect ≈40)  x∈[${xmin.toFixed(2)}, ${xmax.toFixed(2)}] (expect ≈[40, 80])`);
console.log(`ω_meas=${omegaMeas.toFixed(2)}rad/s (target ${OMEGA})  T_piston=${Tmeas?.toFixed(4)}s vs 2π/ω=${Tref.toFixed(4)}s`);
console.log(`anchor drift: crank-pin=${drift1.toFixed(4)}mm  rod-piston=${drift2.toFixed(4)}mm  piston y/z=(${p.y.toFixed(4)}, ${p.z.toFixed(4)})`);

let fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
  if (!ok) fail++;
};
check('travel ≈ 2R', Math.abs(travel - 2 * R) < 2, `Δ=${(travel - 2 * R).toFixed(2)}mm`);
check('x-range ≈ [L−R, L+R]', Math.abs(xmin - (L - R)) < 1.5 && Math.abs(xmax - (L + R)) < 1.5, `Δmin=${(xmin - (L - R)).toFixed(2)} Δmax=${(xmax - (L + R)).toFixed(2)}`);
check('crank ω on target ±10%', Math.abs(omegaMeas - OMEGA) / OMEGA < 0.1, `dev=${((omegaMeas - OMEGA) / OMEGA * 100).toFixed(1)}%`);
check('piston period matches crank ±10%', Math.abs(Tmeas - Tref) / Tref < 0.1, `dev=${((Tmeas - Tref) / Tref * 100).toFixed(1)}%`);
check('joint drift < 1mm', drift1 < 1 && drift2 < 1, `${Math.max(drift1, drift2).toFixed(3)}mm`);
check('piston on axis', Math.abs(p.y) < 0.5 && Math.abs(p.z) < 0.5, `y=${p.y.toFixed(3)} z=${p.z.toFixed(3)}`);

console.log(fail === 0 ? '\nM3.6 STEP-1 SMOKE PASSED' : `\nM3.6 STEP-1 SMOKE FAILED (${fail})`);
process.exit(fail === 0 ? 0 : 1);
