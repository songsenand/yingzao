#!/usr/bin/env node
// L1.5: the CadQuery authoring layer through the REAL generate_part tool:
// code → compile → render via STL→OpenSCAD → model.py/backend pin; cad_session
// info reports the kernel; a CQ example ships and runs.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { cadqueryPackStatus } from '../src/host/cadquery-pack.ts';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const pack = await cadqueryPackStatus();
if (!pack.installed) {
  if (process.env.DSH_CAD_REQUIRE_CQ === '1') {
    console.error('FAIL  DSH_CAD_REQUIRE_CQ=1 but the CadQuery pack is not installed');
    process.exit(1);
  }
  console.log(`SKIP  CadQuery pack is not installed at ${pack.root}`);
  process.exit(0);
}

const home = await mkdtemp(join(tmpdir(), 'cad-cq-author-home-'));
const workspace = await mkdtemp(join(tmpdir(), 'cad-cq-author-work-'));
process.env.DSH_HOME = home;
process.env.DSH_CAD_CQ_PACK = pack.root;
process.env.DSH_CAD_PYTHON_ROOT = join(homedir(), '.dsh', 'cad', 'runtime');
const { registerCadTools } = await import('../src/host/tools.ts');
const { projectStores } = await import('../src/host/project.ts');
const { readVersionEntry, readVersionSource } = await import('../src/host/version.ts');
const { cancelJob, getJob, openJobStore, startCompileJob } = await import('../src/host/jobs.ts');

const tools = new Map();
const ctx = {
  tools: { register: (def) => { tools.set(def.name, def); } },
  attachments: { saveImages: async (items) => items.map((it) => ({ kind: 'stub', name: it.name })) },
  reflect: { get: () => undefined },
  on: () => {},
};
registerCadTools(ctx);
const exec = { agent: { session: { header: { id: 'cq-author-test', cwd: workspace } } } };
const call = async (name, args) => {
  const def = tools.get(name);
  if (!def) throw new Error(`tool ${name} not registered`);
  return await def.execute(args, exec);
};

try {
  const init = await call('init_project', { dir: workspace, title: 'CQ authoring', defaultKernel: 'cadquery' });
  check(init?.root === workspace || init?.created === true, 'init_project selects the workspace', JSON.stringify(init));

  const info = await call('project_info', {});
  check(info.kernel === 'cadquery' && info.kernelSource === 'project', 'cad_session info reports the project kernel', JSON.stringify({ kernel: info.kernel, source: info.kernelSource }));

  const example = await readFile(fileURLToPath(new URL('../examples/cadquery/bracket.py', import.meta.url)), 'utf8');
  const generated = await call('generate_part', {
    code: example,
    part: 'CQ bracket',
    userIntent: 'L1.5 bracket example',
    views: ['top'],
    step: true,
  });
  check(generated.success === true, 'generate_part compiles the CQ example', generated.errors.join('; '));
  check(generated.kernel === 'cadquery', 'generate_part reports the kernel', String(generated.kernel));
  check(generated.step === true, 'generate_part can request a native STEP', String(generated.step));
  check(Array.isArray(generated.views) && generated.views.includes('top'), 'CQ renders through the shared STL→OpenSCAD path', JSON.stringify(generated.views));
  check(Number(generated.sizeMm?.[0]) === 60 && Number(generated.sizeMm?.[1]) === 40 && Number(generated.sizeMm?.[2]) === 6, 'generated bracket has the expected bbox', JSON.stringify(generated.sizeMm));

  const after = await call('project_info', {});
  check(after.kernel === 'cadquery' && after.kernelSource === 'project', 'the first write does not destroy the project kernel pin', JSON.stringify({ kernel: after.kernel, source: after.kernelSource }));

  const store = projectStores(workspace).store;
  const entry = await readVersionEntry(store, generated.versionId);
  check(entry?.sourceFile === 'model.py' && entry?.backend?.kernel === 'cadquery', 'version pins model.py + cadquery', JSON.stringify({ sourceFile: entry?.sourceFile, kernel: entry?.backend?.kernel }));
  check(entry?.stepFile === 'model.step' && Boolean(entry?.stepSha256?.startsWith('sha256:')), 'version records the STEP artifact', JSON.stringify({ stepFile: entry?.stepFile, hash: entry?.stepSha256 }));
  const source = await readVersionSource(store, generated.versionId);
  check(source?.kernel === 'cadquery' && source.code.includes('Workplane'), 'version source reads back as CadQuery', String(source?.kernel));

  let both = '';
  try {
    await call('generate_part', { code: example, scadCode: 'cube(1);', part: 'both', userIntent: 'should fail' });
  } catch (error) { both = String(error?.message ?? error); }
  check(both.includes('not both'), 'generate_part refuses both source languages', both);

  const jobs = openJobStore(join(workspace, 'cad-data'));
  const running = await startCompileJob({ store: jobs, versions: store, project: workspace, versionId: generated.versionId, timeoutMs: 60_000 });
  check(running.status === 'running', 'CQ job returns before compiling', running.status);
  let withPid = getJob(jobs, running.id);
  for (let i = 0; i < 30 && !withPid?.pid; i++) {
    await new Promise((r) => setTimeout(r, 100));
    withPid = getJob(jobs, running.id) ?? withPid;
  }
  check(Boolean(withPid?.pid), 'CQ job exposes its child pid', String(withPid?.pid));
  const cancelled = await cancelJob(jobs, running.id);
  check(cancelled?.status === 'cancelled', 'CQ job can be cancelled', cancelled?.status);
  await new Promise((r) => setTimeout(r, 500));
  check(getJob(jobs, running.id)?.status === 'cancelled', 'cancelled CQ job stays cancelled after the child exits');
} finally {
  await rm(home, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
