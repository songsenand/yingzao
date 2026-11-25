// Acceptance for the TOOL PARAMETER SURFACE, not the engine (2026-11-24).
//
// Why: the joint envelope/fit feature was implemented in the worker and in the TS
// oracle, documented in TOOL-CONTRACTS and covered by accept-motion-joint-pairs — but
// `simulate_motion`'s parameter schema never listed `overlapEnvelope`/`fit`, and the
// joint item is `additionalProperties: false`, so every real call was rejected. Every
// acceptance passed because they call `runMotion()` directly, i.e. BELOW the surface.
// The same drift hid `check_printability`'s `printOrientationDeg` (the job accepts it,
// `check_parts` exposes it, the single-part schema does not).
//
// This test drives the catalog exactly the way the model does: capture the registered
// definitions, then assert the nested schema a caller can see. It also executes
// set_project_kernel for real, because its "not a lossless JSON object" reply was a
// surface bug (a nested `undefined` key), not an engine one.
//
//   node --experimental-strip-types scripts/accept-tool-params.mjs

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

/**
 * The harness's lossless-JSON rule (dsh-typert-protocol `isRemoteJsonValue`):
 * null/string/boolean/finite non--0 number, plain arrays/objects, NO nested
 * undefined. A reply that fails it never reaches the model.
 */
function isLossless(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) return false;
      for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i) || !isLossless(value[i], seen)) return false;
      return true;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return false;
      if (Object.getOwnPropertyDescriptor(value, key)?.enumerable !== true) return false;
      if (!isLossless(value[key], seen)) return false;
    }
    return true;
  } finally {
    seen.delete(value);
  }
}

// ── capture the catalog the same way audit-tool-contracts.mjs does ──────────
const captured = [];
const noop = () => {};
const stub = new Proxy(function () {}, {
  get(_t, k) {
    if (k === 'then') return undefined;
    if (k === 'tools') return { register: (d) => { captured.push(d); return { dispose: noop }; } };
    if (k === 'logger' || k === 'log') return { info: noop, warn: noop, error: noop, debug: noop };
    return stub;
  },
  apply() { return stub; },
});
const { registerCadTools } = await import('../src/host/tools.ts');
try { registerCadTools(stub); } catch (e) {
  console.log('registration threw (partial capture):', String(e?.message ?? e).slice(0, 160));
}
const tools = new Map(captured.filter((d) => d && typeof d.name === 'string').map((d) => [d.name, d]));
check(tools.size >= 25, 'the catalog was captured', `${tools.size} tool(s)`);

// ── simulate_motion: the joint fit contract must be visible ────────────────
const motion = tools.get('simulate_motion');
check(Boolean(motion), 'simulate_motion is registered');
const jointItem = motion?.parameters?.properties?.joints?.items;
const jointProps = jointItem?.properties ?? {};
check(jointItem?.additionalProperties === false, 'the joint item is strict (additionalProperties:false)');
check(Boolean(jointProps.overlapEnvelope), 'a joint can declare overlapEnvelope (the fit capsule)');
check(Boolean(jointProps.fit), 'a joint can declare fit (bearing/press-fit/clamp/clearance)');
check(JSON.stringify(jointProps.fit?.enum) === JSON.stringify(['bearing', 'press-fit', 'clamp', 'clearance']),
  'fit carries the four declared values', JSON.stringify(jointProps.fit?.enum));
check(jointProps.overlapEnvelope?.properties?.radiusMm?.required === true
  || (jointProps.overlapEnvelope?.required ?? []).includes('radiusMm'),
  'overlapEnvelope.radiusMm is required inside the capsule object');
check(jointProps.overlapEnvelope?.additionalProperties === false,
  'the capsule object is strict too');

// ── check_printability: the print frame must be declarable ─────────────────
const cp = tools.get('check_printability');
check(Boolean(cp), 'check_printability is registered');
const cpParams = cp?.parameters?.properties ?? {};
check(Boolean(cpParams.printOrientationDeg), 'check_printability accepts printOrientationDeg');
check(cpParams.printOrientationDeg?.type === 'array', 'printOrientationDeg is an array');
check(/\[rx,ry,rz\]/.test(String(cpParams.printOrientationDeg?.description ?? '')),
  'printOrientationDeg says what the three numbers are');

// ── set_project_kernel: the reply must survive the lossless-JSON gate ──────
const kernel = tools.get('set_project_kernel');
check(Boolean(kernel), 'set_project_kernel is registered');
const root = await mkdtemp(join(tmpdir(), 'cad-surface-'));
await mkdir(join(root, 'cad-data'), { recursive: true });
await writeFile(join(root, 'cad-data', 'project.json'), JSON.stringify({
  schemaVersion: 1, key: 'surface-test', title: 'surface test',
}, null, 2));
const exec = { agent: { session: { header: { id: `surface-${process.pid}-${Date.now()}`, cwd: root } } } };

let first;
try {
  first = await kernel.execute({ kernel: 'cadquery' }, exec);
} catch (e) {
  check(false, 'the first kernel switch returns a value (it used to fail validation)', String(e?.message ?? e));
}
if (first) {
  check(isLossless(first), 'the first reply is lossless JSON (no nested undefined)');
  check(!Object.hasOwn(first, 'previous') && first.kernel === 'cadquery',
    'the first switch has no previous, and does not invent one', JSON.stringify(first));
}
let second;
try {
  second = await kernel.execute({ kernel: 'openscad' }, exec);
} catch (e) {
  check(false, 'the second kernel switch returns a value', String(e?.message ?? e));
}
if (second) {
  check(isLossless(second), 'the second reply is lossless JSON');
  check(second.previous === 'cadquery' && second.kernel === 'openscad',
    'the second switch reports the real previous kernel', JSON.stringify(second));
}

console.log(failures === 0 ? '\nOK' : `\nFAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
