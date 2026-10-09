// Acceptance for the migrated `import_part` domain half (batch 2).
//
// WHY GROUND TRUTH INSTEAD OF AN ORACLE. Every other batch-1 tool kept its TS
// implementation as a parity oracle. Import is the exception, deliberately: the TS
// parser counted degenerate facets and then dropped the count (`parseStl` returned
// `degenerate: 0`), so keeping it as an oracle would enshrine a defect. The checks
// below therefore assert ARITHMETIC the mesh cannot fudge — a 20mm cube is 8000mm³,
// one inch is 25.4mm, two disjoint cubes are two shells — plus the refusals.
//
//   node scripts/accept-import-parity.mjs [--runtime <dir>]

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importGeometry } from '../src/host/import.ts';
import { parseBinaryStl, writeBinaryStl } from '../src/host/mesh.ts';
import { resetPythonWorker } from '../src/host/python-worker.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const REPO = resolve(ROOT, '..');
const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const index = args.indexOf(flag);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  return fallback;
};
process.env.DSH_CAD_PYTHON_ROOT = resolve(argOf('--runtime', join(REPO, '.tmp-measure-runtime')));

const venvPython = process.platform === 'win32'
  ? join(process.env.DSH_CAD_PYTHON_ROOT, 'venv', 'Scripts', 'python.exe')
  : join(process.env.DSH_CAD_PYTHON_ROOT, 'venv', 'bin', 'python');
if (!existsSync(venvPython)) {
  console.error(`no venv python at ${venvPython} — provision the runtime first (or pass --runtime <dir>)`);
  process.exit(2);
}

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const close = (a, b, tolerance = 0.01) => Math.abs(a - b) <= tolerance;

const { compileStlOnly } = await import('../src/host/compile.ts');
const dir = mkdtempSync(join(tmpdir(), 'cad-import-parity-'));
const write = (name, bytes) => {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
};

const asciiStl = (mesh) => {
  const lines = ['solid test'];
  for (let t = 0; t < mesh.triVerts.length; t += 3) {
    lines.push('facet normal 0 0 0', '  outer loop');
    for (let k = 0; k < 3; k++) {
      const v = mesh.triVerts[t + k] * 3;
      lines.push(`    vertex ${mesh.vertProperties[v]} ${mesh.vertProperties[v + 1]} ${mesh.vertProperties[v + 2]}`);
    }
    lines.push('  endloop', 'endfacet');
  }
  lines.push('endsolid test');
  return Buffer.from(lines.join('\n'), 'utf8');
};

const cube = await compileStlOnly('cube(20, center=true);');
check(cube.success, 'compiled a 20mm cube');
const cubeMesh = parseBinaryStl(cube.stl);

console.log('--- a 20mm cube: the arithmetic is the assertion ---');
{
  const path = write('cube.stl', cube.stl);
  const imported = await importGeometry({ file: path, cwd: dir });
  check(imported.solid && imported.watertight, 'a closed cube imports as a solid');
  check(close(imported.volumeMm3, 8000, 0.01), 'volume is 8000 mm³', `${imported.volumeMm3} mm³`);
  check(close(imported.signedVolumeMm3, 8000, 0.01), 'signed volume is positive (winding is right)', `${imported.signedVolumeMm3} mm³`);
  check(imported.triangles === 12, 'twelve triangles', `${imported.triangles}`);
  check(imported.shells === 1, 'one shell', `${imported.shells}`);
  check(imported.degenerate === 0, 'no degenerate facets', `${imported.degenerate}`);
  check(imported.genus === 0, 'genus 0', `${imported.genus}`);
  check(imported.format === 'stl-binary', 'recognised as binary STL', imported.format);
  check(imported.boundingBoxMm.size.every((v, axis) => close(v, [20, 20, 20][axis])), 'bounding size is 20×20×20', imported.boundingBoxMm.size.join(' × '));
  check(imported.repaired.length === 0, 'nothing to repair', imported.repaired.join('; ') || 'none');
  check(imported.sha256 === (await import('node:crypto')).createHash('sha256').update(cube.stl).digest('hex'), 'sha256 is of the FILE bytes');
}

console.log('--- units are a declaration: one inch is 25.4mm ---');
{
  const path = write('cube-inch.stl', cube.stl);
  const imported = await importGeometry({ file: path, cwd: dir, unit: 'inch' });
  check(close(imported.appliedScale, 25.4, 1e-9), 'appliedScale is 25.4', String(imported.appliedScale));
  check(close(imported.volumeMm3, 8000 * 25.4 ** 3, 1), 'volume scales by 25.4³', `${imported.volumeMm3.toFixed(0)} mm³`);
  check(imported.boundingBoxMm.size.every((v) => close(v, 508, 0.01)), 'bounding size is 508×508×508', imported.boundingBoxMm.size.join(' × '));
}

