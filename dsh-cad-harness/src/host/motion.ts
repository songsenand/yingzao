// M3.6: mechanism motion simulation — assembled parts move under a drive,
// verified via constraint solving (rapier) and an exact interference timeline
// (Manifold boolean per sampled pose).
//
// rapier is used purely as a constraint solver here:
//   - no colliders at all → no contact resolution; parts cannot "push through"
//     problems — spatial overlap is measured exactly by Manifold instead
//   - no gravity → mechanism kinematics, not dynamics (that is simulate_physics)
//   - dynamic bodies carry setAdditionalMass only (collider-less mass, verified)
// Drives:
//   - drive      : one kinematicVelocityBased body spinning at constant ω (crank)
//   - oscillators: kinematicPositionBased bodies on sinusoidal paths (valves)
// Everything else follows through revolute/prismatic joints.

import RAPIER from '@dimforge/rapier3d-compat';
import ManifoldModule from 'manifold-3d';
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensurePythonWorker, workerScratchDir } from './python-worker.ts';
import { parseBinaryStl } from './mesh.ts';
import { rotateVec } from './assembly-check.ts';
import type { PhysicsReport, PoseSample, Trajectory } from './physics.ts';

export interface MotionPartInput {
  name: string;
  stl: Uint8Array;
  bodyType: 'dynamic' | 'fixed' | 'kinematic';
  /** Placement in mm. */
  position: [number, number, number];
  /** Initial rotation, degrees XYZ. */
  rotation?: [number, number, number];
}

/**
 * Where a part's body goes so that re-basing its geometry on `pivot` leaves the
 * world pose unchanged: `position + R·pivot`, where R is the part's own initial
 * rotation.
 *
 * WHY R·pivot AND NOT pivot. The geometry is shifted by −pivot in the part's FILE
 * frame, but the body is then rotated by R, so the compensation has to be rotated
 * with it: R(local − p) + (pos + R·p) = R·local + pos. Using `pos + p` is correct
 * only when R·p = p — identity rotation, or a pivot sitting on the rotation axis —
 * and wrong by |p − R·p| otherwise. The toy-balance beam (R = 90° about x,
 * p = [0,84,5]) was off by 119.0mm: it sat 119mm from its own pin, its kinematic
 * body could not be pulled back, and the solver dragged both pans to the wrong
 * anchors while the run still reported "0 drift, 0 interference, pass".
 */
export function rebasedBodyPosition(
  position: number[],
  pivot: number[],
  rotation?: [number, number, number],
): [number, number, number] {
  const r = rotateVec([pivot[0]!, pivot[1]!, pivot[2]!], rotation);
  return [position[0]! + r[0]!, position[1]! + r[1]!, position[2]! + r[2]!];
}

export interface InitialJointGap {
  joint: string;
  /** Distance between the two anchors as the scenario is authored, mm. */
  gapMm: number;
}

/**
 * Measure every joint's anchor gap in the STARTING pose, and refuse a scenario that
 * is not assembled.
 *
 * A revolute joint constrains two anchor POINTS to coincide, so a scenario that
 * starts with them apart is simulated as the solver drags one body onto the other.
 * That is intended for the small authored gaps the warm-up absorbs — and ruinous
 * when the gap is a construction error, because then every number the run produces
 * (drift, interference, travel) describes a pose nobody designed. Measured after a
 * warm-up, drift reads ~0 in exactly that case; measured here, it cannot.
 *
 * A prismatic joint may legitimately start anywhere ALONG its axis: only the
 * perpendicular offset means the two bodies are not on one rail.
 */
/**
 * How far a joint anchor may drift over a run before the run's numbers stop being evidence.
 * Named once: it appeared as a bare `2` in the drift check, the clean verdict and the
 * default starting-gap tolerance, i.e. three places that could drift apart
 * (2026-10-23 audit, FIX-B6).
 */
export const JOINT_DRIFT_TOLERANCE_MM = 2;

