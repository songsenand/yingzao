// Scan dsh-plugin-shop-catalog for plugins overlapping our CAD harness domains.
import { readFileSync, writeFileSync } from 'node:fs';

const catalog = JSON.parse(readFileSync(
  '/home/songsenand/Project/ToyMarker/.tmp-m4/catalog/package/v1/plugins.2735b62a32078730aed5d438397b4baed256b4abd40c84aeb2633fb776571831.json',
  'utf8',
));
const plugins = catalog.plugins;

const summaryOf = (p) => {
  const s = (p.catalog?.summary) ?? {};
  if (typeof s === 'string') return { en: s, zh: '' };
  return { en: s.en ?? '', zh: s.zh ?? '' };
};

const domains = {
  'CAD-建模': ['openscad', 'scad', 'cad', 'stl', '3mf', 'step file', 'parametric', 'solidworks', 'freecad', 'fusion', 'blender', 'gcode', '3d print', '3d-print', 'slicer'],
  '物理-仿真': ['physics', 'rapier', 'rigid body', 'rigid-body', 'simulation', 'simulator', 'finite element', ' fea', 'dyna'],
  '流体-粒子-MPM': ['fluid', 'mpm', 'particle', 'cfd', 'smoke', 'navier', 'sph'],
  '3D渲染-查看器': ['three.js', 'threejs', 'three.js', 'webgl', 'webgpu', '3d view', '3d-view', 'mesh viewer', 'obj viewer', 'gltf', 'gltf', 'babylon', 'voxel', 'point cloud', '3d scene'],
  '图像视觉': ['vision', 'multimodal', 'screenshot', 'image analysis', 'read_image', 'describe_image', 'ocr'],
  '版本管理': ['version control', 'versioning', 'version histor', 'rollback', 'immutable'],
};

const out = {};
for (const [dom, kws] of Object.entries(domains)) {
  const hits = [];
  for (const p of plugins) {
    const name = (p.name ?? '').toLowerCase();
    const { en, zh } = summaryOf(p);
    const text = `${name} ${en} ${zh}`.toLowerCase();
    const kw = kws.find((k) => text.includes(k));
    if (kw) {
      hits.push({
        name: p.name,
        version: p.version ?? '',
        keyword: kw,
        category: p.catalog?.category ?? '',
        summary: (en || zh).slice(0, 150),
        repository: p.repository ?? '',
      });
    }
  }
  out[dom] = hits;
}

for (const [dom, hits] of Object.entries(out)) {
  console.log(`\n===== ${dom}: ${hits.length} hits =====`);
  for (const h of hits) {
    console.log(`${h.name} | ${h.version} | [${h.keyword}] ${h.summary}`);
  }
}
writeFileSync('/home/songsenand/Project/ToyMarker/.tmp-m4/scan-result.json', JSON.stringify(out, null, 2));
console.log('\nsaved to .tmp-m4/scan-result.json');
