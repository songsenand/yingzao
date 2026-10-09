// M4: fluid scenario assembly — SDF boundary + particle seeding + inlet drive
// + escape audit + section metrics. Composes mpm.ts (solver) and sdf.ts (walls).
//
// Unit bridge: the solver runs in cell units (positions = cells, velocities =
// cells/s); mm enter/exit only via dxMm: v_cells = v_mm / dxMm.

import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensurePythonWorker, workerScratchDir } from './python-worker.ts';
import { createMpmWorld, type MpmWorld, type MpmWorldConfig } from './mpm.ts';
import { buildSdfFromStl, sdfAt, solidMaskAt, type SdfField } from './sdf.ts';
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
    /**
     * Seed-lattice accounting. `solidFraction` is the share of the seed region
     * that is METAL: `deriveFluidPreset` sizes the cross-section from the
     * bounding box, so a thick-walled part gives a region far larger than its
     * cavity (measured 4.1x on a Ø60/Ø30 annulus). Those points are now
     * rejected, but the ratio tells the caller how loosely the region fits —
     * and it is the number to look at when arrival looks low for no visible
     * reason.
     */
    seedStats: {
      accepted: number;
      rejectedWall: number;
      rejectedSolid: number;
      solidFraction: number;
      /** Particle count actually placed (explicit `particleCount`, else the lattice size). */
      requested: number;
      /** How many particles share each seed position. >1 means the lattice was NOT refined. */
      stacksPerSeed: number;
    };
    /**
     * Non-fatal problems the caller must know about. Currently raised when the
     * requested particle count exceeds the seed lattice: the placer cycles
     * `seeds[idx++ % seeds.length]`, so extra particles STACK on existing seed
     * positions instead of densifying the lattice — the arrival ratio then
     * describes those few positions rather than the flow field. Raise
     * `particlesPerCell` (or widen `fluidRegionMm`) to get a real denser lattice.
     */
    warnings: string[];
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
  /** DIAGNOSTIC ONLY (CAD_FLUID_DEBUG_PENETRATION=1); not in the tool schema. */
  debugPenetration?: Record<string, number>;
  durationSec: number;
}

const K0 = 50, MU0 = 0.1, RD0 = 1.5;      // reference constants (see bench)
// s, cell-unit time — fixed by design. DIAGNOSTIC (CAD_FLUID_DT) can override it
// to measure how much of the outcome is DISCRETISATION rather than round-off.
const DT = process.env.CAD_FLUID_DT ? Number(process.env.CAD_FLUID_DT) : 0.004;
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
 *
 * BOTH tests are required. The SDF stores the distance to the nearest surface,
 * so it is positive on both sides of a wall: a distance threshold alone cannot
 * tell "0.75mm of clearance inside the cavity" from "6.75mm deep inside the
 * wall", and the latter used to be seeded as fluid (measured 2026-10-08 on a
 * Ø60/Ø30 annulus). `solidMaskAt` supplies the missing sign.
 */
function seedPositions(
  sdf: SdfField,
  region: { min: [number, number, number]; max: [number, number, number] },
  ppc: number,
): { seeds: [number, number, number][]; rejectedWall: number; rejectedSolid: number } {
  const s = Math.pow(ppc, -1 / 3); // lattice spacing in cells for `ppc` particles/cell
  const out: [number, number, number][] = [];
  let rejectedWall = 0, rejectedSolid = 0;
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
        // solid first: inside metal the distance is large and positive, so the
        // clearance test below would wave it through
        if (solidMaskAt(sdf, wm[0]!, wm[1]!, wm[2]!)) { rejectedSolid++; continue; }
        if (sdfAt(sdf, wm[0]!, wm[1]!, wm[2]!) < WALL_CLEARANCE_MM) { rejectedWall++; continue; }
        out.push([cx, cy, cz]);
      }
    }
  }
  return { seeds: out, rejectedWall, rejectedSolid };
}