export function assertAssembledAtStart(
  parts: MotionPartInput[],
  joints: MotionJointInput[],
  toleranceMm = 2,
): InitialJointGap[] {
  // G1 (2026-10-29): report EVERY unassembled joint in ONE refusal, each with its
  // gap and both world anchors — roberval's first attempt was refused for one 10mm
  // joint, "fixed", and residual mismatches on the OTHER joints only surfaced later
  // as 105mm of drift. One structured refusal closes that loop.
  const gaps: InitialJointGap[] = [];
  const broken: string[] = [];
  for (const j of joints) {
    const a = parts.find((p) => p.name === j.bodyA);
    const b = parts.find((p) => p.name === j.bodyB);
    if (!a || !b) continue;
    const ra = rotateVec([j.anchorA[0]!, j.anchorA[1]!, j.anchorA[2]!], a.rotation);
    const rb = rotateVec([j.anchorB[0]!, j.anchorB[1]!, j.anchorB[2]!], b.rotation);
    let dx = ra[0]! + a.position[0]! - (rb[0]! + b.position[0]!);
    let dy = ra[1]! + a.position[1]! - (rb[1]! + b.position[1]!);
    let dz = ra[2]! + a.position[2]! - (rb[2]! + b.position[2]!);
    if (j.type === 'prismatic') {
      const len = Math.hypot(j.axis[0]!, j.axis[1]!, j.axis[2]!) || 1;
      const ax = [j.axis[0]! / len, j.axis[1]! / len, j.axis[2]! / len];
      const along = dx * ax[0]! + dy * ax[1]! + dz * ax[2]!;
      dx -= along * ax[0]!; dy -= along * ax[1]!; dz -= along * ax[2]!;
    }
    const gapMm = Math.hypot(dx, dy, dz);
    gaps.push({ joint: `${j.bodyA}↔${j.bodyB}`, gapMm: +gapMm.toFixed(4) });
    if (gapMm > toleranceMm) {
      const wa = [ra[0]! + a.position[0]!, ra[1]! + a.position[1]!, ra[2]! + a.position[2]!];
      const wb = [rb[0]! + b.position[0]!, rb[1]! + b.position[1]!, rb[2]! + b.position[2]!];
      broken.push(
        `joint ${j.bodyA}↔${j.bodyB} (${j.type}): anchors ${gapMm.toFixed(2)}mm apart — ` +
        `A-side world [${wa.map((v) => v.toFixed(2)).join(', ')}] vs B-side world [${wb.map((v) => v.toFixed(2)).join(', ')}]`,
      );
    }
  }
  if (broken.length > 0) {
    throw new Error(
      `simulate_motion REFUSED: the mechanism is not assembled at t=0 — ${broken.length} of ${joints.length} joints ` +
      `exceed the ${toleranceMm}mm anchor tolerance (anchors are in EACH body's own file frame; a body placed with ` +
      `rotation [90,0,0] does not share world coordinates with an unrotated one):\n` +
      broken.map((s, i) => `  ${i + 1}. ${s}`).join('\n') +
      '\nEvery result such a run could produce (drift, interference, travel) would describe that ' +
      'unassembled pose, not the design — fix the anchors, the placement or the pivot instead.',
    );
  }
  return gaps;
}

export interface MotionJointInput {
  type: 'revolute' | 'prismatic';
  bodyA: string;
  bodyB: string;
  /** Anchor in A's local frame, mm. */
  anchorA: [number, number, number];
  /** Anchor in B's local frame, mm. */
  anchorB: [number, number, number];
  axis: [number, number, number];
  /** Prismatic travel limits [min, max] in mm along the axis. */
  limits?: [number, number];
}

/** Constant-speed spin drive on one kinematic body (the crank). */
export interface MotionDriveInput {
  body: string;
  /** Rotation axis in world coordinates (normalized internally). */
  axis: [number, number, number];
  omegaRadPerSec: number;
}

/** Prescribed sinusoidal translation on one kinematic body (a valve, cam follower). */
export interface MotionOscillatorInput {
  body: string;
  /** Translation direction (normalized internally). */
  axis: [number, number, number];
  /** Peak deviation from the initial position, mm. Sinusoidal mode only. */
  amplitudeMm?: number;
  /** Full oscillation period, s. Sinusoidal mode only. */
  periodSec?: number;
  /** Phase offset, rad. Sinusoidal mode only. */
  phaseRad?: number;
  /**
   * RACK & PINION mode: mm of travel per radian of drive rotation (the pitch
   * radius). Displacement = pitchRadiusMm × (ω·t + phaseRad) along `axis`, so
   * the rack cannot drift out of ratio with the pinion. Requires a `drive`; a
   * negative radius reverses the direction.
   */
  pitchRadiusMm?: number;
}

export interface MotionScenario {
  parts: MotionPartInput[];
  joints: MotionJointInput[];
  drive?: MotionDriveInput;
  oscillators?: MotionOscillatorInput[];
  /** Drive cycles to simulate. Default 2. */
  cycles?: number;
  /** Interference samples per drive cycle. Default 24. Internal: the tool schema does not expose it, so the floor below cannot be defeated by a caller. */
  samplePerCycle?: number;
  /** Parts whose per-sample axial position is recorded (phase analysis input). */
  recordParts?: string[];
}

export interface MotionReport {
  overallStatus: 'pass' | 'check';
  metrics: {
    driveOmegaRadPerSec: number | null;
    cyclePeriodSec: number | null;
    followers: Record<string, { travelMm: number; axis: 'x' | 'y' | 'z'; periodSec: number | null }>;
    interferenceCount: number;
    interferenceEvents: { step: number; timeSec: number; partA: string; partB: string; volumeMm3: number }[];
    /** Sampled poses that were actually boolean-tested (coverage, not outcome). */
    interferenceChecks: number;
    /** Candidate pairs after fixed↔fixed and revolute-linked exclusions. */
    candidatePairs: number;
    /** interferenceChecks × candidatePairs. */
    interferencePairChecks: number;
    /** false when the run could not fit 24 poses — a check, never a pass. */
    samplingSatisfied: boolean;
    /** Largest crank rotation between samples (null without a drive). */
    maxSampleGapDeg: number | null;
    maxJointDriftMm: number;
    jointViolations: string[];
    diverged: boolean;
    /**
     * Parts that are far from everything by their OWN size, or placeholder
     * geometry. Written by the tool (it owns the world AABBs and the declared
     * connections), read here so the type carries the fact.
     */
    geometrySuspects?: string[];
    geometrySuspectRule?: string;
    /** How many of `geometrySuspects` are WARNINGS (placement), not notes. */
    geometrySuspectWarn?: number;
  };
  /** Per-sample positions along each recorded part's dominant axis. */
  followersDetail: Record<string, { t: number[]; vals: number[]; axis: 'x' | 'y' | 'z' }>;
  /** Shape-compatible with physics.ts renderKeyframes. */
  keyframes: PhysicsReport['keyframes'];
  /** Uniform pose timeline (panel playback), includes the t=0 assembly pose. */
  trajectory: Trajectory;
  stepsRun: number;
  durationSec: number;
}

