#!/usr/bin/env node
// Acceptance for scan_stress_hotspots (2026-11-26).
//
// The invariant this protects: the scan is DETECTION, not a verdict. The output
// schema must have no verdict/delivery field, and the clustering must count
// persistence across DISTINCT directions, not peaks. The FEM itself is covered by
// accept-stress.mjs; this test stays hermetic and fast.

import { CAD_TOOL_GROUPS } from '../src/host/tool-groups.ts';
import { clusterStressPeaks, defaultGravityDirections } from '../src/host/stress-hotspots.ts';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

// ── 1. the basis ────────────────────────────────────────────────────────────
const dirs = defaultGravityDirections();
check(dirs.length === 6, 'six signs: +x/-x/+y/-y/+z/-z', String(dirs.length));
check(new Set(dirs.map((d) => d.label)).size === 6, 'labels are distinct');
check(dirs.every((d) => Math.abs(Math.hypot(...d.gravityMmPerS2) - 9810) < 1e-6), 'each direction is 1g (9810 mm/s^2)');

// ── 2. persistence counts directions, not peaks ─────────────────────────────
const peaks = [
  { atMm: [0, 0, 0], value: 3, direction: '+x' },
  { atMm: [0.4, 0, 0], value: 5, direction: '+x' }, // same direction: must NOT raise persistence
  { atMm: [0.2, 0, 0], value: 2, direction: '+y' },
  { atMm: [0, 0.3, 0], value: 1, direction: '-z' },
  { atMm: [20, 0, 0], value: 4, direction: '+x' },
];
const clusters = clusterStressPeaks(peaks, 2, 12);
check(clusters.length === 2, 'two spatial clusters', String(clusters.length));
check(clusters[0].persistence === 3, 'largest cluster persists in 3 DISTINCT directions', String(clusters[0].persistence));
check(clusters[0].atMm[0] === 0.4, 'cluster location is its strongest sampled peak', JSON.stringify(clusters[0].atMm));
check(clusters[0].maxPeakMPa === 5, 'cluster keeps its maximum peak value', String(clusters[0].maxPeakMPa));
check(clusters[0].peakCount === 4, 'cluster counts all peaks, including repeated directions', String(clusters[0].peakCount));
check(clusters[1].persistence === 1, 'the lone cluster persists in 1 direction', String(clusters[1].persistence));

// ── 3. radius is the cluster boundary ──────────────────────────────────────
const pair = [
  { atMm: [0, 0, 0], value: 1, direction: '+x' },
  { atMm: [4, 0, 0], value: 2, direction: '+y' },
];
check(clusterStressPeaks(pair, 3).length === 2, '4 mm apart with r=3 is two clusters');
check(clusterStressPeaks(pair, 5).length === 1, '4 mm apart with r=5 is one cluster');
check(clusterStressPeaks([], 3).length === 0, 'no peaks means no clusters');

const capped = clusterStressPeaks(
  Array.from({ length: 30 }, (_, i) => ({ atMm: [i * 10, 0, 0], value: 30 - i, direction: '+x' })),
  1,
  5,
);
check(capped.length === 5, 'maxHotspots caps the list', String(capped.length));

// ── 4. the tool is registered and has no verdict/delivery ───────────────────
const tools = new Map();
const { registerCadTools } = await import('../src/host/tools.ts');
registerCadTools({
  tools: { register: (def) => { tools.set(def.name, def); } },
  attachments: { saveImages: async (items) => items.map((it) => ({ kind: 'stub', name: it.name })) },
  reflect: { get: () => undefined },
  on: () => {},
});
const def = tools.get('scan_stress_hotspots');
check(!!def, 'scan_stress_hotspots is registered');
const props = def?.output?.schema?.properties ?? {};
check(!('verdict' in props), 'output schema has NO verdict field');
check(!('delivery' in props), 'output schema has NO delivery field');
check(Array.isArray(props.hotspots) || props.hotspots?.type === 'array', 'output schema declares hotspots[]');
check(CAD_TOOL_GROUPS.detect.includes('scan_stress_hotspots'), 'the tool is in the detect group');

console.log(failures === 0 ? '\nscan_stress_hotspots acceptance: PASS' : `\nscan_stress_hotspots acceptance: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
