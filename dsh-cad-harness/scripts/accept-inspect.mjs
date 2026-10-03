import { compileStlOnly } from '../src/host/compile.ts';
import { measureVersion, renderVersionFrame } from '../src/host/inspect.ts';
import { mkdirSync } from 'node:fs';
// Prepare a version store manually pointing at a temp dir with one version
import { openVersionStore, saveVersion } from '../src/host/version.ts';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const flange = await compileStlOnly(`difference() { cylinder(h=8, d=60, $fn=64); cylinder(h=20, d=12, center=true, $fn=64); }`);
mkdirSync('/tmp/insp/versions/v001', { recursive: true });
const store = openVersionStore('/tmp/insp');
await import('node:fs/promises').then(fs => fs.writeFile('/tmp/insp/versions/v001/model.stl', flange.stl));

// 1. measure: expect bbox 60x60x8, volume ≈ (π*30² - π*6²)*8 = 21928.6, genus 1
const m = await measureVersion(store, 'v001');
console.log('measure:', JSON.stringify({ size: m.boundingBoxMm.size, vol: m.volumeMm3, area: m.surfaceAreaMm2, genus: m.genus, watertight: m.watertight, com: m.centerOfMassMm }));
const expectVol = Math.PI * (30*30 - 6*6) * 8;
if (Math.abs(m.volumeMm3 - expectVol) > 50) { console.error('FAIL volume', expectVol); process.exit(1); }
if (m.genus !== 1) { console.error('FAIL genus (expect 1 through hole)'); process.exit(1); }
if (!m.watertight) { console.error('FAIL watertight'); process.exit(1); }

// 2. render with zoom + section
mkdirSync('/tmp/insp/out', { recursive: true });
const f1 = await renderVersionFrame(store, { versionId: 'v001', view: 'top', zoom: 1.5 }, 'a');
console.log('render1 label:', f1.label, 'bytes:', f1.png.length);
const f2 = await renderVersionFrame(store, { versionId: 'v001', rotate: [0, 0, 0], section: { axis: 'z', fraction: 0.5 } }, 'b');
console.log('render2 label:', f2.label, 'bytes:', f2.png.length);
if (f1.png.length < 1000 || f2.png.length < 1000) { console.error('FAIL renders'); process.exit(1); }
console.log('INSPECT TOOLS PASSED');