let rapierReady: typeof RAPIER | null = null;
async function R() {
  if (!rapierReady) { await RAPIER.init(); rapierReady = RAPIER; }
  return rapierReady;
}

let manifoldMod: Awaited<ReturnType<typeof ManifoldModule>> | null = null;
async function M() {
  if (!manifoldMod) { manifoldMod = await ManifoldModule(); manifoldMod.setup(); }
  return manifoldMod;
}

const norm = (v: readonly [number, number, number]): [number, number, number] => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const V = (v: readonly [number, number, number]) => ({ x: v[0], y: v[1], z: v[2] });

function eulerToQuat(deg: [number, number, number]): { x: number; y: number; z: number; w: number } {
  const [rx, ry, rz] = deg.map((d) => (d * Math.PI) / 180);
  const cx = Math.cos(rx / 2), sx = Math.sin(rx / 2);
  const cy = Math.cos(ry / 2), sy = Math.sin(ry / 2);
  const cz = Math.cos(rz / 2), sz = Math.sin(rz / 2);
  return {
    w: cx * cy * cz + sx * sy * sz,
    x: sx * cy * cz - cx * sy * sz,
    y: cx * sy * cz + sx * cy * sz,
    z: cx * cy * sz - sx * sy * cz,
  };
}

function quatToMatrix3(q: { x: number; y: number; z: number; w: number }): number[][] {
  const { x, y, z, w } = q;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ];
}

function worldAnchor(body: RAPIER.RigidBody, local: [number, number, number]): [number, number, number] {
  const t = body.translation();
  const m = quatToMatrix3(body.rotation());
  return [
    t.x + m[0][0]! * local[0] + m[0][1]! * local[1] + m[0][2]! * local[2],
    t.y + m[1][0]! * local[0] + m[1][1]! * local[1] + m[1][2]! * local[2],
    t.z + m[2][0]! * local[0] + m[2][1]! * local[1] + m[2][2]! * local[2],
  ];
}

/** Welded triangle soup (merge once, reuse per sample). */
interface WeldedMesh {
  vertProperties: Float32Array;
  triVerts: Uint32Array;
}

function weldedOf(stl: Uint8Array, mod: NonNullable<typeof manifoldMod>): WeldedMesh {
  const parsed = parseBinaryStl(stl);
  const mesh = new mod.Mesh({ numProp: 3, vertProperties: parsed.vertProperties, triVerts: parsed.triVerts });
  mesh.merge();
  return { vertProperties: mesh.vertProperties, triVerts: mesh.triVerts };
}

function transformedAABB(verts: Float32Array): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < verts.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = verts[i + a]!;
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  return { min, max };
}

function aabbOverlap(
  a: { min: [number, number, number]; max: [number, number, number] },
  b: { min: [number, number, number]; max: [number, number, number] },
): boolean {
  return a.min[0] <= b.max[0] && a.max[0] >= b.min[0]
    && a.min[1] <= b.max[1] && a.max[1] >= b.min[1]
    && a.min[2] <= b.max[2] && a.max[2] >= b.min[2];
}

function periodFromSamples(vals: number[], sampleDt: number): number | null {
  const maxima: number[] = [];
  for (let i = 0; i < vals.length; i++) {
    const left = i > 0 ? vals[i - 1]! : -Infinity;
    const right = i < vals.length - 1 ? vals[i + 1]! : -Infinity;
    if (vals[i]! > left && vals[i]! >= right) {
      if (maxima.length === 0 || i - maxima[maxima.length - 1]! > 3) maxima.push(i);
    }
  }
  if (maxima.length < 2) return null;
  const gaps: number[] = [];
  for (let k = 1; k < maxima.length; k++) gaps.push(maxima[k]! - maxima[k - 1]!);
  return (gaps.reduce((a, b) => a + b, 0) / gaps.length) * sampleDt;
}

/** Darwin-x64 has no `rapier3d` wheel, so mechanisms stay on the TS canonical there. */
const PYTHON_MOTION_UNAVAILABLE = process.platform === 'darwin' && process.arch === 'x64';

/**
 * Drive a mechanism and report kinematics + the exact interference timeline
 * (Q2=A: the Python worker is canonical).
 *
 * Everything the TS version did with rapier AND with Manifold now happens in the
 * worker: rapier is only a constraint solver here (no colliders, no gravity), and
 * the interference timeline is exact Manifold booleans per sampled pose — so the
 * port keeps the same engine version for the part that decides PASS/CHECK, and the
 * probe's constraint-agreement (≈0.05 mm) governs the rest.
 */
