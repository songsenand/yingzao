// Rigid-body physics (M3): rapier3d-compat runs headless in Node.
// Units are millimetres/seconds throughout (rapier is unit-agnostic):
// z-up world (matches OpenSCAD): gravity default [0, 0, -9810] mm/s², density in kg/mm³.

import RAPIER from '@dimforge/rapier3d-compat';
import ManifoldModule from 'manifold-3d';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensurePythonWorker, workerScratchDir } from './python-worker.ts';
import { parseBinaryStl, shellCount } from './mesh.ts';
import { renderScadPng } from './compile.ts';
import { jointLoopClosers } from './joint-graph.ts';

export interface PhysicsPartInput {
  name: string;
  stl: Uint8Array;
  bodyType: 'dynamic' | 'fixed';
  /** Placement in mm. */
  position: [number, number, number];
  /** Initial rotation, degrees XYZ. */
  rotation?: [number, number, number];
  /** kg/mm³. Default 1.05e-6 (≈ ABS plastic). */
  density?: number;
  /**
   * Coulomb friction coefficient for this part's collider. Default: rapier's own
   * default (0.5) — which is a NUMBER NOBODY CHOSE. It matters: a single-start
   * worm has a 7.1° lead angle, and μ=0.5 puts the friction angle at 26.6°, i.e.
   * deep in the self-locking regime (η ≈ 19%), while POM-on-POM μ≈0.15 is a
   * different machine (η ≈ 40%). Without this field every "it stalls" verdict
   * was made at an undeclared μ.
   */
  friction?: number;
  initialAngularVelocity?: [number, number, number]; // rad/s
  fellOverCheck?: boolean;
}

/**
 * A torque-limited velocity motor on a REVOLUTE joint: it drives bodyB relative
 * to bodyA about the joint axis at `targetVelocityRadPerSec`, and may never
 * exceed `maxTorqueNm`.
 *
 * Why this exists (2026-11-14, the reducer session): the joint had no motor, so
 * the only way to make a mechanism move was `initialAngularVelocity` — an
 * IMPULSE, not a drive. A worm given 30 rad/s stopped after 7.5°, when it had
 * spent the 0.056 mm backlash and hit the first tooth face. Every frame of that
 * run looked identical, and the honest reading of it was "the tool cannot drive
 * anything", not "the gearbox slips". Rapier has had the motor all along
 * (`configureMotorVelocity` + `setMotorMaxForce`); the interface never exposed it.
 *
 * Units: N·m and rad/s at the interface; internally rapier works in mm/mN, so
 * 1 N·m = 1e6 N·mm. The cap is what makes a stall a RESULT instead of a bug: a
 * motor that cannot overcome the next tooth reports `measuredRadPerSec` far
 * below the target instead of silently lying.
 */
export interface PhysicsMotorInput {
  /**
   * Target angular velocity of B relative to A about the joint axis (right-hand
   * rule about `axisA`, world direction at t=0), rad/s. 0 = a brake that holds
   * the joint against whatever torque is under the cap.
   */
  targetVelocityRadPerSec: number;
  /** Hard cap on motor torque, N·m. Must be > 0 — an uncapped motor is not a model of anything. */
  maxTorqueNm: number;
  /**
   * Rapier's damping coefficient for the velocity motor, in N·m·s/rad.
   * Default `maxTorqueNm × 100` — a 0.01 rad/s speed error already saturates the
   * cap, so the cap (not the gain) sets the torque and `maxTorqueNm` means what
   * it says. The ×100 is not cosmetic: with damping = maxTorqueNm a "brake" at
   * target 0 is a DAMPER and sags at ω = τ_load/torque (measured: a 0.53 mN·m
   * pendulum crept 22.6° in 1 s under a 2 mN·m cap — a hold that looked like a
   * failure).
   */
  damping?: number;
}

export interface PhysicsJointInput {
  /**
   * `revolute` = a hinge (all degrees of freedom removed except rotation about
   * the axis); `prismatic` = a slider (all except translation along the axis).
   *
   * A slider was missing for a long time and the gap had a cost: the only way to
   * hold a sliding part in a rigid-body run was to weld it (fixed) or to hinge
   * it, so "does this slide stay put under load" could not be asked at all.
   */
  type: 'revolute' | 'prismatic' | 'gear';
  bodyA: string;
  bodyB: string;
  /** Anchor in A's local frame, mm. */
  anchorA: [number, number, number];
  /** Anchor in B's local frame, mm. */
  anchorB: [number, number, number];
  /**
   * The same local axis in BOTH bodies. Correct only when their frames are
   * parallel; for a joint between differently-oriented bodies use `axisA` +
   * `axisB`, or `axisWorld` (resolved by the tool). Kept as the simple shorthand.
   */
  axis?: [number, number, number];
  /** Axis in A's local frame — give with `axisB` for a rotated pair. */
  axisA?: [number, number, number];
  /** Axis in B's local frame — give with `axisA`. */
  axisB?: [number, number, number];
  /** World-space hinge/slide direction, resolved to each body's local frame. */
  axisWorld?: [number, number, number];
  /** prismatic only: the travel the slide is allowed, mm along the axis. */
  limits?: [number, number];
  /**
   * prismatic only: coefficient of static friction μ for the HOLD question —
   * "will this slide stay put under gravity?". Rapier joints are constraints,
   * not friction models, so this is answered analytically after the run:
   * μ·m·|g⊥| vs m·|g∥|. Quasi-static estimate, clearly labelled as one; it
   * answers the microscope/steam-engine class of question without pretending
   * the solver simulated friction.
   */
  staticFriction?: number;
  /**
   * `gear` only: turns of B per turn of A, about each body's own `axisA`/`axisB`
   * (signed — an external spur mesh with both axes +Z is negative, e.g. -40/20).
   *
   * A gear is a COUPLING, not a contact problem: it makes the ratio exact instead
   * of asking a contact solver to rediscover it. The teeth still have to be
   * checked for collision — that is `simulate_motion`'s exact interference
   * timeline, which is what already passes for the 12:1 worm pair. The two bodies
   * of a gear pair do not collide in this run (same rule as a bearing): the
   * coupling would otherwise fight the solver and produce the "chewing" that was
   * indistinguishable from a real stall. The coupling is KINEMATIC: it holds the
   * ratio exactly and transfers no torque, so a slipping mesh is out of scope — a
   * contact run without this joint is the tool for that question.
   */
  ratio?: number;
  /**
   * revolute only: a torque-limited velocity motor on this hinge. Without it the
   * run can only be nudged (initialAngularVelocity) and will coast to a stop on
   * the first tooth/stop it meets — a mechanism that is "supposed to run" needs
   * a drive, and a drive needs a torque cap to be honest about stalling.
   */
  motor?: PhysicsMotorInput;
}

export interface PhysicsScenario {
  parts: PhysicsPartInput[];
  joints?: PhysicsJointInput[];
  gravity?: [number, number, number];
  durationSec?: number;
  timestepSec?: number;
  keyframeCount?: number;
  /**
   * Compute contacts between the two bodies of a joint. Default false: a
   * bearing is DESIGNED to have its parts sit inside one another's clearance,
   * and resolving that as a collision is what threw the Roberval pans out of
   * their forks. Set true only for a stopper that really is supposed to collide
   * on the jointed pair.
   */
  jointContacts?: boolean;
  /**
   * Solver knobs. rapier's defaults are tuned for a metre-scale scene (4 solver
   * iterations, 1 CCD substep), and until now nothing here could change them —
   * so a thin-tooth gear run could only be "improved" by shrinking timestepSec.
   * Both values are echoed in `metrics.solver`, because a penetration number
   * means nothing without the settings that produced it.
   */
  solverIterations?: number;
  ccdSubsteps?: number;
}

export interface PoseSample {
  position: [number, number, number];
  /** Quaternion x,y,z,w */
  rotation: [number, number, number, number];
}

export interface TrajectoryPart {
  name: string;
  bodyType: 'dynamic' | 'fixed' | 'kinematic';
  /** Per-frame flat pose [x,y,z,qx,qy,qz,qw] — aligned with Trajectory.times. */
  frames: number[][];
}

/** Uniform pose timeline for panel playback (panel and LLM share the same data). */
export interface Trajectory {
  times: number[];
  parts: TrajectoryPart[];
  events: { timeSec: number; label: string }[];
}

