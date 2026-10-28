// Acceptance: a motion run with NO crank (`drive` omitted) — the shape a guide /
// valve on a prescribed sinusoid actually has.
//
// WHY (2026-10-28): `drive` used to be `required: true`. An oscillator-only run
// therefore had to invent a crank, and fructose-molecule r013 did exactly that:
// a 20mm cube "Base" and a 10mm cube "Crank" parked at (500,500), `joints: []`,
// purely to pass validation. Consequences: the report title claimed a crank the
// mechanism does not have, "干涉 0 次" could never have been anything else (the
// dummies were 500mm away), and the viewport had to frame 500mm of emptiness.
//
// What is pinned here:
//   1. a run with oscillators and no drive is ACCEPTED;
//   2. its time base is the oscillator period, not a silent 1 s;
//   3. it reports driveOmegaRadPerSec: null (the absence is data, not a gap);
//   4. the oscillator body actually travels (a run where nothing moves is not a pass);
//   5. a run with NEITHER a drive NOR an oscillator is refused, with both options named.
//
//   node scripts/accept-motion-nodrive.mjs
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The workspace is hermetic (a temp dir); the PYTHON RUNTIME is not — it lives in
// the profile's $DSH_HOME/cad/runtime and provisioning it per test would cost
// hundreds of MB. (Same reason accept-motion-pivot sets DSH_HOME only for the
// corpus, not for the engine.)
const workspace = await mkdtemp(join(tmpdir(), 'cad-nodrive-work-'));

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

const body = 'cube([20,20,20], center=true);';
const guide = 'translate([0,0,40]) cube([6,6,20], center=true);';

// ---------- 1-4: oscillator only, no crank ----------
const r = await call('simulate_motion', {
  cycles: 2,
  // One fixed body and one prescribed mover — nothing is "driven" by a crank.
  parts: [
    { name: 'base', bodyType: 'fixed', position: [0, 0, 0], scadCode: body },
    { name: 'guide', bodyType: 'kinematic', position: [0, 0, 40], scadCode: guide },
  ],
  joints: [],
  oscillators: [{ body: 'guide', axis: [0, 0, 1], periodSec: 0.5, amplitudeMm: 4 }],
});

check('1  a motion run without a drive is accepted', Boolean(r) && r.overallStatus !== undefined,
  String(r?.overallStatus));
// 2 cycles × 0.5 s period = 1.0 s. The old fallback was 1 s per cycle, i.e. 2.0 s.
check('2  the time base is the OSCILLATOR period (2 × 0.5 s = 1.0 s)',
  Math.abs((r.durationSec ?? -1) - 1.0) < 1e-6, `${r.durationSec}s`);
// The reply says it in one boolean: a prescribed-mover run is not a run whose
// crank was dropped, and the output schema cannot carry a null number.
check('3  the reply states there is no crank (hasCrank === false)',
  r.hasCrank === false, JSON.stringify(r.hasCrank));
check('4  the prescribed mover actually moves (travel > 0)',
  (r.followers?.guide?.travelMm ?? 0) > 1, `${r.followers?.guide?.travelMm}mm`);

// ---------- 5: nothing moves → refused, both options named ----------
let refused = null;
try {
  await call('simulate_motion', {
    cycles: 1,
    parts: [
      { name: 'base', bodyType: 'fixed', position: [0, 0, 0], scadCode: body },
      { name: 'top', bodyType: 'fixed', position: [0, 0, 40], scadCode: guide },
    ],
    joints: [],
  });
} catch (e) {
  refused = String(e?.message ?? e);
}
check('5  a run with neither drive nor oscillator is refused', Boolean(refused), refused?.slice(0, 120) ?? 'NOT refused');
check('5b …and the refusal names BOTH ways to move', Boolean(refused && /drive/.test(refused) && /oscillator/.test(refused)),
  refused?.slice(0, 160) ?? '');

console.log(fail ? `\nFAILED (${fail})` : '\nOK');
process.exit(fail ? 1 : 0);
