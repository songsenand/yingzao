// Acceptance for the fit/envelope fields THROUGH the tool, not only the engine.
//
// Why: accept-motion-joint-pairs proves the worker + TS oracle understand
// `overlapEnvelope`/`fit`, but it calls `runMotion()` directly. The 2026-11-24 bug was
// one level above: `simulate_motion`'s parameter schema did not list the fields, so a
// real call could never reach that code. This test calls the registered tool exactly
// like the model does, with a deliberately overlapping hinge:
//
//   1. no envelope -> the overlap is a clash, and the event says WHERE (overlapBboxMm)
//   2. capsule + fit -> the same overlap is a listed fit, resolved, and the run can pass
//
//   node --experimental-strip-types scripts/accept-motion-fit-tool.mjs

import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The engine is the profile's Python worker; the runtime normally lives at
// $DSH_HOME/cad/runtime. A workspace checkout may carry its own copy (the read-only
// sandbox cannot write the profile's tmp), so prefer that copy only when it exists;
// otherwise leave the default alone and let the profile's runtime serve the test.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const localRuntime = join(REPO, '.tmp-measure-runtime');
if (!process.env.DSH_CAD_PYTHON_ROOT?.trim() && existsSync(join(localRuntime, 'venv'))) {
  process.env.DSH_CAD_PYTHON_ROOT = localRuntime;
}

const workspace = await mkdtemp(join(tmpdir(), 'cad-fit-tool-'));
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
  if (!def) throw new Error(`tool ${name} is not registered`);
  return def.execute(args, exec);
};

let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) fail++;
};

const base = 'cube([20,20,20], center=true);';
const block = 'cube([10,10,10], center=true);';
const scenario = (joint) => ({
  cycles: 0.02,
  scanJointPairs: true,
  parts: [
    { name: 'base', bodyType: 'kinematic', position: [0, 0, 0], scadCode: base },
    { name: 'block', bodyType: 'dynamic', position: [0, 0, 0], scadCode: block },
  ],
  joints: [{ type: 'revolute', bodyA: 'base', bodyB: 'block', anchorWorld: [0, 0, 0], axisWorld: [0, 1, 0], ...joint }],
  drive: { body: 'base', axis: [0, 1, 0], omegaRadPerSec: 1 },
});

// The fixture overlaps by ~1000mm³ at t=0 (a 10mm block inside a 20mm cube), on the
// hinge axis. Without a declared capsule that is a clash, and the clash must say where.
{
  const r = await call('simulate_motion', scenario({}));
  check('1  a plain hinged overlap is a clash', (r.interferenceCount ?? 0) > 0, `${r.interferenceCount}`);
  const ev = r.interferenceEvents?.[0];
  check('2  the clash carries overlapBboxMm (6 numbers)', Array.isArray(ev?.overlapBboxMm) && ev.overlapBboxMm.length === 6,
    JSON.stringify(ev?.overlapBboxMm));
  check('3  the bbox bounds the overlap (min <= max)', Boolean(ev?.overlapBboxMm)
    && ev.overlapBboxMm[0] <= ev.overlapBboxMm[3]
    && ev.overlapBboxMm[1] <= ev.overlapBboxMm[4]
    && ev.overlapBboxMm[2] <= ev.overlapBboxMm[5], JSON.stringify(ev?.overlapBboxMm));
  check('4  the pair is marked as a joint pair', ev?.jointPair === true, String(ev?.jointPair));
}

// The SAME geometry with a declared capsule + fit: the overlap is a fit, not a clash.
{
  const r = await call('simulate_motion', scenario({
    overlapEnvelope: { radiusMm: 30, halfLengthMm: 10 },
    fit: 'bearing',
  }));
  check('5  a capsule + fit through the tool is accepted', Boolean(r) && r.jointFitsUnresolved === 0,
    JSON.stringify({ unresolved: r?.jointFitsUnresolved, status: r?.overallStatus }));
  check('6  the in-envelope overlap is listed as resolved', r?.jointExemptions?.[0]?.resolved === true,
    JSON.stringify(r?.jointExemptions?.[0]));
  check('7  the fit is recorded with its declared kind', r?.jointExemptions?.[0]?.fit === 'bearing',
    String(r?.jointExemptions?.[0]?.fit));
  check('8  the run can pass when nothing is outside the capsule', r?.overallStatus === 'pass',
    `${r?.overallStatus} (interference ${r?.interferenceCount})`);
}

// A fit capsule is a revolute concept (the capsule runs along the hinge axis).
// Declaring one on a slide must be refused, not silently ignored.
{
  let refused = null;
  try {
    await call('simulate_motion', scenario({
      type: 'prismatic',
      overlapEnvelope: { radiusMm: 30 },
      fit: 'bearing',
    }));
  } catch (e) {
    refused = String(e?.message ?? e);
  }
  check('9  a prismatic joint cannot carry a fit capsule', Boolean(refused && /revolute/i.test(refused)),
    refused?.slice(0, 160) ?? 'NOT refused');
}

console.log(fail ? `\nFAILED (${fail})` : '\nOK');
process.exit(fail ? 1 : 0);
