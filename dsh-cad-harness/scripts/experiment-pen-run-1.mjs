// One end-to-end attempt on a real project (a COPY of the click pen):
//   1. try to move the rotor contract node to the newest version
//   2. reproduce the printability verdict on the newest rotor
//   3. re-run the contract check
// It records what actually happens; it does not "fix" anything.
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const RUNTIME = resolve(process.cwd(), '.tmp-cad-runtime');
process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'pen-run-home-'));
process.env.DSH_CAD_PYTHON_ROOT = RUNTIME;

const { registerCadTools } = await import('./src/host/tools.ts');

const cwd = resolve('../.tmp/pen-run');
const tools = new Map();
const ctx = {
  tools: { register: (def) => { tools.set(def.name, def); } },
  attachments: { saveImages: async (items) => items.map((it) => ({ kind: 'stub', name: it.name })) },
  reflect: { get: () => undefined },
  on: () => {},
};
registerCadTools(ctx);
const exec = { agent: { session: { header: { cwd } } } };
const call = async (name, args) => {
  const def = tools.get(name);
  if (!def) throw new Error(`no tool ${name}`);
  return def.execute(args, exec);
};

const out = { cwd, steps: [] };
const step = (name, ok, detail) => {
  out.steps.push({ name, ok, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
};

// 0. what the contract currently pins
const manifestPath = join(cwd, 'assembly', 'assembly.json');
const raw = await readFile(manifestPath, 'utf8');
const hash = createHash('sha256').update(raw).digest('hex');
const manifest = JSON.parse(raw);
const rotorNode = manifest.root.children.find((c) => c.id === 'rotor');
step('rotor node as pinned', true, { version: rotorNode?.version, manifestHash: hash.slice(0, 8) });

// 1. the evidence says "update to the newest version" — try it
let moved = false;
try {
  const res = await call('write_assembly', {
    mode: 'merge',
    manifestPath: 'assembly/assembly.json',
    expectedHash: `sha256:${hash}`,
    root: { id: manifest.root.id, children: [{ id: 'rotor', version: 'v088' }] },
  });
  moved = true;
  step('write_assembly merge rotor v085 -> v088', true, res);
} catch (e) {
  step('write_assembly merge rotor v085 -> v088', false, String(e?.message ?? e));
}

// 2. reproduce the printability verdict on the newest rotor
if (moved) {
  try {
    const p = await call('check_printability', { versionId: 'v088', profileIds: ['fdm-pla-0.4'] });
    step('check_printability v088 (fdm-pla-0.4)', p.verdict === 'not-excluded', p);
  } catch (e) {
    step('check_printability v088 (fdm-pla-0.4)', false, String(e?.message ?? e));
  }
} else {
  try {
    const p = await call('check_printability', { versionId: 'v088', profileIds: ['fdm-pla-0.4'] });
    step('check_printability v088 (fdm-pla-0.4)', p.verdict === 'not-excluded', p);
  } catch (e) {
    step('check_printability v088 (fdm-pla-0.4)', false, String(e?.message ?? e));
  }
}

// 3. contract check on whatever the manifest points at now
try {
  const c = await call('check_assembly', {});
  step('check_assembly', c.overallStatus === 'pass', { status: c.overallStatus, summary: c.summary });
} catch (e) {
  step('check_assembly', false, String(e?.message ?? e));
}

await writeFile('../.tmp/pen-run-log.json', JSON.stringify(out, null, 2));
console.log('\nlog -> .tmp/pen-run-log.json');
