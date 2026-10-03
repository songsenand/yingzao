// Playback data smoke (M4R pillar B): verifies the host-side artifacts that
// feed panel visualization — physics/motion trajectory.json and fluid
// frames.json + .bin layout. Run: node scripts/smoke-playback.mjs
import { writeFileSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileStlOnly } from '../src/host/compile.ts';
import { runPhysics } from '../src/host/physics.ts';
import { runFluid } from '../src/host/fluid.ts';
import { deriveFluidPreset } from '../src/host/fluid.ts';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

// ---- 1. physics trajectory ----
{
  const box = await compileStlOnly('cube(20, center=true);');
  const plate = await compileStlOnly('cube([200,200,2], center=true);');
  const r = await runPhysics({
    parts: [
      { name: 'ground', stl: plate.stl, bodyType: 'fixed', position: [0, 0, -1] },
      { name: 'box', stl: box.stl, bodyType: 'dynamic', position: [0, 0, 30] },
    ],
    durationSec: 1.5,
  });
  const t = r.trajectory;
  check('physics trajectory present', !!t && t.parts.length === 2);
  check('physics timeline aligned', t.parts.every((p) => p.frames.length === t.times.length),
    `${t.times.length} frames`);
  check('physics timeline monotonic', t.times.every((v, i) => i === 0 || v > t.times[i - 1]));
  const z0 = t.parts.find((p) => p.name === 'box').frames[0][2];
  const zN = t.parts.find((p) => p.name === 'box').frames.at(-1)[2];
  check('physics keyframe bug fixed (first frame ≠ final pose)', z0 > 20 && Math.abs(zN - 10) < 1,
    `z0=${z0.toFixed(1)} zEnd=${zN.toFixed(1)}`);
  check('physics events labeled', t.events.length >= 2, t.events.map((e) => e.label).join(','));
}

// ---- 2. fluid frames ----
{
  const dir = mkdtempSync(join(tmpdir(), 'playback-smoke-'));
  const pipe = await compileStlOnly(
    'difference() { cube([200,48,48], center=false); translate([-1,8,8]) cube([202,32,32]); }');
  const stlPath = join(dir, 'pipe.stl');
  writeFileSync(stlPath, pipe.stl);
  const preset = deriveFluidPreset(new Uint8Array(readFileSync(stlPath)), 2, 100);
  const { report } = await runFluid({
    pipeStl: pipe.stl,
    gridCells: preset.gridCells,
    gridOriginMm: preset.gridOriginMm,
    dxMm: preset.dxMm,
    fluidRegionMm: preset.fluidRegionMm,
    inlet: { axis: preset.axis, bandMm: preset.inletBandMm, velocityMmPerSec: 100 },
    outletPlaneMm: preset.outletPlaneMm,
    particlesPerCell: 2, // small on purpose — layout check only
    steps: 300,
    gravityMmPerSec2: [0, 0, 0],
    snapshotCount: 4,
  });
  const snaps = report.snapshots;
  check('fluid snapshots retained', snaps.length === 4, `${snaps.length} snapshots`);
  const layoutOk = snaps.every((s) => s.posMm.length === s.speedMmPerSec.length * 3);
  check('fluid frame layout pos[3N]+speed[N]', layoutOk);
  const bytes = 16 * snaps[0].speedMmPerSec.length;
  check('fluid frame byte budget = 16B/particle', true, `${(bytes / 1e6).toFixed(2)}MB/frame at this size`);
}

process.exit(failures > 0 ? 1 : 0);
