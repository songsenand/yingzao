// Pairwise interference/clearance for the M1 frame — independent of the manifest.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORK = join(HERE, '..');
const HARNESS = process.env.CAD_HARNESS_ROOT ?? '/home/songsenand/Project/ToyMarker/dsh-cad-harness';
const DATA = process.env.CAD_DATA_ROOT ?? join(WORK, 'cad-data');
const { buildSolid, pairMinDistance } = await import(join(HARNESS, 'src/host/assembly.ts'));

const manifest = JSON.parse(await readFile(join(DATA, 'assembly', 'microscope-frame.json'), 'utf8'));
const kids = manifest.root.children;
const built = [];
for (const k of kids) {
  const stl = await readFile(join(DATA, 'versions', k.version, 'model.stl'));
  const b = await buildSolid(stl, k.transform);
  const bb = b.solid.boundingBox();
  built.push({ id: k.id, ...b, bb });
  console.log(`${k.id.padEnd(7)} ${k.version} bbox [${bb.min.map((x) => x.toFixed(2))}] .. [${bb.max.map((x) => x.toFixed(2))}]  vol=${b.solid.volume().toFixed(0)} mm³`);
}
console.log('');
for (let i = 0; i < built.length; i++) {
  for (let j = i + 1; j < built.length; j++) {
    const A = built[i], B = built[j];
    const inter = A.solid.intersect(B.solid);
    const vol = inter.isEmpty() ? 0 : inter.volume();
    const d = vol > 1e-6 ? 0 : await pairMinDistance(A, B);
    console.log(`${A.id.padEnd(7)} ↔ ${B.id.padEnd(7)} gap=${d.toFixed(4)} mm   interVol=${Math.max(0, vol).toFixed(4)} mm³`);
  }
}
