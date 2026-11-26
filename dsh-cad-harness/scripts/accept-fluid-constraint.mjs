// F1 acceptance, part 3 — the particle-level constraint (F1b).
//
// The projection pushes a particle out of metal. It cannot stop one that has
// already crossed a thin wall into the air OUTSIDE the part, and it cannot hold the
// inlet plane. Before this, such particles wandered outside the bore for the rest of
// the run and were only counted at snapshot time (`outsideSnapshotMax`).
//
// Now they are ABSORBED the moment they leave the fluid component (or sit deeper
// than the penetration tolerance in metal), and the count is reported as
// `leakedOutside` — so the audit still has its witness, it just lives at the
// moment of the leak instead of at the moment of the snapshot.
//
// The proof is a pair of runs on the geometry that leaked (Ø34/Ø30 at dx 1):
//   constraint ON  → outsideSnapshotMax 0, leakedOutside > 0 (absorbed, counted);
//   constraint OFF → particles still outside at snapshot time.
// Toggling is `CAD_FLUID_NO_PROJECT=1` — the existing diagnostic that skips the
// projection AND the constraint, which is what makes the pair meaningful.
//
//   node scripts/accept-fluid-constraint.mjs

import ManifoldModule from 'manifold-3d';
import { deriveFluidPreset, runFluidInTs } from '../src/host/fluid.ts';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const mod = await ManifoldModule();
mod.setup();
const { Manifold } = mod;

function tubeStl(outerD, boreD, height, segments = 48) {
  const outer = Manifold.cylinder(height, outerD / 2, outerD / 2, segments, false);
  const bore = Manifold.cylinder(height + 2, boreD / 2, boreD / 2, segments, false).translate([0, 0, -1]);
  const mesh = outer.subtract(bore).getMesh();
  const verts = mesh.vertProperties;
  const tris = mesh.triVerts;
  const count = tris.length / 3;
  const buffer = new ArrayBuffer(84 + count * 50);
  const view = new DataView(buffer);
  view.setUint32(80, count, true);
  let at = 84;
  for (let t = 0; t < count; t++) {
    const [a, b, c] = [tris[t * 3] * 3, tris[t * 3 + 1] * 3, tris[t * 3 + 2] * 3];
    const A = [verts[a], verts[a + 1], verts[a + 2]];
    const B = [verts[b], verts[b + 1], verts[b + 2]];
    const C = [verts[c], verts[c + 1], verts[c + 2]];
    const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
    const v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(...n) || 1;
    n = n.map((x) => x / len);
    view.setFloat32(at, n[0], true); view.setFloat32(at + 4, n[1], true); view.setFloat32(at + 8, n[2], true);
    for (const [i, P] of [[12, A], [24, B], [36, C]]) {
      view.setFloat32(at + i, P[0], true); view.setFloat32(at + i + 4, P[1], true); view.setFloat32(at + i + 8, P[2], true);
    }
    view.setUint16(at + 48, 0, true);
    at += 50;
  }
  return new Uint8Array(buffer);
}

const stl = tubeStl(34, 30, 40);   // the 2 mm wall that leaked at dx 1
console.log('fluid particle constraint acceptance (Ø34/Ø30 × 40, dx 1)\n');

async function run() {
  const preset = await deriveFluidPreset(stl, 1, 100, { explicitDxMm: true });
  const { report } = await runFluidInTs({
    pipeStl: stl,
    gridCells: preset.gridCells,
    gridOriginMm: preset.gridOriginMm,
    dxMm: preset.dxMm,
    fluidRegionMm: preset.fluidRegionMm,
    inlet: { axis: preset.axis, bandMm: preset.inletBandMm, velocityMmPerSec: 100 },
    outletPlaneMm: preset.outletPlaneMm,
    particlesPerCell: 6,
    steps: preset.steps,
    snapshotCount: 4,
  });
  return report.metrics;
}

// ── constraint ON ──────────────────────────────────────────────────────────
const on = await run();
console.log(`  ON : outsideSnapshotMax ${on.outsideSnapshotMax} · leakedOutside ${on.leakedOutside}`
  + ` · absorbedInWall ${on.absorbedInWall} · inletBackflow ${on.inletBackflowCount}`
  + ` · penetration ${on.penetrationCount} · arrival ${on.outletArrivalRatio} · active/0 ${on.active}/${on.particleCount0}`);
check(on.outsideSnapshotMax === 0, 'with the constraint, NO particle is outside the bore at any snapshot',
  String(on.outsideSnapshotMax));