export async function runMotion(scenario: MotionScenario): Promise<MotionReport> {
  if (PYTHON_MOTION_UNAVAILABLE) return runMotionInTs(scenario);

  const scratch = await workerScratchDir();
  const written: string[] = [];
  const parts = [];
  for (const part of scenario.parts) {
    const path = join(scratch, `motion-${randomUUID()}.stl`);
    await writeFile(path, part.stl);
    written.push(path);
    parts.push({
      name: part.name,
      path,
      bodyType: part.bodyType,
      position: part.position,
      ...(part.rotation ? { rotation: part.rotation } : {}),
    });
  }
  try {
    const worker = await ensurePythonWorker();
    return await worker.request<MotionReport>('simulate_motion', {
      scenario: {
        parts,
        joints: scenario.joints,
        ...(scenario.drive ? { drive: scenario.drive } : {}),
        ...(scenario.oscillators ? { oscillators: scenario.oscillators } : {}),
        ...(scenario.cycles !== undefined ? { cycles: scenario.cycles } : {}),
        ...(scenario.samplePerCycle !== undefined ? { samplePerCycle: scenario.samplePerCycle } : {}),
        ...(scenario.recordParts ? { recordParts: scenario.recordParts } : {}),
      },
    });
  } finally {
    await Promise.all(written.map((path) => rm(path, { force: true }).catch(() => {})));
  }
}

/**
 * The TS implementation — the CANONICAL only on darwin-x64, where the lock ships
 * no `rapier3d` wheel (DESIGN §31.4). Everywhere else it is the parity oracle for
 * the worker's `simulate_motion`.
 */