/** Write the grid SDF + mask + normal as one binary file (see worker.py's header). */
function writeSdfFile(path: string, sdf: SdfField): void {
  const [nx, ny, nz] = sdf.cells;
  const total = nx * ny * nz;
  const header = Buffer.alloc(8 + 12 + 32);
  header.write('CADFSDF1', 0, 'latin1');
  header.writeInt32LE(nx, 8);
  header.writeInt32LE(ny, 12);
  header.writeInt32LE(nz, 16);
  // header = magic(8) + int32 nx,ny,nz(12) + float64 dx + origin[3] (32) = 52 bytes
  header.writeDoubleLE(sdf.dxMm, 20);
  header.writeDoubleLE(sdf.originMm[0], 28);
  header.writeDoubleLE(sdf.originMm[1], 36);
  header.writeDoubleLE(sdf.originMm[2], 44);
  const body = Buffer.alloc(total * 4 + total + total);
  Buffer.from(sdf.sdf.buffer, sdf.sdf.byteOffset, total * 4).copy(body, 0);
  Buffer.from(sdf.solidMask.buffer, sdf.solidMask.byteOffset, total).copy(body, total * 4);
  Buffer.from(sdf.solidNormal.buffer, sdf.solidNormal.byteOffset, total).copy(body, total * 5);
  writeFileSync(path, Buffer.concat([header, body]));
}

/** Write the seed lattice as one binary file: count + xyz doubles. */
function writeSeedFile(path: string, seeds: [number, number, number][]): void {
  const header = Buffer.alloc(8 + 4);
  header.write('CADFSEED', 0, 'latin1');
  header.writeInt32LE(seeds.length, 8);
  const body = Buffer.alloc(seeds.length * 24);
  seeds.forEach((seed, i) => {
    body.writeDoubleLE(seed[0], i * 24);
    body.writeDoubleLE(seed[1], i * 24 + 8);
    body.writeDoubleLE(seed[2], i * 24 + 16);
  });
  writeFileSync(path, Buffer.concat([header, body]));
}

/** Read the snapshot file the worker wrote: step, time, positions (mm), speeds. */
function readSnapshotFile(path: string): FluidSnapshot[] {
  const data = readFileSync(path);
  if (data.subarray(0, 8).toString('latin1') !== 'CADFSNAP') throw new Error('bad snapshot file magic');
  let offset = 8;
  const count = data.readInt32LE(offset); offset += 4;
  const snapshots: FluidSnapshot[] = [];
  for (let s = 0; s < count; s++) {
    const step = data.readInt32LE(offset); offset += 4;
    const timeSec = data.readDoubleLE(offset); offset += 8;
    const n = data.readInt32LE(offset); offset += 4;
    const posMm = new Float32Array(data.buffer.slice(data.byteOffset + offset, data.byteOffset + offset + n * 12));
    offset += n * 12;
    const speedMmPerSec = new Float32Array(data.buffer.slice(data.byteOffset + offset, data.byteOffset + n * 4));
    offset += n * 4;
    snapshots.push({ step, timeSec, posMm, speedMmPerSec });
  }
  return snapshots;
}

/**
 * Run a fluid scenario (batch 4: the MPM kernel AND the run loop are the Python
 * worker's; the matrix records that this is the one place where Python is
 * deliberately slower — 2.5–4× measured — and that the kernel is marked for a
 * later Rust/C implementation, whose native ceiling measured 3.7–4.6× FASTER than
 * the TS kernel).
 */
