// Acceptance for write_assembly: typed contract writing, not generic file IO.
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { projectStores } from '../src/host/project.ts';
import { writeAssembly } from '../src/host/write-assembly.ts';
import { CAD_TOOL_GROUPS } from '../src/host/tool-groups.ts';
import { loadPearl } from '../src/host/pearls/registry.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (ok, label, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };
const hash = (s) => `sha256:${createHash('sha256').update(s).digest('hex')}`;

const dir = await mkdtemp(join(tmpdir(), 'wa-accept-'));
await mkdir(join(dir, 'cad-data/versions/v001'), { recursive: true });
await writeFile(join(dir, 'cad-data/versions/v001/datums.json'), JSON.stringify({
  points: [{ name: 'p', point: [0, 0, 0] }], axes: [], planes: [], cylinders: [],
}));
const project = projectStores(dir);
const root = {
  id: 'asm', name: 'test assembly', kind: 'assembly',
  children: [
    { id: 'partA', name: 'A', kind: 'part', version: 'v001' },
    { id: 'partB', name: 'B', kind: 'part', version: 'v001' },
  ],
  interfaces: [
    { id: 'I1', a: 'partA.p', b: 'partB.p', type: '贴合', severity: 'hard', check: 'distance', expected: 0, tolerance: { min: -1, max: 1 } },
  ],
};

const created = await writeAssembly(project, { mode: 'create', root });
check(created.changed && created.counts.children === 2 && created.counts.interfaces === 1, 'create writes children/interfaces', JSON.stringify(created.counts));
check(created.warnings.some((w) => w.includes('expected -> nominal')), 'expected is normalized to nominal', created.warnings.join(';'));
const text1 = await readFile(created.manifestPath, 'utf8');
check(hash(text1) === created.manifestHash, 'returned hash matches written bytes');

const merged = await writeAssembly(project, {
  mode: 'merge', expectedHash: created.manifestHash,
  root: { interfaces: [{ id: 'I2', a: 'partA.p', b: 'partB.p', type: '贴合', severity: 'hard', check: 'distance', nominal: { quantity: '距离', value: 0 }, tolerance: { min: -1, max: 1 } }] },
});
check(merged.counts.interfaces === 2 && merged.changed, 'merge upserts without deleting I1', JSON.stringify(merged.counts));

let mismatch = '';
try { await writeAssembly(project, { mode: 'merge', expectedHash: 'sha256:' + '0'.repeat(64), root: { interfaces: [] } }); } catch (e) { mismatch = String(e); }
check(mismatch.includes('expectedHash mismatch'), 'stale expectedHash is refused', mismatch.slice(0, 80));

const beforeBad = hash(await readFile(created.manifestPath, 'utf8'));
let badDatum = '';
try { await writeAssembly(project, { mode: 'merge', expectedHash: merged.manifestHash, root: { interfaces: [{ id: 'I3', a: 'partA.nope', b: 'partB.p', type: '贴合', severity: 'hard', check: 'distance', tolerance: { min: -1, max: 1 } }] } }); } catch (e) { badDatum = String(e); }
check(badDatum.includes('datum "nope" not found'), 'missing datum is refused with the version', badDatum.slice(0, 120));
check(hash(await readFile(created.manifestPath, 'utf8')) === beforeBad, 'failed write leaves the manifest untouched');

let escape = '';
try { await writeAssembly(project, { mode: 'create', manifestPath: '../escape.json', root }); } catch (e) { escape = String(e); }
check(escape.includes('escapes the project workspace'), 'path escape is refused', escape.slice(0, 80));

let exists = '';
try { await writeAssembly(project, { mode: 'create', root }); } catch (e) { exists = String(e); }
check(exists.includes('already exists'), 'create refuses an existing manifest', exists.slice(0, 80));

const replaced = await writeAssembly(project, { mode: 'replace', expectedHash: merged.manifestHash, root: { ...root, name: 'renamed root' } });
check(JSON.parse(await readFile(created.manifestPath, 'utf8')).name === 'test assembly', 'replace preserves the top-level manifest name', 'top-level name');

const removed = await writeAssembly(project, { mode: 'merge', expectedHash: replaced.manifestHash, root: { id: 'asm' }, remove: { interfaces: ['I1'] } });
check(removed.counts.interfaces === 0, 'explicit remove deletes only the named interface', JSON.stringify(removed.counts));

const model = await loadPearl(join(ROOT, 'pearls/model'));
const assembly = model.templates.find((t) => t.manifest.id === 'assembly');
check(!!assembly && assembly.manifest.steps.some((s) => s.tool === 'write_assembly'), 'model/assembly uses write_assembly, not run_python');
check(CAD_TOOL_GROUPS.instrument.includes('write_assembly'), 'write_assembly is registered in the instrument group');

await rm(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
