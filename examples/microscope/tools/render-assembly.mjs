// Assembly render: all four M1 parts imported with their manifest transforms and
// colours, rendered to out/assembly-*.png (independent of the per-part views).
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORK = join(HERE, '..');
const HARNESS = process.env.CAD_HARNESS_ROOT ?? '/home/songsenand/Project/ToyMarker/dsh-cad-harness';
const DATA = process.env.CAD_DATA_ROOT ?? join(WORK, 'cad-data');
const { renderScadPng } = await import(join(HARNESS, 'src/host/compile.ts'));

const manifest = JSON.parse(await readFile(join(DATA, 'assembly', 'microscope-frame.json'), 'utf8'));
const COLORS = { base: '#4a7dbd', column: '#c0392b', arm: '#3f9e63', stage: '#d7a13b' };

let scad = '$fn = 64;\n';
for (const c of manifest.root.children) {
  const stl = join(DATA, 'versions', c.version, 'model.stl');
  const t = c.transform?.translate ?? [0, 0, 0];
  const r = c.transform?.rotate ?? [0, 0, 0];
  scad += `color("${COLORS[c.id] ?? '#888888'}") translate([${t.join(',')}]) rotate([${r.join(',')}]) import("${stl}");\n`;
}
// 镜筒/物镜/标本 的名义位置（仅作视觉参考：高度链 155 / 168 / 256 / 324）
scad += `
%color("gray", 0.35) translate([40,0,168]) cylinder(d=34, h=156);   // 镜筒 Ø34, 安装面→像面
%color("gray", 0.35) translate([40,0,155]) cube([25,75,1.37], center=false);  // 载玻片+盖玻片
`;

const tmp = join(WORK, '.tmp', 'assembly.scad');
await mkdir(join(WORK, '.tmp'), { recursive: true });
await mkdir(join(WORK, 'out'), { recursive: true });
await writeFile(tmp, scad, 'utf8');

const VIEWS = { iso: [65, 0, 25], front: [90, 0, 0], side: [0, 90, 0], top: [0, 0, 0] };
for (const [name, rot] of Object.entries(VIEWS)) {
  const png = join(WORK, 'out', `assembly-${name}.png`);
  const ok = await renderScadPng(tmp, png, { rotate: rot, imgSize: 900 });
  console.log(`${ok ? '✓' : '✗'} ${png}`);
}
await rm(tmp, { force: true });

// 底座底面（减料腔/配重腔 + 台墩 + 加强肋）——固定四视图看不到这一侧
const base = manifest.root.children.find((c) => c.id === 'base');
const baseScad = join(DATA, 'versions', base.version, 'model.scad');
for (const [name, rot] of Object.entries({ 'base-bottom': [180, 0, 0], 'base-iso-bottom': [115, 0, 200] })) {
  const png = join(WORK, 'out', `${name}.png`);
  const ok = await renderScadPng(baseScad, png, { rotate: rot, imgSize: 700 });
  console.log(`${ok ? '✓' : '✗'} ${png}`);
}