export async function runFluid(scenario: FluidScenario): Promise<{ report: FluidReport; sdf: SdfField }> {
  // ---------------------------------------------------------------------------
  // The Python worker is canonical (batch 4). The path cost one real debugging
  // round: the run first went out with NO wall boundary conditions — the SDF's
  // solid mask never reached the MPM grid update — and the 50k-particle pipe
  // arrived at 0.098 where the TS canonical arrives at 0.8643, because the flow
  // leaked into the walls. Two lessons are recorded in the matrix:
  //   * the kernel parity check never covered the solid mask, and
  //   * the invariants (penetration, conservation, divergence) held even then, so
  //     only an ARRIVAL-scale assertion catches a missing-wall bug.
  // `runFluidInTs` stays as the parity oracle and as the darwin-x64 fallback.
  //
  // Diagnostics kept on purpose: `CAD_FLUID_NO_PROJECT=1` skips the SDF
  // projection (how the suspect was isolated); it must never be set in production.
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // The Python worker is canonical (batch 4, 2026-10-12).
  //
  // The path cost three debugging rounds and taught three things worth keeping:
  //   1. the SDF's solid mask never reached the MPM grid update (no wall boundary
  //      conditions at all — the 50k pipe arrived at 0.098 instead of 0.864);
  //   2. a defensive box clamp inside the projection pulled particles back onto the
  //      grid FACE, which is inside the wall for a pipe that hugs the boundary;
  //   3. the kernel's float64 state made every step differ from TS's Float32Array
  //      by ~1e-6, and the projection/inlet feedback loop amplified that into a 20%
  //      macroscopic difference over 600 steps. Matching TS's dtypes (float32 state,
  //      float64 grid accumulation) plus reusing work buffers fixed BOTH the
  //      acceptance spread and the memory (941 MB → 229 MB peak) and the runtime
  //      (7.2x → 4.2x of TS).
  //
  // `runFluidInTs` stays as the parity oracle; `DSH_CAD_FLUID_PYTHON=0` selects it.
  // Diagnostics: `CAD_FLUID_NO_PROJECT=1`, `CAD_FLUID_DEBUG_PENETRATION=1`,
  // `CAD_FLUID_DEBUG_PROJECT=1` (never in production).
  // ---------------------------------------------------------------------------
  if (process.env.DSH_CAD_FLUID_PYTHON === '0') {
    const legacy = await runFluidInTs(scenario);
    return { report: legacy.report, sdf: legacy.sdf };
  }
  const t0 = performance.now();
  const sdf = await buildSdfFromStl(scenario.pipeStl, {
    cells: scenario.gridCells,
    dxMm: scenario.dxMm,
    originMm: scenario.gridOriginMm,
  });

  const flowAxis = scenario.inlet?.axis ?? scenario.outletAxis ?? 0;
  const escapeAxis = scenario.outletAxis ?? scenario.inlet?.axis ?? flowAxis;
  const ppc = scenario.particlesPerCell ?? 6;
  const seeded = seedPositions(sdf, scenario.fluidRegionMm, ppc);
  const seeds = seeded.seeds;
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

  const steps = scenario.steps ?? 1200;
  const snapshotCount = scenario.snapshotCount ?? 4;
  const snapshotEvery = Math.max(1, Math.floor(steps / (snapshotCount + 1)));

  const scratch = await workerScratchDir();
  const sdfPath = join(scratch, `fluid-sdf-${randomUUID()}.bin`);
  const seedsPath = join(scratch, `fluid-seeds-${randomUUID()}.bin`);
  const snapshotsPath = join(scratch, `fluid-snap-${randomUUID()}.bin`);
  writeSdfFile(sdfPath, sdf);
  writeSeedFile(seedsPath, seeds);

  const hasSections = scenario.outletPlaneMm !== undefined;
  const lo = scenario.fluidRegionMm.min[flowAxis]!;
  const hi = scenario.outletPlaneMm ?? lo + 1;

  let solved: {
    particleCount0: number; escaped: number; active: number; massConservationError: number;
    penetrationCount: number; outletArrivalRatio: number; timeToOutletSteps: number | null;
    sectionAvgVelocity: { positionMm: number; velocityMmPerSec: number }[];
    maxVelocityMmPerSec: number; avgVelocityMmPerSec: number; diverged: boolean; stepsRun: number;
  };
  try {
    const worker = await ensurePythonWorker();
    // The run is long by nature (thousands of steps x thousands of particles), so it
    // gets a long worker budget; the TOOL's own timeoutMs is what bounds a real call.
    solved = await worker.request('fluid_run', {
      sdfPath,
      seedsPath,
      snapshotsPath,
      config: {
        cells: scenario.gridCells,
        dxMm: scenario.dxMm,
        particleCount: count,
        gravity: gravityCells,
        dt: DT,
        vmax: 2.4 * speedCells,
        ...(scenario.inlet ? { inlet: { axis: scenario.inlet.axis, band: bandCells, speed: speedCells } } : {}),
        ...(escapeAt !== undefined ? { escape: { axis: escapeAxis, at: escapeAt } } : {}),
      },
      steps,
      snapshotCount,
      snapshotEvery,
      flowAxis,
      hasSections,
      sectionLoMm: lo,
      sectionHiMm: hi,
      penetrationTolMm: PENETRATION_TOL_MM,
      stiffness0: K0,
      viscosity0: MU0,
      restDensity0: RD0,
      inlet: Boolean(scenario.inlet),
      skipProject: process.env.CAD_FLUID_NO_PROJECT === '1',
      debugPenetration: process.env.CAD_FLUID_DEBUG_PENETRATION === '1',
    }, { timeoutMs: 1_800_000 });
  } finally {
    for (const path of [sdfPath, seedsPath]) rmSync(path, { force: true });
  }
  const snapshots = readSnapshotFile(snapshotsPath);
  rmSync(snapshotsPath, { force: true });

  // Seed-lattice accounting and its warnings are the CALLER's business: they are
  // about the seeds this side chose, not about the run.
  const count0 = count;
  const stacksPerSeed = +(count / Math.max(1, seeds.length)).toFixed(2);
  const warnings: string[] = [];
  if (seeds.length === 0) {
    warnings.push('no seed positions survived the wall/solid rejection — nothing to simulate');
  }
  if (stacksPerSeed > 1.5) {
    warnings.push(
      `particleCount ${count} exceeds the ${seeds.length} seed positions: particles STACK ` +
      `${stacksPerSeed}-deep on the same spots instead of densifying the lattice. ` +
      `The escaped fraction is unaffected (duplicates share a fate), but the field is far ` +
      `coarser than particleCount0 suggests — raise particlesPerCell (or widen fluidRegionMm) ` +
      `for a real denser lattice.`,
    );
  }
  if (seeded.rejectedSolid > 0 && seeds.length + seeded.rejectedSolid > 0
      && seeded.rejectedSolid / (seeds.length + seeded.rejectedSolid) > 0.5) {
    warnings.push(
      `${(100 * seeded.rejectedSolid / (seeds.length + seeded.rejectedSolid)).toFixed(0)}% of the seed region ` +
      `is solid metal — the region is derived from the bounding box, so a thick-walled part gives a ` +
      `region much larger than its cavity. Those points are rejected, but the lattice is coarse where it counts.`,
    );
  }
  const hasEscape = scenario.outletPlaneMm !== undefined;
  const clean = !solved.diverged && solved.penetrationCount === 0 && solved.massConservationError < 1e-6
    && (!hasEscape || solved.outletArrivalRatio >= 0.5);

  const report: FluidReport = {
    overallStatus: clean ? 'pass' : 'check',
    warnings,
    metrics: {
      particleCount0: count0,
      seedStats: {
        accepted: seeds.length,
        rejectedWall: seeded.rejectedWall,
        rejectedSolid: seeded.rejectedSolid,
        solidFraction: +(seeded.rejectedSolid / Math.max(1, seeds.length + seeded.rejectedWall + seeded.rejectedSolid)).toFixed(4),
        requested: count,
        stacksPerSeed,
      },
      escaped: solved.escaped,
      active: solved.active,
      massConservationError: solved.massConservationError,
      penetrationCount: solved.penetrationCount,
      outletArrivalRatio: solved.outletArrivalRatio,
      timeToOutletSteps: solved.timeToOutletSteps,
      sectionAvgVelocity: solved.sectionAvgVelocity,
      maxVelocityMmPerSec: solved.maxVelocityMmPerSec,
      avgVelocityMmPerSec: solved.avgVelocityMmPerSec,
      diverged: solved.diverged,
      stepsRun: solved.stepsRun,
    },
    snapshots,
    // DIAGNOSTIC ONLY (CAD_FLUID_DEBUG_PENETRATION=1): where the penetrating
    // particles sit relative to the projection band. Not part of the tool schema.
    ...(solved.debugPenetration ? { debugPenetration: solved.debugPenetration } : {}),
    durationSec: +((performance.now() - t0) / 1000).toFixed(1),
  };
  return { report, sdf };
}

