// MLS-MPM fluid solver core (M4), CPU-side.
//
// Pure computation: no I/O, no UI. Runs in "cell units" — positions in grid
// cells, velocities in cells/second — which makes the transfer kernels
// identical in form to the GPU reference (three.js webgpu_compute_particles_fluid,
// following matsuoka-601/WebGPU-Ocean). Physical units (mm) enter only via
// dxMm at the edges: cells = mm / dxMm.
//
// Per step: clear → P2G (mass+momentum) → P2G (stress force) → grid update
// (boundary conditions) → G2P (APIC) → external drive → safety clamps.
//
// Constitutive model: weakly compressible EOS
//   pressure = max(0, (density/restDensity)^5 - 1) * stiffness
//   stress   = -pressure*I + viscosity*(C + C^T)
//   affine   = volume * (-4) * stress * dt   (quadratic B-spline gradient)

export interface MpmWorldConfig {
  /** Grid resolution in cells per axis. */
  cells: [number, number, number];
  /** Millimetres per cell — unit bridge only, solver is unit-agnostic. */
  dxMm: number;
  /** Particle count (fixed for the world's lifetime). */
  particleCount: number;
  /** Gravity in cells/s² (mm/s² / dxMm). Default [0, 0, -4905] ≈ -9810 mm/s² at dx=2mm. */
  gravity?: [number, number, number];
  /** Timestep in seconds (cell-unit time). */
  dt: number;
  /** EOS stiffness. Default 50 (three.js fluid example). */
  stiffness?: number;
  /** Dynamic viscosity term. Default 0.1. */
  viscosity?: number;
  /** Rest density (auto-calibrated from the initial layout when omitted). */
  restDensity?: number;
  /** Speed clamp in cells/s — CFL guard (|v|*dt ≤ ~0.25 cells). Required. */
  vmax: number;
  /**
   * Constant-speed inlet: particles whose axial coordinate is inside [bandMin,
   * bandMax] get their axial velocity raised to `speed` each step.
   * Coordinates in cells.
   */
  inlet?: { axis: 0 | 1 | 2; band: [number, number]; speed: number };
  /**
   * Outlet recycling: a particle passing `at` (cells) along `axis` wraps back
   * to `respawn` and counts one transit. Keeps particle count constant for
   * steady-state runs.
   */
  recycle?: { axis: 0 | 1 | 2; at: number; respawn: number };
  /**
   * Outlet escape: a particle passing `at` (cells) along `axis` is REMOVED
   * from the simulation and counted (world.escaped). Mutually exclusive with
   * `recycle`. Use for through-flow acceptance (arrival-ratio audit).
   */
  escape?: { axis: 0 | 1 | 2; at: number };
  /**
   * Per-cell solid mask (pipe walls, M4 proper). Grid BC zeroes the velocity
   * component stored per solid cell (see solidNormal).
   */
  solidMask?: Uint8Array;
  /**
   * Per-cell dominant normal for solid cells: 0 none, 1..6 = -x,+x,-y,+y,-z,+z.
   * Same length as the mask.
   */
  solidNormal?: Uint8Array;
}

export interface MpmWorld {
  readonly cfg: MpmWorldConfig;
  readonly n: number;
  /** Particle positions, cells, xyz-interleaved (Float32Array, 3n). */
  readonly pos: Float32Array;
  /** Particle velocities, cells/s, xyz-interleaved (Float32Array, 3n). */
  readonly vel: Float32Array;
  /** Affine matrices, 9 values per particle, row-major C[row*3+col]. */
  readonly C: Float32Array;
  /** Transits recorded by the recycle rule so far. */
  transits: number;
  /** Particles removed by the escape rule so far. */
  escaped: number;
  /** Active (non-escaped) particle count; loops below run over [0, activeN). */
  activeN: number;
  /** Non-finite velocity events since world creation (should stay 0). */
  nonFinite: number;
  /** Rest density in effect (calibrated value when not configured). */
  restDensity: number;
  /** Per-step diagnostics from the most recent step. */
  lastStep: { maxSpeed: number; clampedFraction: number };
  step(): void;
  /** Seed pass used at construction; exposed for tests. */
  calibrateRestDensity(): number;
}

