// Regenerate demo artifacts as RUNS under data/runs/ (physics trajectory +
// fluid frames), using the same engine calls and the same run store the tools
// write through — so seeded data is indistinguishable from a real run.
// Run: node scripts/regen-playback-data.mjs
//      node scripts/regen-playback-data.mjs --clean   # drop data/runs first
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { beginRun, openRunStore } from '../src/host/runs.ts';
import { compileStlOnly } from '../src/host/compile.ts';
import { runPhysics } from '../src/host/physics.ts';
import { runFluid, deriveFluidPreset, deriveGridFromStl } from '../src/host/fluid.ts';
import { gridBounds } from '../src/host/fluid-render.ts';

const root = join(new URL('../', import.meta.url).pathname, 'data');
const runStore = openRunStore(root);
if (process.argv.includes('--clean')) {
  await rm(runStore.root, { recursive: true, force: true });
  console.log('cleaned data/runs/');
}

// ---- physics trajectory: column dropping onto a base plate ----
{
  const plate = await compileStlOnly('cube([120,120,4], center=true);');
  const column = await compileStlOnly('cylinder(r=8, h=60, $fn=48);');
  const report = await runPhysics({
    parts: [
      { name: 'base', stl: plate.stl, bodyType: 'fixed', position: [0, 0, -2] },
      { name: 'column', stl: column.stl, bodyType: 'dynamic', position: [0, 0, 80], fellOverCheck: true },
    ],
    durationSec: 2,
  });
  const run = await beginRun(runStore, { kind: 'physics', title: '刚体物理 · 示例（立柱倾倒）' });
  await run.part('base', plate.stl);
  await run.part('column', column.stl);
  await run.json('report.json', report);
  await run.json('trajectory.json', { kind: 'physics', durationSec: report.durationSec, trajectory: report.trajectory });
  const entry = await run.commit({
    status: report.metrics.settledPenetrationMm > 1 ? 'check' : 'pass',
    summary: `稳态穿透 ${report.metrics.settledPenetrationMm.toFixed(2)}mm · 示例`,
  });
  console.log(`${entry.id} physics:`, report.trajectory.times.length, 'frames,',
    report.trajectory.events.length, 'events');
}

// ---- fluid frames: small straight-pipe run ----
{
  const pipe = await compileStlOnly(
    'difference() { translate([0,0,0]) cube([200,48,48]); translate([-1,8,8]) cube([202,32,32]); }');
  const preset = deriveFluidPreset(pipe.stl, 2, 100);
  const { report } = await runFluid({
    pipeStl: pipe.stl,
    gridCells: preset.gridCells,
    gridOriginMm: preset.gridOriginMm,
    dxMm: preset.dxMm,
    fluidRegionMm: preset.fluidRegionMm,
    inlet: { axis: preset.axis, bandMm: preset.inletBandMm, velocityMmPerSec: 100 },
    outletPlaneMm: preset.outletPlaneMm,
    particlesPerCell: 3,
    steps: 500,
    gravityMmPerSec2: [0, 0, 0],
    snapshotCount: 8,
  });
  void deriveGridFromStl;
  const bounds = gridBounds(preset.gridCells, preset.gridOriginMm, preset.dxMm);
  const manifest = {
    particleCount0: report.metrics.particleCount0,
    dxMm: preset.dxMm,
    boundsMm: bounds,
    vmaxMmPerSec: Math.max(report.metrics.maxVelocityMmPerSec, 1),
    versionId: null,
    frames: [],
  };
  const run = await beginRun(runStore, { kind: 'fluid', title: '流体仿真 · 示例（直管）' });
  await run.part('wall', pipe.stl);
  for (const snap of report.snapshots) {
    const n = snap.speedMmPerSec.length;
    const bin = new Float32Array(4 * n);
    bin.set(snap.posMm, 0);
    bin.set(snap.speedMmPerSec, 3 * n);
    const file = `frame_${String(snap.step).padStart(6, '0')}.bin`;
    await run.frame(file, Buffer.from(bin.buffer, bin.byteOffset, bin.byteLength));
    manifest.frames.push({ step: snap.step, timeSec: snap.timeSec, particles: n, file });
  }
  await run.json('fluid-manifest.json', manifest);
  const { snapshots, ...slim } = report;
  void snapshots;
  await run.json('report.json', slim);
  const entry = await run.commit({
    status: report.overallStatus === 'pass' ? 'pass' : 'check',
    summary: `粒子 ${manifest.particleCount0} · ${manifest.frames.length} 帧 · 示例`,
  });
  console.log(`${entry.id} fluid:`, manifest.frames.length, 'frames x', manifest.particleCount0, 'particles');
}
