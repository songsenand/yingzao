// Step 2 of the real run: repair the datums the revert dropped, then point the
// contract at the repaired version and re-check.
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'pen-run2-home-'));
process.env.DSH_CAD_PYTHON_ROOT = resolve(process.cwd(), '.tmp-cad-runtime');

const { registerCadTools } = await import('./src/host/tools.ts');
const cwd = resolve('../.tmp/pen-run');
const tools = new Map();
registerCadTools({
  tools: { register: (def) => { tools.set(def.name, def); } },
  attachments: { saveImages: async (items) => items.map((it) => ({ kind: 'stub', name: it.name })) },
  reflect: { get: () => undefined },
  on: () => {},
});
const exec = { agent: { session: { header: { cwd } } } };
const call = async (name, args) => tools.get(name).execute(args, exec);

const out = { steps: [] };
const step = (name, ok, detail) => {
  out.steps.push({ name, ok, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
};

// 1. re-declare the anchors the revert lost (same frame as v085)
let repaired;
try {
  repaired = await call('set_datums', {
    versionId: 'v088',
    datums: [
      { name: 'axis', kind: 'axis', point: [0, 0, 0], dir: [0, 0, 1] },
      { name: 'top', kind: 'plane', point: [0, 0, 127], normal: [0, 0, 1] },
      { name: 'seat', kind: 'plane', point: [0, 0, 116.5], normal: [0, 0, 1] },
    ],
  });
  step('set_datums v088', true, { newVersion: repaired.versionId, datums: repaired.datums });
} catch (e) {
  step('set_datums v088', false, String(e?.message ?? e));
}

// 2. point the contract at the repaired version
if (repaired?.versionId) {
  const manifestPath = join(cwd, 'assembly', 'assembly.json');
  const raw = await readFile(manifestPath, 'utf8');
  const hash = createHash('sha256').update(raw).digest('hex');
  try {
    const res = await call('write_assembly', {
      mode: 'merge',
      manifestPath: 'assembly/assembly.json',
      expectedHash: `sha256:${hash}`,
      root: { id: 'pen', children: [{ id: 'rotor', version: repaired.versionId }] },
    });
    step(`write_assembly rotor -> ${repaired.versionId}`, true, { changed: res.changed, counts: res.counts, warnings: res.warnings });
  } catch (e) {
    step(`write_assembly rotor -> ${repaired.versionId}`, false, String(e?.message ?? e));
  }

  try {
    const c = await call('check_assembly', {});
    step('check_assembly after repair', c.overallStatus === 'pass', {
      status: c.overallStatus,
      summary: c.summary,
      hard: (c.hardViolations ?? []).map((v) => `${v.interfaceId}: ${String(v.detail).slice(0, 120)}`),
    });
  } catch (e) {
    step('check_assembly after repair', false, String(e?.message ?? e));
  }
}

await writeFile('../.tmp/pen-run2-log.json', JSON.stringify(out, null, 2));
console.log('\nlog -> .tmp/pen-run2-log.json');