/** Deterministic tiny jitter — no RNG dependency, reproducible runs. */
function jitter(i: number): number {
  // Low-amplitude additive mix; keeps lattice alignment fromaliasing weights.
  const s = Math.sin(i * 12.9898) * 43758.5453;
  return (s - Math.floor(s) - 0.5) * 0.04;
}

/**
 * Create a world and seed particle positions. `seed(i)` returns the initial
 * position in cells. Positions are clamped into the safe band
 * [1.5, cells-1.5] so every 27-cell stencil stays in range.
 */
export function createMpmWorld(
  cfg: MpmWorldConfig,
  seed: (i: number) => [number, number, number],
): MpmWorld {
  const [nx, ny, nz] = cfg.cells;
  const n = cfg.particleCount;
  const pos = new Float32Array(3 * n);
  const vel = new Float32Array(3 * n);
  const C = new Float32Array(9 * n);
  for (let i = 0; i < n; i++) {
    const [x, y, z] = seed(i);
    pos[i * 3] = Math.min(nx - 1.5, Math.max(1.5, x)) + jitter(i);
    pos[i * 3 + 1] = Math.min(ny - 1.5, Math.max(1.5, y)) + jitter(i + 7_000_000);
    pos[i * 3 + 2] = Math.min(nz - 1.5, Math.max(1.5, z)) + jitter(i + 14_000_000);
  }
  const world: MpmWorld = {
    cfg, n, pos, vel, C,
    transits: 0,
    escaped: 0,
    activeN: n,
    nonFinite: 0,
    restDensity: cfg.restDensity ?? 0,
    lastStep: { maxSpeed: 0, clampedFraction: 0 },
    step: () => stepWorld(world),
    calibrateRestDensity: () => {
      world.restDensity = cfg.restDensity ?? calibrate(world);
      return world.restDensity;
    },
  };
  if (cfg.restDensity !== undefined) world.restDensity = cfg.restDensity;
  return world;
}

const gridCells = (cfg: MpmWorldConfig): number =>
  cfg.cells[0] * cfg.cells[1] * cfg.cells[2];

/** Mass-only P2G pass; median density over occupied cells → rest density. */
function calibrate(w: MpmWorld): number {
  const { cfg, pos } = w;
  const [, ny, nz] = cfg.cells;
  const gridMass = new Float64Array(gridCells(cfg));
  scatterMass(pos, w.n, ny, nz, gridMass);
  const samples: number[] = [];
  for (let c = 0; c < gridMass.length; c++) {
    const m = gridMass[c]!;
    if (m > 0.2) samples.push(m);
    if (samples.length >= 8192) break;
  }
  if (samples.length === 0) return 1.0;
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)]!;
}

/** One MLS-MPM step. Grid work arrays are allocated once and cached on fn. */
const scratch = new WeakMap<MpmWorld, {
  gridMom: Float64Array; gridMass: Float64Array; gridVel: Float32Array; escapeFlags: Uint8Array;
}>();