console.log('--- the ASCII flavour of the same cube ---');
{
  const path = write('cube-ascii.stl', asciiStl(cubeMesh));
  const imported = await importGeometry({ file: path, cwd: dir });
  check(imported.format === 'stl-ascii', 'recognised as ASCII STL', imported.format);
  check(close(imported.volumeMm3, 8000, 0.01), 'same volume as the binary cube', `${imported.volumeMm3} mm³`);
  check(imported.triangles === 12 && imported.solid, 'twelve triangles, still a solid');
}

console.log('--- two disjoint bodies ---');
{
  const a = parseBinaryStl(cube.stl);
  const b = parseBinaryStl(cube.stl);
  const verts = [...a.vertProperties, ...Array.from(b.vertProperties, (v, i) => (i % 3 === 0 ? v + 60 : v))];
  const tris = [...a.triVerts, ...Array.from(b.triVerts, (v) => v + a.vertProperties.length / 3)];
  const path = write('two-cubes.stl', writeBinaryStl({ vertProperties: new Float32Array(verts), triVerts: new Uint32Array(tris) }));
  const imported = await importGeometry({ file: path, cwd: dir });
  check(imported.shells === 2, 'two shells are reported', `${imported.shells}`);
  check(imported.warnings.some((w) => /2 separate bodies/.test(w)), 'and the warning says so', imported.warnings.join(' | ').slice(0, 100));
  check(close(imported.volumeMm3, 16000, 0.01), 'volume is the sum of both', `${imported.volumeMm3} mm³`);
}

console.log('--- an open mesh is refused, and says why ---');
{
  const open = { vertProperties: cubeMesh.vertProperties, triVerts: cubeMesh.triVerts.slice(0, cubeMesh.triVerts.length - 3) };
  const path = write('open.stl', writeBinaryStl(open));
  let message = '';
  try { await importGeometry({ file: path, cwd: dir }); } catch (error) { message = String(error?.message ?? error); }
  check(/is not a closed solid/.test(message) && /edge\(s\) are not shared/.test(message), 'refused with the edge diagnosis', message.split('.')[0].slice(0, 120));
  const allowed = await importGeometry({ file: path, cwd: dir, allowNonSolid: true });
  check(allowed.solid === false && allowed.warnings.some((w) => /NOT A SOLID/.test(w)), 'allowNonSolid stores it and warns', allowed.warnings[0]?.slice(0, 80));
}

console.log('--- inside-out winding is its own failure ---');
{
  const flipped = { vertProperties: cubeMesh.vertProperties, triVerts: cubeMesh.triVerts.slice() };
  for (let t = 0; t < flipped.triVerts.length; t += 3) {
    const swap = flipped.triVerts[t + 1];
    flipped.triVerts[t + 1] = flipped.triVerts[t + 2];
    flipped.triVerts[t + 2] = swap;
  }
  const path = write('flipped.stl', writeBinaryStl(flipped));
  let message = '';
  try { await importGeometry({ file: path, cwd: dir }); } catch (error) { message = String(error?.message ?? error); }
  check(/wound inside-out/.test(message) && /-8000/.test(message), 'refused as inside-out with the negative volume', message.split('.')[0].slice(0, 120));
}

console.log('--- degenerate facets are now REPORTED (the TS parser dropped the count) ---');
{
  const degenerate = { vertProperties: cubeMesh.vertProperties, triVerts: cubeMesh.triVerts.slice() };
  degenerate.triVerts[1] = degenerate.triVerts[0]; // a facet with a repeated vertex
  const path = write('degenerate.stl', writeBinaryStl(degenerate));
  const imported = await importGeometry({ file: path, cwd: dir, allowNonSolid: true });
  check(imported.degenerate === 1, 'the degenerate facet is counted', `${imported.degenerate}`);
  check(imported.repaired.some((r) => /degenerate triangles discarded during parse/.test(r)), 'and named in repaired', imported.repaired.join('; '));
}

console.log('--- a real corpus part, against numbers measured earlier ---');
{
  const path = join(REPO, 'examples', 'microscope4', 'cad-data', 'runs', 'r024', 'parts', '整机.stl');
  const imported = await importGeometry({ file: path, cwd: dir });
  check(imported.solid, '整机 imports as a solid');
  check(close(imported.volumeMm3, 710012.998, 0.01), 'volume matches the Manifold measurement', `${imported.volumeMm3} mm³`);
  check(imported.triangles === 28830, 'triangle count matches', `${imported.triangles}`);
  check(imported.shells === 26, 'shell count matches', `${imported.shells}`);
  check(imported.boundingBoxMm.size.every((v, axis) => close(v, [150, 172, 304.88][axis], 0.01)), 'bounding size matches', imported.boundingBoxMm.size.join(' × '));
}

rmSync(dir, { recursive: true, force: true });
resetPythonWorker();
console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
