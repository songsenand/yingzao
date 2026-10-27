// Acceptance for `check_parts`: one call screens a family, and the printability
// half is the SAME job as `check_printability` (runs included).
//
// The glucose build made 11 measure_part + 22 check_printability calls for 7
// parts. This test proves the batch tool returns the same per-part facts in one
// compact table and writes one printability run per version, so the rows can
// back a delivery claim.
//
//   node scripts/accept-check-parts.mjs [--runtime <dir>]
//
// Needs the pinned Python runtime (the measure/printability engines), like the
// assembly parity test; it is not part of `npm run accept` for that reason.
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'cad-check-parts-'));
process.env.DSH_CAD_PYTHON_ROOT = resolve(argOf('--runtime', join(REPO, 'dsh-cad-harness', '.tmp-cad-runtime')));

const venvPython = process.platform === 'win32'
  ? join(process.env.DSH_CAD_PYTHON_ROOT, 'venv', 'Scripts', 'python.exe')
  : join(process.env.DSH_CAD_PYTHON_ROOT, 'venv', 'bin', 'python');
if (!existsSync(venvPython)) {
  console.error(`no venv python at ${venvPython} — pass --runtime <dir> with a provisioned runtime`);
  process.exit(2);
}

const { registerCadTools } = await import('../src/host/tools.ts');
const { projectStores, ensureProjectDir } = await import('../src/host/project.ts');
const { saveVersion } = await import('../src/host/version.ts');
const { ensurePart, attachVersion } = await import('../src/host/parts.ts');
const { listRuns } = await import('../src/host/runs.ts');
const { writeBinaryStl } = await import('../src/host/mesh.ts');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

/** A closed box as a binary STL (12 triangles), the shape both screens can read. */
function boxStl(dx, dy, dz) {
  const v = [
    0, 0, 0, dx, 0, 0, dx, dy, 0, 0, dy, 0,
    0, 0, dz, dx, 0, dz, dx, dy, dz, 0, dy, dz,
  ];
  const t = [
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ];
  return writeBinaryStl({ vertProperties: new Float32Array(v), triVerts: new Uint32Array(t) });
}

const tools = new Map();
const fakeCtx = {
  tools: { register: (def) => { tools.set(def.name, def); return () => {}; } },
  on: () => {},
  effect: (fn) => fn(),
  reflect: {
    get: (k) => (k === 'agentPresets'
      ? { list: async () => [{ id: 'cad', name: '造物模式' }] }
      : k === 'connection'
        ? { fetch: { register: () => () => {} }, rpc: { intercept: () => () => {} } }
        : undefined),
  },
};
registerCadTools(fakeCtx, { toolScope: 'preset', presets: ['cad'] });
check(tools.has('check_parts'), 'check_parts is registered');

const cwd = join(process.env.DSH_HOME, 'proj');
mkdirSync(cwd, { recursive: true });
const project = projectStores(cwd);
await ensureProjectDir(project);
const part = await ensurePart(project.partStore, '测试件', 'agent');
const thin = await saveVersion(project.store, {
  scadCode: '// test', stl: boxStl(10, 10, 0.5), userIntent: 'thin plate', partId: part.id,
});
await attachVersion(project.partStore, part.id, thin);
const cube = await saveVersion(project.store, {
  scadCode: '// test', stl: boxStl(10, 10, 10), userIntent: 'cube', partId: part.id,
});
await attachVersion(project.partStore, part.id, cube);

const exec = { agent: { session: { header: { cwd } } } };
const batch = await tools.get('check_parts').execute({
  versionIds: [thin, cube],
  profileIds: ['fdm-pla-0.4'],
}, exec);

check(batch.parts.length === 2 && batch.failures.length === 0,
  'two versions screen in one call', JSON.stringify(batch.summary));
const thinRow = batch.parts.find((p) => p.versionId === thin);
const cubeRow = batch.parts.find((p) => p.versionId === cube);
check(thinRow?.partName === '测试件', 'the row names the part', String(thinRow?.partName));
check(thinRow?.watertight === true && thinRow?.bodies === 1,
  'the measure half reports watertight and body count', JSON.stringify({ w: thinRow?.watertight, b: thinRow?.bodies }));
check(typeof thinRow?.printability?.minWallMm === 'number'
    && thinRow.printability.minWallMm > 0.3 && thinRow.printability.minWallMm < 0.7,
  'the printability half finds the 0.5mm wall', String(thinRow?.printability?.minWallMm));
check(thinRow?.printability?.profiles?.some((p) => p.verdict === 'excluded'),
  'the thin plate is excluded by fdm-pla-0.4 (profile verdict)', JSON.stringify(thinRow?.printability?.profiles));
check(typeof thinRow?.printability?.runId === 'string' && thinRow.printability.runId.startsWith('r'),
  'the printability row cites the run it wrote', String(thinRow?.printability?.runId));
check(!cubeRow?.printability?.profiles?.some((p) => p.verdict === 'excluded'),
  'the 10mm cube is not excluded by the wall rule', JSON.stringify(cubeRow?.printability?.profiles));
check(batch.summary.thinnestMm === thinRow.printability.minWallMm,
  'the summary names the thinnest wall', String(batch.summary.thinnestMm));

const runs = await listRuns(project.runStore);
const printRuns = runs.filter((r) => r.kind === 'printability');
check(printRuns.length === 2, 'one printability run per version (evidence, not a shortcut)', String(printRuns.length));

// A missing version is one row's failure, not the whole call.
const partial = await tools.get('check_parts').execute({
  versionIds: [thin, 'v999'], checks: ['measure'],
}, exec);
check(partial.parts.length === 1 && partial.failures.length === 1
    && partial.failures[0].versionId === 'v999',
  'an unknown version fails its row, the rest still returns', JSON.stringify(partial.summary));

// Duplicates are screened once.
const dedup = await tools.get('check_parts').execute({
  versionIds: [thin, thin], checks: ['measure'],
}, exec);
check(dedup.summary.requested === 1, 'duplicate ids are screened once', String(dedup.summary.requested));

console.log(failures ? `\n${failures} FAIL` : '\nall PASS');
process.exit(failures ? 1 : 0);
