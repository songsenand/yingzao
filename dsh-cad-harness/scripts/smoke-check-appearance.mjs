// Sandbox smoke test for check_appearance: register the real tools, call the tool,
// print the value AND the run it wrote. Isolated home + temp project, so the user's
// corpus is untouched.
import { mkdtemp, mkdir, cp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = join(REPO, '..');
const home = await mkdtemp(join(tmpdir(), 'cad-app-home-'));
process.env.DSH_HOME = home;
process.env.DSH_CAD_PYTHON_ROOT = process.env.DSH_CAD_PYTHON_ROOT ?? '/home/songsenand/.dsh/cad/runtime';

const ws = await mkdtemp(join(tmpdir(), 'cad-app-work-'));
const corpus = process.argv[2];      // optional: a project dir to reuse (examples/…)
const manifestRel = process.argv[3] ?? 'assembly/smoke.json';
const budgetRel = process.argv[5];   // optional: assembly/budget.json
await mkdir(join(ws, 'cad-data', 'versions'), { recursive: true });
if (corpus) {
  await cp(join(corpus, 'cad-data', 'versions'), join(ws, 'cad-data', 'versions'), { recursive: true });
  await mkdir(join(ws, 'assembly'), { recursive: true });
  await cp(join(corpus, manifestRel), join(ws, manifestRel), { recursive: true });
  if (budgetRel) await cp(join(corpus, budgetRel), join(ws, budgetRel), { recursive: true });
} else {
for (const v of ['v002', 'v003']) {
  await cp(join(PROJECT, 'cad-data', 'versions', v), join(ws, 'cad-data', 'versions', v), { recursive: true });
}
await mkdir(join(ws, 'assembly'), { recursive: true });
await writeFile(join(ws, 'assembly', 'smoke.json'), JSON.stringify({
  schemaVersion: 1, name: 'appearance smoke',
  root: {
    kind: 'assembly', id: 'root', children: [
      { id: 'flat', kind: 'part', part: '校准件-平端杆', version: 'v002', transform: { translate: [-25, 0, 0] } },
      { id: 'capsule', kind: 'part', part: '校准件-圆端杆', version: 'v003', transform: { translate: [25, 0, 0] } },
    ],
  },
}));
}

const { registerCadTools } = await import('../src/host/tools.ts');
const tools = new Map();
const ctx = {
  tools: { register: (def) => { tools.set(def.name, def); } },
  attachments: { saveImages: async () => [] },
  reflect: { get: () => undefined },
  on: () => {},
};
registerCadTools(ctx);
const exec = { agent: { session: { header: { cwd: ws } } } };

const t0 = Date.now();
const value = await tools.get('check_appearance').execute({ manifestPath: manifestRel, mode: 'both', views: 12, ...(budgetRel ? { budgetPath: budgetRel } : {}) }, exec);
console.log('call ok in', Date.now() - t0, 'ms');
const j = value.judgement ?? {};
console.log('verdict', value.verdict, '| parts', JSON.stringify(value.parts),
  '| visible', j.visibleSharpMm, 'mm | density', j.visibleSharpPerKmm2,
  '| attention', value.attention?.count);
const def = tools.get('check_appearance');
if (def?.output?.render) console.log('\n--- what the model sees ---\n' + def.output.render({}, value)[0].text + '\n');

if (process.argv[4]) {
  const { writeFile: wf } = await import('node:fs/promises');
  await wf(process.argv[4], JSON.stringify(value, null, 1));
  console.log('report →', process.argv[4]);
}

// the run the tool wrote
const { projectStores } = await import('../src/host/project.ts');
const project = projectStores(ws);
const runs = await readFile(join(project.runStore.root, 'manifest.json'), 'utf8').catch(() => null);
if (runs) {
  const m = JSON.parse(runs);
  const last = (m.runs ?? []).at(-1);
  console.log('run written:', last?.id, last?.kind, last?.judgement, last?.summary);
}
