// Pure kernel at increasing density, no SDF / no inlet / no gravity:
// does the Python kernel drift systematically as particles per cell rises?
import { createMpmWorld, stepWorld } from '../src/host/mpm.ts';
import { ensurePythonWorker, resetPythonWorker } from '../src/host/python-worker.ts';

const worker = await ensurePythonWorker();
const cells = [40, 20, 20];
const dx = 2;
for (const count of [2000, 8000, 20000]) {
  const seeds = [];
  for (let i = 0; i < count; i++) {
    seeds.push(4 + (i % 24) * 1.2, 4 + (Math.floor(i / 24) % 12) * 1.2, 4 + (Math.floor(i / 288) % 12) * 1.2);
  }
  const config = { cells, dxMm: dx, particleCount: count, dt: 1 / 60, vmax: 20, gravity: [0, 0, 0], stiffness: 50, viscosity: 0.1 };
  const w = createMpmWorld(config, (i) => [seeds[i * 3], seeds[i * 3 + 1], seeds[i * 3 + 2]]);
  const rd = w.calibrateRestDensity();
  for (let s = 0; s < 200; s++) stepWorld(w);
  let tsSpeed = 0, tsMax = 0;
  for (let p = 0; p < w.activeN; p++) {
    const sp = Math.hypot(w.vel[p * 3], w.vel[p * 3 + 1], w.vel[p * 3 + 2]);
    tsSpeed += sp; tsMax = Math.max(tsMax, sp);
  }
  const created = await worker.request('mpm_create', { config, seeds });
  await worker.request('mpm_step', { worldId: created.worldId, steps: 200 });
  const st = await worker.request('mpm_state', { worldId: created.worldId });
  await worker.request('mpm_destroy', { worldId: created.worldId });
  console.log(`count=${String(count).padStart(6)} rd TS=${rd.toFixed(4)} py=${created.restDensity.toFixed(4)} | TS avg=${(tsSpeed / w.activeN).toFixed(4)} max=${tsMax.toFixed(3)} | py avg=${st.meanSpeed.toFixed(4)} max=${st.maxSpeed.toFixed(3)}`);
}
resetPythonWorker();
process.exit(0);
