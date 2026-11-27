#!/usr/bin/env node
// Acceptance: importing a corrected export ITERATES a part; it does not fork one.
//
// WHY (2026-11-27): the dog-piggy-bank session passed `name` to import_part, whose
// field is `part`. The unknown field was ignored, so every import fell through to
// createUniquePart(fileName) and the panel showed 14 parts ("底盖 旋扣", "底盖 旋扣 2",
// ...) instead of 2 version chains. The same path also skipped the wall screen that
// generate_part runs, so a 0.088 mm wall shipped unnoticed.
//
//   node scripts/accept-import-identity.mjs
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'cad-import-identity-home-'));
const WORK = mkdtempSync(join(tmpdir(), 'cad-import-identity-work-'));
process.env.DSH_HOME = HOME;
const RUNTIME = process.env.DSH_CAD_PYTHON_ROOT?.trim() || join(HOME, 'cad', 'runtime');
if (!existsSync(join(RUNTIME, 'state.json'))) {
  // import_part runs the real mesh engine before it can register anything; without
  // a provisioned runtime this file cannot exercise the path, and a fake pass
  // would be worse than an explicit skip.
  console.log(`SKIP (not a pass): no provisioned Python runtime at ${RUNTIME}`);
  process.exit(0);
}
const PROJ = join(WORK, 'project');
mkdirSync(PROJ, { recursive: true });

const { registerCadTools } = await import('../src/host/tools.ts');
const { createProjectMarker, bindSessionToProject, projectStores } = await import('../src/host/project.ts');
const { readPartManifest } = await import('../src/host/parts.ts');
const { writeBinaryStl } = await import('../src/host/mesh.ts');

let passed = 0;
let failed = 0;
const check = (ok, label, detail = '') => {
  if (ok) { passed++; console.log(`  PASS ${label}`); }
  else { failed++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

/** A closed box as binary STL (12 triangles). */
function boxStl(dx, dy, dz) {
  const v = [0,0,0, dx,0,0, dx,dy,0, 0,dy,0, 0,0,dz, dx,0,dz, dx,dy,dz, 0,dy,dz];
  const t = [0,2,1, 0,3,2, 4,5,6, 4,6,7, 0,1,5, 0,5,4, 1,2,6, 1,6,5, 2,3,7, 2,7,6, 3,0,4, 3,4,7];
  return writeBinaryStl({ vertProperties: new Float32Array(v), triVerts: new Uint32Array(t) });
}

const tools = new Map();
const ctx = {
  tools: { register: (def) => { tools.set(def.name, def); return () => {}; } },
  on: () => {}, effect: (fn) => fn(),
  reflect: { get: () => undefined },
};
registerCadTools(ctx, { toolScope: 'preset', presets: ['cad'] });
const importTool = tools.get('import_part');
check(Boolean(importTool), 'import_part is registered');

await createProjectMarker(PROJ, 'import identity');
const exec = { agent: { session: { header: { id: 'import-identity', cwd: PROJ } } } };
await bindSessionToProject(exec, PROJ);
const project = projectStores(PROJ);

const boxPath = join(PROJ, 'box.stl');
writeFileSync(boxPath, boxStl(20, 20, 20));
const platePath = join(PROJ, 'plate.stl');
writeFileSync(platePath, boxStl(20, 20, 0.5));

const importOf = async (args) => importTool.execute({ ...args, render: false }, exec);

console.log('--- same file, no part: one part, versions appended ---');
const a1 = await importOf({ file: boxPath, userIntent: 'first' });
const a2 = await importOf({ file: boxPath, userIntent: 'second' });
check(a1.partCreated === true, 'the first import starts a part', JSON.stringify({ part: a1.part, created: a1.partCreated }));
check(a1.minWallMm === undefined && !(a1.warnings ?? []).some((w) => /wall screen/i.test(w)),
  'a default import stays process-neutral (no FDM screen)', JSON.stringify(a1.warnings));
check(a2.partCreated === false, 'the second import does NOT create another part', JSON.stringify({ part: a2.part, created: a2.partCreated }));
check(a1.part === a2.part, 'both land on the same part', `${a1.part} vs ${a2.part}`);
const manifest1 = await readPartManifest(project.partStore);
const boxPart = manifest1.parts.find((p) => p.name === a1.part);
check(Boolean(boxPart) && boxPart.versionIds.length === 2, 'that part has both versions', JSON.stringify(boxPart?.versionIds));

console.log('--- `name` is accepted as the alias the model actually sends ---');
const lidPath = join(PROJ, 'lid.stl');
writeFileSync(lidPath, boxStl(30, 30, 5));
const n1 = await importOf({ file: lidPath, name: '底盖', userIntent: 'lid v1' });
const n2 = await importOf({ file: lidPath, name: '底盖', userIntent: 'lid v2' });
check(n1.part === '底盖' && n2.part === '底盖', 'name names the part', `${n1.part} / ${n2.part}`);
check(n1.partCreated === true && n2.partCreated === false, 'the alias iterates one part', `${n1.partCreated}/${n2.partCreated}`);
const manifest2 = await readPartManifest(project.partStore);
const lidPart = manifest2.parts.find((p) => p.name === '底盖');
check(Boolean(lidPart) && lidPart.versionIds.length === 2, 'the aliased part has both versions');

console.log('--- import runs the wall screen (or says it could not) ---');
const thin = await importOf({ file: platePath, userIntent: 'thin plate', wallScreen: true });
const wallLine = (thin.warnings ?? []).find((w) => /wall screen/i.test(String(w)));
check(Boolean(wallLine), 'an explicit FDM screen reports a line', JSON.stringify(thin.warnings));
if (typeof thin.minWallMm === 'number') {
  check(thin.minWallMm < 1.2, 'a 0.5 mm plate is measured below the 1.2 mm threshold', String(thin.minWallMm));
  check(/FDM wall screen \(opt-in\).*< 1\.2mm/.test(wallLine ?? ''), 'and names the FDM threshold it applied', wallLine ?? '');
} else {
  check(/unavailable/i.test(wallLine ?? ''), 'without the Python runtime it says the screen was unavailable (never a silent pass)', wallLine ?? '');
}

console.log(`\naccept-import-identity: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
