// M4: fluid scenario assembly — SDF boundary + particle seeding + inlet drive
// + escape audit + section metrics. Composes mpm.ts (solver) and sdf.ts (walls).
//
// Unit bridge: the solver runs in cell units (positions = cells, velocities =
// cells/s); mm enter/exit only via dxMm: v_cells = v_mm / dxMm.

import { createMpmWorld, type MpmWorld, type MpmWorldConfig } from './mpm.ts';
import { buildSdfFromStl, sdfAt, type SdfField } from './sdf.ts';
import { parseBinaryStl, boundingBox } from './mesh.ts';

export interface FluidScenario {
  pipeStl: Uint8Array;
  gridCells: [number, number, number];
  gridOriginMm: [number, number, number];
  dxMm: number;
  /** Particle seed box (mm) — must lie inside the pipe cavity. */
  fluidRegionMm: { min: [number, number, number]; max: [number, number, number] };
  /** Constant-speed inlet: band (mm) along the axis, axial speed floor.
   *  Omit for settling / filling scenarios with no driven inflow. */
  inlet?: { axis: 0 | 1 | 2; bandMm: [number, number]; velocityMmPerSec: number };
  /** Escape plane (mm) along the flow axis (particles passing are removed+counted).
   *  Omit for fully closed scenarios. Defaults to the inlet axis; override with
   *  outletAxis for turns (90° elbow escapes along the second leg). */
  outletPlaneMm?: number;
  outletAxis?: 0 | 1 | 2;
  /** Target particles per cell over the seed region. Default 6 (M4-PREP §1.1 sweet spot 4-8). */
  particlesPerCell?: number;
  particleCount?: number;
  steps?: number;
  /** Default [0,0,-98.1] mm/s² — gentle, keeps the pool shallow. */
  gravityMmPerSec2?: [number, number, number];
  snapshotCount?: number;
}

export interface FluidSnapshot {
  step: number;
  timeSec: number;
  posMm: Float32Array;
  speedMmPerSec: Float32Array;
}

export interface FluidReport {
  overallStatus: 'pass' | 'check';
  metrics: {
    particleCount0: number;
    escaped: number;
    active: number;
    /** Audit: |count0 − escaped − active| / count0 (≈0 by construction; guards kernel bugs). */
    massConservationError: number;
    penetrationCount: number;
    outletArrivalRatio: number;
    timeToOutletSteps: number | null;
    sectionAvgVelocity: { positionMm: number; velocityMmPerSec: number }[];
    maxVelocityMmPerSec: number;
    avgVelocityMmPerSec: number;
    diverged: boolean;
    stepsRun: number;
  };
  snapshots: FluidSnapshot[];
  durationSec: number;
}

const K0 = 50, MU0 = 0.1, RD0 = 1.5;      // reference constants (see bench)
const DT = 0.004;                          // s, cell-unit time — fixed by design
const WALL_CLEARANCE_MM = 0.75;            // seed rejection margin near walls
const PENETRATION_TOL_MM = 0.3;            // sdf below this counts as penetration

/** Derive a solver grid covering the pipe bbox plus a 1-cell margin per side. */
export function deriveGridFromStl(pipeStl: Uint8Array, dxMm: number): {
  cells: [number, number, number]; originMm: [number, number, number];
} {
  const parsed = parseBinaryStl(pipeStl);
  const bb = boundingBox(parsed);
  const cells: [number, number, number] = [0, 0, 0];
  const originMm: [number, number, number] = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const lo = bb.min[a]! - dxMm;
    const span = bb.max[a]! - bb.min[a]! + 2 * dxMm;
    originMm[a] = lo;
    cells[a] = Math.max(6, Math.round(span / dxMm));
  }
  return { cells, originMm, };
}

/**
 * Seed a deterministic lattice over the region (cell units), rejecting points
 * inside the walls or closer than WALL_CLEARANCE_MM to them.
 */
function seedPositions(
  sdf: SdfField,
  region: { min: [number, number, number]; max: [number, number, number] },
  ppc: number,
): [number, number, number][] {
  const s = Math.pow(ppc, -1 / 3); // lattice spacing in cells for `ppc` particles/cell
  const out: [number, number, number][] = [];
  const perAxis = [0, 1, 2].map((a) => {
    const lo = (region.min[a]! - sdf.originMm[a]!) / sdf.dxMm;
    const hi = (region.max[a]! - sdf.originMm[a]!) / sdf.dxMm;
    const n = Math.max(1, Math.floor((hi - lo) / s));
    return { lo, step: (hi - lo) / n, n };
  });
  for (let ix = 0; ix < perAxis[0].n; ix++) {
    for (let iy = 0; iy < perAxis[1].n; iy++) {
      for (let iz = 0; iz < perAxis[2].n; iz++) {
        const cx = perAxis[0].lo + (ix + 0.5) * perAxis[0].step;
        const cy = perAxis[1].lo + (iy + 0.5) * perAxis[1].step;
        const cz = perAxis[2].lo + (iz + 0.5) * perAxis[2].step;
        const wm = [cx * sdf.dxMm + sdf.originMm[0], cy * sdf.dxMm + sdf.originMm[1], cz * sdf.dxMm + sdf.originMm[2]];
        if (sdfAt(sdf, wm[0]!, wm[1]!, wm[2]!) < WALL_CLEARANCE_MM) continue; // wall rejection
        out.push([cx, cy, cz]);
      }
    }
  }
  return out;
}

