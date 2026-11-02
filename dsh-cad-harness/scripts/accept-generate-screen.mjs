// Acceptance for representative-first: the FIRST version of a part is screened
// for thin walls, and an iteration (parentVersion set) is not.
//
// The glucose build generated v034-v037 (four sticks) before any printability
// call, so a 0.038mm lip shipped four times. The screen is in-process (TS, ~60ms)
// and its warning names the place; this test pins both halves.
//
//   node scripts/accept-generate-screen.mjs [--runtime <dir>]
//
// Needs OpenSCAD + the pinned Python runtime (generate_part compiles through the
// worker); not part of `npm run accept` for that reason.
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'cad-gen-screen-'));
process.env.DSH_CAD_PYTHON_ROOT = resolve(argOf('--runtime', join(REPO, 'dsh-cad-harness', '.tmp-cad-runtime')));

const venvPython = process.platform === 'win32'
  ? join(process.env.DSH_CAD_PYTHON_ROOT, 'venv', 'Scripts', 'python.exe')
  : join(process.env.DSH_CAD_PYTHON_ROOT, 'venv', 'bin', 'python');
if (!existsSync(venvPython)) {
  console.error(`no venv python at ${venvPython} — pass --runtime <dir> with a provisioned runtime`);
  process.exit(2);
}

const { registerCadTools } = await import('../src/host/tools.ts');
let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const tools = new Map();
const fakeCtx = {
  tools: { register: (def) => { tools.set(def.name, def); return () => {}; } },
  on: () => {},
  effect: (fn) => fn(),
  reflect: {
    get: (k) => (k === 'agentPresets'
      ? { list: async () => [{ id: 'cad', name: '造物模式' }] }
      : k === 'connection'
        ? { fetch: { register: () => () => {} }, rpc: { intercept: () => () => {} } }
        : undefined),
  },
};
registerCadTools(fakeCtx, { toolScope: 'preset', presets: ['cad'] });

const cwd = join(process.env.DSH_HOME, 'proj');
mkdirSync(cwd, { recursive: true });
const exec = { agent: { session: { header: { id: 'generate-screen', cwd } } } };
await tools.get('init_project').execute({ dir: cwd }, exec);
const generate = tools.get('generate_part');

const first = await generate.execute({
  scadCode: 'cube([10,10,0.5]);',
  userIntent: 'thin plate',
  part: 'plate',
  views: [],
}, exec);
check(typeof first.minWallMm === 'number' && Math.abs(first.minWallMm - 0.5) < 0.15,
  'the first version reports the thinnest wall', String(first.minWallMm));
check(first.warnings.some((w) => w.startsWith('first-version wall screen') && w.includes('0.5mm')),
  'the warning names the measured wall', first.warnings.find((w) => w.includes('wall screen')));
check(first.warnings.some((w) => w.includes('fix this representative')),
  'the warning says what to do before generating the family');
check(Array.isArray(first.minWallAtMm) && first.minWallAtMm.length === 3,
  'the warning carries the location', JSON.stringify(first.minWallAtMm));

const second = await generate.execute({
  scadCode: 'cube([10,10,0.6]);',
  userIntent: 'thicker plate',
  part: 'plate',
  parentVersion: first.versionId,
  views: [],
}, exec);
check(second.minWallMm === undefined, 'an iteration (parentVersion set) is not screened', String(second.minWallMm));
check(!second.warnings.some((w) => w.includes('wall screen')),
  'an iteration carries no first-version warning');

console.log(failures ? `\n${failures} FAIL` : '\nall PASS');
process.exit(failures ? 1 : 0);