export function stepWorld(w: MpmWorld): void {
  const { cfg, pos, vel, C } = w;
  const n = w.activeN;
  const [nx, ny, nz] = cfg.cells;
  const dt = cfg.dt;
  const stiffness = cfg.stiffness ?? 50;
  const viscosity = cfg.viscosity ?? 0.1;
  const restDensity = w.restDensity;

  let s = scratch.get(w);
  if (!s) {
    s = {
      gridMom: new Float64Array(3 * gridCells(cfg)),
      gridMass: new Float64Array(gridCells(cfg)),
      gridVel: new Float32Array(3 * gridCells(cfg)),
      escapeFlags: new Uint8Array(cfg.particleCount),
    };
    scratch.set(w, s);
  }
  const { gridMom, gridMass, gridVel, escapeFlags } = s;
  gridMom.fill(0);
  gridMass.fill(0);

  // --- P2G pass 1: mass + APIC momentum ---
  scatterMassAndMomentum(pos, vel, C, n, nx, ny, nz, gridMom, gridMass);

  // --- P2G pass 2: stress force (needs fresh cell masses) ---
  scatterStress(pos, vel, C, n, nx, ny, nz, gridMass, gridMom, dt, stiffness, viscosity, restDensity);

  // --- grid update: v = momentum/mass + boundary conditions ---
  const nyz = ny * nz;
  for (let x = 0; x < nx; x++) {
    for (let y = 0; y < ny; y++) {
      for (let z = 0; z < nz; z++) {
        const cell = (x * ny + y) * nz + z;
        const m = gridMass[cell]!;
        const base = cell * 3;
        let vx = 0, vy = 0, vz = 0;
        if (m > 0) {
          vx = gridMom[base]! / m;
          vy = gridMom[base + 1]! / m;
          vz = gridMom[base + 2]! / m;
          // Border normal-velocity zeroing (free-slip walls, matches reference).
          if (x < 1 || x > nx - 2) vx = 0;
          if (y < 1 || y > ny - 2) vy = 0;
          if (z < 1 || z > nz - 2) vz = 0;
          // Interior solid mask (pipe walls): zero the dominant normal comp.
          if (cfg.solidMask && cfg.solidNormal) {
            const code = cfg.solidNormal[cell]!;
            if (cfg.solidMask[cell] && code > 0) {
              if (code === 1 || code === 2) vx = 0;
              else if (code === 3 || code === 4) vy = 0;
              else vz = 0;
            }
          }
        }
        gridVel[base] = vx;
        gridVel[base + 1] = vy;
        gridVel[base + 2] = vz;
      }
    }
  }

  // --- G2P: gather velocity + affine, advect, drives, clamps ---
  const vmax = cfg.vmax;
  const vmax2 = vmax * vmax;
  const gx = cfg.gravity?.[0] ?? 0;
  const gy = cfg.gravity?.[1] ?? 0;
  const gz = cfg.gravity?.[2] ?? 0;
  let maxSpeed = 0;
  let clamped = 0;

  for (let p = 0; p < n; p++) {
    const px = pos[p * 3]!, py = pos[p * 3 + 1]!, pz = pos[p * 3 + 2]!;

    // weights (same quadratic B-spline as P2G)
    const xCell = px, yCell = py, zCell = pz;
    const cx = Math.trunc(xCell) - 1, cy = Math.trunc(yCell) - 1, cz = Math.trunc(zCell) - 1;
    const fx = xCell - Math.trunc(xCell) - 0.5;
    const fy = yCell - Math.trunc(yCell) - 0.5;
    const fz = zCell - Math.trunc(zCell) - 0.5;
    const w0x = 0.5 * (0.5 - fx) * (0.5 - fx), w1x = 0.75 - fx * fx, w2x = 0.5 * (0.5 + fx) * (0.5 + fx);
    const w0y = 0.5 * (0.5 - fy) * (0.5 - fy), w1y = 0.75 - fy * fy, w2y = 0.5 * (0.5 + fy) * (0.5 + fy);
    const w0z = 0.5 * (0.5 - fz) * (0.5 - fz), w1z = 0.75 - fz * fz, w2z = 0.5 * (0.5 + fz) * (0.5 + fz);

    let vpx = 0, vpy = 0, vpz = 0;
    let b00 = 0, b01 = 0, b02 = 0, b10 = 0, b11 = 0, b12 = 0, b20 = 0, b21 = 0, b22 = 0;
    // free-slip renormalization: solid cells (v ≡ 0) are EXCLUDED from the
    // interpolation, otherwise near-wall particles get dragged by the zeros
    // (artificial boundary-layer friction stalls the flow)
    const mask = cfg.solidMask;
    let wsum = 0;

    for (let i = 0; i < 3; i++) {
      const xi = cx + i;
      const wx = i === 0 ? w0x : i === 1 ? w1x : w2x;
      const dx = (xi + 0.5) - xCell;
      for (let j = 0; j < 3; j++) {
        const yj = cy + j;
        const wy = j === 0 ? w0y : j === 1 ? w1y : w2y;
        const dy = (yj + 0.5) - yCell;
        const wxy = wx * wy;
        for (let k = 0; k < 3; k++) {
          const zk = cz + k;
          const wz = k === 0 ? w0z : k === 1 ? w1z : w2z;
          const dz = (zk + 0.5) - zCell;
          const weight = wxy * wz;
          const cell = (xi * ny + yj) * nz + zk;
          if (mask && mask[cell]) continue;
          const base = cell * 3;
          // clamp per-cell contribution: a transient compression spike in one
          // cell must not poison B/C (huge affine → Inf−Inf → grid-wide NaN)
          const gvx = Math.min(vmax, Math.max(-vmax, gridVel[base]!));
          const gvy = Math.min(vmax, Math.max(-vmax, gridVel[base + 1]!));
          const gvz = Math.min(vmax, Math.max(-vmax, gridVel[base + 2]!));
          const tx = weight * gvx, ty = weight * gvy, tz = weight * gvz;
          vpx += tx; vpy += ty; vpz += tz;
          wsum += weight;
          // B += w * (gv ⊗ cellDist)
          b00 += tx * dx; b01 += tx * dy; b02 += tx * dz;
          b10 += ty * dx; b11 += ty * dy; b12 += ty * dz;
          b20 += tz * dx; b21 += tz * dy; b22 += tz * dz;
        }
      }
    }
    // renormalize only when the stencil is fluid-dominated; deep-in-wall
    // particles (low wsum) keep the damped raw gather — projection fixes them
    if (wsum > 0.5) {
      const inv = 1 / wsum;
      vpx *= inv; vpy *= inv; vpz *= inv;
      b00 *= inv; b01 *= inv; b02 *= inv;
      b10 *= inv; b11 *= inv; b12 *= inv;
      b20 *= inv; b21 *= inv; b22 *= inv;
    }
    if (!Number.isFinite(b00 + b11 + b22)) {
      b00 = 0; b01 = 0; b02 = 0; b10 = 0; b11 = 0; b12 = 0; b20 = 0; b21 = 0; b22 = 0;
      vpx = 0; vpy = 0; vpz = 0;
    }

    // C = 4B (cell units → dx=1)
    C[p * 9] = 4 * b00; C[p * 9 + 1] = 4 * b01; C[p * 9 + 2] = 4 * b02;
    C[p * 9 + 3] = 4 * b10; C[p * 9 + 4] = 4 * b11; C[p * 9 + 5] = 4 * b12;
    C[p * 9 + 6] = 4 * b20; C[p * 9 + 7] = 4 * b21; C[p * 9 + 8] = 4 * b22;

    // gravity + speed clamp (CFL guard)
    vpx += gx * dt; vpy += gy * dt; vpz += gz * dt;
    const sp2 = vpx * vpx + vpy * vpy + vpz * vpz;
    if (sp2 > vmax2) {
      const scale = vmax / Math.sqrt(sp2);
      vpx *= scale; vpy *= scale; vpz *= scale;
      clamped++;
      maxSpeed = vmax;
    } else if (sp2 > maxSpeed * maxSpeed) {
      maxSpeed = Math.sqrt(sp2);
    }

    // inlet drive: floor the axial velocity of band particles (governs both
    // advection this step and the stored velocity below).
    const inlet = cfg.inlet;
    if (inlet) {
      const ax = inlet.axis === 0 ? px : inlet.axis === 1 ? py : pz;
      if (ax >= inlet.band[0] && ax <= inlet.band[1]) {
        const cur = inlet.axis === 0 ? vpx : inlet.axis === 1 ? vpy : vpz;
        if (cur < inlet.speed) {
          if (inlet.axis === 0) vpx = inlet.speed;
          else if (inlet.axis === 1) vpy = inlet.speed;
          else vpz = inlet.speed;
        }
      }
    }

    // NaN guard: reset velocity AND zero C — a poisoned affine matrix would
    // otherwise re-scatter NaN into the grid every following step
    if (!Number.isFinite(vpx + vpy + vpz)) {
      w.nonFinite++;
      vpx = inlet?.axis === 0 ? inlet.speed : 0;
      vpy = 0; vpz = 0;
      for (let a = 0; a < 9; a++) C[p * 9 + a] = 0;
    }

    // advection + box clamp with normal-velocity kill (free-slip walls)
    let X = px + vpx * dt, Y = py + vpy * dt, Z = pz + vpz * dt;
    if (X < 1.5) { X = 1.5; if (vpx < 0) vpx = 0; }
    else if (X > nx - 1.5) { X = nx - 1.5; if (vpx > 0) vpx = 0; }
    if (Y < 1.5) { Y = 1.5; if (vpy < 0) vpy = 0; }
    else if (Y > ny - 1.5) { Y = ny - 1.5; if (vpy > 0) vpy = 0; }
    if (Z < 1.5) { Z = 1.5; if (vpz < 0) vpz = 0; }
    else if (Z > nz - 1.5) { Z = nz - 1.5; if (vpz > 0) vpz = 0; }

    // outlet recycle
    const rec = cfg.recycle;
    if (rec) {
      const a = rec.axis === 0 ? X : rec.axis === 1 ? Y : Z;
      if (a > rec.at) {
        if (rec.axis === 0) X = rec.respawn;
        else if (rec.axis === 1) Y = rec.respawn;
        else Z = rec.respawn;
        w.transits++;
      }
    }
    // outlet escape: flag for post-loop compaction
    const esc = cfg.escape;
    if (esc) {
      const a = esc.axis === 0 ? X : esc.axis === 1 ? Y : Z;
      if (a > esc.at) escapeFlags[p] = 1;
    }

    pos[p * 3] = X; pos[p * 3 + 1] = Y; pos[p * 3 + 2] = Z;
    vel[p * 3] = vpx; vel[p * 3 + 1] = vpy; vel[p * 3 + 2] = vpz;
  }

  // compact escaped particles away (swap-with-last, order not preserved)
  if (cfg.escape) {
    let w2 = 0;
    for (let r = 0; r < n; r++) {
      if (escapeFlags[r]) {
        escapeFlags[r] = 0;
        w.escaped++;
        continue;
      }
      if (w2 !== r) {
        pos[w2 * 3] = pos[r * 3]; pos[w2 * 3 + 1] = pos[r * 3 + 1]; pos[w2 * 3 + 2] = pos[r * 3 + 2];
        vel[w2 * 3] = vel[r * 3]; vel[w2 * 3 + 1] = vel[r * 3 + 1]; vel[w2 * 3 + 2] = vel[r * 3 + 2];
        for (let a = 0; a < 9; a++) C[w2 * 9 + a] = C[r * 9 + a];
      }
      w2++;
    }
    w.activeN = w2;
  }

  w.lastStep.maxSpeed = maxSpeed;
  w.lastStep.clampedFraction = n > 0 ? clamped / n : 0;
}

