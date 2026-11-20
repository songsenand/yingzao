#!/usr/bin/env node
// L1.2 CadQuery provider: real compile + datum schema, classified failures,
// missing pack, and the doctor probe. The pack is an external, explicit
// capability: if it is absent this script still proves the missing-pack path
// and skips the real-compile half.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cadqueryPackStatus } from '../src/host/cadquery-pack.ts';
import { compile, compileAndRender } from '../src/host/compile.ts';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const savedPack = process.env.DSH_CAD_CQ_PACK;
const pack = await cadqueryPackStatus();
if (pack.installed) check(true, 'CadQuery pack is installed for this acceptance', `${pack.root} ${pack.version ?? ''}`.trim());
else console.log(`SKIP  CadQuery pack not installed at ${pack.root}`);
if (!pack.installed && process.env.DSH_CAD_REQUIRE_CQ === '1') {
  console.error('FAIL  DSH_CAD_REQUIRE_CQ=1 but the CadQuery pack is not installed');
  process.exit(1);
}

if (!pack.installed) {
  process.env.DSH_CAD_CQ_PACK = '/nonexistent/cadquery-pack';
  const missing = await compile('result = None', { kernel: 'cadquery' });
  check(!missing.success && missing.errorCode === 'cadquery_pack_missing', 'missing pack is a classified failure', missing.errorCode);
  check(Boolean(missing.fix?.includes('pip install')), 'missing pack carries an install fix', missing.fix);
  console.log('\nSKIP real-pack checks (pack not installed)');
  if (savedPack === undefined) delete process.env.DSH_CAD_CQ_PACK; else process.env.DSH_CAD_CQ_PACK = savedPack;
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
  process.exit(failures ? 1 : 0);
}

try {
  const source = `
import cadquery as cq
result = (
    cq.Workplane('XY').box(60, 40, 6).translate((0, 0, 3))
      .edges('|Z').fillet(4)
      .faces('>Z').workplane().rect(44, 26, forConstruction=True).vertices().hole(4.5)
)
datum('top', [0, 0, 6])
datum_plane('top_plane', [0, 0, 6], [0, 0, 1])
datum_axis('hole_axis', [22, 13, 0], [0, 0, 1])
datum_cyl('hole', [22, 13, 0], [0, 0, 1], 2.25)
`;
  const built = await compile(source, { kernel: 'cadquery', timeoutMs: 60000 });
  check(built.success, 'CadQuery compiles the bracket', built.errors.join('; '));
  check((built.stl?.length ?? 0) > 1000, 'the compile returns STL bytes', String(built.stl?.length));
  check(built.datumSet?.points?.[0]?.name === 'top', 'datum() reaches the shared points schema', JSON.stringify(built.datumSet?.points));
  check(built.datumSet?.planes?.[0]?.normal?.[2] === 1, 'datum_plane() reaches the shared planes schema');
  check(built.datumSet?.axes?.[0]?.dir?.[2] === 1, 'datum_axis() reaches the shared axes schema');
  check(built.datumSet?.cylinders?.[0]?.radius === 2.25, 'datum_cyl() reaches the shared cylinders schema');

  const withStep = await compile(source, { kernel: 'cadquery', step: true, timeoutMs: 60000 });
  check(withStep.success && (withStep.step?.length ?? 0) > 1000, 'CadQuery can export native STEP', String(withStep.step?.length));
  check(withStep.meta?.kernel === 'cadquery' && withStep.meta?.brepValid === true, 'STEP carries provider BRepCheck provenance', JSON.stringify(withStep.meta));

  const exited = await compile('import sys\nsys.exit(0)', { kernel: 'cadquery', timeoutMs: 60000 });
  check(!exited.success && exited.errorCode === 'cadquery_exit', 'sys.exit is classified, not a crash', exited.errorCode);
  check(Boolean(exited.fix?.includes('remove sys.exit')), 'sys.exit carries a fix', exited.fix);
  const nan = await compile('datum("bad", [float("nan"), 0, 0])', { kernel: 'cadquery', timeoutMs: 60000 });
  check(!nan.success && nan.errorCode === 'cadquery_exception' && !String(nan.errors).includes('JSON'), 'NaN datum is a model error, not a JSON crash', nan.errorCode);

  const rendered = await compileAndRender('result = cq.Workplane("XY").box(2, 2, 2)', { kernel: 'cadquery', timeoutMs: 60000 });
  check(rendered.success, 'compileAndRender dispatches to CadQuery');
  check((rendered.renders?.length ?? 0) === 0, 'CadQuery does not fake OpenSCAD renders');

  for (const [name, code, opts, expected] of [
    ['syntax error', 'result = cq.Workplane(', {}, 'cadquery_syntax'],
    ['runtime exception', 'raise RuntimeError("boom")', {}, 'cadquery_exception'],
    ['no result', 'x = 1', {}, 'cadquery_no_result'],
    ['timeout', 'while True:\n    pass\n', { timeoutMs: 1000 }, 'cadquery_timeout'],
  ]) {
    const failed = await compile(code, { kernel: 'cadquery', ...opts });
    check(!failed.success && failed.errorCode === expected, `${name} is classified`, `${failed.errorCode}: ${failed.errors.join('; ')}`);
    check(Boolean(failed.fix), `${name} carries a fix`, failed.fix?.slice(0, 90));
  }

  const doctor = spawnSync(process.execPath, [fileURLToPath(new URL('./doctor.mjs', import.meta.url)), '--json'], {
    encoding: 'utf8', timeout: 60000, env: { ...process.env, DSH_CAD_CQ_PACK: pack.root },
  });
  let report = null;
  try { report = JSON.parse(doctor.stdout); } catch { /* checked below */ }
  const cqCheck = report?.checks?.find((c) => c.id === 'cadquery');
  check(cqCheck?.status === 'pass', 'doctor probes the CadQuery pack', cqCheck?.detail ?? doctor.stderr.slice(0, 120));
} finally {
  if (savedPack === undefined) delete process.env.DSH_CAD_CQ_PACK; else process.env.DSH_CAD_CQ_PACK = savedPack;
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
