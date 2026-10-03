// Probe: compile each part source and report datums, bbox, volume, warnings.
// Usage: node tools/probe.mjs [part-file ...]
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORK = join(HERE, '..');
const HARNESS = process.env.CAD_HARNESS_ROOT ?? '/home/songsenand/Project/ToyMarker/dsh-cad-harness';
const { compileAndRender } = await import(join(HARNESS, 'src/host/compile.ts'));

function stlStats(buf) {
  const count = buf.readUInt32LE(80);
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let vol = 0;
  for (let i = 0; i < count; i++) {
    const o = 84 + i * 50 + 12;
    const v = [];
    for (let k = 0; k < 3; k++) {
      const p = [buf.readFloatLE(o + k * 12), buf.readFloatLE(o + k * 12 + 4), buf.readFloatLE(o + k * 12 + 8)];
      v.push(p);
      for (let d = 0; d < 3; d++) { min[d] = Math.min(min[d], p[d]); max[d] = Math.max(max[d], p[d]); }
    }
    const [a, b, c] = v;
    vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  return { count, min, max, vol: Math.abs(vol) };
}

const files = process.argv.slice(2);
const list = files.length > 0 ? files : ['scad/000-base.scad', 'scad/010-column.scad', 'scad/020-arm.scad', 'scad/030-stage.scad'];

for (const rel of list) {
  const code = await readFile(join(WORK, rel), 'utf8');
  const t0 = Date.now();
  const r = await compileAndRender(code);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n=== ${rel}  success=${r.success}  ${dt}s  renders=${(r.renders ?? []).length}`);
  if (r.errors.length) console.log('  ERRORS:', r.errors.join(' | '));
  if (r.warnings.length) console.log('  WARN :', r.warnings.join(' | '));
  if (r.stl) {
    const s = stlStats(Buffer.from(r.stl));
    console.log(`  bbox  min=[${s.min.map((x) => x.toFixed(2)).join(', ')}]  max=[${s.max.map((x) => x.toFixed(2)).join(', ')}]`);
    console.log(`  size  [${s.max.map((x, i) => (x - s.min[i]).toFixed(2)).join(' × ')}]   volume=${(s.vol / 1000).toFixed(1)} cm³   tris=${s.count}`);
  }
  for (const [k, v] of Object.entries({ point: r.datums, axis: r.datumSet?.axes, plane: r.datumSet?.planes, cyl: r.datumSet?.cylinders })) {
    for (const d of v ?? []) console.log(`  datum ${k.padEnd(5)} ${d.name}  ${JSON.stringify(d.point)}${d.dir ? ' dir ' + JSON.stringify(d.dir) : ''}${d.normal ? ' n ' + JSON.stringify(d.normal) : ''}${d.radius !== undefined ? ' r=' + d.radius : ''}`);
  }
  // dump a render for eyeballing
  if (r.renders?.length) {
    const { writeFile } = await import('node:fs/promises');
    for (const rv of r.renders) await writeFile(join(WORK, 'out', 'probe', `${rel.split('/').pop().replace('.scad', '')}-${rv.view}.png`), rv.png);
  }
}
