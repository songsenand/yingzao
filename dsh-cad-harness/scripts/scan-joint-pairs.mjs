// Independent JOINT-PAIR clearance scan over a stored motion run.
//
// Why this exists: `simulate_motion` deliberately removes every revolute-linked
// pair from its interference timeline (pin/bearing overlap is expected), so its
// "0 interference" is a statement about the OTHER pairs only. A joint pair can
// therefore pass a whole motion run while its bodies cut through each other away
// from the pin. The sewing rotary-hook r024 did exactly that: arbor↔rod reached
// 75.87 mm³ while the run reported 0 events.
//
// This scan puts those pairs back and applies the SAME declared-capsule rule as
// the engine: each joint's `overlapEnvelope {radiusMm, halfLengthMm}` is the only
// forgiven zone; overlap outside it is a clash. It also lists in-envelope overlap
// and whether the joint declares `fit` — an in-envelope overlap with no fit is
// `unresolved`, exactly what keeps the engine run at `check`.
//
// It is an EVIDENCE tool, not a gate: a motion-clearance interface still needs a
// run that covers the pair (see readMotionPairCoverage in the assembly checker).
//
//   node scripts/scan-joint-pairs.mjs --run <runDir> [--min-volume 1] [--json]
//
// Exits 1 when any joint pair has out-of-capsule overlap, 0 otherwise, 2 on a
// usage or input error.

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import ManifoldModule from 'manifold-3d';

const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const runDir = argOf('--run', null);
const minVolume = Number(argOf('--min-volume', '1'));
const asJson = args.includes('--json');
if (!runDir || !Number.isFinite(minVolume) || minVolume < 0) {
  console.error('usage: node scripts/scan-joint-pairs.mjs --run <runDir> [--min-volume 1] [--json]');
  process.exit(2);
}
const dir = resolve(runDir);

function parseStl(buffer) {
  const triangles = buffer.readUInt32LE(80);
  const vertProperties = new Float32Array(triangles * 9);
  const triVerts = new Uint32Array(triangles * 3);
  let offset = 84;
  for (let i = 0; i < triangles; i++) {
    offset += 12;
    for (let k = 0; k < 9; k++) {
      vertProperties[i * 9 + k] = buffer.readFloatLE(offset);
      offset += 4;
    }
    offset += 2;
    triVerts[i * 3] = i * 3;
    triVerts[i * 3 + 1] = i * 3 + 1;
    triVerts[i * 3 + 2] = i * 3 + 2;
  }
  return { vertProperties, triVerts };
}

const quatMatrix = (q) => {
  const [x, y, z, w] = q;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ];
};
const apply = (m, p, t) => [
  m[0][0] * p[0] + m[0][1] * p[1] + m[0][2] * p[2] + t[0],
  m[1][0] * p[0] + m[1][1] * p[1] + m[1][2] * p[2] + t[1],
  m[2][0] * p[0] + m[2][1] * p[1] + m[2][2] * p[2] + t[2],
];

const [spec, trajectory] = await Promise.all([
  readFile(join(dir, 'motion-spec.json'), 'utf8').then(JSON.parse).catch(() => null),
  readFile(join(dir, 'trajectory.json'), 'utf8').then(JSON.parse),
]);
if (!spec) {
  console.error(`${dir}/motion-spec.json is missing — cannot know which pairs were revolute-linked.`);
  process.exit(2);
}
const jointPairs = [];
const seen = new Set();
for (const j of spec.joints ?? []) {
  if (j.type !== 'revolute') continue;
  const key = [j.bodyA, j.bodyB].sort().join('\u0000');
  if (seen.has(key)) continue;
  seen.add(key);
  const env = j.overlapEnvelope;
  const rawAxis = j.axisA ?? j.axis ?? [0, 1, 0];
  const len = Math.hypot(...rawAxis) || 1;
  jointPairs.push({
    a: j.bodyA, b: j.bodyB, anchorA: j.anchorA,
    axisA: rawAxis.map((v) => v / len),
    envelope: env ? { radiusMm: env.radiusMm, halfLengthMm: env.halfLengthMm ?? 0 } : null,
    fit: j.fit ?? null,
  });
}
if (jointPairs.length === 0) {
  console.log('no revolute pairs — nothing to scan');
  process.exit(0);
}