/**
 * The TS implementation — the parity oracle for the worker's `fluid_run`.
 *
 * It also OWNS what the worker does not: building the SDF from the pipe mesh and
 * choosing seed positions (both need the geometry, and both are handed over as
 * FILES — the SDF is one float per cell and the seeds are three doubles per
 * particle, 13.5 MB at the 564k-particle acceptance case).
 */
export async function runFluidInTs(scenario: FluidScenario): Promise<{
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
  const seeded = seedPositions(sdf, scenario.fluidRegionMm, ppc);
  const seeds = seeded.seeds;
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
  // DIAGNOSTIC (CAD_FLUID_DEBUG_PROJECT=1): the projection's effect on velocity,
  // so the two engines' projections can be compared quantity by quantity.
  const projectionCounters = { candidate: 0, inside: 0, killed: 0, killedSpeedSum: 0, pushSum: 0 };
  const projectParticles = () => {
    const dx = scenario.dxMm;
    const tol = 0.05;
    for (let p = 0; p < world.activeN; p++) {
      const cx = world.pos[p * 3]!, cy = world.pos[p * 3 + 1]!, cz = world.pos[p * 3 + 2]!;
      const cell = (cx | 0) * gnyz + (cy | 0) * gnz + (cz | 0);
      if (!nearSurface[cell]) continue;
      projectionCounters.candidate++;
      const wx = cx * dx + scenario.gridOriginMm[0];
      const wy = cy * dx + scenario.gridOriginMm[1];
      const wz = cz * dx + scenario.gridOriginMm[2];
      const d = sdfAt(sdf, wx, wy, wz);
      if (d >= -tol) continue;
      projectionCounters.inside++;
      projectionCounters.pushSum += -d + 0.15 * dx;
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
        projectionCounters.killed++;
        projectionCounters.killedSpeedSum += -vn;
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

  // DIAGNOSTIC HOOK (see the open defect note at the top of runFluid): skipping the
  // projection on BOTH engines is how the suspect gets isolated.
  const skipProject = process.env.CAD_FLUID_NO_PROJECT === '1';
  for (let step = 1; step <= steps; step++) {
    world.step();
    if (!skipProject) projectParticles();
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

  // Non-fatal problems the caller must know about. The stacking case matters:
  // the placer cycles `seeds[idx++ % seeds.length]`, so asking for more
  // particles than the lattice holds STACKS them on existing seed positions
  // instead of densifying. (Measured 2026-10-08: 80,000 particles on 3,906
  // seeds = 20.5-deep stacks. The escaped FRACTION is unchanged — duplicates
  // share a fate — but the run then looks far better sampled than it is, and
  // `particleCount0` no longer means "particles in the field".)
  const stacksPerSeed = +(count / Math.max(1, seeds.length)).toFixed(2);
  const warnings: string[] = [];
  if (seeds.length === 0) {
    warnings.push('no seed positions survived the wall/solid rejection — nothing to simulate');
  }
  if (stacksPerSeed > 1.5) {
    warnings.push(
      `particleCount ${count} exceeds the ${seeds.length} seed positions: particles STACK ` +
      `${stacksPerSeed}-deep on the same spots instead of densifying the lattice. ` +
      `The escaped fraction is unaffected (duplicates share a fate), but the field is far ` +
      `coarser than particleCount0 suggests — raise particlesPerCell (or widen fluidRegionMm) ` +
      `for a real denser lattice.`,
    );
  }
  if (seeded.rejectedSolid > 0 && seeds.length + seeded.rejectedSolid > 0
      && seeded.rejectedSolid / (seeds.length + seeded.rejectedSolid) > 0.5) {
    warnings.push(
      `${(100 * seeded.rejectedSolid / (seeds.length + seeded.rejectedSolid)).toFixed(0)}% of the seed region ` +
      `is solid metal — the region is derived from the bounding box, so a thick-walled part gives a ` +
      `region much larger than its cavity. Those points are rejected, but the lattice is coarse where it counts.`,
    );
  }

  const report: FluidReport = {
    overallStatus: clean ? 'pass' : 'check',
    warnings,
    metrics: {
      particleCount0: count0,
      seedStats: {
        accepted: seeds.length,
        rejectedWall: seeded.rejectedWall,
        rejectedSolid: seeded.rejectedSolid,
        solidFraction: +(seeded.rejectedSolid / Math.max(1, seeds.length + seeded.rejectedWall + seeded.rejectedSolid)).toFixed(4),
        requested: count,
        stacksPerSeed,
      },
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
  if (process.env.CAD_FLUID_DEBUG_PROJECT === '1') {
    (report as unknown as { debugProjection?: unknown }).debugProjection = {
      ...projectionCounters,
      inlet: world.inletCounters,
    };
  }
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
