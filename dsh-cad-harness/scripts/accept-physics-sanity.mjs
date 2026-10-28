// Acceptance: the geometry-sanity rule reaches `simulate_physics` too.
//
// WHY: physics fails silently in the same way motion did. A body dropped 500mm
// from everything "settles" (or never lands) and reports a penetration number that
// describes nothing. The criterion is the SAME one (gap ÷ the part's own bbox
// diagonal > 5, and ≤24 triangles = simple box), and it is still a FACT: the
// status must not move because of it.
//
//   node scripts/accept-physics-sanity.mjs
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workspace = await mkdtemp(join(tmpdir(), 'cad-phys-sanity-'));

const { registerCadTools } = await import('../src/host/tools.ts');
const tools = new Map();
const ctx = {
  tools: { register: (def) => { tools.set(def.name, def); } },
  attachments: { saveImages: async (items) => items.map((it) => ({ kind: 'stub', name: it.name })) },
  reflect: { get: () => undefined },
  on: () => {},
};
registerCadTools(ctx);
const exec = { agent: { session: { header: { cwd: workspace } } } };
const call = async (name, args) => {
  const def = tools.get(name);
  if (!def) throw new Error(`tool ${name} not registered`);
  return def.execute(args, exec);
};

let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) fail++;
};

const plate = 'cube([120,120,4], center=true);';
const cube = 'cube([20,20,20], center=true);';

const scene = (cubePos) => ({
  durationSec: 1.2,
  parts: [
    { name: 'plate', bodyType: 'fixed', position: [0, 0, -2], scadCode: plate },
    { name: 'ball', bodyType: 'dynamic', position: cubePos, scadCode: cube },
  ],
  joints: [],
});

// ---------- 1. a body on the plate: quiet ----------
const near = await call('simulate_physics', scene([0, 0, 60]));
check('1  a body above the plate has no 离群 flag',
  (near.geometrySuspects ?? []).every((l) => !/离群/.test(l)),
  (near.geometrySuspects ?? []).join(' | ') || 'none');
check('1b the rule is reported even when empty', /÷/.test(near.geometrySuspectRule ?? ''),
  near.geometrySuspectRule ?? '');

// ---------- 2. the same body dropped 500mm away: reported ----------
const far = await call('simulate_physics', scene([500, 500, 100]));
check('2  a body 500mm from everything is listed, with its numbers',
  (far.geometrySuspects ?? []).some((l) => /ball/.test(l) && /离群/.test(l)),
  (far.geometrySuspects ?? []).join(' | ') || 'none');
check('2b the ratio comes from the part\'s own size (both parts are boxes, both reported as such)',
  (far.geometrySuspects ?? []).every((l) => /自身 [\d.]+mm/.test(l)),
  (far.geometrySuspects ?? []).join(' | ') || 'none');
check('2c it is a WARNING, not a failure', far.overallStatus === 'check', String(far.overallStatus));
check('2d …and the body on the plate is still pass', near.overallStatus === 'pass', String(near.overallStatus));

console.log(fail ? `\nFAILED (${fail})` : '\nOK');
process.exit(fail ? 1 : 0);
