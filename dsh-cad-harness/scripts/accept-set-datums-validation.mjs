// Acceptance for the G2 datum direction validation (2026-10-29) — the set_datums half.
//
// The p/dir positional swap is silent in OpenSCAD and landed in datums.json
// unflagged (roberval-balance v048 bottom_axis was point=[0,1,0] dir=[0,0,140];
// four parts needed set_datums repair). The echo-protocol reader side is covered
// by scripts/datum-axis-selftest.py; this covers the explicit-declaration side:
// a zero direction is refused, the swap signature warns in the reply, honest
// input stays clean.
//
// Hermetic, and needs NO Python/OpenSCAD: it stores bytes directly through saveVersion.
//
//   node scripts/accept-set-datums-validation.mjs
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'cad-datum-home-'));
const workspace = await mkdtemp(join(tmpdir(), 'cad-datum-work-'));
process.env.DSH_HOME = home;
await mkdir(join(workspace, 'cad-data'), { recursive: true });

const { registerCadTools } = await import('../src/host/tools.ts');
const { openVersionStore, saveVersion } = await import('../src/host/version.ts');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const tools = new Map();
const ctx = {
  tools: { register: (def) => { tools.set(def.name, def); } },
  attachments: { saveImages: async (items) => items.map((it) => ({ kind: 'stub', name: it.name })) },
  reflect: { get: () => undefined }, on: () => {},
};
registerCadTools(ctx);
const exec = { agent: { session: { header: { cwd: workspace } } } };
const call = async (name, args) => {
  const def = tools.get(name);
  if (!def) throw new Error(`tool ${name} not registered`);
  return { value: await def.execute(args, exec) };
};

const store = openVersionStore(join(workspace, 'cad-data'));
const STL = new Uint8Array([0x53, 0x54, 0x4c, 0x20, 0x62, 0x79, 0x74, 0x65, 0x73, 0x21]);
const v1 = await saveVersion(store, {
  stl: STL, userIntent: 'datum validation body', partId: 'p001',
  datumSet: { points: [], axes: [], planes: [], cylinders: [] },
});

// 1. zero direction is refused at declaration time
let threw = null;
try {
  await call('set_datums', {
    versionId: v1,
    datums: [{ name: 'rail', kind: 'axis', point: [10, 0, 205], dir: [0, 0, 0] }],
  });
} catch (e) { threw = e; }
check(threw !== null && String(threw.message).includes('[0, 0, 0]'), 'zero dir axis is refused', threw?.message);
check(
  threw !== null && String(threw.message).includes('never be an assembly endpoint'),
  'the refusal says WHY (no direction, no endpoint)',
);

let threwPlane = null;
try {
  await call('set_datums', {
    versionId: v1,
    datums: [{ name: 'face', kind: 'plane', point: [0, -10, 45], normal: [0, 0, 0] }],
  });
} catch (e) { threwPlane = e; }
check(threwPlane !== null && String(threwPlane.message).includes('[0, 0, 0]'), 'zero plane normal is refused too');

// 2. the swap signature warns in the reply (and still records — repair must stay possible)
const swapped = await call('set_datums', {
  versionId: v1,
  datums: [{ name: 'bottom_axis', kind: 'axis', point: [0, 1, 0], dir: [0, 0, 140] }],
});
check(
  swapped.value.warnings.some((w) => w.includes('swapped p/dir')),
  'the v048 signature (point=[0,1,0] dir=[0,0,140]) warns in the reply',
  swapped.value.warnings.join(' | '),
);
check(
  swapped.value.mode === 'versioned',
  'the swapped anchor is still recorded (repair stays possible; warning, not refusal)',
);

// 3. honest input stays clean
const honest = await call('set_datums', {
  versionId: v1,
  datums: [
    { name: 'pivot', kind: 'point', point: [10, 0, 205] },
    { name: 'axis_a', kind: 'axis', point: [10, 0, 205], dir: [0, 1, 0] },
  ],
});
check(
  !honest.value.warnings.some((w) => w.includes('swapped')),
  'honest input (unit dir at a real coordinate) does not warn',
  honest.value.warnings.join(' | '),
);

await rm(home, { recursive: true, force: true });
await rm(workspace, { recursive: true, force: true });
console.log(failures === 0 ? 'OK' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