/** P2G mass only (calibration). */
function scatterMass(
  pos: Float32Array, n: number, ny: number, nz: number,
  gridMass: Float64Array,
): void {
  for (let p = 0; p < n; p++) {
    const x = pos[p * 3]!, y = pos[p * 3 + 1]!, z = pos[p * 3 + 2]!;
    const cx = Math.trunc(x) - 1, cy = Math.trunc(y) - 1, cz = Math.trunc(z) - 1;
    const fx = x - Math.trunc(x) - 0.5, fy = y - Math.trunc(y) - 0.5, fz = z - Math.trunc(z) - 0.5;
    const w0x = 0.5 * (0.5 - fx) * (0.5 - fx), w1x = 0.75 - fx * fx, w2x = 0.5 * (0.5 + fx) * (0.5 + fx);
    const w0y = 0.5 * (0.5 - fy) * (0.5 - fy), w1y = 0.75 - fy * fy, w2y = 0.5 * (0.5 + fy) * (0.5 + fy);
    const w0z = 0.5 * (0.5 - fz) * (0.5 - fz), w1z = 0.75 - fz * fz, w2z = 0.5 * (0.5 + fz) * (0.5 + fz);
    for (let i = 0; i < 3; i++) {
      const wx = i === 0 ? w0x : i === 1 ? w1x : w2x;
      for (let j = 0; j < 3; j++) {
        const wy = j === 0 ? w0y : j === 1 ? w1y : w2y;
        const wxy = wx * wy;
        for (let k = 0; k < 3; k++) {
          const wz = k === 0 ? w0z : k === 1 ? w1z : w2z;
          gridMass[((cx + i) * ny + (cy + j)) * nz + (cz + k)]! += wxy * wz;
        }
      }
    }
  }
}

