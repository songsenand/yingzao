// Golden numeric fixture for validate_assembly (Python canonical).
//
// The TS oracle was retired on 2026-11-25. This fixture is the replacement for the
// numeric half of the parity evidence: fixed, analytically-known solids and expected
// volume / bbox / minDistance. If manifold3d or the weld path drifts, these numbers
// fail even though both sides are gone.
//
//   node --experimental-strip-types scripts/accept-assembly-golden.mjs

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const localRuntime = join(REPO, '.tmp-measure-runtime');
if (!process.env.DSH_CAD_PYTHON_ROOT?.trim() && existsSync(join(localRuntime, 'venv'))) {
  process.env.DSH_CAD_PYTHON_ROOT = localRuntime;
}
const { validateAssembly } = await import('../src/host/assembly.ts');
const { resetPythonWorker } = await import('../src/host/python-worker.ts');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const near = (a, b, tol, label, detail = '') => {
  check(typeof a === 'number' && Math.abs(a - b) <= tol, label, detail || `${a} vs ${b}`);
};

/** Binary STL box centred at (cx,cy,cz), dimensions (sx,sy,sz). Outward winding. */
function box(cx, cy, cz, sx, sy, sz) {
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const v = [
    [cx - hx, cy - hy, cz - hz], [cx + hx, cy - hy, cz - hz],
    [cx + hx, cy + hy, cz - hz], [cx - hx, cy + hy, cz - hz],
    [cx - hx, cy - hy, cz + hz], [cx + hx, cy - hy, cz + hz],
    [cx + hx, cy + hy, cz + hz], [cx - hx, cy + hy, cz + hz],
  ];
  const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const buf = Buffer.alloc(84 + 12 * 50);
  buf.write('assembly-golden', 0);
  buf.writeUInt32LE(12, 80);
  let o = 84;
  for (const [i, j, k] of faces) {
    const a = v[i], b = v[j], c = v[k];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const len = Math.hypot(...n) || 1;
    n = n.map((x) => x / len);
    for (const p of [n, a, b, c]) for (const x of p) { buf.writeFloatLE(x, o); o += 4; }
    o += 2;
  }
  return buf;
}

// 1. 20mm cube ↔ 10mm cube at x=20: gap 5mm, no interference.
const gap = await validateAssembly([
  { name: 'big', stl: box(0, 0, 0, 20, 20, 20) },
  { name: 'small', stl: box(20, 0, 0, 10, 10, 10) },
], 0.75, 1e-3);
check(gap.overallStatus === 'pass', 'gap pair passes', gap.overallStatus);
near(gap.parts[0]?.volume, 8000, 1e-6, 'big volume is 8000mm³');
near(gap.parts[1]?.volume, 1000, 1e-6, 'small volume is 1000mm³');
check(gap.parts[1]?.watertight === true, 'small is watertight');
near(gap.parts[1]?.boundingBox.min[0], 15, 1e-6, 'small bbox min.x is 15');
near(gap.parts[1]?.boundingBox.max[0], 25, 1e-6, 'small bbox max.x is 25');
near(gap.pairs[0]?.minDistance, 5, 1e-6, 'surface gap is 5mm', String(gap.pairs[0]?.minDistance));
near(gap.pairs[0]?.intersectionVolume, 0, 1e-6, 'no intersection', String(gap.pairs[0]?.intersectionVolume));

// 2. two 10mm cubes at x=0 and x=8: 2×10×10 = 200mm³ interference.
const clash = await validateAssembly([
  { name: 'a', stl: box(0, 0, 0, 10, 10, 10) },
  { name: 'b', stl: box(8, 0, 0, 10, 10, 10) },
], 0.75, 1e-3);
check(clash.overallStatus === 'fail', 'clash pair fails', clash.overallStatus);
near(clash.pairs[0]?.intersectionVolume, 200, 1e-6, 'intersection is 200mm³', String(clash.pairs[0]?.intersectionVolume));
check(clash.pairs[0]?.status === 'interference', 'pair is interference', String(clash.pairs[0]?.status));

// 3. transform path: same 10mm cube, translated +20 by the manifest transform.
const moved = await validateAssembly([
  { name: 'a', stl: box(0, 0, 0, 10, 10, 10) },
  { name: 'b', stl: box(0, 0, 0, 10, 10, 10), transform: { translate: [20, 0, 0] } },
], 0.75, 1e-3);
near(moved.parts[1]?.boundingBox.min[0], 15, 1e-6, 'transformed bbox min.x is 15');
near(moved.parts[1]?.boundingBox.max[0], 25, 1e-6, 'transformed bbox max.x is 25');
near(moved.pairs[0]?.minDistance, 10, 1e-6, 'transformed gap is 10mm', String(moved.pairs[0]?.minDistance));

// 4. a single triangle is not a solid; the worker must refuse, not report.
const triangle = Buffer.alloc(84 + 50);
triangle.write('single-triangle', 0); triangle.writeUInt32LE(1, 80);
let refused = false;
try {
  await validateAssembly([
    { name: 'a', stl: box(0, 0, 0, 10, 10, 10) },
    { name: 'tri', stl: triangle },
  ]);
} catch { refused = true; }
check(refused, 'a non-solid part is refused');

resetPythonWorker();
console.log(failures === 0 ? '\nOK' : `\nFAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
