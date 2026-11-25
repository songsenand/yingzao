// Acceptance for generate_part dryRun / preflight.
//
// The CadQuery sewing session created 123 versions for 27 parts; 94 were
// parentVersion iterations, and several were known-bad (open surface, two
// bodies) only after the version and its images existed. dryRun compiles and
// checks without writing; preflight refuses to save unless the mesh is
// watertight and one connected body. A thin wall is reported, not blocked.
//
//   node --experimental-strip-types scripts/accept-generate-preflight.mjs

import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { registerCadTools } = await import('../src/host/tools.ts');
const captured = [];
const noop = () => {};
const ctx = {
  tools: { register: (def) => { captured.push(def); return { dispose: noop }; } },
  attachments: { saveImages: async (items) => items.map((it) => ({ kind: 'stub', name: it.name })) },
  reflect: { get: () => undefined }, on: noop,
  logger: { info: noop, warn: noop, error: noop, debug: noop },
};
registerCadTools(ctx);
const tools = new Map(captured.map((d) => [d.name, d]));

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const root = await mkdtemp(join(tmpdir(), 'cad-preflight-'));
const exec = { agent: { session: { header: { id: `preflight-${process.pid}-${Date.now()}`, cwd: root } } } };
const call = async (name, args) => {
  const def = tools.get(name);
  if (!def) throw new Error(`${name} not registered`);
  return def.execute(args, exec);
};
const versions = async () => (await readdir(join(root, 'cad-data', 'versions')).catch(() => [])).length;
await call('init_project', { dir: root });

// 1. dryRun: compile + measure, create nothing.
const dry = await call('generate_part', {
  scadCode: 'cube([10,10,10], center=true);',
  userIntent: 'preflight dry cube', dryRun: true, views: ['iso'],
});
check(dry.saved === false, 'dryRun does not save', String(dry.saved));
check(dry.versionId === undefined, 'dryRun has no versionId', String(dry.versionId));
check(dry.watertight === true, 'dryRun reports watertight', String(dry.watertight));
check(dry.preflight?.bodies === 1, 'dryRun reports one body', String(dry.preflight?.bodies));
check(typeof dry.minWallMm === 'number', 'dryRun reports min wall', String(dry.minWallMm));
check((await versions()) === 0, 'dryRun wrote zero versions', String(await versions()));

// 2. preflight refuses a multi-body mesh (no version, no part row).
const bad = await call('generate_part', {
  scadCode: 'cube([5,5,5]); translate([20,0,0]) cube([5,5,5]);',
  userIntent: 'preflight two cubes', preflight: true, views: ['iso'],
});
check(bad.saved === false, 'preflight refuses to save a multi-body mesh', String(bad.saved));
check(bad.success === false, 'the refusal is not success', String(bad.success));
check(bad.versionId === undefined, 'the refusal has no versionId', String(bad.versionId));
check(bad.preflight?.bodies === 2, 'the refusal reports 2 bodies', String(bad.preflight?.bodies));
check(bad.preflight?.ok === false, 'the preflight report is not ok', String(bad.preflight?.ok));
check((await versions()) === 0, 'the refusal wrote zero versions', String(await versions()));

// 3. preflight saves a valid single-body mesh.
const good = await call('generate_part', {
  scadCode: 'cube([10,10,10], center=true);',
  userIntent: 'preflight good cube', preflight: true, views: ['iso'],
});
check(good.saved === true, 'preflight saves a valid mesh', String(good.saved));
check(typeof good.versionId === 'string' && good.versionId.startsWith('v'), 'preflight returns a versionId', String(good.versionId));
check(good.preflight?.ok === true, 'the saved preflight is ok', String(good.preflight?.ok));
check((await versions()) === 1, 'the pass wrote exactly one version', String(await versions()));

// 4. a thin wall is a warning, not a refusal (legitimate ears must not block).
const thin = await call('generate_part', {
  scadCode: 'cube([20,20,0.8], center=true);',
  userIntent: 'preflight thin plate', dryRun: true, views: ['iso'],
});
check(thin.saved === false, 'thin dryRun does not save', String(thin.saved));
check(thin.preflight?.ok === true, 'a thin wall does not fail preflight', String(thin.preflight?.ok));
check(typeof thin.minWallMm === 'number' && thin.minWallMm < 1.2, 'the thin wall is measured', String(thin.minWallMm));
check(thin.warnings.some((w) => /1\.2mm|thinnest/.test(w)), 'the thin wall is warned about', thin.warnings.join(' | ').slice(0, 160));

// 5. Normal generation is unchanged: it still saves and returns a version.
const normal = await call('generate_part', {
  scadCode: 'cube([8,8,8], center=true);',
  userIntent: 'normal cube', views: ['iso'],
});
check(normal.saved === true, 'normal generate still saves', String(normal.saved));
check(typeof normal.versionId === 'string' && normal.versionId.startsWith('v'), 'normal generate returns a versionId', String(normal.versionId));
check((await versions()) === 2, 'normal generate wrote one more version', String(await versions()));

console.log(failures === 0 ? '\nOK' : `\nFAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
