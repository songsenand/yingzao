// Acceptance for the prescribed GEAR coupling in simulate_motion.
//
// A gear is a ratio coupling, not a contact problem: rapier has no gear constraint,
// so the follower's pose is projected each step (Python canonical + TS oracle).
// Fixture: a driven 4mm cube at the origin and a follower 30mm away, ratio 2 about
// +Z, quarter turn. Expect turnsA≈0.25, turnsB≈0.5, measuredRatio≈2 on BOTH engines.
//
//   node --experimental-strip-types scripts/accept-motion-gear.mjs

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const localRuntime = join(REPO, '.tmp-measure-runtime');
if (!process.env.DSH_CAD_PYTHON_ROOT?.trim() && existsSync(join(localRuntime, 'venv'))) {
  process.env.DSH_CAD_PYTHON_ROOT = localRuntime;
}

const { runMotion, runMotionInTs } = await import('../src/host/motion.ts');
const { resetPythonWorker } = await import('../src/host/python-worker.ts');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

/** Binary STL cube at the origin. */
function cubeStl(s) {
  const h = s / 2;
  const v = [[-h, -h, -h], [h, -h, -h], [h, h, -h], [-h, h, -h], [-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]];
  const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const buf = Buffer.alloc(84 + 12 * 50);
  buf.write('motion-gear cube', 0);
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

const stl = cubeStl(4);
const scenario = {
  cycles: 0.25,
  parts: [
    { name: 'gearA', stl, bodyType: 'kinematic', position: [0, 0, 0] },
    { name: 'gearB', stl, bodyType: 'dynamic', position: [30, 0, 0] },
  ],
  joints: [{ type: 'gear', bodyA: 'gearA', bodyB: 'gearB', ratio: 2, axisA: [0, 0, 1], axisB: [0, 0, 1] }],
  drive: { body: 'gearA', axis: [0, 0, 1], omegaRadPerSec: 2 * Math.PI },
};

const py = await runMotion(scenario);
const ts = await runMotionInTs(scenario);
for (const [label, r] of [['Python', py], ['TS', ts]]) {
  const g = r.metrics.gears?.[0];
  check(Boolean(g), `${label}: the gear coupling is reported`, JSON.stringify(g));
  check(Math.abs((g?.turnsA ?? 0) - 0.25) < 1e-3, `${label}: driven gear turned 0.25 turn`, String(g?.turnsA));
  check(Math.abs((g?.turnsB ?? 0) - 0.5) < 1e-3, `${label}: follower turned 0.5 turn (ratio 2)`, String(g?.turnsB));
  check(Math.abs((g?.measuredRatio ?? 0) - 2) < 1e-3, `${label}: measured ratio is 2`, String(g?.measuredRatio));
  check(g?.agrees === true, `${label}: the run agrees with the declared ratio`, String(g?.agrees));
  check(r.overallStatus === 'pass', `${label}: a clean gear run is pass`, r.overallStatus);
}
check(Math.abs((py.metrics.gears?.[0]?.turnsA ?? 0) - (ts.metrics.gears?.[0]?.turnsA ?? 0)) < 1e-4,
  'Python and TS agree on the driven angle');
check(Math.abs((py.metrics.gears?.[0]?.turnsB ?? 0) - (ts.metrics.gears?.[0]?.turnsB ?? 0)) < 1e-4,
  'Python and TS agree on the follower angle');

resetPythonWorker();
console.log(failures === 0 ? '\nOK' : `\nFAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
