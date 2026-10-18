// M3.6 acceptance — mechanism motion simulation (design: docs/archive/M3.6-MOTION-PREP.md).
//
// case 1  slider-crank (kinematics): travel = 2R, period, no interference
// case 2  single-cylinder four-stroke: crank + rod + piston + block + 2 valves
//         (oscillators at ω/2, anti-phase) — full assertions + keyframe renders
// case 3  NEGATIVE: rod too long (64 instead of 60) → piston crashes into the
//         head → interference MUST be detected, status 'check'
//
// Units: mm, z-up, gravity off (mechanism kinematics).

import { compileStlOnly } from '../src/host/compile.ts';
import { runMotion } from '../src/host/motion.ts';
import { renderKeyframes } from '../src/host/physics.ts';
import { createHash } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Acceptance writes are throwaway: never pollute data/ (runs live in data/runs/).
const MOTION_DIR = mkdtempSync(join(tmpdir(), 'accept-m36-'));

let fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
  if (!ok) fail++;
};

async function stl(scad) {
  const c = await compileStlOnly(scad);
  if (!c.success || !c.stl) throw new Error('compile failed: ' + c.errors.join('; '));
  return c.stl;
}

// ---------------- case 1: slider-crank ----------------
console.log('--- case 1: slider-crank ---');
{
  const report = await runMotion({
    parts: [
      { name: 'ground', stl: await stl('cube([60,20,2], center=true);'), bodyType: 'fixed', position: [0, 0, -30] },
      { name: 'crank', stl: await stl('cube([10,10,10], center=true);'), bodyType: 'kinematic', position: [0, 0, 0] },
      { name: 'rod', stl: await stl('cube([56,4,4], center=true);'), bodyType: 'dynamic', position: [50, 0, 0] },
      { name: 'piston', stl: await stl('cube([10,10,10], center=true);'), bodyType: 'dynamic', position: [80, 0, 0] },
    ],
    joints: [
      { type: 'revolute', bodyA: 'ground', bodyB: 'crank', anchorA: [0, 0, 30], anchorB: [0, 0, 0], axis: [0, 0, 1] },
      { type: 'revolute', bodyA: 'crank', bodyB: 'rod', anchorA: [20, 0, 0], anchorB: [-28, 0, 0], axis: [0, 0, 1] },
      { type: 'revolute', bodyA: 'piston', bodyB: 'rod', anchorA: [0, 0, 0], anchorB: [28, 0, 0], axis: [0, 0, 1] },
      { type: 'prismatic', bodyA: 'ground', bodyB: 'piston', anchorA: [80, 0, 30], anchorB: [0, 0, 0], axis: [1, 0, 0] },
    ],
    drive: { body: 'crank', axis: [0, 0, 1], omegaRadPerSec: 10 },
    cycles: 2,
    recordParts: ['piston'],
  });

  const f = report.metrics.followers.piston;
  console.log(`  status=${report.overallStatus} travel=${f.travelMm}mm period=${f.periodSec}s interfer=${report.metrics.interferenceCount} drift=${report.metrics.maxJointDriftMm}mm`);
  check('c1 status pass', report.overallStatus === 'pass', report.overallStatus);
  check('c1 piston travel ≈ 40', Math.abs(f.travelMm - 40) < 2, `${f.travelMm}mm`);
  check('c1 piston period ≈ 0.628s', f.periodSec !== null && Math.abs(f.periodSec - 0.6283) / 0.6283 < 0.1, `${f.periodSec}s`);
  check('c1 zero interference', report.metrics.interferenceCount === 0, `${report.metrics.interferenceCount} events`);
  check('c1 joint drift < 1mm', report.metrics.maxJointDriftMm < 1, `${report.metrics.maxJointDriftMm}mm`);
}

