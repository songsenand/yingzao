// Bisect the fluid gap by feature: no mask/inlet → +inlet → +mask → +both.
import { createMpmWorld, stepWorld } from '../src/host/mpm.ts';
import { ensurePythonWorker, resetPythonWorker } from '../src/host/python-worker.ts';

const worker = await ensurePythonWorker();
const cells = [40, 20, 20];
const [nx, ny, nz] = cells;
const total = nx * ny * nz;
const count = Number(process.env.COUNT ?? 5000);
const steps = Number(process.env.STEPS ?? 100);

const seeds = [];
for (let i = 0; i < count; i++) {
  seeds.push(4 + (i % 24) * 1.2, 4 + (Math.floor(i / 24) % 12) * 1.2, 4 + (Math.floor(i / 288) % 12) * 1.2);
}
// a pipe-ish mask: solid shell cells with dominant normals
const mask = new Uint8Array(total);
const normal = new Uint8Array(total);
for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) {
  const cell = (x * ny + y) * nz + z;
  if (y <= 1 || y >= ny - 2 || z <= 1 || z >= nz - 2) {
    mask[cell] = 1;
    normal[cell] = y <= 1 ? 4 : y >= ny - 2 ? 3 : z <= 1 ? 6 : 5;
  }
}

const variants = [
  { label: 'plain', extra: {} },
  { label: '+inlet', extra: { inlet: { axis: 0, band: [0, 12], speed: 20 } } },
  { label: '+mask', extra: { solidMask: mask, solidNormal: normal } },
  { label: '+inlet+mask', extra: { inlet: { axis: 0, band: [0, 12], speed: 20 }, solidMask: mask, solidNormal: normal } },
];

for (const variant of variants) {
  const config = { cells, dxMm: 2, particleCount: count, dt: 1 / 60, vmax: 20, gravity: [0, 0, 0], stiffness: 50, viscosity: 0.1, ...variant.extra };
  const w = createMpmWorld(config, (i) => [seeds[i * 3], seeds[i * 3 + 1], seeds[i * 3 + 2]]);
  w.calibrateRestDensity();
  for (let s = 0; s < steps; s++) stepWorld(w);
  const created = await worker.request('mpm_create', { config, seeds });
  await worker.request('mpm_step', { worldId: created.worldId, steps });
  const st = await worker.request('mpm_state', { worldId: created.worldId, particles: true });
  await worker.request('mpm_destroy', { worldId: created.worldId });
  let maxPos = 0, maxVel = 0;
  for (let p = 0; p < w.activeN; p++) {
    maxPos = Math.max(maxPos, Math.hypot(st.pos[p * 3] - w.pos[p * 3], st.pos[p * 3 + 1] - w.pos[p * 3 + 1], st.pos[p * 3 + 2] - w.pos[p * 3 + 2]));
    maxVel = Math.max(maxVel, Math.hypot(st.vel[p * 3] - w.vel[p * 3], st.vel[p * 3 + 1] - w.vel[p * 3 + 1], st.vel[p * 3 + 2] - w.vel[p * 3 + 2]));
  }
  console.log(`${variant.label.padEnd(12)} max|Δpos|=${maxPos.toExponential(3)}  max|Δvel|=${maxVel.toExponential(3)}  meanSpeed TS=${(w.vel.reduce((a, _, i) => a, 0), '')}${''}py=${st.meanSpeed.toFixed(4)}`);
}
resetPythonWorker();
process.exit(0);