export interface PhysicsReport {
  metrics: {
    maxPenetrationMm: number;
    settledPenetrationMm: number;
    fellOver: Record<string, boolean>;
    maxHorizontalDisplacementMm: Record<string, number>;
    jointViolations: string[];
    settled: boolean;
    /** Written by the tool (it owns the world AABBs and the declared joints). */
    geometrySuspects?: string[];
    geometrySuspectRule?: string;
    /** How many of `geometrySuspects` are WARNINGS (placement), not notes. */
    geometrySuspectWarn?: number;
    /** Quasi-static "will the slide hold?" answers, when staticFriction was given. */
    holdAnalysis?: { joint: string; mu: number; massKg: number; axialDriveN: number; frictionCapN: number; holds: boolean }[];
    /**
     * One entry per motor joint: what was commanded and what the solver actually
     * delivered at the last step. `measuredRadPerSec` materially below
     * `targetVelocityRadPerSec` is a STALL (the teeth/stop held it), not a
     * numerical artefact — that is the number a "did it really turn?" claim needs.
     */
    /**
     * One entry per gear coupling: the declared ratio and the ratio the run
     * produced. They agree exactly because the ratio is PRESCRIBED by a kinematic
     * coupling — that is not a measurement of transmission, and the wording in
     * the report must not imply otherwise.
     */
    gears?: {
      joint: string;
      ratio: number;
      turnedADeg: number;
      turnedBDeg: number;
      measuredRatio: number;
    }[];
    motors?: {
      joint: string;
      targetVelocityRadPerSec: number;
      maxTorqueNm: number;
      damping: number;
      /** B's angular velocity relative to A about the joint axis at the final step, rad/s. */
      measuredRadPerSec: number;
      /** Signed angle the joint actually turned over the run, degrees (wrapped-free). */
      turnedDeg: number;
      reachedTarget: boolean;
    }[];
    /** Anchor gap per joint, measured at t=0 (before any step). */
    initialJointGaps?: { joint: string; gapMm: number }[];
    /** The t=0 tolerance used by the assembly gate, mm. */
    jointToleranceMm?: number;
    /** Jointed pairs whose mutual contact is OFF (bearing clearance, not a clash). */
    contactsDisabled?: string[];
    /** The subset isolated because of a GEAR coupling (not a designed clearance). */
    gearContactsDisabled?: string[];
    /** The solver settings that produced this report — a penetration number without them is not reproducible. */
    solver?: { timestepSec: number; solverIterations: number; ccdSubsteps: number };
    /** The collision shape each body actually got: "hull" or "trimesh". */
    colliders?: Record<string, 'hull' | 'trimesh'>;
    /**
     * The Coulomb friction each collider actually carries. Always reported because
     * 0.5 (rapier's default) is a number nobody chose, and a self-locking worm's
     * efficiency moves by 2x between μ=0.5 and μ=0.15.
     */
    frictions?: Record<string, number>;
    /** The kinematic graph contains a cycle (a fact, not a verdict). */
    closedLoop?: boolean;
    /** The joints that close a loop, in declaration order. */
    loopJoints?: string[];
    /** Honest-input notes: contact topology, hold-analysis caveats. */
    notes: string[];
  };
  finalPositions: Record<string, [number, number, number]>;
  keyframes: { step: number; timeSec: number; label: string; poses: Record<string, PoseSample> }[];
  /** Uniform pose timeline (panel playback); keyframe poses are snapped from it. */
  trajectory: Trajectory;
  stepsRun: number;
  durationSec: number;
}

/**
 * The world is mm + mN (density kg/mm³, gravity 9810 mm/s²), so torque in this
 * unit system is mm·mN = 1e-6 N·m: N·m → rapier units is × 1e6.
 */
const TORQUE_NM_TO_RAPIER = 1e6;

let rapierReady: typeof RAPIER | null = null;
async function R() {
  if (!rapierReady) { await RAPIER.init(); rapierReady = RAPIER; }
  return rapierReady;
}

function quatToMatrix3(q: { x: number; y: number; z: number; w: number }): number[][] {
  const { x, y, z, w } = q;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ];
}

