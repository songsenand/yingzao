// Rigid-body physics (M3): rapier3d-compat runs headless in Node.
// Units are millimetres/seconds throughout (rapier is unit-agnostic):
// z-up world (matches OpenSCAD): gravity default [0, 0, -9810] mm/s², density in kg/mm³.

import RAPIER from '@dimforge/rapier3d-compat';
import ManifoldModule from 'manifold-3d';
import { parseBinaryStl, shellCount } from './mesh.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

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
  initialAngularVelocity?: [number, number, number]; // rad/s
  fellOverCheck?: boolean;
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
  type: 'revolute' | 'prismatic';
  bodyA: string;
  bodyB: string;
  /** Anchor in A's local frame, mm. */
  anchorA: [number, number, number];
  /** Anchor in B's local frame, mm. */
  anchorB: [number, number, number];
  /** Axis in both bodies' local frames (should match in world when aligned). */
  axis: [number, number, number];
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
}

export interface PhysicsScenario {
  parts: PhysicsPartInput[];
  joints?: PhysicsJointInput[];
  gravity?: [number, number, number];
  durationSec?: number;
  timestepSec?: number;
  keyframeCount?: number;
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
    /** Quasi-static "will the slide hold?" answers, when staticFriction was given. */
    holdAnalysis?: { joint: string; mu: number; massKg: number; axialDriveN: number; frictionCapN: number; holds: boolean }[];
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

/** Angle in degrees between initial up vector and current up for a body quat. */
function upTiltDegrees(q: { x: number; y: number; z: number; w: number }): number {
  const m = quatToMatrix3(q);
  // z-up world: local +Z in world = third column diagonal
  const uz = m[2][2]!;
  return Math.acos(Math.max(-1, Math.min(1, uz))) * 180 / Math.PI;
}

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
export async function runPhysics(scenario: PhysicsScenario): Promise<PhysicsReport> {
  const RAPIER_ = await R();
  const gravity = scenario.gravity ?? [0, 0, -9810];
  const dt = scenario.timestepSec ?? 1 / 60;
  const duration = scenario.durationSec ?? 2;
  const steps = Math.max(1, Math.round(duration / dt));
  const keyframeEvery = Math.max(1, Math.floor(steps / (scenario.keyframeCount ?? 6)));

  const world = new RAPIER_.World({ x: gravity[0], y: gravity[1], z: gravity[2] });
  world.timestep = dt;

  const bodies = new Map<string, RAPIER.RigidBody>();
  const colliders = new Map<string, RAPIER.Collider>();
  const fellOverChecks: string[] = [];
  const initialPos = new Map<string, [number, number, number]>();

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
      const hullPoints = verticesOf(part.stl);
      const cd = RAPIER_.ColliderDesc.convexHull(hullPoints)!;
      cd.setDensity(part.density ?? 1.05e-6);
      world.createCollider(cd, body);
      if (part.initialAngularVelocity) {
        body.setAngvel({ x: part.initialAngularVelocity[0], y: part.initialAngularVelocity[1], z: part.initialAngularVelocity[2] }, true);
      }
      if (part.fellOverCheck !== false) fellOverChecks.push(part.name);
    } else {
      // Fixed parts: rapier CCD does not help against trimesh colliders, so
      // convex fixed geometry MUST use a convex hull collider (robust + fast).
      // Non-convex geometry falls back to trimesh with finer substeps.
      if (await isConvexStl(part.stl)) {
        world.createCollider(RAPIER_.ColliderDesc.convexHull(verticesOf(part.stl))!, body);
      } else {
        const { vertices, indices } = trimeshOf(part.stl);
        world.createCollider(RAPIER_.ColliderDesc.trimesh(vertices, indices), body);
      }
    }
    bodies.set(part.name, body);
    initialPos.set(part.name, [...part.position]);
  }

  // Joints: revolute (hinge) and prismatic (slide).
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
    const anchorA = { x: j.anchorA[0], y: j.anchorA[1], z: j.anchorA[2] };
    const anchorB = { x: j.anchorB[0], y: j.anchorB[1], z: j.anchorB[2] };
    const axis = { x: j.axis[0], y: j.axis[1], z: j.axis[2] };
    const type = j.type === 'prismatic' ? 'prismatic' : 'revolute';
    const params = type === 'prismatic'
      ? RAPIER_.JointData.prismatic(anchorA, anchorB, axis)
      : RAPIER_.JointData.revolute(anchorA, anchorB, axis);
    const joint = world.createImpulseJoint(params, a, b, true);
    if (type === 'prismatic' && j.limits) {
      (joint as RAPIER.PrismaticImpulseJoint).setLimits(j.limits[0], j.limits[1]);
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
      if (upTiltDegrees({ x: r[0], y: r[1], z: r[2], w: r[3] }) > 30) {
        toppleNoted.add(name);
        noteStep(step, `倾倒:${name}`);
      }
    }

    if (step % trajEvery === 0) recordTraj(step);

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
    fellOver[name] = upTiltDegrees({ x: r[0], y: r[1], z: r[2], w: r[3] }) > 60;
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

  // ---- quasi-static hold analysis for prismatic joints with staticFriction ----
  const holdAnalysis: NonNullable<PhysicsReport['metrics']['holdAnalysis']> = [];
  for (const j of scenario.joints ?? []) {
    if (j.type !== 'prismatic' || typeof j.staticFriction !== 'number' || j.staticFriction <= 0) continue;
    const b = bodies.get(j.bodyB);
    if (!b) continue;
    const massKg = b.mass(); // density kg/mm³ × mm³ → kg
    const m = quatToMatrix3(b.rotation());
    const axisWorld: [number, number, number] = [
      m[0]![0]! * j.axis[0] + m[0]![1]! * j.axis[1] + m[0]![2]! * j.axis[2],
      m[1]![0]! * j.axis[0] + m[1]![1]! * j.axis[1] + m[1]![2]! * j.axis[2],
      m[2]![0]! * j.axis[0] + m[2]![1]! * j.axis[1] + m[2]![2]! * j.axis[2],
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

  return {
    metrics: {
      maxPenetrationMm: +Math.abs(Math.min(0, maxPenetration)).toFixed(4),
      settledPenetrationMm: +Math.abs(Math.min(0, settledPenetration)).toFixed(4),
      fellOver,
      maxHorizontalDisplacementMm,
      jointViolations,
      settled: !anyMoving,
      ...(holdAnalysis.length ? { holdAnalysis } : {}),
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

export async function renderKeyframes(
  report: PhysicsReport,
  parts: RenderPart[],
  outDir: string,
): Promise<{ view: string; png: Uint8Array }[]> {
  await mkdir(outDir, { recursive: true });
  const pngs: { view: string; png: Uint8Array }[] = [];
  for (const kf of report.keyframes) {
    const lines: string[] = [];
    for (const part of parts) {
      const pose = kf.poses[part.name];
      if (!pose) continue;
      const [x, y, z, w] = pose.rotation;
      const m = quatToMatrix3({ x, y, z, w });
      const mStr = m.map((row) => `[${row.map((v) => v.toFixed(6)).join(',')}]`).join(',');
      lines.push(`translate([${pose.position.map((v) => v.toFixed(4)).join(',')}]) rotate(m=[${mStr}]) import("${part.stlPath}");`);
    }
    const safe = kf.label.replace(/[^A-Za-z0-9\u4e00-\u9fff]+/g, '_').slice(0, 24);
    const scadPath = join(outDir, `frame_${String(kf.step).padStart(5, '0')}_${safe}.scad`);
    await writeFile(scadPath, lines.join('\n'), 'utf8');
    const pngPath = join(outDir, `frame_${String(kf.step).padStart(5, '0')}_${safe}.png`);
    const ok = await renderPng(scadPath, pngPath);
    if (ok) {
      const { readFile } = await import('node:fs/promises');
      pngs.push({ view: `t${kf.timeSec}s ${kf.label}`, png: await readFile(pngPath) });
    }
  }
  return pngs;
}

function renderPng(scadPath: string, pngPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('xvfb-run', ['-a', 'openscad', '-o', pngPath,
      '--camera=0,0,0,65,0,25,0', '--imgsize=512,512', '--viewall', '--autocenter',
      '--projection=p', '--colorscheme=Tomorrow', scadPath], { cwd: join(scadPath, '..') });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0); });
    child.on('error', () => { clearTimeout(timer); resolve(false); });
  });
}
