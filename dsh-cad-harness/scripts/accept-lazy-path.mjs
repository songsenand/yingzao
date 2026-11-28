#!/usr/bin/env node
// Acceptance: the lazy path for generate_part (2026-11-28).
//
// One part + no `part` means iterate that part (default parent = its newest
// version). Several parts means refuse and list them; `newPart: true` is the
// explicit long path. The first-version wall screen is additive-only: with no
// declared process it must be skipped, not assumed FDM.
//
//   node scripts/accept-lazy-path.mjs
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'cad-lazy-path-home-'));
const WORK = mkdtempSync(join(tmpdir(), 'cad-lazy-path-work-'));
process.env.DSH_HOME = HOME;
const PROJ = join(WORK, 'project');
mkdirSync(PROJ, { recursive: true });

const { registerCadTools } = await import('../src/host/tools.ts');
const { createProjectMarker, bindSessionToProject, projectStores } = await import('../src/host/project.ts');
const { listVersions } = await import('../src/host/version.ts');

let passed = 0;
let failed = 0;
const check = (ok, label, detail = '') => {
  if (ok) { passed++; console.log(`  PASS ${label}`); }
  else { failed++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

const tools = new Map();
const ctx = {
  tools: { register: (def) => { tools.set(def.name, def); return () => {}; } },
  attachments: { saveImages: async (images) => images },
  reflect: { get: () => undefined }, on: () => {}, effect: (fn) => fn(),
  logger: { debug() {}, info() {}, warn() {}, error() {} },
};
registerCadTools(ctx, { toolScope: 'preset', presets: ['cad'] });
const generate = tools.get('generate_part');
const create = tools.get('create_part');

await createProjectMarker(PROJ, 'lazy path fixture');
const exec = { agent: { session: { header: { id: 'lazy-path', cwd: PROJ } } } };
await bindSessionToProject(exec, PROJ);
const project = projectStores(PROJ);

const make = async (extra = {}) => generate.execute({
  scadCode: 'cube(10);',
  userIntent: 'lazy box',
  views: ['top'],
  ...extra,
}, exec);

console.log('--- first part: created, no FDM screen without a declared process ---');
const g1 = await make();
check(g1.saved === true && typeof g1.versionId === 'string', 'the first generate saves a version', g1.versionId);
check((g1.warnings ?? []).some((w) => /wall screen skipped: process is not declared/.test(String(w))),
  'the additive wall screen is skipped when no process is declared', JSON.stringify(g1.warnings));

console.log('--- one part, no `part`: iterate it and default the parent ---');
const g2 = await make();
check(g2.part === g1.part, 'the second generate attaches to the only part', `${g2.part} vs ${g1.part}`);
const versions = await listVersions(project.store);
const v2 = versions.find((v) => v.id === g2.versionId);
check(v2?.parentVersion === g1.versionId, 'the parent defaults to the newest version', JSON.stringify({ parent: v2?.parentVersion, expected: g1.versionId }));

console.log('--- newPart is the explicit long path ---');
const g3 = await make({ newPart: true });
check(g3.part !== g1.part, 'newPart creates a different part', `${g3.part} vs ${g1.part}`);

console.log('--- several parts, no `part`: refuse and list ---');
let refused = null;
try { await make(); } catch (error) { refused = String(error?.message ?? error); }
check(Boolean(refused) && /generate_part: no part given/.test(refused) && /project has 2 parts/.test(refused),
  'the refusal names the project size', refused);
check(/newPart: true/.test(refused ?? ''), 'and the explicit way forward', refused);

console.log(`\naccept-lazy-path: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
