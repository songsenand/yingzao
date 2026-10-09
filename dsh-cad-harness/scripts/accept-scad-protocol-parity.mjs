// Acceptance for the migrated SCAD text protocol (batch 2: what `generate_part`
// and `render_part` are actually made of).
//
// WHAT MOVED AND WHY. The datum prelude is the WRITER half of the harness's
// interface contract and the echo parser is the READER half; they belong in one
// place. `// PARAMS` parsing and OpenSCAD's ERROR/WARNING unwrapping are the same
// kind of domain text work. What stayed in TypeScript is the OpenSCAD PROCESS —
// binary discovery (system binary, bundled snapshot, xvfb), timeouts, temp files
// and image handling — because that is about this machine, not about geometry.
//
// The checks are therefore:
//   1. exact parsing of synthetic OpenSCAD output (the four datum tags, errors,
//      warnings, Trace/In-file),
//   2. the prelude really declares the four modules and their echo tags, and is
//      cached across calls,
//   3. `// PARAMS` parsing including negative/decimal values and non-top-level lines,
//   4. a REAL compile: datums declared in SCAD must come back through the worker's
//      parser with the right values,
//   5. a REAL failure: a syntax error must still produce readable errors.
//
//   node scripts/accept-scad-protocol-parity.mjs [--runtime <dir>]

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileStlOnly, datumPrelude, parseParams, scadParseOutput } from '../src/host/compile.ts';
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
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('--- synthetic OpenSCAD output ---');
{
  const raw = [
    'ECHO: "__DATUM__top=0,0,10"',
    'ECHO: "__DATUM__corner=-1.5,2,3e-2"',
    'ECHO: "__DATUM_AXIS__ax=1,2,3|0,1,0"',
    'ECHO: "__DATUM_PLANE__pl=0,0,0|0,0,1"',
    'ECHO: "__DATUM_CYL__hole=5,5,0|0,0,1|2.5"',
    'WARNING: Ignoring unknown variable',
    'ERROR: Current top level object is not a 2D object.',
    'Trace: called from line 3',
    'In file: model.scad',
    'ECHO: "unrelated"',
  ].join('\n');
  const solved = await scadParseOutput(raw);
  check(solved.errors.length === 3, 'three error lines are collected (ERROR + Trace + In file)', `${solved.errors.length}`);
  check(solved.errors[0] === 'Current top level object is not a 2D object.', 'ERROR: prefix is stripped', solved.errors[0]);
  check(solved.warnings.length === 1 && solved.warnings[0] === 'Ignoring unknown variable', 'WARNING: prefix is stripped', solved.warnings[0]);
  check(same(solved.datumSet.points, [
    { name: 'top', point: [0, 0, 10] },
    { name: 'corner', point: [-1.5, 2, 0.03] },
  ]), 'point datums parse with signs and exponents', JSON.stringify(solved.datumSet.points));
  check(same(solved.datumSet.axes, [{ name: 'ax', point: [1, 2, 3], dir: [0, 1, 0] }]), 'axis datums parse', JSON.stringify(solved.datumSet.axes));
  check(same(solved.datumSet.planes, [{ name: 'pl', point: [0, 0, 0], normal: [0, 0, 1] }]), 'plane datums parse', JSON.stringify(solved.datumSet.planes));
  check(same(solved.datumSet.cylinders, [{ name: 'hole', point: [5, 5, 0], dir: [0, 0, 1], radius: 2.5 }]), 'cylinder datums parse', JSON.stringify(solved.datumSet.cylinders));
}

console.log('--- the prelude is the writer half of that protocol ---');
{
  const first = await datumPrelude();
  const second = await datumPrelude();
  check(first === second, 'the prelude is cached (one round trip)');
  for (const token of ['module datum(', 'module datum_axis(', 'module datum_plane(', 'module datum_cyl(']) {
    check(first.includes(token), `declares ${token}…`);
  }
  for (const tag of ['__DATUM__', '__DATUM_AXIS__', '__DATUM_PLANE__', '__DATUM_CYL__']) {
    check(first.includes(tag), `emits ${tag}`);
  }
}

console.log('--- // PARAMS ---');
{
  const scad = [
    'flange_diameter = 60;  // PARAMS 法兰外径 mm',
    'thickness = 8;         // PARAMS 厚度 mm',
    'offset = -1.25;        // PARAMS negative and decimal',
    'not_a_param = 3;       // ordinary comment',
    'module inner() { wall = 2; // PARAMS nested declarations are not tunables',
    '}',
  ].join('\n');
  const found = await parseParams(scad);
  check(found.length === 3, 'three tunables are found', `${found.length}`);
  check(same(found[0], { name: 'flange_diameter', value: 60, desc: '法兰外径 mm' }), 'name, value and description', JSON.stringify(found[0]));
  check(found[2]?.value === -1.25, 'negative decimals are kept', String(found[2]?.value));
}

console.log('--- a real compile: datums declared in SCAD come back ---');
{
  const scad = [
    'datum("top", [0, 0, 10]);',
    'datum_axis("ax", [1, 2, 3], [0, 1, 0]);',
    'datum_plane("pl", [0, 0, 0], [0, 0, 1]);',
    'datum_cyl("hole", [5, 5, 0], [0, 0, 1], 2.5);',
    'cube(20, center=true);',
  ].join('\n');
  const compiled = await compileStlOnly(scad);
  check(compiled.success, 'the part compiles', compiled.errors.join('; ') || 'ok');
  const set = compiled.datumSet;
  check(JSON.stringify(set.points) === JSON.stringify([{ name: 'top', point: [0, 0, 10] }]), 'the point datum survives the real pipeline', JSON.stringify(set.points));
  check(set.axes[0]?.name === 'ax' && set.axes[0]?.dir[1] === 1, 'the axis datum survives', JSON.stringify(set.axes));
  check(set.planes[0]?.name === 'pl', 'the plane datum survives', JSON.stringify(set.planes));
  check(set.cylinders[0]?.radius === 2.5, 'the cylinder datum survives', JSON.stringify(set.cylinders));
  check(compiled.datums.length === 1, 'datums mirrors datumSet.points', `${compiled.datums.length}`);
}

console.log('--- a real failure still reads like a failure ---');
{
  const broken = 'cube([10,10,10;\n'; // missing bracket
  const compiled = await compileStlOnly(broken);
  check(compiled.success === false, 'the broken source does not compile');
  check(compiled.errors.length > 0, 'and the errors are non-empty', compiled.errors.join(' | ').slice(0, 120));
}

resetPythonWorker();
console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
