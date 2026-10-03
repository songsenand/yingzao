// M1 host smoke test: compile a real SCAD file, check renders, save a version.
import { compileAndRender } from '../src/host/compile.ts';
import { openVersionStore, saveVersion, listVersions, readManifest } from '../src/host/version.ts';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 1. valid compile
const good = await compileAndRender('cube(20, center=true);\ncube([30,10,10], center=true);');
console.log('good compile:', good.success, 'errors:', good.errors, 'renders:', good.renders?.map(r => r.view), 'ms:', good.durationMs);
if (!good.success || !good.stl || (good.renders?.length ?? 0) !== 4) { console.error('FAIL good'); process.exit(1); }

// 2. syntax error compile
const bad = await compileAndRender('cube(20');
console.log('bad compile:', bad.success, 'first error:', bad.errors[0]);
if (bad.success || bad.errors.length === 0) { console.error('FAIL bad'); process.exit(1); }

// 3. version store round trip
const root = await mkdtemp(join(tmpdir(), 'cad-store-'));
const store = openVersionStore(root);
const id1 = await saveVersion(store, { scadCode: 'cube(1);', stl: good.stl, renders: good.renders, userIntent: 'test part' });
const id2 = await saveVersion(store, { scadCode: 'cube(2);', userIntent: 'second' });
console.log('versions:', id1, id2);
const versions = await listVersions(store);
if (id1 !== 'v001' || id2 !== 'v002' || versions.length !== 2) { console.error('FAIL versions'); process.exit(1); }
const stlBack = await readFile(join(root, 'versions', id1, 'model.stl'));
if (stlBack.length === 0) { console.error('FAIL stl persisted'); process.exit(1); }
const manifest = await readManifest(store);
console.log('manifest entries:', manifest.versions.length, 'first intent:', manifest.versions[0].userIntent);

// 4. render PNG validity (PNG magic)
const png = good.renders[0].png;
if (!(png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47)) { console.error('FAIL png magic'); process.exit(1); }
console.log('render size:', png.length, 'bytes');
console.log('M1 SMOKE TEST PASSED');