// ---------------- case 2: four-stroke (pass) ----------------
console.log('--- case 2: four-stroke ---');
const C2_SCADS = {
  block: `union() {
      translate([-14,0,74]) cube([4,20,28], center=true);
      translate([14,0,74]) cube([4,20,28], center=true);
      translate([0,0,90]) cube([36,20,4], center=true);
    }`,
  crank: `union() {
      rotate([-90,0,0]) cylinder(h=16, d=10, center=true);
      translate([0,0,20]) rotate([-90,0,0]) cylinder(h=24, d=6, center=true);
    }`,
  rod: 'cube([4,4,56], center=true);',
  piston: 'cube([20,20,12], center=true);',
  'valve-in': 'cube([6,6,10], center=true);',
  'valve-ex': 'cube([6,6,10], center=true);',
};

const c2Spec = {
  parts: [
    { name: 'block', bodyType: 'fixed', position: [0, 0, 0] },
    { name: 'crank', bodyType: 'kinematic', position: [0, 0, 0] },
    { name: 'rod', bodyType: 'dynamic', position: [0, 0, 50] },
    { name: 'piston', bodyType: 'dynamic', position: [0, 0, 80] },
    { name: 'valve-in', bodyType: 'kinematic', position: [-8, 0, 100] },
    { name: 'valve-ex', bodyType: 'kinematic', position: [8, 0, 100] },
  ],
  joints: [
    { type: 'revolute', bodyA: 'crank', bodyB: 'rod', anchorA: [0, 0, 20], anchorB: [0, 0, -30], axis: [0, 1, 0] },
    { type: 'revolute', bodyA: 'piston', bodyB: 'rod', anchorA: [0, 0, 0], anchorB: [0, 0, 30], axis: [0, 1, 0] },
    { type: 'prismatic', bodyA: 'block', bodyB: 'piston', anchorA: [0, 0, 80], anchorB: [0, 0, 0], axis: [0, 0, 1] },
  ],
  drive: { body: 'crank', axis: [0, 1, 0], omegaRadPerSec: 10 },
  oscillators: [
    { body: 'valve-in', axis: [0, 0, 1], amplitudeMm: 2, periodSec: 1.2566, phaseRad: 0 },
    { body: 'valve-ex', axis: [0, 0, 1], amplitudeMm: 2, periodSec: 1.2566, phaseRad: Math.PI },
  ],
  cycles: 2,
  recordParts: ['piston', 'valve-in', 'valve-ex'],
};

{
  const parts = [];
  for (const p of c2Spec.parts) {
    parts.push({ ...p, stl: await stl(C2_SCADS[p.name]) });
  }

  const report = await runMotion({ ...c2Spec, parts });

  const m = report.metrics;
  const p = m.followers.piston;
  console.log(`  status=${report.overallStatus} piston travel=${p.travelMm}mm period=${p.periodSec}s interfer=${m.interferenceCount} drift=${m.maxJointDriftMm}mm keyframes=${report.keyframes.length}`);
  check('c2 status pass', report.overallStatus === 'pass', report.overallStatus);
  check('c2 piston travel ≈ 40 (z)', p.axis === 'z' && Math.abs(p.travelMm - 40) < 2, `${p.travelMm}mm on ${p.axis}`);
  check('c2 piston period ≈ 0.628s', p.periodSec !== null && Math.abs(p.periodSec - 0.6283) / 0.6283 < 0.1, `${p.periodSec}s`);
  check('c2 zero interference', m.interferenceCount === 0, `${m.interferenceCount} events`);
  check('c2 joint drift < 1mm', m.maxJointDriftMm < 1, `${m.maxJointDriftMm}mm`);

  // valve timing: ω/2 (period 1.257s) and anti-phase
  const vi = report.followersDetail['valve-in'];
  const ve = report.followersDetail['valve-ex'];
  const firstOpen = (d) => {
    const i = d.vals.findIndex((v) => v < 99);
    return i < 0 ? NaN : d.t[i];
  };
  const tIn = firstOpen(vi), tEx = firstOpen(ve);
  const sep = Math.abs(tEx - tIn);
  check('c2 valves anti-phase (sep ≈ half valve period)', Math.abs(sep - 0.6283) < 0.25, `Δt=${sep.toFixed(3)}s (t_in=${tIn?.toFixed(3)}, t_ex=${tEx?.toFixed(3)})`);
  const strokes = vi.vals.some((v) => v < 99) && vi.vals.some((v) => v > 101);
  check('c2 valves actually stroke (±1mm band crossed)', strokes, `in-z∈[${Math.min(...vi.vals).toFixed(2)}, ${Math.max(...vi.vals).toFixed(2)}]`);
  check('c2 keyframes ≥ 5', report.keyframes.length >= 5, `${report.keyframes.length}`);

  // keyframe renders (reuse physics.ts OpenSCAD pipeline)
  await mkdir(join(MOTION_DIR, 'frames'), { recursive: true });
  const stlFiles = [];
  for (const name of Object.keys(C2_SCADS)) {
    const path = join(MOTION_DIR, `${name}.stl`);
    await writeFile(path, parts.find((x) => x.name === name).stl);
    stlFiles.push({ name, stlPath: path });
  }
  const { frames, warnings } = await renderKeyframes(report, stlFiles, join(MOTION_DIR, 'frames'));
  check('c2 rendered ≥ 4 keyframe PNGs', frames.length >= 4, `${frames.length} frames`);
  // A render that emits WARNING/ERROR must not pass silently: `rotate(m=…)` used to
  // degenerate to the identity here, and the pictures were the only evidence.
  check('c2 rendered without OpenSCAD warnings', warnings.length === 0, warnings.slice(0, 2).join(' | ') || 'clean');
  const hashes = frames.map((f) => createHash('sha256').update(f.png).digest('hex'));
  check('c2 keyframe images actually differ (the pose reached the renderer)',
    new Set(hashes).size === hashes.length, `${new Set(hashes).size}/${hashes.length} distinct`);
}

