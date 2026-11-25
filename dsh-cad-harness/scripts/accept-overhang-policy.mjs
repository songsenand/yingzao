// Overhang is a support COST, not a feasibility failure. A declared FDM profile
// (overhangDeg.hard=false) must not turn a sphere into a non-pass; a profile that
// explicitly says supports are unacceptable (hard=true) must still gate.
//
//   node --experimental-strip-types scripts/accept-overhang-policy.mjs

import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const localRuntime = join(REPO, '.tmp-measure-runtime');
if (!process.env.DSH_CAD_PYTHON_ROOT?.trim() && existsSync(join(localRuntime, 'venv'))) {
  process.env.DSH_CAD_PYTHON_ROOT = localRuntime;
}

const captured = [];
const noop = () => {};
const ctx = {
  tools: { register: (def) => { captured.push(def); return { dispose: noop }; } },
  attachments: { saveImages: async (items) => items.map((it) => ({ kind: 'stub', name: it.name })) },
  reflect: { get: () => undefined }, on: noop,
  logger: { info: noop, warn: noop, error: noop, debug: noop },
};
const { registerCadTools } = await import('../src/host/tools.ts');
registerCadTools(ctx);
const tools = new Map(captured.map((d) => [d.name, d]));

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const root = await mkdtemp(join(tmpdir(), 'cad-overhang-'));
const exec = { agent: { session: { header: { id: `overhang-${process.pid}-${Date.now()}`, cwd: root } } } };
const call = async (name, args) => {
  const def = tools.get(name);
  if (!def) throw new Error(`${name} not registered`);
  return def.execute(args, exec);
};
await call('init_project', { dir: root });
const made = await call('generate_part', {
  scadCode: 'sphere(r=14, $fn=64);',
  userIntent: 'overhang policy sphere', views: ['iso'],
});
check(made.saved === true, 'the sphere version exists', String(made.versionId));

const advisory = await call('check_printability', { versionId: made.versionId, profileIds: ['fdm-pla-0.4'] });
check((advisory.overhangAreaMm2 ?? 0) > 20, 'the sphere has a large overhang', String(advisory.overhangAreaMm2));
check(advisory.verdict === 'not-excluded', 'a declared FDM profile treats overhang as advisory', advisory.verdict);
check(advisory.findings.some((f) => /悬垂/.test(f)), 'the overhang is still reported as a finding', advisory.findings.join(' | ').slice(0, 160));

const hardProfile = {
  schemaVersion: 1,
  id: 'fdm-no-support',
  process: 'FDM',
  rules: {
    wallMinMm: { applies: true, decidable: 'geometry', value: 1.2, direction: 'min', source: { kind: 'assumed' } },
    overhangDeg: { applies: true, decidable: 'geometry', value: 45, direction: 'max', hard: true, source: { kind: 'assumed' } },
  },
};
const hard = await call('check_printability', {
  versionId: made.versionId,
  profilesJson: JSON.stringify([hardProfile]),
});
check(hard.verdict === 'difficult', 'a profile with overhangDeg.hard=true still gates', hard.verdict);
check(hard.findings.some((f) => /硬约束/.test(f)), 'the gate names the hard profile', hard.findings.join(' | ').slice(0, 200));

console.log(failures === 0 ? '\nOK' : `\nFAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