export async function runMotionInTs(scenario: MotionScenario): Promise<MotionReport> {
  const RAPIER_ = await R();
  const mod = await M();

  const dt = 1 / 2000;
  const cycles = scenario.cycles ?? 2;
  const samplePerCycle = scenario.samplePerCycle ?? 24;
  const oscillators = scenario.oscillators ?? [];
  const omega = scenario.drive?.omegaRadPerSec ?? 0;
  // Without a crank the time base is the prescribed mover's period: silently using
  // 1 s made `cycles` mean "seconds since I left omega at 0", which is not a cycle
  // of anything. (1 s stays only when there is no oscillator to ask either.)
  const oscPeriods = oscillators
    .filter((o) => !o.pitchRadiusMm && typeof o.periodSec === 'number' && o.periodSec > 0)
    .map((o) => o.periodSec as number);
  const cyclePeriod = omega > 0 ? (2 * Math.PI) / omega : (oscPeriods.length ? Math.max(...oscPeriods) : 1);
  const totalSec = cycles * cyclePeriod;
  const steps = Math.max(1, Math.round(totalSec / dt));
  // A density per crank PERIOD is not a density per RUN: a 0.03-cycle sweep got
  // one sample per 1047 steps against 754 total, so the interference loop ran
  // zero times while `clean` still reported pass. Cap the interval so every run
  // gets at least MIN_MOTION_INTERFERENCE_POSES samples; the final pose is
  // sampled unconditionally (the end of travel is where a stop/collision lives).
  const MIN_MOTION_INTERFERENCE_POSES = 24;
  const sampleEveryByCycle = Math.max(1, Math.round((cyclePeriod / samplePerCycle) / dt));
  const sampleEveryByFloor = Math.max(1, Math.floor((steps - 1) / (MIN_MOTION_INTERFERENCE_POSES - 1)));
  const sampleEvery = Math.max(1, Math.min(sampleEveryByCycle, sampleEveryByFloor));

  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  world.timestep = dt;

  const bodyByName = new Map<string, RAPIER.RigidBody>();
  const basePose = new Map<string, { p: [number, number, number]; q: { x: number; y: number; z: number; w: number } }>();

  for (const part of scenario.parts) {
    const q = eulerToQuat(part.rotation ?? [0, 0, 0]);
    basePose.set(part.name, { p: part.position, q });
    const isDriveBody = scenario.drive?.body === part.name;
    let desc: RAPIER.RigidBodyDesc;
    if (part.bodyType === 'fixed') {
      desc = RAPIER.RigidBodyDesc.fixed();
    } else if (isDriveBody) {
      // velocity-integrated kinematic: setAngvel persists and is exact
      desc = RAPIER.RigidBodyDesc.kinematicVelocityBased();
    } else if (part.bodyType === 'kinematic' || oscillators.some((o) => o.body === part.name)) {
      desc = RAPIER.RigidBodyDesc.kinematicPositionBased();
    } else {
      // collider-less dynamic body: translational mass alone breaks the joint
      // solver (zero rotational inertia → constraint drift). Give it an
      // AABB-estimated inertia tensor (m = 1 kg, box approximation).
      const w = weldedOf(part.stl, mod);
      const bb = transformedAABB(w.vertProperties);
      const ex = Math.max(1e-3, bb.max[0] - bb.min[0]);
      const ey = Math.max(1e-3, bb.max[1] - bb.min[1]);
      const ez = Math.max(1e-3, bb.max[2] - bb.min[2]);
      desc = RAPIER.RigidBodyDesc.dynamic()
        .setAdditionalMassProperties(
          1.0,
          { x: 0, y: 0, z: 0 },
          { x: (ey * ey + ez * ez) / 12, y: (ex * ex + ez * ez) / 12, z: (ex * ex + ey * ey) / 12 },
          { x: 0, y: 0, z: 0, w: 1 },
        )
        .setCanSleep(false);
    }
    const body = world.createRigidBody(
      desc.setTranslation(part.position[0], part.position[1], part.position[2]).setRotation(q),
    );
    bodyByName.set(part.name, body);
  }

  // spin drive: constant angular velocity on the kinematic crank
  if (scenario.drive) {
    const axis = norm(scenario.drive.axis);
    bodyByName.get(scenario.drive.body)!.setAngvel({ x: axis[0] * omega, y: axis[1] * omega, z: axis[2] * omega }, true);
  }

  // joints
  for (const j of scenario.joints) {
    const a = bodyByName.get(j.bodyA);
    const b = bodyByName.get(j.bodyB);
    if (!a || !b) throw new Error(`motion: joint references unknown body (${j.bodyA}, ${j.bodyB})`);
    const axis = norm(j.axis);
    const data = j.type === 'prismatic'
      ? RAPIER.JointData.prismatic(V(j.anchorA), V(j.anchorB), V(axis))
      : RAPIER.JointData.revolute(V(j.anchorA), V(j.anchorB), V(axis));
    if (j.type === 'prismatic' && j.limits) {
      data.limitsEnabled = true;
      data.limits = j.limits;
    }
    world.createImpulseJoint(data, a, b, true);
  }

  // oscillators: prescribed translation on kinematic bodies. Two modes:
  //   * sinusoidal                     — a valve-like back-and-forth (amplitudeMm)
  //   * RACK & PINION (pitchRadiusMm)  — displacement = r × drive angle, so the
  //     rack and the pinion stay in the ratio a real gear pair enforces. The
  //     sinusoidal mode cannot express this: a sine and a uniform rotation drift
  //     apart within a quarter turn, and the teeth then gnash by construction.
  const osc = oscillators.map((o) => {
    // Sign is meaningful: a negative pitch radius is a pinion turning the other
    // way (or a rack on the far side), so "coupled" is "a finite non-zero
    // radius", not "a positive one".
    const coupled = typeof o.pitchRadiusMm === 'number'
      && Number.isFinite(o.pitchRadiusMm) && o.pitchRadiusMm !== 0;
    if (!coupled && typeof o.amplitudeMm !== 'number') {
      throw new Error(`oscillator for "${o.body}" needs amplitudeMm (sinusoidal) or pitchRadiusMm (rack & pinion)`);
    }
    if (coupled && !scenario.drive) {
      throw new Error(`oscillator for "${o.body}" is rack-coupled (pitchRadiusMm) but the scenario has no drive to follow`);
    }
    if (!coupled && !(o.periodSec && o.periodSec > 0)) {
      throw new Error(`oscillator for "${o.body}" needs a positive periodSec`);
    }
    return {
      body: bodyByName.get(o.body)!,
      axis: norm(o.axis),
      base: basePose.get(o.body)!.p,
      A: o.amplitudeMm ?? 0,
      w: coupled ? 0 : (2 * Math.PI) / (o.periodSec as number),
      coupled,
      phi: o.phaseRad ?? 0,
      /** mm per radian of drive rotation; 0 = sinusoidal mode. */
      r: coupled ? (o.pitchRadiusMm as number) : 0,
    };
  });

  // milestone keyframe steps (crank angle within the first cycle) + final
  const milestoneAngles = [Math.PI / 2, Math.PI, (3 * Math.PI) / 2];
  const milestoneSteps = new Map<number, string>(); // step index → label
  for (const a of milestoneAngles) {
    const stp = Math.round((a / omega) / dt);
    if (stp > 0 && stp < steps) milestoneSteps.set(stp, `crank${Math.round((a * 180) / Math.PI)}`);
  }

  // ---- simulation loop (solver only; geometry work deferred) ----
  const sampleTimes: number[] = [];
  const sampleSteps: number[] = [];
  const samplePoses: Record<string, PoseSample>[] = [];
  const milestonePoses = new Map<number, { label: string; poses: Record<string, PoseSample> }>();
  let diverged = false;

  // Travel extremes are tracked on EVERY step, not only on interference samples:
  // a stroke is max−min of the position, and sampling it 24×/cycle under-reports
  // a monotonic ramp by up to one sample interval (the microscope2 run reported
  // 24.913mm for a commanded 25.0 and had to explain the difference away).
  // EXCEPT during the warm-up: the first steps exist to absorb the gap between
  // the modelled pose and what the joint constraints demand (accept-m36's
  // piston starts 4mm off, and seeding the extremes with that pose reported a
  // 44mm stroke for a 40mm slider-crank). Once the solver has settled, the
  // extremes re-seed from the live pose.
  const warmUpSteps = Math.max(1, Math.min(Math.round(steps * 0.05), Math.ceil(0.1 / dt)));
  let warm = 0;
  const travelLo = new Map<string, [number, number, number]>();
  const travelHi = new Map<string, [number, number, number]>();
  const seedTravel = () => {
    for (const p of scenario.parts) {
      if (p.bodyType === 'fixed') continue;
      const b = bodyByName.get(p.name)!.translation();
      travelLo.set(p.name, [b.x, b.y, b.z]);
      travelHi.set(p.name, [b.x, b.y, b.z]);
    }
  };
  seedTravel();
  const trackTravel = () => {
    if (warm < warmUpSteps) return;
    for (const p of scenario.parts) {
      if (p.bodyType === 'fixed') continue;
      const t = bodyByName.get(p.name)!.translation();
      const lo = travelLo.get(p.name)!;
      const hi = travelHi.get(p.name)!;
      if (t.x < lo[0]) lo[0] = t.x; else if (t.x > hi[0]) hi[0] = t.x;
      if (t.y < lo[1]) lo[1] = t.y; else if (t.y > hi[1]) hi[1] = t.y;
      if (t.z < lo[2]) lo[2] = t.z; else if (t.z > hi[2]) hi[2] = t.z;
    }
  };

  for (let i = 0; i < steps; i++) {
    const t = (i + 1) * dt;
    for (const o of osc) {
      const s = o.coupled
        ? o.r * (omega * t + o.phi)          // rack & pinion: x = r·θ, θ = ω·t
        : o.A * Math.sin(o.w * t + o.phi);   // prescribed sinusoid
      o.body.setNextKinematicTranslation({
        x: o.base[0] + o.axis[0] * s,
        y: o.base[1] + o.axis[1] * s,
        z: o.base[2] + o.axis[2] * s,
      });
    }
    world.step();
    warm++;
    if (warm === warmUpSteps) seedTravel(); // discard the settling transient
    trackTravel();

    if ((i + 1) % sampleEvery === 0 || (i + 1) === steps) {
      sampleTimes.push(t);
      sampleSteps.push(i + 1);
      const poses: Record<string, PoseSample> = {};
      for (const part of scenario.parts) {
        const b = bodyByName.get(part.name)!;
        const tr = b.translation();
        const rq = b.rotation();
        poses[part.name] = { position: [tr.x, tr.y, tr.z], rotation: [rq.x, rq.y, rq.z, rq.w] };
        if (!Number.isFinite(tr.x + tr.y + tr.z)) diverged = true;
      }
      samplePoses.push(poses);
    }

    const ms = milestoneSteps.get(i + 1);
    if (ms !== undefined) {
      const poses: Record<string, PoseSample> = {};
      for (const part of scenario.parts) {
        const b = bodyByName.get(part.name)!;
        const tr = b.translation();
        const rq = b.rotation();
        poses[part.name] = { position: [tr.x, tr.y, tr.z], rotation: [rq.x, rq.y, rq.z, rq.w] };
      }
      milestonePoses.set(i + 1, { label: ms, poses });
    }
  }

  // ---- interference timeline (exact Manifold booleans per sampled pose) ----
  const welded = new Map<string, WeldedMesh>();
  for (const part of scenario.parts) welded.set(part.name, weldedOf(part.stl, mod));
  const isFixed = new Map<string, boolean>(scenario.parts.map((p) => [p.name, p.bodyType === 'fixed']));

  // fixed parts: bake their placement into world-space verts once (their
  // rapier body pose is otherwise not reflected in the raw mesh)
  const fixedWorldVerts = new Map<string, Float32Array>();
  for (const part of scenario.parts) {
    if (part.bodyType !== 'fixed') continue;
    const w = welded.get(part.name)!;
    const bp = basePose.get(part.name)!;
    const m = quatToMatrix3(bp.q);
    const src = w.vertProperties;
    const out = new Float32Array(src.length);
    for (let vi = 0; vi < src.length; vi += 3) {
      const x = src[vi]!, y = src[vi + 1]!, z = src[vi + 2]!;
      out[vi] = m[0][0]! * x + m[0][1]! * y + m[0][2]! * z + bp.p[0];
      out[vi + 1] = m[1][0]! * x + m[1][1]! * y + m[1][2]! * z + bp.p[1];
      out[vi + 2] = m[2][0]! * x + m[2][1]! * y + m[2][2]! * z + bp.p[2];
    }
    fixedWorldVerts.set(part.name, out);
  }

  // static manifolds for fixed parts (transform never changes)
  const fixedManifold = new Map<string, any>();
  for (const part of scenario.parts) {
    if (part.bodyType !== 'fixed') continue;
    const solid = new mod.Manifold(new mod.Mesh({ numProp: 3, vertProperties: fixedWorldVerts.get(part.name)!, triVerts: welded.get(part.name)!.triVerts }));
    fixedManifold.set(part.name, solid);
  }

  const interferenceEvents: MotionReport['metrics']['interferenceEvents'] = [];
  let interferenceCount = 0;
  let firstInterferenceSample = -1;

  const pairs: [string, string][] = [];
  // revolute-connected neighbours are excluded: they legitimately share space
  // at the pin (bearing overlap) and their relative motion is constraint-governed.
  // prismatic pairs are KEPT: contact with the slide rail / bore is exactly the
  // interference signal (piston vs bore walls, slider vs guide).
  const linked = new Set(scenario.joints
    .filter((j) => j.type === 'revolute')
    .map((j) => [j.bodyA, j.bodyB].sort().join('\u0000')));
  for (let i = 0; i < scenario.parts.length; i++) {
    for (let j = i + 1; j < scenario.parts.length; j++) {
      const a = scenario.parts[i]!, b = scenario.parts[j]!;
      if (isFixed.get(a.name) && isFixed.get(b.name)) continue;
      if (linked.has([a.name, b.name].sort().join('\u0000'))) continue;
      pairs.push([a.name, b.name]);
    }
  }

  for (let k = 0; k < samplePoses.length; k++) {
    const poses = samplePoses[k]!;
    // transform verts per non-fixed part + AABBs
    const verts = new Map<string, Float32Array>();
    const boxes = new Map<string, { min: [number, number, number]; max: [number, number, number] }>();
    for (const part of scenario.parts) {
      const pose = poses[part.name]!;
      const w = welded.get(part.name)!;
      if (isFixed.get(part.name)) {
        const wv = fixedWorldVerts.get(part.name)!;
        verts.set(part.name, wv);
        boxes.set(part.name, transformedAABB(wv));
        continue;
      }
      const m = quatToMatrix3({ x: pose.rotation[0], y: pose.rotation[1], z: pose.rotation[2], w: pose.rotation[3] });
      const src = w.vertProperties;
      const out = new Float32Array(src.length);
      for (let vi = 0; vi < src.length; vi += 3) {
        const x = src[vi]!, y = src[vi + 1]!, z = src[vi + 2]!;
        out[vi] = m[0][0]! * x + m[0][1]! * y + m[0][2]! * z + pose.position[0];
        out[vi + 1] = m[1][0]! * x + m[1][1]! * y + m[1][2]! * z + pose.position[1];
        out[vi + 2] = m[2][0]! * x + m[2][1]! * y + m[2][2]! * z + pose.position[2];
      }
      verts.set(part.name, out);
      boxes.set(part.name, transformedAABB(out));
    }

    for (const [aName, bName] of pairs) {
      if (!aabbOverlap(boxes.get(aName)!, boxes.get(bName)!)) continue;
      const ma = fixedManifold.get(aName) ?? new mod.Manifold(new mod.Mesh({ numProp: 3, vertProperties: verts.get(aName)!, triVerts: welded.get(aName)!.triVerts }));
      const mb = fixedManifold.get(bName) ?? new mod.Manifold(new mod.Mesh({ numProp: 3, vertProperties: verts.get(bName)!, triVerts: welded.get(bName)!.triVerts }));
      const inter = ma.intersect(mb);
      const vol = inter.isEmpty() ? 0 : inter.volume();
      if (vol > 1e-3) {
        interferenceCount++;
        const timeSec = sampleTimes[k]!;
        interferenceEvents.push({ step: sampleSteps[k]!, timeSec, partA: aName, partB: bName, volumeMm3: +vol.toFixed(3) });
        if (firstInterferenceSample < 0) firstInterferenceSample = k;
      }
    }
  }
  interferenceEvents.sort((a, b) => a.step - b.step || b.volumeMm3 - a.volumeMm3);

  // ---- followers: every part that is not fixed and not the drive body ----
  const followers: MotionReport['metrics']['followers'] = {};
  const followersDetail: Record<string, { t: number[]; vals: number[]; axis: 'x' | 'y' | 'z' }> = {};
  // Mean spacing of the ACTUAL samples (the mandatory final pose can sit closer
  // than sampleEvery; the uniform value would bias the period on short runs).
  const sampleDt = sampleTimes.length > 1
    ? (sampleTimes[sampleTimes.length - 1]! - sampleTimes[0]!) / (sampleTimes.length - 1)
    : sampleEvery * dt;
  const recordSet = new Set(scenario.recordParts ?? []);
  for (const part of scenario.parts) {
    if (part.bodyType === 'fixed') continue;
    if (scenario.drive?.body === part.name) continue;
    const ranges: [number, number, number] = [
      travelHi.get(part.name)![0] - travelLo.get(part.name)![0],
      travelHi.get(part.name)![1] - travelLo.get(part.name)![1],
      travelHi.get(part.name)![2] - travelLo.get(part.name)![2],
    ];
    const axisIdx = ranges[0]! >= ranges[1]! && ranges[0]! >= ranges[2]! ? 0 : ranges[1]! >= ranges[2]! ? 1 : 2;
    const axis = (['x', 'y', 'z'] as const)[axisIdx]!;
    const vals = samplePoses.map((poses) => +poses[part.name]!.position[axisIdx]!.toFixed(4));
    followers[part.name] = {
      travelMm: +ranges[axisIdx]!.toFixed(3),
      axis,
      periodSec: periodFromSamples(vals, sampleDt),
    };
    if (recordSet.has(part.name)) {
      followersDetail[part.name] = { t: sampleTimes.map((t) => +t.toFixed(4)), vals, axis };
    }
  }

  // ---- joint drift (final pose) ----
  let maxJointDriftMm = 0;
  const jointViolations: string[] = [];
  for (const j of scenario.joints) {
    const a = bodyByName.get(j.bodyA)!;
    const b = bodyByName.get(j.bodyB)!;
    const wa = worldAnchor(a, j.anchorA);
    const wb = worldAnchor(b, j.anchorB);
    let drift = Math.hypot(wa[0] - wb[0], wa[1] - wb[1], wa[2] - wb[2]);
    if (j.type === 'prismatic') {
      // sliding along the axis is the joint's purpose — measure only the
      // perpendicular offset from the slide axis
      const axis = norm(j.axis);
      const d = [wa[0] - wb[0], wa[1] - wb[1], wa[2] - wb[2]];
      const along = d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2];
      drift = Math.hypot(d[0] - along * axis[0], d[1] - along * axis[1], d[2] - along * axis[2]);
    }
    if (drift > maxJointDriftMm) maxJointDriftMm = drift;
    if (drift > JOINT_DRIFT_TOLERANCE_MM) jointViolations.push(`${j.bodyA}↔${j.bodyB}: anchor drift ${drift.toFixed(2)}mm`);
  }

  // ---- keyframes: initial + crank milestones + first interference + final ----
  const keyframes: PhysicsReport['keyframes'] = [];
  const initial: Record<string, PoseSample> = {};
  for (const part of scenario.parts) {
    const bp = basePose.get(part.name)!;
    initial[part.name] = { position: bp.p, rotation: [bp.q.x, bp.q.y, bp.q.z, bp.q.w] };
  }
  keyframes.push({ step: 0, timeSec: 0, label: 'crank0', poses: initial });
  for (const [msStep, ms] of [...milestonePoses.entries()].sort((a, b) => a[0] - b[0])) {
    keyframes.push({ step: msStep, timeSec: +(msStep * dt).toFixed(4), label: ms.label, poses: ms.poses });
  }
  if (firstInterferenceSample >= 0) {
    const k = firstInterferenceSample;
    keyframes.push({
      step: sampleSteps[k]!,
      timeSec: +sampleTimes[k]!.toFixed(4),
      label: 'interference',
      poses: samplePoses[k]!,
    });
  }
  if (samplePoses.length > 0) {
    const k = samplePoses.length - 1;
    keyframes.push({ step: steps, timeSec: +sampleTimes[k]!.toFixed(4), label: 'final', poses: samplePoses[k]! });
  }

  // Coverage is part of the verdict: zero sampled poses means zero interference
  // checks, and "no counter-example" must never print as pass (DESIGN §25.7).
  const interferenceChecks = samplePoses.length;
  const candidatePairs = pairs.length;
  const interferencePairChecks = interferenceChecks * candidatePairs;
  const samplingSatisfied = interferenceChecks >= MIN_MOTION_INTERFERENCE_POSES;
  const maxSampleGapDeg = omega > 0 ? +((360 * sampleEvery * dt) / cyclePeriod).toFixed(2) : null;

  const clean = interferenceCount === 0
    && !diverged
    && maxJointDriftMm <= JOINT_DRIFT_TOLERANCE_MM
    && samplingSatisfied;

  // Playback timeline: t=0 assembly pose + every simulation sample, per part.
  const toFlat = (poses: Record<string, PoseSample>, name: string): number[] => {
    const s = poses[name]!;
    return [s.position[0], s.position[1], s.position[2], s.rotation[0], s.rotation[1], s.rotation[2], s.rotation[3]];
  };
  const trajFrames: Record<string, PoseSample>[] = [initial, ...samplePoses];
  const trajectory: Trajectory = {
    times: [0, ...sampleTimes].map((t) => +t.toFixed(4)),
    parts: scenario.parts.map((p) => ({
      name: p.name,
      bodyType: p.bodyType,
      frames: trajFrames.map((fr) => toFlat(fr, p.name)),
    })),
    events: interferenceEvents.slice(0, 20).map((e) => ({
      timeSec: e.timeSec,
      label: `干涉:${e.partA}↔${e.partB} ${e.volumeMm3.toFixed(1)}mm³`,
    })),
  };

  return {
    overallStatus: clean ? 'pass' : 'check',
    metrics: {
      driveOmegaRadPerSec: scenario.drive?.omegaRadPerSec ?? null,
      cyclePeriodSec: omega > 0 ? +cyclePeriod.toFixed(4) : null,
      followers,
      interferenceCount,
      interferenceEvents: interferenceEvents.slice(0, 20),
      interferenceChecks,
      candidatePairs,
      interferencePairChecks,
      samplingSatisfied,
      maxSampleGapDeg,
      maxJointDriftMm: +maxJointDriftMm.toFixed(4),
      jointViolations,
      diverged,
    },
    followersDetail,
    keyframes: keyframes.slice(0, 8),
    trajectory,
    stepsRun: steps,
    durationSec: +totalSec.toFixed(3),
  };
}
