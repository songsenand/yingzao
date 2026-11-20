#!/usr/bin/env node
// L1.1 engine seam: compile(source, {kernel}) is the one entry; adapters need
// only compile; unknown/planned/duplicate registrations are refused; the
// render flag reaches the adapter without a second method.
import {
  compile, compileAndRender, compileStlOnly,
} from '../src/host/compile.ts';
import {
  engineAdapter, listEngineAdapters, registerEngineAdapter, unregisterEngineAdapter,
} from '../src/host/backends/index.ts';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const sentinel = new Uint8Array([0x53, 0x54, 0x4c, 0x31]);
const calls = [];
const fake = {
  id: 'fake-engine',
  async compile(source, opts = {}) {
    calls.push({ source, render: opts.render });
    return { success: true, stl: sentinel, renders: [], errors: [], warnings: [], datums: [], durationMs: 0 };
  },
};

try {
  check(listEngineAdapters().includes('openscad'), 'OpenSCAD is registered');
  const openscad = engineAdapter('openscad');
  check(openscad.id === 'openscad' && typeof openscad.compile === 'function', 'OpenSCAD resolves to a compile adapter');
  check(!('render' in openscad) && !('export' in openscad), 'the adapter exposes only compile');

  let unknown = '';
  try { await compile('cube(1);', { kernel: 'no-such-engine' }); } catch (error) { unknown = String(error?.message ?? error); }
  check(unknown.includes('backend_not_available') && unknown.includes('unknown kernel'), 'unknown kernel is refused', unknown);

  let planned = '';
  try { await compile('cube(1);', { kernel: 'freecad' }); } catch (error) { planned = String(error?.message ?? error); }
  check(planned.includes('backend_not_available') && planned.includes('planned'), 'planned kernel is refused, never substituted', planned);

  let invalid = '';
  try { registerEngineAdapter({ id: 'broken' }); } catch (error) { invalid = String(error?.message ?? error); }
  check(invalid.includes('engine_registration') && invalid.includes('compile'), 'registration refuses an adapter without compile', invalid);

  registerEngineAdapter(fake);
  check(engineAdapter('fake-engine') === fake, 'a registered adapter resolves by id');
  const built = await compile('SENTINEL', { kernel: 'fake-engine', render: true });
  check(built.success && built.stl === sentinel, 'compile() dispatches to the registered engine');
  check(calls.at(-1)?.render === true, 'compile() forwards render=true', JSON.stringify(calls.at(-1)));

  await compileStlOnly('SENTINEL', { kernel: 'fake-engine' });
  check(calls.at(-1)?.render === false, 'compileStlOnly() forwards render=false', JSON.stringify(calls.at(-1)));
  await compileAndRender('SENTINEL', { kernel: 'fake-engine' });
  check(calls.at(-1)?.render === true, 'compileAndRender() forwards render=true', JSON.stringify(calls.at(-1)));

  let duplicate = '';
  try { registerEngineAdapter(fake); } catch (error) { duplicate = String(error?.message ?? error); }
  check(duplicate.includes('already registered'), 'duplicate registration is refused', duplicate);

  check(unregisterEngineAdapter('fake-engine') === true, 'test adapter can be unregistered');
  let gone = '';
  try { await compile('x', { kernel: 'fake-engine' }); } catch (error) { gone = String(error?.message ?? error); }
  check(gone.includes('unknown kernel'), 'unregistered kernel is unknown again', gone);
} finally {
  unregisterEngineAdapter('fake-engine');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