export async function runFluid(scenario: FluidScenario): Promise<{
  report: FluidReport;
  sdf: SdfField;
  world: MpmWorld;
}> {
  const t0 = performance.now();
  const sdf = await buildSdfFromStl(scenario.pipeStl, {
    cells: scenario.gridCells,
    dxMm: scenario.dxMm,
    originMm: scenario.gridOriginMm,
  });

  const flowAxis = scenario.inlet?.axis ?? scenario.outletAxis ?? 0;
  const escapeAxis = scenario.outletAxis ?? scenario.inlet?.axis ?? flowAxis;
  const ppc = scenario.particlesPerCell ?? 6;
  const seeds = seedPositions(sdf, scenario.fluidRegionMm, ppc);
  const count = scenario.particleCount ?? seeds.length;

  const speedCells = (scenario.inlet?.velocityMmPerSec ?? 100) / scenario.dxMm;
  const bandCells: [number, number] | undefined = scenario.inlet
    ? [
        (scenario.inlet.bandMm[0] - scenario.gridOriginMm[scenario.inlet.axis]) / scenario.dxMm,
        (scenario.inlet.bandMm[1] - scenario.gridOriginMm[scenario.inlet.axis]) / scenario.dxMm,
      ]
    : undefined;
  const escapeAt = scenario.outletPlaneMm !== undefined
    ? (scenario.outletPlaneMm - scenario.gridOriginMm[escapeAxis]) / scenario.dxMm
    : undefined;
  const grav = scenario.gravityMmPerSec2 ?? [0, 0, -98.1];
  const gravityCells: [number, number, number] = [grav[0] / scenario.dxMm, grav[1] / scenario.dxMm, grav[2] / scenario.dxMm];

  let idx = 0;
  const world = createMpmWorld({
    cells: scenario.gridCells,
    dxMm: scenario.dxMm,
    particleCount: count,
    gravity: gravityCells,
    dt: DT,
    vmax: 2.4 * speedCells,
    inlet: scenario.inlet ? { axis: scenario.inlet.axis, band: bandCells!, speed: speedCells } : undefined,
    escape: escapeAt !== undefined ? { axis: escapeAxis, at: escapeAt } : undefined,
    solidMask: sdf.solidMask,
    solidNormal: sdf.solidNormal,
  }, () => seeds[idx++ % seeds.length]!);
  world.activeN = count;
  const rd = world.calibrateRestDensity();
  world.cfg.stiffness = K0 * (rd / RD0);
  world.cfg.viscosity = MU0 * (rd / RD0);

  const steps = scenario.steps ?? 1200;
  const snapshotCount = scenario.snapshotCount ?? 4;
  const snapshotEvery = Math.max(1, Math.floor(steps / (snapshotCount + 1)));
  const snapshots: FluidSnapshot[] = [];
  let timeToOutletSteps: number | null = null;
  let escapedBefore = 0;

  // near-surface mask: only particles in these cells need SDF projection
  const [gnx, gny, gnz] = scenario.gridCells;
  const gnyz = gny * gnz;
  const nearSurface = new Uint8Array(gnx * gnyz);
  const band = 2.5 * scenario.dxMm;
  for (let ix = 0; ix < gnx; ix++) {
    for (let iy = 0; iy < gny; iy++) {
      for (let iz = 0; iz < gnz; iz++) {
        const d = sdf.sdf[(ix * gny + iy) * gnz + iz]!;
        if (d > -band && d < band) nearSurface[(ix * gny + iy) * gnz + iz] = 1;
      }
    }
  }

  /** Push particles that ended up inside the wall back to the surface (free-slip). */
  const projectParticles = () => {
    const dx = scenario.dxMm;
    const tol = 0.05;
    for (let p = 0; p < world.activeN; p++) {
      const cx = world.pos[p * 3]!, cy = world.pos[p * 3 + 1]!, cz = world.pos[p * 3 + 2]!;
      const cell = (cx | 0) * gnyz + (cy | 0) * gnz + (cz | 0);
      if (!nearSurface[cell]) continue;
      const wx = cx * dx + scenario.gridOriginMm[0];
      const wy = cy * dx + scenario.gridOriginMm[1];
      const wz = cz * dx + scenario.gridOriginMm[2];
      const d = sdfAt(sdf, wx, wy, wz);
      if (d >= -tol) continue;
      // outward gradient via central differences on the grid SDF
      const gx = sdfAt(sdf, wx + dx, wy, wz) - sdfAt(sdf, wx - dx, wy, wz);
      const gy = sdfAt(sdf, wx, wy + dx, wz) - sdfAt(sdf, wx, wy - dx, wz);
      const gz = sdfAt(sdf, wx, wy, wz + dx) - sdfAt(sdf, wx, wy, wz - dx);
      const gl = Math.hypot(gx, gy, gz) || 1;
      const nx = gx / gl, ny = gy / gl, nz = gz / gl;
      const push = -d + 0.15 * dx; // bring the centre just outside the surface
      world.pos[p * 3] = cx + (nx * push) / dx;
      world.pos[p * 3 + 1] = cy + (ny * push) / dx;
      world.pos[p * 3 + 2] = cz + (nz * push) / dx;
      // kill the into-wall velocity component (free slip)
      const vn = world.vel[p * 3]! * nx + world.vel[p * 3 + 1]! * ny + world.vel[p * 3 + 2]! * nz;
      if (vn < 0) {
        world.vel[p * 3] -= nx * vn;
        world.vel[p * 3 + 1] -= ny * vn;
        world.vel[p * 3 + 2] -= nz * vn;
      }
    }
  };

  let divergedLogged = false;
  // time-averaged axial velocity per axial section (M5 consumes these)
  const hasSections = scenario.outletPlaneMm !== undefined;
  const lo = scenario.fluidRegionMm.min[flowAxis]!;
  const hi = scenario.outletPlaneMm ?? lo + 1;
  const sectionCount = 20;
  const sectionVelSum = new Float64Array(sectionCount);
  const sectionVelN = new Float64Array(sectionCount);

  for (let step = 1; step <= steps; step++) {
    world.step();
    projectParticles();
    if (process.env.CAD_FLUID_DEBUG && world.nonFinite > 0 && !divergedLogged) {
      divergedLogged = true;
      let bad = 0, sample = '';
      for (let p = 0; p < world.activeN; p++) {
        const v = world.vel[p * 3]! + world.vel[p * 3 + 1]! + world.vel[p * 3 + 2]!;
        const x = world.pos[p * 3]!, y = world.pos[p * 3 + 1]!, z = world.pos[p * 3 + 2]!;
        if (!Number.isFinite(v + x + y + z)) { bad++; if (bad <= 2) sample += ` p${p}=[${x},${y},${z}]v=[${world.vel[p * 3]},${world.vel[p * 3 + 1]},${world.vel[p * 3 + 2]}]`; }
      }
      console.error(`[dbg] first NaN at step ${step}, bad=${bad}, escaped=${world.escaped}, activeN=${world.activeN}${sample}`);
    }
    if (timeToOutletSteps === null && world.escaped > escapedBefore) timeToOutletSteps = step;
    escapedBefore = world.escaped;

    if (hasSections) for (let p = 0; p < world.activeN; p++) {
      const along = world.pos[p * 3 + flowAxis]! * scenario.dxMm + scenario.gridOriginMm[flowAxis];
      const bin = Math.floor((along - lo) / ((hi - lo) / sectionCount));
      if (bin < 0 || bin >= sectionCount) continue;
      sectionVelSum[bin] += world.vel[p * 3 + flowAxis]! * scenario.dxMm;
      sectionVelN[bin]++;
    }

    if (step % snapshotEvery === 0 && snapshots.length < snapshotCount) {
      const n = world.activeN;
      const posMm = new Float32Array(3 * n);
      const spd = new Float32Array(n);
      for (let p = 0; p < n; p++) {
        for (let a = 0; a < 3; a++) posMm[p * 3 + a] = world.pos[p * 3 + a]! * scenario.dxMm + scenario.gridOriginMm[a]!;
        spd[p] = Math.hypot(world.vel[p * 3]!, world.vel[p * 3 + 1]!, world.vel[p * 3 + 2]!) * scenario.dxMm;
      }
      snapshots.push({ step, timeSec: +(step * DT).toFixed(3), posMm, speedMmPerSec: spd });
    }
  }

  // ---- metrics: penetration + speed stats over the final state ----
  const active = world.activeN;
  let penetrationCount = 0;
  let maxV = 0, sumV = 0;
  for (let p = 0; p < active; p++) {
    const wm: [number, number, number] = [
      world.pos[p * 3]! * scenario.dxMm + scenario.gridOriginMm[0],
      world.pos[p * 3 + 1]! * scenario.dxMm + scenario.gridOriginMm[1],
      world.pos[p * 3 + 2]! * scenario.dxMm + scenario.gridOriginMm[2],
    ];
    const d = sdfAt(sdf, wm[0], wm[1], wm[2]);
    if (d < -PENETRATION_TOL_MM) penetrationCount++;
    const vx = world.vel[p * 3]! * scenario.dxMm;
    const vy = world.vel[p * 3 + 1]! * scenario.dxMm;
    const vz = world.vel[p * 3 + 2]! * scenario.dxMm;
    const sp = Math.hypot(vx, vy, vz);
    if (sp > maxV) maxV = sp;
    sumV += sp;
  }
  const sectionAvgVelocity = scenario.outletPlaneMm === undefined && !scenario.inlet
    ? []
    : Array.from(sectionVelSum, (v, i) => ({
        positionMm: +(lo + ((hi - lo) * (i + 0.5)) / sectionCount).toFixed(1),
        velocityMmPerSec: +(sectionVelN[i] ? v / sectionVelN[i] : 0).toFixed(1),
      }));

  const count0 = count;
  const massConservationError = Math.abs(count0 - world.escaped - active) / count0;
  const outletArrivalRatio = world.escaped / count0;
  const hasEscape = scenario.outletPlaneMm !== undefined;
  const clean = !divergedOf(world) && penetrationCount === 0 && massConservationError < 1e-6
    && (!hasEscape || outletArrivalRatio >= 0.5);

  const report: FluidReport = {
    overallStatus: clean ? 'pass' : 'check',
    metrics: {
      particleCount0: count0,
      escaped: world.escaped,
      active,
      massConservationError: +massConservationError.toFixed(6),
      penetrationCount,
      outletArrivalRatio: +outletArrivalRatio.toFixed(4),
      timeToOutletSteps,
      sectionAvgVelocity,
      maxVelocityMmPerSec: +maxV.toFixed(1),
      avgVelocityMmPerSec: +(sumV / Math.max(1, active)).toFixed(1),
      diverged: divergedOf(world),
      stepsRun: steps,
    },
    snapshots,
    durationSec: +((performance.now() - t0) / 1000).toFixed(1),
  };
  return { report, sdf, world };
}