/** P2G mass + APIC momentum. Particle mass = 1 (reference convention). */
function scatterMassAndMomentum(
  pos: Float32Array, vel: Float32Array, C: Float32Array, n: number,
  nx: number, ny: number, nz: number,
  gridMom: Float64Array, gridMass: Float64Array,
): void {
  for (let p = 0; p < n; p++) {
    const x = pos[p * 3]!, y = pos[p * 3 + 1]!, z = pos[p * 3 + 2]!;
    const vx = vel[p * 3]!, vy = vel[p * 3 + 1]!, vz = vel[p * 3 + 2]!;
    const c00 = C[p * 9]!, c01 = C[p * 9 + 1]!, c02 = C[p * 9 + 2]!;
    const c10 = C[p * 9 + 3]!, c11 = C[p * 9 + 4]!, c12 = C[p * 9 + 5]!;
    const c20 = C[p * 9 + 6]!, c21 = C[p * 9 + 7]!, c22 = C[p * 9 + 8]!;
    const cx = Math.trunc(x) - 1, cy = Math.trunc(y) - 1, cz = Math.trunc(z) - 1;
    const fx = x - Math.trunc(x) - 0.5, fy = y - Math.trunc(y) - 0.5, fz = z - Math.trunc(z) - 0.5;
    const w0x = 0.5 * (0.5 - fx) * (0.5 - fx), w1x = 0.75 - fx * fx, w2x = 0.5 * (0.5 + fx) * (0.5 + fx);
    const w0y = 0.5 * (0.5 - fy) * (0.5 - fy), w1y = 0.75 - fy * fy, w2y = 0.5 * (0.5 + fy) * (0.5 + fy);
    const w0z = 0.5 * (0.5 - fz) * (0.5 - fz), w1z = 0.75 - fz * fz, w2z = 0.5 * (0.5 + fz) * (0.5 + fz);
    for (let i = 0; i < 3; i++) {
      const xi = cx + i;
      const wx = i === 0 ? w0x : i === 1 ? w1x : w2x;
      const dx = (xi + 0.5) - x;
      for (let j = 0; j < 3; j++) {
        const yj = cy + j;
        const wy = j === 0 ? w0y : j === 1 ? w1y : w2y;
        const dy = (yj + 0.5) - y;
        const wxy = wx * wy;
        for (let k = 0; k < 3; k++) {
          const zk = cz + k;
          const wz = k === 0 ? w0z : k === 1 ? w1z : w2z;
          const weight = wxy * wz;
          const dz = (zk + 0.5) - z;
          // Q = C @ cellDist
          const qx = c00 * dx + c01 * dy + c02 * dz;
          const qy = c10 * dx + c11 * dy + c12 * dz;
          const qz = c20 * dx + c21 * dy + c22 * dz;
          const cell = (xi * ny + yj) * nz + zk;
          const base = cell * 3;
          gridMom[base] += weight * (vx + qx);
          gridMom[base + 1] += weight * (vy + qy);
          gridMom[base + 2] += weight * (vz + qz);
          gridMass[cell] += weight;
        }
      }
    }
  }
}