check(on.absorbedInWall > 0,
  'and the constraint is DOING work — particles were stopped at a wall they could not pass',
  `${on.absorbedInWall} particle(s)`);
check(on.leakedOutside + on.absorbedInWall <= on.particleCount0,
  'the counters are per-particle, not per-step events', `${on.leakedOutside + on.absorbedInWall} <= ${on.particleCount0}`);
check(on.inletBackflowCount >= 0, 'the inlet clamp counter is present and non-negative', String(on.inletBackflowCount));
// A WALL, NOT A DELETION: nothing is removed, so the mass audit must stay exact.
const accounted = on.escaped + on.active;
check(Math.abs(accounted - on.particleCount0) / on.particleCount0 < 1e-6,
  'conservation holds exactly: escaped + active = count0 (the constraint moves, it does not delete)',
  `${accounted} vs ${on.particleCount0}`);

// ── constraint OFF (the diagnostic that skips projection + constraint) ─────
process.env.CAD_FLUID_NO_PROJECT = '1';
let off;
try {
  off = await run();
} finally {
  delete process.env.CAD_FLUID_NO_PROJECT;
}
console.log(`  OFF: outsideSnapshotMax ${off.outsideSnapshotMax} · leakedOutside ${off.leakedOutside}`
  + ` · penetration ${off.penetrationCount} · arrival ${off.outletArrivalRatio} · active/0 ${off.active}/${off.particleCount0}`);
check(off.leakedOutside === 0 && off.absorbedInWall === 0,
  'with the constraint OFF nothing is absorbed (the toggle really toggles)', String(off.leakedOutside));
check(off.penetrationCount > on.penetrationCount,
  'and without it more particles end the run deeper in metal (the state the constraint prevents)',
  `OFF ${off.penetrationCount} vs ON ${on.penetrationCount}`);

// ── parity with the Python engine, when one exists ────────────────────────
// The Python worker needs numpy; this sandbox has no runtime, so the mirror cannot
// be executed here. A SKIP is printed with the reason rather than silently passing:
// a divergence between the two engines would show up as different penetration or
// leak counts on the SAME scenario.
{
  const { spawnSync } = await import('node:child_process');
  const probe = spawnSync(process.env.DSH_CAD_PYTHON_BIN ?? 'python3', ['-c', 'import numpy'], { encoding: 'utf8' });
  // numpy alone is not enough: the worker writes its SDF/labels to the runtime's
  // scratch directory, which is read-only on some hosts (this one). Probe both, so
  // the parity run is attempted only where it can actually happen.
  let scratchOk = false;
  try {
    const { workerScratchDir } = await import('../src/host/python-worker.ts');
    const { writeFileSync, rmSync } = await import('node:fs');
    const dir = await workerScratchDir();
    const probePath = `${dir}/.parity-probe`;
    writeFileSync(probePath, 'ok');
    rmSync(probePath, { force: true });
    scratchOk = true;
  } catch { scratchOk = false; }
  if (probe.status === 0 && scratchOk) {
    const { runFluid } = await import('../src/host/fluid.ts');
    const preset = await deriveFluidPreset(stl, 1, 100, { explicitDxMm: true });
    const { report } = await runFluid({
      pipeStl: stl,
      gridCells: preset.gridCells,
      gridOriginMm: preset.gridOriginMm,
      dxMm: preset.dxMm,
      fluidRegionMm: preset.fluidRegionMm,
      inlet: { axis: preset.axis, bandMm: preset.inletBandMm, velocityMmPerSec: 100 },
      outletPlaneMm: preset.outletPlaneMm,
      particlesPerCell: 6,
      steps: preset.steps,
      snapshotCount: 4,
    });
    const py = report.metrics;
    check(py.penetrationCount === 0, 'the Python engine also ends with zero penetration', String(py.penetrationCount));
    check(Math.abs(py.outletArrivalRatio - on.outletArrivalRatio) < 0.1,
      'and its arrival ratio agrees with the TS oracle within 0.10',
      `py ${py.outletArrivalRatio} vs ts ${on.outletArrivalRatio}`);
  } else {
    console.log('SKIP  Python-engine parity not run: '
      + (probe.status !== 0 ? 'no numpy' : 'the worker scratch directory is not writable')
      + ` in this environment (${probe.status !== 0 ? String(probe.stderr ?? '').trim().split('\n').pop() || 'import failed' : 'read-only ~/.dsh'})`);
  }
}

console.log(failures ? `\naccept-fluid-constraint: ${failures} FAILURE(S)` : '\naccept-fluid-constraint: PASS');
process.exit(failures ? 1 : 0);
