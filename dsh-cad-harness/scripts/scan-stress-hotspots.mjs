#!/usr/bin/env node
// Gravity hot-spot scan through the real tool object.
//
//   node scripts/scan-stress-hotspots.mjs <project-dir> <versionId> \
//     [--support x,y,z[,r]]... [--face x:min]... [--ground] \
//     [--exclude x,y,z[,r]]... [--direction gx,gy,gz]... [--dx 1.2] [--cluster 4] [--max 12]
//
// This is the manual companion to `cad_simulate action="hotspots"`: it prints the
// clustered peaks and the per-direction cases as JSON, and writes NO run — the
// scan is a pointer, not delivery evidence.

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [projectArg, versionId, ...rest] = process.argv.slice(2);
if (!projectArg || !versionId) {
  console.error('usage: scan-stress-hotspots.mjs <project-dir> <versionId> [--support x,y,z[,r]] [--face x:min] [--ground] [--dx 1.2] [--cluster 4] [--max 12]');
  process.exit(3);
}

const num3 = (text, label) => {
  const parts = text.split(',').map((v) => Number(v));
  if (parts.length < 3 || parts.some((v) => !Number.isFinite(v))) {
    console.error(`bad ${label} "${text}" (want x,y,z[,radiusMm])`);
    process.exit(3);
  }
  return parts;
};

const supports = [];
const excludes = [];
const directions = [];
let dxMm;
let clusterRadiusMm;
let maxHotspots;
for (let i = 0; i < rest.length; i++) {
  const arg = rest[i];
  const next = () => rest[++i] ?? '';
  if (arg === '--support') {
    const p = num3(next(), '--support');
    supports.push({ atMm: p.slice(0, 3), ...(p.length > 3 ? { radiusMm: p[3] } : {}) });
  } else if (arg === '--face') {
    const [axis, side = 'min'] = next().split(':');
    if (!['x', 'y', 'z'].includes(axis)) { console.error(`bad --face "${axis}"`); process.exit(3); }
    supports.push({ face: { axis, side } });
  } else if (arg === '--ground') {
    supports.push({ ground: true });
  } else if (arg === '--direction') {
    const p = num3(next(), '--direction');
    directions.push(p.slice(0, 3));
  } else if (arg === '--exclude') {
    const p = num3(next(), '--exclude');
    excludes.push({ atMm: p.slice(0, 3), ...(p.length > 3 ? { radiusMm: p[3] } : {}) });
  } else if (arg === '--dx') {
    dxMm = Number(next());
  } else if (arg === '--cluster') {
    clusterRadiusMm = Number(next());
  } else if (arg === '--max') {
    maxHotspots = Number(next());
  } else {
    console.error(`unknown argument "${arg}"`);
    process.exit(3);
  }
}

const project = resolve(projectArg);
process.env.DSH_HOME ??= await mkdtemp(join(tmpdir(), 'scan-hotspots-home-'));

const { registerCadTools } = await import('../src/host/tools.ts');
const tools = new Map();
registerCadTools({
  tools: { register: (def) => { tools.set(def.name, def); } },
  attachments: { saveImages: async (items) => items.map((it) => ({ kind: 'stub', name: it.name })) },
  reflect: { get: () => undefined },
  on: () => {},
});
const exec = { agent: { session: { header: { cwd: project } } } };

const args = {
  versionId,
  supports,
  ...(directions.length ? { directions } : {}),
  ...(excludes.length ? { excludeFromReport: excludes } : {}),
  ...(dxMm !== undefined ? { dxMm } : {}),
  ...(clusterRadiusMm !== undefined ? { clusterRadiusMm } : {}),
  ...(maxHotspots !== undefined ? { maxHotspots } : {}),
};

const value = await tools.get('scan_stress_hotspots').execute(args, exec);
console.log(JSON.stringify(value, null, 2));