// ---------------- case 3: negative (rod too long) ----------------
console.log('--- case 3: negative (rod 64 → piston hits head) ---');
{
  const stls = {
    block: await stl(C2_SCADS.block),
    crank: await stl(C2_SCADS.crank),
    rod: await stl('cube([4,4,60], center=true);'),
    piston: await stl(C2_SCADS.piston),
  };

  const report = await runMotion({
    parts: [
      { name: 'block', stl: stls.block, bodyType: 'fixed', position: [0, 0, 0] },
      { name: 'crank', stl: stls.crank, bodyType: 'kinematic', position: [0, 0, 0] },
      { name: 'rod', stl: stls.rod, bodyType: 'dynamic', position: [0, 0, 52] },
      { name: 'piston', stl: stls.piston, bodyType: 'dynamic', position: [0, 0, 84] },
    ],
    joints: [
      { type: 'revolute', bodyA: 'crank', bodyB: 'rod', anchorA: [0, 0, 20], anchorB: [0, 0, -32], axis: [0, 1, 0] },
      { type: 'revolute', bodyA: 'piston', bodyB: 'rod', anchorA: [0, 0, 0], anchorB: [0, 0, 32], axis: [0, 1, 0] },
      { type: 'prismatic', bodyA: 'block', bodyB: 'piston', anchorA: [0, 0, 84], anchorB: [0, 0, 0], axis: [0, 0, 1] },
    ],
    drive: { body: 'crank', axis: [0, 1, 0], omegaRadPerSec: 10 },
    cycles: 1,
  });

  const m = report.metrics;
  console.log(`  status=${report.overallStatus} interfer=${m.interferenceCount} first=${JSON.stringify(m.interferenceEvents.slice(0, 2))}`);
  check('c3 interference detected', m.interferenceCount > 0, `${m.interferenceCount} events`);
  check('c3 piston↔block among events', m.interferenceEvents.some((e) => (e.partA === 'piston' && e.partB === 'block') || (e.partA === 'block' && e.partB === 'piston')), '');
  check('c3 status check', report.overallStatus === 'check', report.overallStatus);
}

console.log(fail === 0 ? '\nM3.6 ACCEPTANCE PASSED' : `\nM3.6 ACCEPTANCE FAILED (${fail})`);
process.exit(fail === 0 ? 0 : 1);