/** P2G stress force: pressure (weakly compressible EOS) + viscosity. */
function scatterStress(
  pos: Float32Array, vel: Float32Array, C: Float32Array, n: number,
  nx: number, ny: number, nz: number,
  gridMass: Float64Array, gridMom: Float64Array,
  dt: number, stiffness: number, viscosity: number, restDensity: number,
): void {
  for (let p = 0; p < n; p++) {
    const x = pos[p * 3]!, y = pos[p * 3 + 1]!, z = pos[p * 3 + 2]!;
    const c00 = C[p * 9]!, c01 = C[p * 9 + 1]!, c02 = C[p * 9 + 2]!;
    const c10 = C[p * 9 + 3]!, c11 = C[p * 9 + 4]!, c12 = C[p * 9 + 5]!;
    const c20 = C[p * 9 + 6]!, c21 = C[p * 9 + 7]!, c22 = C[p * 9 + 8]!;
    const cx = Math.trunc(x) - 1, cy = Math.trunc(y) - 1, cz = Math.trunc(z) - 1;
    const fx = x - Math.trunc(x) - 0.5, fy = y - Math.trunc(y) - 0.5, fz = z - Math.trunc(z) - 0.5;
    const w0x = 0.5 * (0.5 - fx) * (0.5 - fx), w1x = 0.75 - fx * fx, w2x = 0.5 * (0.5 + fx) * (0.5 + fx);
    const w0y = 0.5 * (0.5 - fy) * (0.5 - fy), w1y = 0.75 - fy * fy, w2y = 0.5 * (0.5 + fy) * (0.5 + fy);
    const w0z = 0.5 * (0.5 - fz) * (0.5 - fz), w1z = 0.75 - fz * fz, w2z = 0.5 * (0.5 + fz) * (0.5 + fz);

    // density over the 27-cell support (fresh masses from pass 1)
    let density = 0;
    for (let i = 0; i < 3; i++) {
      const wx = i === 0 ? w0x : i === 1 ? w1x : w2x;
      for (let j = 0; j < 3; j++) {
        const wy = j === 0 ? w0y : j === 1 ? w1y : w2y;
        const wxy = wx * wy;
        for (let k = 0; k < 3; k++) {
          const wz = k === 0 ? w0z : k === 1 ? w1z : w2z;
          density += wxy * wz * gridMass[((cx + i) * ny + (cy + j)) * nz + (cz + k)]!;
        }
      }
    }
    const volume = 1 / density;
    const dr = density / restDensity;
    const pressure = stiffness * Math.max(0, dr * dr * dr * dr * dr - 1);
    // stress = -p*I + viscosity*(C + C^T)
    const sxx = -pressure + viscosity * 2 * c00;
    const syy = -pressure + viscosity * 2 * c11;
    const szz = -pressure + viscosity * 2 * c22;
    const sxy = viscosity * (c01 + c10);
    const sxz = viscosity * (c02 + c20);
    const syz = viscosity * (c12 + c21);
    // eq16Term0 = volume * (-4) * stress * dt
    const t00 = volume * -4 * sxx * dt, t01 = volume * -4 * sxy * dt, t02 = volume * -4 * sxz * dt;
    const t10 = volume * -4 * sxy * dt, t11 = volume * -4 * syy * dt, t12 = volume * -4 * syz * dt;
    const t20 = volume * -4 * sxz * dt, t21 = volume * -4 * syz * dt, t22 = volume * -4 * szz * dt;

    for (let i = 0; i < 3; i++) {
      const xi = cx + i;
      const wx = i === 0 ? w0x : i === 1 ? w1x : w2x;
      const dx = (xi + 0.5) - x;
      for (let j = 0; j < 3; j++) {
        const yj = cy + j;
        const wy = j === 0 ? w0y : j === 1 ? w1y : w2y;
        const dy = (yj + 0.5) - y;
        const wxy = wx * wy;
        for (let k = 0; k < 3; k++) {
          const zk = cz + k;
          const wz = k === 0 ? w0z : k === 1 ? w1z : w2z;
          const weight = wxy * wz;
          const dz = (zk + 0.5) - z;
          const mx = (t00 * dx + t01 * dy + t02 * dz) * weight;
          const my = (t10 * dx + t11 * dy + t12 * dz) * weight;
          const mz = (t20 * dx + t21 * dy + t22 * dz) * weight;
          const base = ((xi * ny + yj) * nz + zk) * 3;
          gridMom[base] += mx;
          gridMom[base + 1] += my;
          gridMom[base + 2] += mz;
        }
      }
    }
  }
}
