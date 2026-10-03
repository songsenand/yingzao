// M3 acceptance, mirroring design doc §6.5. Z-up world (matches OpenSCAD).
import { compileStlOnly } from '../src/host/compile.ts';
import { runPhysics } from '../src/host/physics.ts';

// 1. box resting on a plate: settles, no penetration, no drift
const box = await compileStlOnly('cube(20, center=true);');
const plate = await compileStlOnly('cube([200,200,2], center=true);');
if (!box.success || !plate.success) { console.error('FAIL compile'); process.exit(1); }
const r1 = await runPhysics({
  parts: [
    { name: 'ground', stl: plate.stl, bodyType: 'fixed', position: [0, 0, -1] },
    { name: 'box', stl: box.stl, bodyType: 'dynamic', position: [0, 0, 15] },
  ],
  durationSec: 2,
});
console.log('case1: settledPenetration =', r1.metrics.settledPenetrationMm, 'mm; fellOver =', r1.metrics.fellOver.box,
  '; drift =', r1.metrics.maxHorizontalDisplacementMm.box, 'mm; settled =', r1.metrics.settled,
  '; final z =', r1.finalPositions.box[2].toFixed(2), '(expect ≈10)');
if (r1.metrics.settledPenetrationMm > 0.5) { console.error('FAIL case1 penetration'); process.exit(1); }
if (r1.metrics.fellOver.box || !r1.metrics.settled) { console.error('FAIL case1 stability'); process.exit(1); }

// 2. hinged door: fixed post + dynamic door on a vertical (z) revolute joint, pushed
const post = await compileStlOnly('cube([10,10,60], center=false);');
const door = await compileStlOnly('cube([30,4,50], center=false);');
if (!post.success || !door.success) { console.error('FAIL compile2'); process.exit(1); }
const r2 = await runPhysics({
  parts: [
    { name: 'post', stl: post.stl, bodyType: 'fixed', position: [0, 0, 0] },
    { name: 'door', stl: door.stl, bodyType: 'dynamic', position: [10, -2, 0],
      density: 1.05e-6, initialAngularVelocity: [0, 0, 1.5] },
  ],
  joints: [{ type: 'revolute', bodyA: 'post', bodyB: 'door', anchorA: [10, 0, 25], anchorB: [0, 2, 25], axis: [0, 0, 1] }],
  durationSec: 1.5,
});
const doorDrift = r2.metrics.maxHorizontalDisplacementMm.door;
console.log('case2: door drift =', doorDrift, 'mm; jointViolations =', r2.metrics.jointViolations.length,
  '; fellOver =', r2.metrics.fellOver.door);
if (r2.metrics.jointViolations.length > 0) { console.error('FAIL case2 joint'); process.exit(1); }
if (doorDrift > 60) { console.error('FAIL case2 flew away'); process.exit(1); }

// 3. tall tower tilted 12°: high COM → must topple
const tall = await compileStlOnly('cube([12,12,60], center=false);');
if (!tall.success) { console.error('FAIL compile3'); process.exit(1); }
const r3 = await runPhysics({
  parts: [
    { name: 'floor', stl: plate.stl, bodyType: 'fixed', position: [0, 0, -1] },
    { name: 'tower', stl: tall.stl, bodyType: 'dynamic', position: [0, 0, 5], rotation: [12, 0, 0] },
  ],
  durationSec: 2.5,
});
console.log('case3: fellOver =', r3.metrics.fellOver.tower,
  '; final z =', r3.finalPositions.tower[2].toFixed(1), '(lying flat ≈ 2-6)');
if (!r3.metrics.fellOver.tower) { console.error('FAIL case3 should topple'); process.exit(1); }

console.log('M3 ACCEPTANCE PASSED');