/** Hamilton product: qMul(a,b) applies b first, then a (same convention as rapier's q1*q2). */
function quatMul(
  a: { x: number; y: number; z: number; w: number },
  b: { x: number; y: number; z: number; w: number },
): { x: number; y: number; z: number; w: number } {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

function quatConj(q: { x: number; y: number; z: number; w: number }): { x: number; y: number; z: number; w: number } {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

/** The body's local +Z in world coordinates. */
function bodyUp(q: { x: number; y: number; z: number; w: number }): [number, number, number] {
  const m = quatToMatrix3(q);
  return [m[0]![2]!, m[1]![2]!, m[2]![2]!];
}

/**
 * How far the body has TIPPED since its authored pose, in degrees.
 *
 * Measuring against world up called a beam authored at [90,0,0] "90° toppled"
 * at t=0, and it could not tell a hinge rotation (allowed) from a tip (failure).
 * Comparing the body's own up at t=0 with its up now fixes both.
 */
function relativeTiltDegrees(
  q: { x: number; y: number; z: number; w: number },
  q0: { x: number; y: number; z: number; w: number },
): number {
  const a = bodyUp(q);
  const b = bodyUp(q0);
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  return Math.acos(dot) * 180 / Math.PI;
}

/** Same values as the Python canonical, named once. */
const JOINT_TOLERANCE_MM = 2;
const TOPPLE_EVENT_DEG = 30;
const TOPPLE_VERDICT_DEG = 60;

/** Euler XYZ degrees → quaternion (matches rapier setRotation from euler convention). */
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

function verticesOf(stl: Uint8Array): Float32Array {
  return parseBinaryStl(stl).vertProperties;
}

let manifoldMod: Awaited<ReturnType<typeof ManifoldModule>> | null = null;
/** True when the STL encloses the same volume as its convex hull (±1%). */
async function isConvexStl(stl: Uint8Array): Promise<boolean> {
  if (!manifoldMod) { manifoldMod = await ManifoldModule(); manifoldMod.setup(); }
  const parsed = parseBinaryStl(stl);
  try {
    const mesh = new manifoldMod.Mesh({ numProp: 3, vertProperties: parsed.vertProperties, triVerts: parsed.triVerts });
    mesh.merge();
    const solid = new manifoldMod.Manifold(mesh);
    const hull = solid.hull();
    if (hull.isEmpty() || solid.volume() <= 0) return false;
    return Math.abs(hull.volume() - solid.volume()) / solid.volume() < 0.01;
  } catch {
    return false; // non-manifold input → treat as non-convex (trimesh path)
  }
}

function trimeshOf(stl: Uint8Array): { vertices: Float32Array; indices: Uint32Array } {
  const m = parseBinaryStl(stl);
  return { vertices: m.vertProperties, indices: m.triVerts };
}

/**
 * Run the scenario. Never renders — see renderKeyframes for visuals.
 */
/** Darwin-x64 has no `rapier3d` wheel (the lock excludes it), so physics stays on
 * the TS canonical there. Everywhere else the worker owns the solve. */
const PYTHON_PHYSICS_UNAVAILABLE = process.platform === 'darwin' && process.arch === 'x64';

/**
 * Step a rigid-body scenario (Q2=A: the Python worker is canonical).
 *
 * The parts travel as PATH (the scenario already carries STL bytes, so they are
 * written to the worker's scratch directory), and the report comes back in the
 * same shape the tool has always seen. The engine versions differ (TS
 * `rapier3d-compat` 0.20 vs Python `rapier3d` 0.36), and the probe measured what
 * that means: joint/constraint quantities agree to ~0.05 mm, free flight and light
 * contact to ~1 mm, contact-dominated trajectories by millimetres to tens of
 * millimetres — see experiments/20261008_python_rapier_probe.md.
 */
export async function runPhysics(scenario: PhysicsScenario): Promise<PhysicsReport> {
  if (PYTHON_PHYSICS_UNAVAILABLE) return runPhysicsInTs(scenario);

  const scratch = await workerScratchDir();
  const written: string[] = [];
  const parts = [];
  for (const part of scenario.parts) {
    const path = join(scratch, `physics-${randomUUID()}.stl`);
    await writeFile(path, part.stl);
    written.push(path);
    parts.push({
      name: part.name,
      path,
      bodyType: part.bodyType,
      position: part.position,
      ...(part.rotation ? { rotation: part.rotation } : {}),
      ...(part.density !== undefined ? { density: part.density } : {}),
      ...(part.friction !== undefined ? { friction: part.friction } : {}),
      ...(part.initialAngularVelocity ? { initialAngularVelocity: part.initialAngularVelocity } : {}),
      ...(part.fellOverCheck !== undefined ? { fellOverCheck: part.fellOverCheck } : {}),
    });
  }
  try {
    const worker = await ensurePythonWorker();
    return await worker.request<PhysicsReport>('simulate_physics', {
      scenario: {
        parts,
        ...(scenario.joints ? { joints: scenario.joints } : {}),
        ...(scenario.gravity ? { gravity: scenario.gravity } : {}),
        ...(scenario.durationSec !== undefined ? { durationSec: scenario.durationSec } : {}),
        ...(scenario.timestepSec !== undefined ? { timestepSec: scenario.timestepSec } : {}),
        ...(scenario.keyframeCount !== undefined ? { keyframeCount: scenario.keyframeCount } : {}),
        ...(scenario.jointContacts !== undefined ? { jointContacts: scenario.jointContacts } : {}),
        ...(scenario.solverIterations !== undefined ? { solverIterations: scenario.solverIterations } : {}),
        ...(scenario.ccdSubsteps !== undefined ? { ccdSubsteps: scenario.ccdSubsteps } : {}),
      },
    });
  } finally {
    await Promise.all(written.map((path) => rm(path, { force: true }).catch(() => {})));
  }
}

/**
 * The TS implementation — the CANONICAL only on darwin-x64, where the lock ships
 * no `rapier3d` wheel (DESIGN §31.4). Everywhere else it is the parity oracle for
 * the Python worker (`scripts/accept-physics-parity.mjs`), exactly like
 * `validateAssemblyInTs` / `importGeometry`'s predecessor.
 */
export async function runPhysicsInTs(scenario: PhysicsScenario): Promise<PhysicsReport> {
  const RAPIER_ = await R();
  const gravity = scenario.gravity ?? [0, 0, -9810];
  const dt = scenario.timestepSec ?? 1 / 60;
  const duration = scenario.durationSec ?? 2;
  const steps = Math.max(1, Math.round(duration / dt));
  const keyframeEvery = Math.max(1, Math.floor(steps / (scenario.keyframeCount ?? 6)));

  const world = new RAPIER_.World({ x: gravity[0], y: gravity[1], z: gravity[2] });
  const solverIterations = Math.max(1, Math.min(64, Math.round(scenario.solverIterations ?? 4)));
  const ccdSubsteps = Math.max(1, Math.min(16, Math.round(scenario.ccdSubsteps ?? 1)));
  world.integrationParameters.numSolverIterations = solverIterations;
  world.integrationParameters.maxCcdSubsteps = ccdSubsteps;
  world.timestep = dt;

  const bodies = new Map<string, RAPIER.RigidBody>();
  const colliders = new Map<string, RAPIER.Collider>();
  /** μ the solver actually used, per part (declared, or rapier's undeclared default). */
  const frictionUsed: Record<string, number> = {};
  const applyFriction = (collider: RAPIER.Collider, part: PhysicsPartInput) => {
    if (part.friction !== undefined) collider.setFriction(part.friction);
    frictionUsed[part.name] = collider.friction();
  };

  // A gear pair must not collide with itself in a physics run: the coupling
  // already fixes the ratio, and letting the teeth resolve as contacts turns a
  // designed mesh into permanent interpenetration ("chewing"). Collision groups
  // express that per part; rapier gives 16 usable bits, so a scene with more than
  // 16 parts falls back to the default (and says so) rather than silently
  // isolating the wrong pair.
  const gearPartners = new Map<string, Set<string>>();
  for (const j of scenario.joints ?? []) {
    if (j.type !== 'gear') continue;
    if (!gearPartners.has(j.bodyA)) gearPartners.set(j.bodyA, new Set());
    if (!gearPartners.has(j.bodyB)) gearPartners.set(j.bodyB, new Set());
    gearPartners.get(j.bodyA)!.add(j.bodyB);
    gearPartners.get(j.bodyB)!.add(j.bodyA);
  }
  const gearIsolation = gearPartners.size > 0 && scenario.parts.length <= 16;
  const bitOf = new Map<string, number>();
  if (gearIsolation) scenario.parts.forEach((p, i) => bitOf.set(p.name, i));
  const applyGroups = (collider: RAPIER.Collider, part: PhysicsPartInput) => {
    if (!gearIsolation) return;
    const bit = bitOf.get(part.name);
    if (bit === undefined) return;
    let filter = 0xffff;
    for (const other of gearPartners.get(part.name) ?? []) {
      const ob = bitOf.get(other);
      if (ob !== undefined) filter &= ~(1 << ob);
    }
    collider.setCollisionGroups(((1 << bit) << 16) | filter);
  };
  const colliderKinds: Record<string, 'hull' | 'trimesh'> = {};
  const fellOverChecks: string[] = [];
  const initialPos = new Map<string, [number, number, number]>();
  const initialRotations = new Map<string, { x: number; y: number; z: number; w: number }>();

  for (const part of scenario.parts) {
    const desc = part.bodyType === 'fixed'
      ? RAPIER_.RigidBodyDesc.fixed()
      // CCD on: at mm scale a fast part can tunnel through thin geometry
      // within one 60Hz step (9mm/step at just 0.54 m/s).
      : RAPIER_.RigidBodyDesc.dynamic().setCanSleep(false).setCcdEnabled(true);
    desc.setTranslation(...part.position);
    if (part.rotation) desc.setRotation(eulerToQuat(part.rotation));
    const body = world.createRigidBody(desc);
    if (part.bodyType === 'dynamic') {
      // A single convex hull is a wrong collision shape for a concave part: the
      // Roberval pan/link fork had 0 mm³ of real overlap at t=0 but 12,140 mm³ of
      // HULL overlap at each top hinge. The solver read that as penetration and
      // threw the pans across the machine. Convex parts keep the cheap hull;
      // concave parts use their exact mesh, as the fixed side already did.
      if (await isConvexStl(part.stl)) {
        const cd = RAPIER_.ColliderDesc.convexHull(verticesOf(part.stl))!;
        cd.setDensity(part.density ?? 1.05e-6);
        const collider = world.createCollider(cd, body);
        applyFriction(collider, part);
        applyGroups(collider, part);
        colliderKinds[part.name] = 'hull';
      } else {
        const { vertices, indices } = trimeshOf(part.stl);
        const cd = RAPIER_.ColliderDesc.trimesh(vertices, indices);
        cd.setDensity(part.density ?? 1.05e-6);
        const collider = world.createCollider(cd, body);
        applyFriction(collider, part);
        applyGroups(collider, part);
        colliderKinds[part.name] = 'trimesh';
      }
      if (part.initialAngularVelocity) {
        body.setAngvel({ x: part.initialAngularVelocity[0], y: part.initialAngularVelocity[1], z: part.initialAngularVelocity[2] }, true);
      }
      if (part.fellOverCheck !== false) fellOverChecks.push(part.name);
    } else {
      // Fixed parts: rapier CCD does not help against trimesh colliders, so
      // convex fixed geometry MUST use a convex hull collider (robust + fast).
      // Non-convex geometry falls back to trimesh with finer substeps.
      if (await isConvexStl(part.stl)) {
        const collider = world.createCollider(RAPIER_.ColliderDesc.convexHull(verticesOf(part.stl))!, body);
        applyFriction(collider, part);
        applyGroups(collider, part);
        colliderKinds[part.name] = 'hull';
      } else {
        const { vertices, indices } = trimeshOf(part.stl);
        const collider = world.createCollider(RAPIER_.ColliderDesc.trimesh(vertices, indices), body);
        applyFriction(collider, part);
        applyGroups(collider, part);
        colliderKinds[part.name] = 'trimesh';
      }
    }
    bodies.set(part.name, body);
    initialPos.set(part.name, [...part.position]);
    const q = body.rotation();
    initialRotations.set(part.name, { x: q.x, y: q.y, z: q.z, w: q.w });
  }

  /** Per-body axes, with B flipped when the two world directions disagree. */
  const axesOf = (j: PhysicsJointInput, a: RAPIER.RigidBody, b: RAPIER.RigidBody) => {
    const rawA = j.axisA ?? j.axis;
    const rawB = j.axisB ?? j.axisA ?? j.axis;
    if (!rawA || !rawB) {
      throw new Error(`joint ${j.bodyA}~${j.bodyB} needs axis, axisA + axisB, or axisWorld`);
    }
    let axisB: [number, number, number] = [rawB[0], rawB[1], rawB[2]];
    const ma = quatToMatrix3(a.rotation());
    const mb = quatToMatrix3(b.rotation());
    const wa = [0, 1, 2].map((i) => ma[i]![0]! * rawA[0] + ma[i]![1]! * rawA[1] + ma[i]![2]! * rawA[2]);
    const wb = [0, 1, 2].map((i) => mb[i]![0]! * axisB[0] + mb[i]![1]! * axisB[1] + mb[i]![2]! * axisB[2]);
    // The axis is a LINE, but rapier aligns the two joint FRAMES; opposite world
    // directions make the solver resolve a 180° frame twist as motion.
    if (wa[0]! * wb[0]! + wa[1]! * wb[1]! + wa[2]! * wb[2]! < 0) {
      axisB = [-axisB[0], -axisB[1], -axisB[2]];
    }
    return { axisA: [rawA[0], rawA[1], rawA[2]] as [number, number, number], axisB };
  };

  // ---- t=0 assembly gate (mirrors motion's assertAssembledAtStart) ----------
  const initialJointGaps: { joint: string; gapMm: number }[] = [];
  const broken: string[] = [];
  for (const j of scenario.joints ?? []) {
    if (j.type === 'gear') continue; // a coupling has no anchor points to line up
    if (!j.anchorA || !j.anchorB) throw new Error(`joint ${j.bodyA}~${j.bodyB} (${j.type}) needs anchors`);
    const a = bodies.get(j.bodyA);
    const b = bodies.get(j.bodyB);
    if (!a || !b) throw new Error(`joint references unknown part: ${!a ? j.bodyA : j.bodyB}`);
    const pa = worldPoint(a, { x: j.anchorA[0], y: j.anchorA[1], z: j.anchorA[2] });
    const pb = worldPoint(b, { x: j.anchorB[0], y: j.anchorB[1], z: j.anchorB[2] });
    let dx = pa[0] - pb[0];
    let dy = pa[1] - pb[1];
    let dz = pa[2] - pb[2];
    if (j.type === 'prismatic') {
      const { axisA } = axesOf(j, a, b);
      const m = quatToMatrix3(a.rotation());
      const axis = [0, 1, 2].map((i) => m[i]![0]! * axisA[0] + m[i]![1]! * axisA[1] + m[i]![2]! * axisA[2]);
      const len = Math.hypot(axis[0]!, axis[1]!, axis[2]!) || 1;
      const u = axis.map((v) => v! / len);
      const along = dx * u[0]! + dy * u[1]! + dz * u[2]!;
      dx -= along * u[0]!; dy -= along * u[1]!; dz -= along * u[2]!;
    }
    const gap = Math.hypot(dx, dy, dz);
    initialJointGaps.push({ joint: `${j.bodyA}~${j.bodyB}`, gapMm: +gap.toFixed(4) });
    if (gap > JOINT_TOLERANCE_MM) {
      broken.push(
        `joint ${j.bodyA}~${j.bodyB} (${j.type}): anchors ${gap.toFixed(2)}mm apart — `
        + `A-side world [${pa.map((v) => v.toFixed(2)).join(', ')}] vs `
        + `B-side world [${pb.map((v) => v.toFixed(2)).join(', ')}]`,
      );
    }
  }
  if (broken.length > 0) {
    throw new Error(
      `simulate_physics REFUSED: the mechanism is not assembled at t=0 — ${broken.length} of `
      + `${initialJointGaps.length} joints exceed the ${JOINT_TOLERANCE_MM}mm anchor tolerance:\n`
      + broken.map((line, index) => `  ${index + 1}. ${line}`).join('\n')
      + '\nFix the anchors or the placement; do not widen the tolerance. Every result such a run '
      + 'could produce (drift, penetration, topple) would describe that unassembled pose, not the design.',
    );
  }

  // Joints: revolute (hinge) and prismatic (slide) — plus `gear`, which is not a
  // rapier joint at all but a velocity coupling enforced below.
  const gears: {
    a: RAPIER.RigidBody;
    b: RAPIER.RigidBody;
    ratio: number;
    axisA: [number, number, number];
    axisB: [number, number, number];
    /** Poses at t=0: the follower is built from these. */
    qA0: { x: number; y: number; z: number; w: number };
    qB0: { x: number; y: number; z: number; w: number };
    /**
     * Angle turned by A since t=0, ACCUMULATED per step. Recomputing it from the
     * total rotation aliases at ±180° (2·atan2 has range (−π, π]) — the 64:1
     * gearbox saw the output "shake in place" because at 6400 rpm the input
     * crossed that boundary every 2.8 ms.
     */
    thetaA: number;
    /** A's pose at the previous step: the increment is taken against it. */
    prevA: { x: number; y: number; z: number; w: number };
    /** Largest per-step increment seen, rad — > π means the pose aliased. */
    maxStepRad: number;
  }[] = [];
  const jointContacts = scenario.jointContacts === true;
  /** Pairs whose contact is off: a GEAR pair for a different reason than a JOINT pair. */
  const jointIsolated: string[] = [];
  const gearIsolated: string[] = [];
  const contactsDisabled: string[] = [];
  const jointAnchors: {
    name: string;
    type: 'revolute' | 'prismatic';
    a: RAPIER.RigidBody;
    b: RAPIER.RigidBody;
    anchorA: RAPIER.Vector3;
    anchorB: RAPIER.Vector3;
    /** Local axis, needed to tell slide travel from real drift. */
    axis: RAPIER.Vector3;
  }[] = [];
  for (const j of scenario.joints ?? []) {
    const a = bodies.get(j.bodyA);
    const b = bodies.get(j.bodyB);
    if (!a || !b) throw new Error(`joint references unknown part: ${!a ? j.bodyA : j.bodyB}`);
    if (j.type === 'gear') {
      if (typeof j.ratio !== 'number' || !Number.isFinite(j.ratio) || j.ratio === 0) {
        throw new Error(`joint ${j.bodyA}~${j.bodyB}: gear needs a non-zero ratio (turns of B per turn of A)`);
      }
      const { axisA, axisB } = axesOf(j, a, b);
      gearIsolated.push(`${j.bodyA}~${j.bodyB}`);
      contactsDisabled.push(`${j.bodyA}~${j.bodyB}`);
      gears.push({
        a, b, ratio: j.ratio, axisA, axisB,
        qA0: a.rotation(), qB0: b.rotation(),
        thetaA: 0, prevA: a.rotation(), maxStepRad: 0,
      });
      continue; // no rapier joint: nothing to anchor, and the pair must not collide
    }
    if (!j.anchorA || !j.anchorB) throw new Error(`joint ${j.bodyA}~${j.bodyB} (${j.type}) needs anchors`);
    const anchorA = { x: j.anchorA[0], y: j.anchorA[1], z: j.anchorA[2] };
    const anchorB = { x: j.anchorB[0], y: j.anchorB[1], z: j.anchorB[2] };
    const { axisA, axisB } = axesOf(j, a, b);
    const axis = { x: axisA[0], y: axisA[1], z: axisA[2] };
    const type = j.type === 'prismatic' ? 'prismatic' : 'revolute';
    const params = type === 'prismatic'
      ? RAPIER_.JointData.prismatic(anchorA, anchorB, axis)
      : RAPIER_.JointData.revoluteWithAxes(anchorA, anchorB, { x: axisA[0], y: axisA[1], z: axisA[2] }, { x: axisB[0], y: axisB[1], z: axisB[2] });
    const joint = world.createImpulseJoint(params, a, b, true);
    joint.setContactsEnabled(jointContacts);
    if (!jointContacts) {
      jointIsolated.push(`${j.bodyA}~${j.bodyB}`);
      contactsDisabled.push(`${j.bodyA}~${j.bodyB}`);
    }
    if (type === 'prismatic' && j.limits) {
      (joint as RAPIER.PrismaticImpulseJoint).setLimits(j.limits[0], j.limits[1]);
    }
    if (j.motor) {
      // A motor on a slider is a category error, not a typo: making it a slide
      // silently would report the drive as applied while nothing turned.
      if (type !== 'revolute') {
        throw new Error(`joint ${j.bodyA}~${j.bodyB}: motor is revolute-only (this is a ${type})`);
      }
      const { targetVelocityRadPerSec, maxTorqueNm } = j.motor;
      if (!Number.isFinite(targetVelocityRadPerSec)) {
        throw new Error(`joint ${j.bodyA}~${j.bodyB}: motor.targetVelocityRadPerSec must be a number`);
      }
      if (!Number.isFinite(maxTorqueNm) || maxTorqueNm <= 0) {
        throw new Error(`joint ${j.bodyA}~${j.bodyB}: motor.maxTorqueNm must be > 0 (got ${maxTorqueNm}); an uncapped motor is not a model`);
      }
      const damping = j.motor.damping ?? maxTorqueNm * 100;
      if (!Number.isFinite(damping) || damping <= 0) {
        throw new Error(`joint ${j.bodyA}~${j.bodyB}: motor.damping must be > 0 (got ${damping})`);
      }
      const rj = joint as RAPIER.RevoluteImpulseJoint;
      rj.configureMotorModel(RAPIER_.MotorModel.ForceBased);
      rj.setMotorMaxForce(maxTorqueNm * TORQUE_NM_TO_RAPIER);
      rj.configureMotorVelocity(targetVelocityRadPerSec, damping * TORQUE_NM_TO_RAPIER);
    }
    jointAnchors.push({
      name: `${j.bodyA}~${j.bodyB}`, type, a, b, anchorA, anchorB, axis,
    });
  }

  const dynamicParts = scenario.parts.filter((p) => p.bodyType === 'dynamic');
  const pairColliders: [RAPIER.Collider, RAPIER.Collider][] = [];
  for (let i = 0; i < dynamicParts.length; i++) {
    for (let j = i + 1; j < dynamicParts.length; j++) {
      pairColliders.push([collidersOf(bodies, dynamicParts[i]!.name), collidersOf(bodies, dynamicParts[j]!.name)]);
    }
    // dynamic vs every fixed part
    for (const fixed of scenario.parts.filter((p) => p.bodyType === 'fixed')) {
      pairColliders.push([collidersOf(bodies, dynamicParts[i]!.name), collidersOf(bodies, fixed.name)]);
    }
  }

  let maxPenetration = 0;          // worst transient during the whole run (impact spikes live here)
  let settledPenetration = 0;      // worst penetration in the final 10% of steps
  const settleFrom = Math.floor(steps * 0.9);

  /** A joint axis (local) expressed in world coordinates for the CURRENT pose. */
  const worldAxisOf = (body: RAPIER.RigidBody, local: [number, number, number]): [number, number, number] => {
    const m = quatToMatrix3(body.rotation());
    return [
      m[0]![0]! * local[0] + m[0]![1]! * local[1] + m[0]![2]! * local[2],
      m[1]![0]! * local[0] + m[1]![1]! * local[1] + m[1]![2]! * local[2],
      m[2]![0]! * local[0] + m[2]![1]! * local[1] + m[2]![2]! * local[2],
    ];
  };

  /**
   * Moment of inertia about a world-space axis through the centre of mass.
   * 0 means the body is fixed (infinite inertia): such a body is a rigid
   * reference, so the coupling simply leaves it alone.
   */
  const inertiaAbout = (body: RAPIER.RigidBody, u: [number, number, number]): number => {
    if (body.invMass() === 0) return 0;
    const m = quatToMatrix3(body.rotation());
    // world -> body local (transpose), then body local -> principal frame.
    const l: [number, number, number] = [
      m[0]![0]! * u[0] + m[1]![0]! * u[1] + m[2]![0]! * u[2],
      m[0]![1]! * u[0] + m[1]![1]! * u[1] + m[2]![1]! * u[2],
      m[0]![2]! * u[0] + m[1]![2]! * u[1] + m[2]![2]! * u[2],
    ];
    const f = quatToMatrix3(body.principalInertiaLocalFrame());
    const pl: [number, number, number] = [
      f[0]![0]! * l[0] + f[1]![0]! * l[1] + f[2]![0]! * l[2],
      f[0]![1]! * l[0] + f[1]![1]! * l[1] + f[2]![1]! * l[2],
      f[0]![2]! * l[0] + f[1]![2]! * l[1] + f[2]![2]! * l[2],
    ];
    const pi = body.principalInertia();
    return pi.x! * pl[0] ** 2 + pi.y! * pl[1] ** 2 + pi.z! * pl[2] ** 2;
  };

  const samplePose = (name: string): PoseSample => {
    const b = bodies.get(name)!;
    const t = b.translation();
    const r = b.rotation();
    return { position: [t.x, t.y, t.z], rotation: [r.x, r.y, r.z, r.w] };
  };

  // Adaptive keyframe steps: collision-event moments + penetration peak +
  // topple transitions, plus a couple of uniform frames for context.
  const eventSteps = new Map<number, string>(); // step → reason
  const noteStep = (step: number, reason: string) => {
    const prev = eventSteps.get(step);
    eventSteps.set(step, prev ? `${prev}|${reason}` : reason);
  };
  noteStep(0, 'start');

  // collider handle → part name (contact events report handles)
  const nameByHandle = new Map<number, string>();
  for (const p of scenario.parts) {
    nameByHandle.set(collidersOf(bodies, p.name).handle, p.name);
  }

  const evq = new RAPIER_.EventQueue(true);
  let maxPenStep = -1;
  const toppleNoted = new Set<string>();

  // Uniform pose timeline, recorded DURING the loop. Doubles as playback data
  // and as the pose source for keyframes — poses used to be sampled after the
  // loop, which collapsed every keyframe into the final frame.
  const trajEvery = Math.max(1, Math.ceil(steps / 160));
  const trajTimes: number[] = [];
  const trajPoses: Record<string, PoseSample>[] = [];
  const recordTraj = (step: number) => {
    const poses: Record<string, PoseSample> = {};
    for (const p of scenario.parts) poses[p.name] = samplePose(p.name);
    trajTimes.push(+(step * dt).toFixed(4));
    trajPoses.push(poses);
  };

  for (let step = 0; step <= steps; step++) {
    // penetration sampling while contacts are live
    for (const [c1, c2] of pairColliders) {
      if (process.env.CAD_SKIP_CONTACTS) continue;
      try {
        world.contactPair(c1, c2, (manifold) => {
          if (!manifold) return;
          for (let i = 0; i < manifold.numSolverContacts(); i++) {
            const d = manifold.solverContactDist(i);
            if (d < maxPenetration) { maxPenetration = d; maxPenStep = step; }
            if (step >= settleFrom && d < settledPenetration) settledPenetration = d;
          }
        });
      } catch { /* contacts may be gone after sleep */ }
    }

    // collision start/stop events → first-contact keyframes
    evq.drainCollisionEvents((h1, h2, started) => {
      if (!started) return;
      const a = nameByHandle.get(h1) ?? `#${h1}`;
      const b = nameByHandle.get(h2) ?? `#${h2}`;
      noteStep(step, `接触:${a}↔${b}`);
    });
    evq.clear();

    // topple transition: first time tilt passes 30°
    for (const name of fellOverChecks) {
      if (toppleNoted.has(name)) continue;
      const r = samplePose(name).rotation;
      const q0 = initialRotations.get(name)!;
      if (relativeTiltDegrees({ x: r[0], y: r[1], z: r[2], w: r[3] }, q0) > TOPPLE_EVENT_DEG) {
        toppleNoted.add(name);
        noteStep(step, `倾倒:${name}`);
      }
    }

    if (step % trajEvery === 0) recordTraj(step);

    // Gear coupling: the ratio is PRESCRIBED, not solved. rapier has no gear
    // constraint, and an external per-step impulse cannot be exact — a measured
    // version left 0.9% error at 1/1000 and 16% at 1/60, because the coupling
    // can only correct one step after the solver has already integrated. So the
    // follower's pose and angular velocity are projected onto the ratio here,
    // before the frame is recorded: what the panel plays IS the ratio, and the
    // report says so. Torque is not transferred — a contact run without the gear
    // joint is the tool for "do the teeth actually drive it".
    for (const g of gears) {
      if (g.b.invMass() === 0) continue;
      const uA = worldAxisOf(g.a, g.axisA);
      const uB = worldAxisOf(g.b, g.axisB);
      // Incremental, not absolute: the step-to-step rotation is small, so the
      // signed angle about the axis is unambiguous. (Absolute 2·atan2 aliases at
      // ±180°, which is what made a 6400 rpm run oscillate.)
      const dA = quatMul(quatConj(g.prevA), g.a.rotation());
      g.prevA = g.a.rotation();
      const len = Math.hypot(dA.x, dA.y, dA.z);
      const thetaStep = Math.sign(len > 1e-12 ? dA.x * uA[0] + dA.y * uA[1] + dA.z * uA[2] : 1)
        * 2 * Math.atan2(len, dA.w);
      g.thetaA += thetaStep;
      g.maxStepRad = Math.max(g.maxStepRad, Math.abs(thetaStep));
      const thetaB = g.ratio * g.thetaA;
      const half = thetaB / 2;
      const sinHalf = Math.sin(half);
      const rot = { w: Math.cos(half), x: uB[0] * sinHalf, y: uB[1] * sinHalf, z: uB[2] * sinHalf };
      g.b.setRotation(quatMul(rot, g.qB0), true);
      const wA = g.a.angvel();
      const wAaxis = wA.x * uA[0] + wA.y * uA[1] + wA.z * uA[2];
      g.b.setAngvel({ x: uB[0] * g.ratio * wAaxis, y: uB[1] * g.ratio * wAaxis, z: uB[2] * g.ratio * wAaxis }, true);
    }

    if (step < steps) world.step();
  }
  if (trajTimes[trajTimes.length - 1] !== +(steps * dt).toFixed(4)) recordTraj(steps);
  if (maxPenStep >= 0) noteStep(maxPenStep, '最大穿透');
  noteStep(steps, 'final');

  // Merge: keep event frames, fill remaining budget with uniform context
  // frames, enforcing a minimum gap so near-duplicates don't waste slots.
  const budget = scenario.keyframeCount ?? 6;
  const minGap = Math.max(1, Math.floor(steps / (budget * 4)));
  const chosen = new Map<number, string>();
  for (const [step, reason] of [...eventSteps.entries()].sort((a, b) => a[0] - b[0])) {
    if (chosen.size >= budget) break;
    const near = [...chosen.keys()].some((k) => Math.abs(k - step) < minGap);
    if (!near) chosen.set(step, reason);
  }
  if (chosen.size < budget) {
    for (let step = 0; step <= steps && chosen.size < budget; step += keyframeEvery) {
      if (!chosen.has(step)) {
        const near = [...chosen.keys()].some((k) => Math.abs(k - step) < minGap);
        if (!near) chosen.set(step, 'context');
      }
    }
  }
  if (!chosen.has(steps)) {
    // final frame is non-negotiable: drop the closest other context frame
    let best: number | null = null;
    for (const k of chosen.keys()) {
      if (chosen.get(k) === 'context' && (best === null || Math.abs(k - steps) < Math.abs(best - steps))) best = k;
    }
    if (best !== null) chosen.delete(best);
    chosen.set(steps, 'final');
  }

  // Poses for a chosen step: nearest recorded timeline frame (grid gap is
  // ≈0.6% of the run — visually exact; labels keep the true step number).
  const poseAt = (step: number): Record<string, PoseSample> => {
    const idx = Math.min(trajPoses.length - 1, Math.max(0, Math.round(step / trajEvery)));
    return trajPoses[idx]!;
  };

  const keyframes: PhysicsReport['keyframes'] = [...chosen.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([step, label]) => ({ step, timeSec: +(step * dt).toFixed(3), label, poses: poseAt(step) }));

  // metrics
  const fellOver: Record<string, boolean> = {};
  const maxHorizontalDisplacementMm: Record<string, number> = {};
  const finalPositions: Record<string, [number, number, number]> = {};
  for (const name of fellOverChecks) {
    const r = samplePose(name).rotation;
    const q0 = initialRotations.get(name)!;
    fellOver[name] = relativeTiltDegrees({ x: r[0], y: r[1], z: r[2], w: r[3] }, q0) > TOPPLE_VERDICT_DEG;
  }
  let anyMoving = false;
  for (const p of scenario.parts) {
    const pose = samplePose(p.name);
    finalPositions[p.name] = pose.position;
    const i0 = initialPos.get(p.name)!;
    const dh = Math.hypot(pose.position[0] - i0[0], pose.position[2] - i0[2]);
    maxHorizontalDisplacementMm[p.name] = +dh.toFixed(3);
    // "settled" = still moving at the end of the run, not total drift (a short
    // slide after impact is physical).
    if (p.bodyType === 'dynamic') {
      const v = bodies.get(p.name)!.linvel();
      if (Math.hypot(v.x, v.y, v.z) > 5) anyMoving = true; // > 5 mm/s
    }
  }
  const jointViolations: string[] = [];
  for (const j of jointAnchors) {
    const wa = worldPoint(j.a, j.anchorA);
    const wb = worldPoint(j.b, j.anchorB);
    const d: [number, number, number] = [wa[0] - wb[0], wa[1] - wb[1], wa[2] - wb[2]];
    if (j.type === 'prismatic') {
      // A slider is SUPPOSED to let the two anchors separate, but only along
      // the axis: what would be a violation is motion across it. Measuring the
      // full distance here would report every working slide as broken.
      const m = quatToMatrix3(j.a.rotation());
      const axis: [number, number, number] = [
        m[0]![0]! * j.axis.x + m[0]![1]! * j.axis.y + m[0]![2]! * j.axis.z,
        m[1]![0]! * j.axis.x + m[1]![1]! * j.axis.y + m[1]![2]! * j.axis.z,
        m[2]![0]! * j.axis.x + m[2]![1]! * j.axis.y + m[2]![2]! * j.axis.z,
      ];
      const len = Math.hypot(axis[0], axis[1], axis[2]) || 1;
      const u: [number, number, number] = [axis[0] / len, axis[1] / len, axis[2] / len];
      const along = d[0] * u[0] + d[1] * u[1] + d[2] * u[2];
      const perp = Math.hypot(d[0] - along * u[0], d[1] - along * u[1], d[2] - along * u[2]);
      if (perp > 2) jointViolations.push(`${j.name}: slide left its axis by ${perp.toFixed(2)}mm`);
      continue;
    }
    const drift = Math.hypot(d[0], d[1], d[2]);
    if (drift > 2) jointViolations.push(`${j.name}: anchor drift ${drift.toFixed(2)}mm`);
  }

  const trajectory: Trajectory = {
    times: trajTimes,
    parts: scenario.parts.map((p) => ({
      name: p.name,
      bodyType: p.bodyType,
      frames: trajPoses.map((poses) => {
        const s = poses[p.name]!;
        return [s.position[0], s.position[1], s.position[2], s.rotation[0], s.rotation[1], s.rotation[2], s.rotation[3]];
      }),
    })),
    events: [...chosen.entries()]
      .filter(([, label]) => label !== 'context')
      .map(([step, label]) => ({ timeSec: +(step * dt).toFixed(3), label })),
  };

  // ---- honest-input diagnostics ----
  // microscope3's whole-machine run (46 shells, ground contact through four
  // rubber-pad rings only) reported 6.41mm settled penetration — a contact-
  // solver artefact the agent then had to explain away by hand. The tool says
  // it itself now.
  const notes: string[] = [];
  let totalShells = 0;
  for (const p of scenario.parts) {
    try { totalShells += shellCount(parseBinaryStl(p.stl)); } catch { /* truth is best-effort */ }
  }
  if (totalShells >= 4) {
    notes.push(
      `input has ${totalShells} disconnected shells across ${scenario.parts.length} part(s); ` +
      'with sparse ground contacts the settled-penetration figure is a solver artefact, not a fit measurement — ' +
      'cross-check part fit with check_assembly / validate_assembly instead',
    );
  }
  if (jointIsolated.length > 0) {
    notes.push(
      'jointed pairs do not collide (bearing clearance is design intent): '
      + `${jointIsolated.join(', ')}; a stopper that really is supposed to collide on exactly that pair `
      + 'must be verified another way (or pass jointContacts: true and expect the solver to resolve the '
      + 'bearing overlap as a collision)',
    );
  }
  if (gearIsolated.length > 0) {
    // Separate from the joint note: a gear pair is isolated because the ratio is
    // PRESCRIBED, not because a clearance was designed. Lumping them together let
    // a gear run's "0 penetration" read as "the teeth do not touch".
    notes.push(
      `gear pair(s) ${gearIsolated.join(', ')} are ratio-coupled with contact DISABLED — this run cannot `
      + 'show tooth interference, and 0 penetration here is not evidence that the teeth clear. For that, '
      + 'run the same parts WITHOUT the gear joint (contact mode) or use validate_assembly / check_assembly',
    );
  }
  const nonConvexDynamic = scenario.parts
    .filter((p) => p.bodyType === 'dynamic' && colliderKinds[p.name] === 'trimesh')
    .map((p) => p.name);
  if (nonConvexDynamic.length > 0) {
    notes.push(
      'non-convex dynamic part(s) use exact trimesh colliders, not a single convex hull: '
      + `${nonConvexDynamic.join(', ')} (a hull would fill their cavities and report phantom contact)`,
    );
  }

  // ---- quasi-static hold analysis for prismatic joints with staticFriction ----
  const holdAnalysis: NonNullable<PhysicsReport['metrics']['holdAnalysis']> = [];
  for (const j of scenario.joints ?? []) {
    if (j.type !== 'prismatic' || typeof j.staticFriction !== 'number' || j.staticFriction <= 0) continue;
    const b = bodies.get(j.bodyB);
    if (!b) continue;
    const massKg = b.mass(); // density kg/mm³ × mm³ → kg
    const m = quatToMatrix3(b.rotation());
    const rawAxis = j.axisB ?? j.axis ?? j.axisA!;
    const axisWorld: [number, number, number] = [
      m[0]![0]! * rawAxis[0] + m[0]![1]! * rawAxis[1] + m[0]![2]! * rawAxis[2],
      m[1]![0]! * rawAxis[0] + m[1]![1]! * rawAxis[1] + m[1]![2]! * rawAxis[2],
      m[2]![0]! * rawAxis[0] + m[2]![1]! * rawAxis[1] + m[2]![2]! * rawAxis[2],
    ];
    const alen = Math.hypot(...axisWorld) || 1;
    const u = axisWorld.map((x) => x / alen) as [number, number, number];
    const gPar = gravity[0]! * u[0] + gravity[1]! * u[1] + gravity[2]! * u[2];
    const gPerpVec: [number, number, number] = [
      gravity[0]! - gPar * u[0], gravity[1]! - gPar * u[1], gravity[2]! - gPar * u[2],
    ];
    const axialDriveN = Math.abs(gPar) * massKg;
    const normalN = Math.hypot(...gPerpVec) * massKg;
    const frictionCapN = j.staticFriction * normalN;
    const holds = frictionCapN >= axialDriveN;
    holdAnalysis.push({
      joint: `${j.bodyA}~${j.bodyB}`, mu: j.staticFriction,
      massKg: +massKg.toFixed(4), axialDriveN: +axialDriveN.toFixed(4),
      frictionCapN: +frictionCapN.toFixed(4), holds,
    });
    notes.push(
      `hold analysis for ${j.bodyA}~${j.bodyB} is a QUASI-STATIC analytic estimate ` +
      `(μ·m·|g⊥| = ${frictionCapN.toFixed(3)}N vs m·|g∥| = ${axialDriveN.toFixed(3)}N → ` +
      `${holds ? 'HOLDS (self-locking under gravity)' : 'SLIDES (gravity drives it along the axis)'}); ` +
      'the rigid-body solver did not simulate friction',
    );
  }

  const loopJoints = jointLoopClosers(scenario.joints ?? []);

  // ---- motor diagnostics -------------------------------------------------
  // "Did the drive actually deliver?" answered with two independent numbers:
  // the angle the joint really turned (from the recorded pose timeline, so it is
  // the same data the panel plays back) and the relative angular velocity at the
  // last step (from the solver). A cap that is too small shows up here as
  // turnedDeg ≈ 0 / measured ≈ 0 while the target says 20 rad/s.
  /**
   * Signed, unwrapped turn of ONE body about its own local axis, from the pose
   * timeline the panel plays back. Used for the gear ratio: it is the number a
   * reader can check against the animation, not an internal solver quantity.
   */
  const signedTurn = (name: string, axisLocal: [number, number, number]): number => {
    const len = Math.hypot(axisLocal[0], axisLocal[1], axisLocal[2]) || 1;
    const u: [number, number, number] = [axisLocal[0] / len, axisLocal[1] / len, axisLocal[2] / len];
    let total = 0;
    let prev: { x: number; y: number; z: number; w: number } | null = null;
    for (const poses of trajPoses) {
      const q = poses[name]!.rotation;
      const cur = { x: q[0]!, y: q[1]!, z: q[2]!, w: q[3]! };
      if (prev) {
        const d = quatMul(quatConj(prev), cur);
        const l = Math.hypot(d.x, d.y, d.z);
        const angle = 2 * Math.atan2(l, d.w);
        const sign = l > 1e-12 ? Math.sign(d.x * u[0] + d.y * u[1] + d.z * u[2]) : 0;
        total += sign * angle;
      }
      prev = cur;
    }
    return total;
  };

  const motorJoints = (scenario.joints ?? []).filter((j) => j.motor);
  const motors = motorJoints.map((j) => {
    const a = bodies.get(j.bodyA)!;
    const b = bodies.get(j.bodyB)!;
    const axisLocal = jointAnchors.find((k) => k.name === `${j.bodyA}~${j.bodyB}` && k.type === 'revolute')!.axis;
    const alen = Math.hypot(axisLocal.x, axisLocal.y, axisLocal.z) || 1;
    const u: [number, number, number] = [axisLocal.x / alen, axisLocal.y / alen, axisLocal.z / alen];

    // Signed, unwrapped turn of B relative to A about that axis, from the poses.
    let turned = 0;
    let prev: { x: number; y: number; z: number; w: number } | null = null;
    for (const poses of trajPoses) {
      const pa = poses[j.bodyA]!.rotation;
      const pb = poses[j.bodyB]!.rotation;
      const rel = quatMul(
        quatConj({ x: pa[0]!, y: pa[1]!, z: pa[2]!, w: pa[3]! }),
        { x: pb[0]!, y: pb[1]!, z: pb[2]!, w: pb[3]! },
      );
      if (prev) {
        const d = quatMul(quatConj(prev), rel);
        const len = Math.hypot(d.x, d.y, d.z);
        const angle = 2 * Math.atan2(len, d.w);
        const sign = len > 1e-12 ? Math.sign(d.x * u[0] + d.y * u[1] + d.z * u[2]) : 0;
        turned += sign * angle;
      }
      prev = rel;
    }

    const m = quatToMatrix3(a.rotation());
    const wAxis: [number, number, number] = [
      m[0]![0]! * u[0] + m[0]![1]! * u[1] + m[0]![2]! * u[2],
      m[1]![0]! * u[0] + m[1]![1]! * u[1] + m[1]![2]! * u[2],
      m[2]![0]! * u[0] + m[2]![1]! * u[1] + m[2]![2]! * u[2],
    ];
    const wa = a.angvel();
    const wb = b.angvel();
    const measured =
      (wb.x - wa.x) * wAxis[0] + (wb.y - wa.y) * wAxis[1] + (wb.z - wa.z) * wAxis[2];
    const target = j.motor!.targetVelocityRadPerSec;
    return {
      joint: `${j.bodyA}~${j.bodyB}`,
      targetVelocityRadPerSec: target,
      maxTorqueNm: j.motor!.maxTorqueNm,
      damping: j.motor!.damping ?? j.motor!.maxTorqueNm * 100,
      measuredRadPerSec: +measured.toFixed(4),
      turnedDeg: +((turned * 180) / Math.PI).toFixed(2),
      // 10% band: a drive that cannot hold speed under its own load is a stall,
      // and "reached" must not be claimed for 19/20 of the target.
      reachedTarget: Math.abs(measured - target) <= Math.max(0.1 * Math.abs(target), 0.05),
    };
  });
  // A per-step rotation near 180° means the increment itself is ambiguous, so the
  // accumulated angle may be wrong even though the metric looks plausible.
  for (const g of gears) {
    if (g.maxStepRad > Math.PI * 0.9) {
      notes.push(
        `gear coupling moved ${(g.maxStepRad * 180 / Math.PI).toFixed(0)}° per step — at or above 180° the `
        + 'signed increment is ambiguous and the ratio may alias; lower timestepSec',
      );
    }
  }

  // Report the angle from the COUPLING's accumulator, not from the sampled poses.
  // The playback timeline is ~160 frames, so a 6400 rpm shaft advances ~2 turns
  // per frame and the pose-derived turn aliases into noise (measured: a 3 s run
  // reported -29° for a shaft that turned 320 times). The accumulator is exact by
  // construction; `signedTurn` stays in the file for the motor report, where the
  // speeds are low enough for it to be meaningful.
  const gearReport = (scenario.joints ?? []).filter((j) => j.type === 'gear').map((j) => {
    const g = gears.find((x) => x.a.handle === bodies.get(j.bodyA)?.handle && x.b.handle === bodies.get(j.bodyB)?.handle);
    if (!g) {
      const axisLocalA = (j.axisA ?? j.axis) as [number, number, number];
      const axisLocalB = (j.axisB ?? j.axisA ?? j.axis) as [number, number, number];
      const turnedA = signedTurn(j.bodyA, axisLocalA);
      const turnedB = signedTurn(j.bodyB, axisLocalB);
      return {
        joint: `${j.bodyA}~${j.bodyB}`,
        ratio: j.ratio!,
        turnedADeg: +((turnedA * 180) / Math.PI).toFixed(2),
        turnedBDeg: +((turnedB * 180) / Math.PI).toFixed(2),
        measuredRatio: Math.abs(turnedA) > 1e-9 ? +(turnedB / turnedA).toFixed(4) : 0,
      };
    }
    const turnedB = g.ratio * g.thetaA;
    return {
      joint: `${j.bodyA}~${j.bodyB}`,
      ratio: j.ratio!,
      turnedADeg: +((g.thetaA * 180) / Math.PI).toFixed(2),
      turnedBDeg: +((turnedB * 180) / Math.PI).toFixed(2),
      measuredRatio: Math.abs(g.thetaA) > 1e-9 ? +(turnedB / g.thetaA).toFixed(4) : 0,
    };
  });

  if (motors.length > 0) {
    for (const m of motors) {
      if (m.reachedTarget) continue;
      notes.push(
        `motor ${m.joint} did NOT reach its target: commanded ${m.targetVelocityRadPerSec} rad/s, `
        + `measured ${m.measuredRadPerSec} rad/s, turned ${m.turnedDeg}° — the ${m.maxTorqueNm} N·m cap `
        + 'was spent on the load (tooth/stop/friction). That is a STALL, not a solver artefact.',
      );
    }
  }

  return {
    metrics: {
      maxPenetrationMm: +Math.abs(Math.min(0, maxPenetration)).toFixed(4),
      settledPenetrationMm: +Math.abs(Math.min(0, settledPenetration)).toFixed(4),
      fellOver,
      maxHorizontalDisplacementMm,
      jointViolations,
      settled: !anyMoving,
      initialJointGaps,
      jointToleranceMm: JOINT_TOLERANCE_MM,
      contactsDisabled,
      gearContactsDisabled: gearIsolated,
      colliders: colliderKinds,
      frictions: frictionUsed,
      closedLoop: loopJoints.length > 0,
      loopJoints,
      ...(holdAnalysis.length ? { holdAnalysis } : {}),
      ...(motors.length ? { motors } : {}),
      ...(gearReport.length ? { gears: gearReport } : {}),
      solver: { timestepSec: +(scenario.timestepSec ?? 1 / 60).toFixed(6), solverIterations, ccdSubsteps },
      notes,
    },
    finalPositions,
    keyframes: keyframes.slice(0, (scenario.keyframeCount ?? 6) + 1),
    trajectory,
    stepsRun: steps,
    durationSec: duration,
  };
}

function collidersOf(bodies: Map<string, RAPIER.RigidBody>, name: string): RAPIER.Collider {
  const c = bodies.get(name)?.collider(0);
  if (!c) throw new Error(`part ${name} has no collider`);
  return c;
}

function worldPoint(body: RAPIER.RigidBody, local: RAPIER.Vector3): [number, number, number] {
  const t = body.translation();
  const r = body.rotation();
  const m = quatToMatrix3(r);
  return [
    t.x + m[0][0]! * local.x + m[0][1]! * local.y + m[0][2]! * local.z,
    t.y + m[1][0]! * local.x + m[1][1]! * local.y + m[1][2]! * local.z,
    t.z + m[2][0]! * local.x + m[2][1]! * local.y + m[2][2]! * local.z,
  ];
}

// --- keyframe rendering: one OpenSCAD scene per keyframe ---

export interface RenderPart {
  name: string;
  stlPath: string;
}

export interface KeyframeRender {
  frames: { view: string; png: Uint8Array }[];
  /** Diagnostics OpenSCAD printed while rendering the keyframes (WARNING/ERROR lines). */
  warnings: string[];
}

/**
 * One OpenSCAD scene per keyframe, then one PNG per scene.
 *
 * TWO THINGS HERE ARE LOAD-BEARING, and both were wrong until 2026-10-11:
 *
 * 1. THE POSE GOES THROUGH `multmatrix`, NOT `rotate(m=)`. OpenSCAD's `rotate()`
 *    has no `m` parameter — it takes `a=[x,y,z]` or `a=deg, v=axis`. Passing a
 *    matrix to `rotate` makes OpenSCAD print
 *      `WARNING: variable "m" not specified as parameter` and
 *      `WARNING: Problem converting rotate(a=undef) parameter`
 *    then fall back to `rotate(a=undef)` = IDENTITY, at exit code 0. Every
 *    simulator keyframe was therefore rendered in the part's INITIAL
 *    orientation: for `simulate_motion` (pure spin, translation 0) all four
 *    attached frames were byte-identical, and for `simulate_physics` a toppling
 *    tower rendered as translated boxes. Verified on both the system OpenSCAD
 *    2021.01 and the bundled 2026.09.23 snapshot — the parameter does not exist
 *    in either.
 *
 * 2. THE RENDERER IS THE PLUGIN'S, not a bare `openscad` off PATH. The old
 *    private `renderPng` hardcoded `xvfb-run -a openscad`, so keyframes came
 *    from a different binary than every other picture in the plugin (no
 *    `resolveBinary()` snapshot preference, no Manifold backend, no bundled
 *    `LD_LIBRARY_PATH`, no shared display). It now goes through
 *    `renderScadPng`, whose camera string for these options is identical.
 *
 * Diagnostics are RETURNED rather than swallowed: item 1 survived months of
 * green runs precisely because the only signal was a WARNING line nobody read.
 */
export async function renderKeyframes(
  report: PhysicsReport,
  parts: RenderPart[],
  outDir: string,
): Promise<KeyframeRender> {
  await mkdir(outDir, { recursive: true });
  const frames: { view: string; png: Uint8Array }[] = [];
  const warnings: string[] = [];
  for (const kf of report.keyframes) {
    const lines: string[] = [];
    for (const part of parts) {
      const pose = kf.poses[part.name];
      if (!pose) continue;
      const [x, y, z, w] = pose.rotation;
      const m = quatToMatrix3({ x, y, z, w });
      lines.push(`translate([${pose.position.map((v) => v.toFixed(4)).join(',')}]) ` +
        `multmatrix(${homogeneous(m)}) import("${part.stlPath}");`);
    }
    const safe = kf.label.replace(/[^A-Za-z0-9\u4e00-\u9fff]+/g, '_').slice(0, 24);
    const stem = `frame_${String(kf.step).padStart(5, '0')}_${safe}`;
    const scadPath = join(outDir, `${stem}.scad`);
    await writeFile(scadPath, lines.join('\n'), 'utf8');
    const pngPath = join(outDir, `${stem}.png`);
    const diagnostics: string[] = [];
    const ok = await renderScadPng(scadPath, pngPath, { rotate: [65, 0, 25], imgSize: 512 },
      (text) => diagnostics.push(text));
    for (const line of diagnostics.join('\n').split('\n')) {
      const trimmed = line.trim();
      if (/^(WARNING|ERROR):/.test(trimmed)) {
        warnings.push(`${stem}: ${trimmed}`);
      }
    }
    if (ok) {
      const { readFile } = await import('node:fs/promises');
      frames.push({ view: `t${kf.timeSec}s ${kf.label}`, png: await readFile(pngPath) });
    }
  }
  return { frames, warnings };
}

/** A 3×3 rotation as the 4×4 homogeneous matrix `multmatrix` takes. */
function homogeneous(m: number[][]): string {
  const rows = [
    [m[0]![0]!, m[0]![1]!, m[0]![2]!, 0],
    [m[1]![0]!, m[1]![1]!, m[1]![2]!, 0],
    [m[2]![0]!, m[2]![1]!, m[2]![2]!, 0],
    [0, 0, 0, 1],
  ];
  return `[${rows.map((row) => `[${row.map((v) => Number(v.toFixed(6))).join(',')}]`).join(',')}]`;
}