function divergedOf(world: MpmWorld): boolean {
  return world.nonFinite > 0 || !Number.isFinite(world.activeN);
}

// ---------- preset derivation (tool + panel button + manual route) ----------

export interface FluidPreset {
  gridCells: [number, number, number];
  gridOriginMm: [number, number, number];
  dxMm: number;
  axis: 0 | 1 | 2;
  fluidRegionMm: { min: [number, number, number]; max: [number, number, number] };
  inletBandMm: [number, number];
  inletVelocityMmPerSec: number;
  outletPlaneMm: number;
  steps: number;
}

/**
 * Derive a full fluid scenario from the pipe mesh alone: flow along the
 * longest bbox axis, seed block at the inlet end (30% of the length, 3mm
 * wall clearance), escape plane just before the far opening.
 */
export function deriveFluidPreset(pipeStl: Uint8Array, dxMm = 2, inletVelocityMmPerSec = 100): FluidPreset {
  const parsed = parseBinaryStl(pipeStl);
  const bb = boundingBox(parsed);
  const spans = [bb.max[0]! - bb.min[0]!, bb.max[1]! - bb.min[1]!, bb.max[2]! - bb.min[2]!];
  const axis = (spans[0]! >= spans[1]! && spans[0]! >= spans[2]! ? 0 : spans[1]! >= spans[2]! ? 1 : 2) as 0 | 1 | 2;
  const { cells, originMm } = deriveGridFromStl(pipeStl, dxMm);

  const lo = bb.min[axis]!;
  const span = spans[axis]!;
  const bandMm: [number, number] = [lo + 2 * dxMm, lo + 6 * dxMm];
  const outletPlaneMm = bb.max[axis]! - 2 * dxMm;

  const region = { min: [0, 0, 0] as [number, number, number], max: [0, 0, 0] as [number, number, number] };
  for (let a = 0; a < 3; a++) {
    if (a === axis) {
      region.min[a] = lo + 4 * dxMm;
      region.max[a] = lo + Math.max(span * 0.3, 10 * dxMm);
    } else {
      const c = (bb.min[a]! + bb.max[a]!) / 2;
      const half = spans[a]! / 2 - 1.5 * dxMm;
      region.min[a] = c - half;
      region.max[a] = c + half;
    }
  }

  const travel = outletPlaneMm - (bandMm[0] + bandMm[1]) / 2;
  const steps = Math.min(3000, Math.max(600, Math.ceil((travel / inletVelocityMmPerSec / 0.004) * 1.6)));

  return {
    gridCells: cells,
    gridOriginMm: originMm,
    dxMm,
    axis,
    fluidRegionMm: region,
    inletBandMm: bandMm,
    inletVelocityMmPerSec,
    outletPlaneMm,
    steps,
  };
}