const mod = await ManifoldModule();
mod.setup();
const capsuleAt = (radius, halfLength, center, axis) => {
  const sph = () => mod.Manifold.sphere(radius, 32);
  let solid;
  if (halfLength <= 1e-9) {
    solid = sph();
  } else {
    solid = mod.Manifold.cylinder(halfLength * 2, radius, radius, 32, true)
      .add(sph().translate([0, 0, halfLength]))
      .add(sph().translate([0, 0, -halfLength]));
  }
  const w = axis;
  const helper = Math.abs(w[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const norm = (u) => { const l = Math.hypot(...u) || 1; return u.map((x) => x / l); };
  const v = norm(cross(w, helper));
  const b = cross(w, v);
  const m = [b[0], b[1], b[2], 0, v[0], v[1], v[2], 0, w[0], w[1], w[2], 0, center[0], center[1], center[2], 1];
  return solid.transform(m);
};

const frames = trajectory.trajectory ?? trajectory;
const times = frames.times;
const poses = new Map(frames.parts.map((p) => [p.name, p.frames]));
const meshes = new Map();
for (const part of spec.parts ?? []) {
  const buffer = await readFile(join(dir, 'parts', `${part.name}.stl`));
  const { vertProperties, triVerts } = parseStl(buffer);
  const mesh = new mod.Mesh({ numProp: 3, vertProperties, triVerts });
  mesh.merge();
  meshes.set(part.name, mesh);
}

const events = [];
for (const pair of jointPairs) {
  const meshA = meshes.get(pair.a);
  const meshB = meshes.get(pair.b);
  if (!meshA || !meshB) {
    console.error(`missing STL for ${pair.a} or ${pair.b}`);
    process.exit(2);
  }
  pair.max = 0;
  pair.frames = 0;
  pair.firstTime = null;
  pair.maxTime = null;
  pair.exemptFrames = 0;
  pair.maxExempt = 0;
  pair.maxRadial = 0;
  pair.maxAxial = 0;
  for (let k = 0; k < times.length; k++) {
    const fa = poses.get(pair.a)[k];
    const fb = poses.get(pair.b)[k];
    const ma = quatMatrix(fa.slice(3, 7));
    const mb = quatMatrix(fb.slice(3, 7));
    const ta = fa.slice(0, 3);
    const tb = fb.slice(0, 3);
    const place = (mesh, m, t) => {
      const src = mesh.vertProperties;
      const out = new Float32Array(src.length);
      for (let i = 0; i < src.length; i += 3) {
        const w = apply(m, [src[i], src[i + 1], src[i + 2]], t);
        out[i] = w[0]; out[i + 1] = w[1]; out[i + 2] = w[2];
      }
      const placed = new mod.Mesh({ numProp: 3, vertProperties: out, triVerts: mesh.triVerts });
      placed.merge();
      return new mod.Manifold(placed);
    };
    const solidA = place(meshA, ma, ta);
    const solidB = place(meshB, mb, tb);
    const inter = solidA.intersect(solidB);
    if (inter.isEmpty()) continue;
    const anchor = apply(ma, pair.anchorA, ta);
    const u = apply(ma, pair.axisA, [0, 0, 0]);
    const ul = Math.hypot(...u) || 1;
    u[0] /= ul; u[1] /= ul; u[2] /= ul;
    let outside = inter;
    if (pair.envelope) {
      const capsule = capsuleAt(pair.envelope.radiusMm, pair.envelope.halfLengthMm, anchor, u);
      outside = inter.subtract(capsule);
    }
    const outsideVolume = outside.isEmpty() ? 0 : outside.volume();
    const totalVolume = inter.volume();
    const exemptVolume = Math.max(0, totalVolume - outsideVolume);
    if (exemptVolume > 0.01) {
      pair.exemptFrames++;
      pair.maxExempt = Math.max(pair.maxExempt, exemptVolume);
      for (const x of [inter.boundingBox().min[0], inter.boundingBox().max[0]]) {
        for (const y of [inter.boundingBox().min[1], inter.boundingBox().max[1]]) {
          for (const z of [inter.boundingBox().min[2], inter.boundingBox().max[2]]) {
            const d = [x - anchor[0], y - anchor[1], z - anchor[2]];
            const axial = d[0] * u[0] + d[1] * u[1] + d[2] * u[2];
            pair.maxRadial = Math.max(pair.maxRadial, Math.hypot(d[0] - axial * u[0], d[1] - axial * u[1], d[2] - axial * u[2]));
            pair.maxAxial = Math.max(pair.maxAxial, Math.abs(axial));
          }
        }
      }
    }
    if (outsideVolume <= minVolume) continue;
    pair.frames++;
    if (pair.firstTime === null) pair.firstTime = times[k];
    if (outsideVolume > pair.max) {
      pair.max = outsideVolume;
      pair.maxTime = times[k];
    }
    events.push({
      partA: pair.a, partB: pair.b, timeSec: +times[k].toFixed(4), frame: k,
      volumeMm3: +outsideVolume.toFixed(2),
      bbox: { min: outside.boundingBox().min.map((v) => +v.toFixed(2)), max: outside.boundingBox().max.map((v) => +v.toFixed(2)) },
      anchor: anchor.map((v) => +v.toFixed(2)),
    });
  }
}

const summary = jointPairs.map((p) => {
  const attention = [];
  if (p.exemptFrames > 0 && !p.fit) attention.push('unresolved-fit');
  if (p.exemptFrames > 0 && p.envelope && (p.maxRadial > 0.9 * p.envelope.radiusMm || p.maxAxial > 0.9 * (p.envelope.halfLengthMm + p.envelope.radiusMm))) {
    attention.push('near-boundary');
  }
  return {
    pair: `${p.a}↔${p.b}`,
    overlappingFrames: p.frames,
    totalFrames: times.length,
    firstTimeSec: p.firstTime,
    maxVolumeMm3: +p.max.toFixed(2),
    maxTimeSec: p.maxTime,
    envelope: p.envelope,
    fit: p.fit,
    exemptFrames: p.exemptFrames,
    maxExemptMm3: +p.maxExempt.toFixed(2),
    maxRadialMm: +p.maxRadial.toFixed(2),
    maxAxialMm: +p.maxAxial.toFixed(2),
    attention,
  };
});

if (asJson) {
  console.log(JSON.stringify({ runDir: dir, pairs: summary, events }, null, 2));
} else {
  console.log(`joint-pair scan · ${dir}`);
  console.log('declared capsule per joint; outside it = clash; inside + no fit = unresolved');
  console.log('');
  for (const s of summary) {
    const flag = s.overlappingFrames > 0 ? 'FAIL' : 'ok  ';
    const env = s.envelope ? `R=${s.envelope.radiusMm} L=${s.envelope.halfLengthMm}` : 'no envelope';
    console.log(`${flag} ${s.pair}: ${s.overlappingFrames}/${s.totalFrames} frames OUTSIDE` +
      (s.overlappingFrames > 0 ? ` · max ${s.maxVolumeMm3}mm³ at t=${s.maxTimeSec}s` : '') +
      ` · ${env} · fit=${s.fit ?? 'NONE'}` +
      (s.exemptFrames > 0 ? ` · exempt ${s.exemptFrames} frames max ${s.maxExemptMm3}mm³` : '') +
      (s.attention.length ? `  ⚠ ${s.attention.join('/')}` : ''));
  }
  if (events.length > 0) {
    console.log('');
    console.log('events:');
    for (const e of events) {
      console.log(`  t=${e.timeSec}s ${e.partA}↔${e.partB} ${e.volumeMm3}mm³  bbox x ${e.bbox.min[0]}..${e.bbox.max[0]} y ${e.bbox.min[1]}..${e.bbox.max[1]} z ${e.bbox.min[2]}..${e.bbox.max[2]}`);
    }
  }
}

const failed = summary.some((s) => s.overlappingFrames > 0);
process.exit(failed ? 1 : 0);
