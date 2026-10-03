// Quick stability smoke for the MLS-MPM kernel before the full sweep.
import { createMpmWorld } from '../src/host/mpm.ts';

const NX = 100, NY = 24, NZ = 24;
const s = 0.63;
const perX = Math.floor(20 / s), perY = Math.floor(21 / s), perZ = Math.floor(97 / s);
const count = perX * perY * perZ;
let i = 0;
const world = createMpmWorld({
  cells: [NX, NY, NZ], dxMm: 2, particleCount: count,
  gravity: [0, 0, -49.05], dt: 0.004, vmax: 60,
  inlet: { axis: 0, band: [2, 5], speed: 25 },
  recycle: { axis: 0, at: 98, respawn: 3 },
}, () => {
  const x = 2 + (i % perX) * s + 0.5 + s / 2;
  const y = 1.5 + (Math.floor(i / perX) % perY) * s + s / 2;
  const z = 1.5 + (Math.floor(i / (perX * perY)) % perZ) * s + s / 2;
  i++;
  return [x, y, z];
});
const rd = world.calibrateRestDensity();
world.cfg.stiffness = 50 * (rd / 1.5);
world.cfg.viscosity = 0.1 * (rd / 1.5);
console.log(`count=${count} restDensity=${rd.toFixed(3)}`);

const t = performance.now();
for (let step = 1; step <= 120; step++) {
  world.step();
  if (step % 20 === 0) {
    const { pos, vel } = world;
    let ke = 0, vmaxSeen = 0, nan = 0, meanX = 0, meanVx = 0;
    for (let p = 0; p < world.n; p++) {
      const vx = vel[p * 3], vy = vel[p * 3 + 1], vz = vel[p * 3 + 2];
      if (!Number.isFinite(vx + vy + vz)) { nan++; continue; }
      const sp = Math.hypot(vx, vy, vz);
      if (sp > vmaxSeen) vmaxSeen = sp;
      ke += 0.5 * sp * sp;
      meanX += pos[p * 3]; meanVx += vx;
    }
    console.log(
      `step ${String(step).padStart(3)} ke=${(ke / world.n).toFixed(1)} vmax=${vmaxSeen.toFixed(1)} ` +
      `meanX=${(meanX / world.n).toFixed(1)} meanVx=${(meanVx / world.n).toFixed(2)} ` +
      `nan=${nan} transits=${world.transits} nonFinite=${world.nonFinite}`,
    );
  }
}
console.log(`120 steps in ${((performance.now() - t) / 1000).toFixed(1)}s`);
