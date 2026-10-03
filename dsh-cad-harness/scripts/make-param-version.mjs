import { openVersionStore, saveVersion } from '../src/host/version.ts';
import { compileStlOnly } from '../src/host/compile.ts';
import { mkdtemp } from 'node:fs/promises';
const scad = `// 法兰盘（参数化）
flange_diameter = 60;  // PARAMS 法兰外径 mm
thickness = 8;         // PARAMS 厚度 mm
hole_diameter = 12;    // PARAMS 中心孔径 mm

difference() {
  cylinder(h = thickness, d = flange_diameter);
  cylinder(h = thickness * 2 + 2, d = hole_diameter, center = true);
}`;
const c = await compileStlOnly(scad);
if (!c.success) { console.error('compile failed'); process.exit(1); }
const store = openVersionStore('/home/songsenand/Project/ToyMarker/dsh-cad-harness/data');
const id = await saveVersion(store, { scadCode: scad, stl: c.stl, userIntent: '参数化法兰（customizer 测试）' });
console.log('created', id);
