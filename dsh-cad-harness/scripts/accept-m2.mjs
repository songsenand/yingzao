// M2 acceptance test, mirroring the design doc §6.4:
// 1. obviously interfering parts → intersectionVolume > 0
// 2. parts with 1mm gap → minDistance ≈ 1.0
// 3. watertight checks on OpenSCAD output
import { compileStlOnly } from '../src/host/compile.ts';
import { validateAssembly } from '../src/host/assembly.ts';
import { parseBinaryStl, isWatertight } from '../src/host/mesh.ts';

// Real compile: 20mm cube and a 40mm cylinder, both via OpenSCAD.
const cube = await compileStlOnly('cube(20, center=true);');
const cyl = await compileStlOnly('cylinder(h=40, d=12, center=true, $fn=64);');
if (!cube.success || !cyl.success) { console.error('FAIL compile'); process.exit(1); }

const cubeMesh = parseBinaryStl(cube.stl);
console.log('cube watertight:', isWatertight(cubeMesh).watertight, 'tris:', cubeMesh.triVerts.length / 3);
if (!isWatertight(cubeMesh).watertight) { console.error('FAIL watertight'); process.exit(1); }

// Case 1: interference — cylinder through cube centre, both at origin.
const r1 = await validateAssembly([
  { name: 'cube', stl: cube.stl },
  { name: 'shaft', stl: cyl.stl, transform: {} },
], 0.75);
const p1 = r1.pairs[0];
console.log('case1:', p1.status, 'interVol:', p1.intersectionVolume.toFixed(1), 'overall:', r1.overallStatus);
if (p1.status !== 'interference' || p1.intersectionVolume <= 0) { console.error('FAIL case1'); process.exit(1); }
// expected interference = cylinder segment inside cube z∈[-10,10] = π·r²·20 ≈ 2262
if (Math.abs(p1.intersectionVolume - Math.PI * 36 * 20) > 50) { console.error('FAIL case1 volume, got', p1.intersectionVolume); process.exit(1); }

// Case 2: 1mm gap — cylinder shifted so its end is 1mm from cube face.
// 1mm > 0.75mm default threshold → status ok, but minDistance must measure 1.0.
const r2 = await validateAssembly([
  { name: 'cube', stl: cube.stl },
  { name: 'shaft', stl: cyl.stl, transform: { translate: [0, 0, 31] } },
], 0.75);
const p2 = r2.pairs[0];
console.log('case2:', p2.status, 'minDistance:', p2.minDistance.toFixed(3), 'overall:', r2.overallStatus);
if (p2.status !== 'ok' || Math.abs(p2.minDistance - 1.0) > 0.01) { console.error('FAIL case2 (expect minDistance ≈ 1.0, ok)'); process.exit(1); }

// Case 2b: same 1mm gap but stricter threshold 1.5mm → too_tight.
const r2b = await validateAssembly([
  { name: 'cube', stl: cube.stl },
  { name: 'shaft', stl: cyl.stl, transform: { translate: [0, 0, 31] } },
], 1.5);
const p2b = r2b.pairs[0];
console.log('case2b:', p2b.status, 'minDistance:', p2b.minDistance.toFixed(3));
if (p2b.status !== 'too_tight') { console.error('FAIL case2b (expect too_tight under 1.5mm threshold)'); process.exit(1); }

// Case 3: clear of each other — 5mm gap → ok.
const r3 = await validateAssembly([
  { name: 'cube', stl: cube.stl },
  { name: 'shaft', stl: cyl.stl, transform: { translate: [0, 0, 35] } },
], 0.75);
const p3 = r3.pairs[0];
console.log('case3:', p3.status, 'minDistance:', p3.minDistance.toFixed(3));
if (p3.status !== 'ok' || Math.abs(p3.minDistance - 5.0) > 0.01) { console.error('FAIL case3 (expect ≈5.0, ok)'); process.exit(1); }

console.log('M2 ACCEPTANCE PASSED');
