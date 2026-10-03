import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const BINARIES = [
  { name: '2026 Manifold', bin: '/home/songsenand/Project/ToyMarker/bin/squashfs-root/usr/bin/openscad', flags: ['--backend=Manifold'] },
  { name: '2021 CGAL     ', bin: 'openscad', flags: [] },
];
const PARTS = [
  { name: '简单(cube20)      ', scad: 'cube(20, center=true);' },
  { name: '法兰(4孔 fn64)    ', scad: readFileSync('/home/songsenand/Project/ToyMarker/dsh-cad-harness/data/versions/v001/model.scad', 'utf8') },
  { name: 'BOSL2 M6螺纹 fn64 ', scad: 'include <BOSL2/std.scad>\ninclude <BOSL2/screws.scad>\n$fn=64;\nscrew("M6", length=20);' },
];
const env = { ...process.env, OPENSCADPATH: '/home/songsenand/Project/ToyMarker/lib', DISPLAY: ':95' };

const ms = (bin, args) => {
  const t = Date.now();
  const r = spawnSync(bin, args, { env, timeout: 180000 });
  return { ms: Date.now() - t, ok: r.status === 0 };
};

console.log('| 零件 | 指标 | 2026 Manifold | 2021 CGAL | 加速比 |');
console.log('|---|---|---|---|---|');
let n = 0;
for (const part of PARTS) {
  n++;
  const scadFile = `/tmp/perf_${n}.scad`;
  writeFileSync(scadFile, part.scad);
  const row = {};
  for (const b of BINARIES) {
    const stl = ms(b.bin, [...b.flags, '-o', `/tmp/perf_${n}.stl`, '--export-format', 'binstl', scadFile]);
    const views = [];
    for (const c of ['0,0,0,0', '0,90,0,0', '90,0,0,0', '65,0,25,0']) {
      views.push(ms(b.bin, [...b.flags, '-o', `/tmp/perf_${n}_v.png`, `--camera=0,0,0,${c},0`, '--imgsize=512,512', '--viewall', '--autocenter', scadFile]));
    }
    row[b.name] = { stl: stl.ms, views: views.reduce((a, v) => a + v.ms, 0), ok: stl.ok && views.every(v => v.ok) };
  }
  const [nu, o] = BINARIES;
  if (!row[nu.name].ok || !row[o.name].ok) console.log(`| ${part.name} | !! 部分失败 | ${row[nu.name].ok} | ${row[o.name].ok} | - |`);
  const speed = (k) => (row[o.name][k] / Math.max(1, row[nu.name][k])).toFixed(1);
  console.log(`| ${part.name} | STL导出 | ${row[nu.name].stl}ms | ${row[o.name].stl}ms | ${speed('stl')}× |`);
  console.log(`| ${part.name} | 4视图渲染 | ${row[nu.name].views}ms | ${row[o.name].views}ms | ${speed('views')}× |`);
}
