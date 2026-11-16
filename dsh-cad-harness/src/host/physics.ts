// Rigid-body physics (M3): rapier3d-compat runs headless in Node.
// Units are millimetres/seconds throughout (rapier is unit-agnostic):
// z-up world (matches OpenSCAD): gravity default [0, 0, -9810] mm/s², density in kg/mm³.

import ManifoldModule from 'manifold-3d';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensurePythonWorker, workerScratchDir } from './python-worker.ts';
import { parseBinaryStl } from './mesh.ts';
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


function quatToMatrix3(q: { x: number; y: number; z: number; w: number }): number[][] {
  const { x, y, z, w } = q;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ];
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
