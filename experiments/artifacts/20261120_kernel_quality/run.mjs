#!/usr/bin/env node
// Drive the SAME brief through the real generate_part tool twice: once with
// scadCode, once with code. Records the mesh/datum/validation facts the product
// actually exposes, so engine quality and the validation flow are compared on
// the same contract rather than on two hand-run compilers.
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const briefPath = join(HERE, 'BRIEF.md');
const scadPath = join(HERE, 'plate.scad');
const pyPath = join(HERE, 'plate.py');
const outPath = join(HERE, 'result.json');

const home = await mkdtemp(join(tmpdir(), 'cad-kq-home-'));
const workspaces = {
  openscad: await mkdtemp(join(tmpdir(), 'cad-kq-scad-')),
  cadquery: await mkdtemp(join(tmpdir(), 'cad-kq-cq-')),
};
process.env.DSH_HOME = home;
if (!process.env.DSH_CAD_PYTHON_ROOT) {
  // The sandbox cannot write the profile runtime's tmp; the caller normally
  // supplies a writable symlink root. Refuse rather than silently producing
  // "STEP invalid" results from a worker that cannot start.
  console.error('run.mjs: set DSH_CAD_PYTHON_ROOT to a writable runtime root (symlinks to real venv/python/user-site)');
  process.exit(2);
}

const { registerCadTools } = await import('../../../dsh-cad-harness/src/host/tools.ts');
const { projectStores } = await import('../../../dsh-cad-harness/src/host/project.ts');
const { measureVersion } = await import('../../../dsh-cad-harness/src/host/inspect.ts');
const { validateVersionGeometry } = await import('../../../dsh-cad-harness/src/host/geometry-validate.ts');
const { readVersionEntry } = await import('../../../dsh-cad-harness/src/host/version.ts');
const { resolveOpenScadBinary } = await import('../../../dsh-cad-harness/src/host/compile.ts');

const tools = new Map();
const ctx = {
  tools: { register: (def) => { tools.set(def.name, def); } },
  attachments: { saveImages: async (items) => items.map((it) => ({ kind: 'stub', name: it.name })) },
  reflect: { get: () => undefined },
  on: () => {},
};
registerCadTools(ctx);

const call = async (name, args, workspace, id) => {
  const def = tools.get(name);
  return await def.execute(args, { agent: { session: { header: { id, cwd: workspace } } } });
};

const brief = await readFile(briefPath, 'utf8');
const scad = await readFile(scadPath, 'utf8');
const py = await readFile(pyPath, 'utf8');
const results = {};
const openScad = await resolveOpenScadBinary();
const openScadProbe = spawnSync(openScad.bin, ['--version'], { encoding: 'utf8' });
const openScadVersion = `${openScadProbe.stdout ?? ''}${openScadProbe.stderr ?? ''}`.trim();

try {
  for (const kernel of ['openscad', 'cadquery']) {
    const workspace = workspaces[kernel];
    const sessionId = `kq-${kernel}`;
    const init = await call('init_project', { dir: workspace, title: `kernel quality ${kernel}`, defaultKernel: kernel }, workspace, sessionId);
    const generated = await call('generate_part', {
      ...(kernel === 'openscad' ? { scadCode: scad } : { code: py, step: true }),
      part: 'same-prompt plate',
      userIntent: `L1.11 same brief via ${kernel}`,
      views: ['top', 'iso'],
    }, workspace, sessionId);
    const store = projectStores(workspace).store;
    const entry = generated.versionId ? await readVersionEntry(store, generated.versionId) : null;
    const measured = generated.versionId ? await measureVersion(store, generated.versionId) : null;
    const validation = generated.versionId
      ? await validateVersionGeometry(store, generated.versionId, { requireStep: kernel === 'cadquery' })
      : null;
    const versionDir = generated.versionId ? join(store.root, 'versions', generated.versionId) : null;
    const files = versionDir ? (await readdir(versionDir)).sort() : [];
    const stepFile = entry?.stepFile && versionDir ? join(versionDir, entry.stepFile) : null;
    const stepStat = stepFile ? await stat(stepFile).catch(() => null) : null;
    results[kernel] = {
      brief: { file: briefPath, chars: brief.length },
      init,
      generated,
      entry: entry ? {
        sourceFile: entry.sourceFile, backend: entry.backend, stepFile: entry.stepFile,
        stepSha256: entry.stepSha256, brep: entry.brep, designEvidence: entry.designEvidence,
        solid: entry.solid,
      } : null,
      measured,
      validation,
      files,
      stepBytes: stepStat?.size ?? null,
      versionDir,
    };
  }
  await writeFile(outPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), openScad, openScadVersion, results }, null, 2)}\n`);
  console.log(JSON.stringify(Object.fromEntries(Object.entries(results).map(([k, v]) => [k, {
    success: v.generated.success, versionId: v.generated.versionId, views: v.generated.views,
    sizeMm: v.generated.sizeMm, watertight: v.generated.watertight, triangles: v.generated.triangles,
    shells: v.generated.shells, minWallMm: v.generated.minWallMm,
    volumeMm3: v.measured?.volumeMm3, areaMm2: v.measured?.surfaceAreaMm2, genus: v.measured?.genus,
    issues: v.validation?.issues?.map((i) => i.code) ?? null,
    datums: v.validation?.datums, stepBytes: v.stepBytes,
  }])), null, 2));
} finally {
  await rm(home, { recursive: true, force: true });
  for (const workspace of Object.values(workspaces)) await rm(workspace, { recursive: true, force: true });
}
