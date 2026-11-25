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

import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensurePythonWorker, workerScratchDir } from './python-worker.ts';
import { rotateVec } from './assembly-check.ts';
import type { PhysicsReport, Trajectory } from './physics.ts';

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
    if (j.type === 'gear') continue; // a ratio coupling has no anchor to assemble
    const a = parts.find((p) => p.name === j.bodyA);
    const b = parts.find((p) => p.name === j.bodyB);
    if (!a || !b) continue;
    const ra = rotateVec([j.anchorA[0]!, j.anchorA[1]!, j.anchorA[2]!], a.rotation);
    const rb = rotateVec([j.anchorB[0]!, j.anchorB[1]!, j.anchorB[2]!], b.rotation);
    let dx = ra[0]! + a.position[0]! - (rb[0]! + b.position[0]!);
    let dy = ra[1]! + a.position[1]! - (rb[1]! + b.position[1]!);
    let dz = ra[2]! + a.position[2]! - (rb[2]! + b.position[2]!);
    if (j.type === 'prismatic') {
      const raw = j.axisA ?? j.axis!;
      const world = rotateVec([raw[0]!, raw[1]!, raw[2]!], a.rotation);
      const len = Math.hypot(world[0]!, world[1]!, world[2]!) || 1;
      const ax = [world[0]! / len, world[1]! / len, world[2]! / len];
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
  type: 'revolute' | 'prismatic' | 'gear';
  bodyA: string;
  bodyB: string;
  /** Anchor in A's local frame, mm. */
  anchorA: [number, number, number];
  /** Anchor in B's local frame, mm. */
  anchorB: [number, number, number];
  /** Same local axis in BOTH bodies; only correct for parallel frames. */
  axis?: [number, number, number];
  /** Per-body axes for a joint between differently-oriented bodies. */
  axisA?: [number, number, number];
  axisB?: [number, number, number];
  /** World-space direction at t=0; the tool resolves it per body. */
  axisWorld?: [number, number, number];
  /** Prismatic travel limits [min, max] in mm along the axis. */
  limits?: [number, number];
  /** `gear` only: turns of bodyB per turn of bodyA about each body's own axis (signed). */
  ratio?: number;
  /**
   * Declared pin/bearing envelope for a revolute joint: a capsule along the
   * joint axis, radius `radiusMm`, cylindrical half-length `halfLengthMm`
   * (default 0 = sphere). Overlap inside it is a fit candidate, not a collision;
   * overlap outside it is interference. Absent -> every overlap is interference.
   */
  overlapEnvelope?: { radiusMm: number; halfLengthMm?: number };
  /**
   * The designer/agent declares this joint's in-envelope overlap is an intended
   * fit. WITHOUT it, an in-envelope overlap keeps the run at `check` and asks
   * for a decision; the tool does not assume "bearing" from the joint type.
   */
  fit?: 'bearing' | 'press-fit' | 'clamp' | 'clearance';
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
  /**
   * Also boolean-test revolute-linked pairs against their declared
   * `overlapEnvelope` capsule. The default is false because a pin/bearing is
   * expected to share space; without this, a motion-clearance interface over a
   * revolute pair cannot be evidenced at all (the pair is never in the timeline).
   */
  scanJointPairs?: boolean;
}

export interface MotionReport {
  overallStatus: 'pass' | 'check';
  metrics: {
    driveOmegaRadPerSec: number | null;
    cyclePeriodSec: number | null;
    followers: Record<string, {
      travelMm: number; axis: 'x' | 'y' | 'z'; periodSec: number | null;
      /**
       * max−min INCLUDING the t=0 pose. The warm-up is deliberately excluded
       * from `travelMm` (it absorbs the assembly gap), but a driven mechanism
       * that starts 0.4 mm away from its low stop then reports a 5% short
       * stroke with no explanation. Publishing both makes the difference
       * auditable instead of something the agent has to reverse-engineer.
       */
      fullTravelMm?: number;
      /** |settled − initial| when the warm-up ends; the settling transient. */
      warmUpOffsetMm?: number;
      /** fullTravelMm − travelMm: how much of the stroke the warm-up discarded. */
      warmUpLostMm?: number;
    }>;
    interferenceCount: number;
    interferenceEvents: { step: number; timeSec: number; partA: string; partB: string; volumeMm3: number; jointPair?: boolean; overlapBboxMm?: [number, number, number, number, number, number] }[];
    /** Gear couplings: the declared ratio and the turns the run produced. */
    gears?: { a: string; b: string; ratio: number; turnsA: number; turnsB: number; measuredRatio: number | null; agrees: boolean | null }[];
    /** Sampled poses that were actually boolean-tested (coverage, not outcome). */
    interferenceChecks: number;
    /** Candidate pairs after fixed↔fixed and revolute-linked exclusions. */
    candidatePairs: number;
    /**
     * Revolute-linked pairs that were NOT in the interference timeline. This is
     * coverage, not an outcome: "0 interference" says nothing about them. Every
     * entry here is a pair whose relative motion was constraint-governed only.
     * Empty when `scanJointPairs` is on (they were scanned, with the pin zone
     * forgiven).
     */
    excludedJointPairs: [string, string][];
    /** Whether revolute pairs entered the timeline. */
    jointPairScan: boolean;
    /**
     * What the declared capsule envelope forgave, per pair. This is the agent's
     * to-do list: an entry with `resolved:false` means the run cannot pass until
     * the fit is declared (or the geometry/envelope changes).
     */
    jointExemptions: {
      partA: string; partB: string;
      frames: number;
      maxVolumeMm3: number;
      maxTimeSec: number;
      maxRadialMm: number;
      maxAxialMm: number;
      radiusMm: number;
      halfLengthMm: number;
      fit: string | null;
      resolved: boolean;
      attention: string[];
      requiredAction: string | null;
    }[];
    /** How many exempted pairs still lack a fit declaration (a run gate). */
    jointFitsUnresolved: number;
    /** The rule that produced `jointExemptions.attention`, in words. */
    jointExemptRule: string;
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
    /** The kinematic graph contains a cycle (a fact, not a verdict). */
    closedLoop?: boolean;
    /** The joints that close a loop, in declaration order. */
    loopJoints?: string[];
    /**
     * What this engine actually simulates. It is a rigid-body kinematic solver:
     * it has no springs, no contact and no gravity. A "0 interference" motion run
     * therefore cannot prove a detent, a preload or a click — a boundary the
     * Bicycle sessions had to state by hand.
     */
    capabilities?: { rigidBodies: true; joints: true; springs: false; contact: false; gravity: false };
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
        ...(scenario.scanJointPairs ? { scanJointPairs: true } : {}),
      },
    });
  } finally {
    await Promise.all(written.map((path) => rm(path, { force: true }).catch(() => {})));
  }
}
