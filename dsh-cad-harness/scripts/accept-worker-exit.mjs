// A worker-using script MUST terminate on its own.
//
// WHY: measured 2026-10-21 — `ensurePythonWorker()` spawns a DETACHED child whose
// stdin/stdout/stderr are pipes. Those handles keep the parent's event loop non-empty, so a
// script that finished its work printed its results and then sat there until an external
// `timeout` killed it. The symptom reads as "it ran halfway and hung"; every other
// acceptance missed it because they call process.exit() themselves or never wait.
//
// This test runs a MINIMAL script that deliberately does NOT call process.exit(), and
// asserts: it exits promptly, with code 0, and leaves no worker behind.
//
//   node scripts/accept-worker-exit.mjs
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PY = join(ROOT, '.tmp-cad-runtime', 'venv', 'bin', 'python');
const CORPUS = join(ROOT, '..', 'examples', 'toy-balance', 'cad-data', 'versions', 'v069', 'model.stl');
const BUDGET_MS = 20_000;

let failures = 0;
const check = (ok, label, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };

if (!existsSync(PY) || !existsSync(CORPUS)) {
  console.log('SKIP  the worker-exit tripwire — runtime or toy-balance corpus absent');
  process.exit(0);
}

const workers = () => {
  const r = spawnSync('ps', ['-eo', 'args'], { encoding: 'utf8' });
  return (r.stdout ?? '').split('\n').filter((l) => l.includes('cad_worker/worker.py') && !l.includes('ps -eo')).length;
};

const script = `
import { resolve } from 'node:path';
const { projectStores } = await import(${JSON.stringify(join(ROOT, 'src/host/project.ts'))});
const { checkPrintability } = await import(${JSON.stringify(join(ROOT, 'src/host/inspect.ts'))});
const project = await projectStores(resolve(${JSON.stringify(ROOT)}, '..', 'examples', 'toy-balance'));
const r = await checkPrintability(project.store, { versionId: 'v069', withSampleField: true });
console.log('field samples=' + Object.values(r.field?.samples ?? {}).flat().length);
// NO process.exit() on purpose: the event loop must drain by itself.
`;

const before = workers();
const t0 = Date.now();
const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
  cwd: ROOT,
  env: { ...process.env, DSH_CAD_PYTHON_ROOT: join(ROOT, '.tmp-cad-runtime') },
  encoding: 'utf8',
  timeout: BUDGET_MS,
});
const ms = Date.now() - t0;
const after = workers();

check(res.error?.code !== 'ETIMEDOUT', 'the script exited before the watchdog fired (it did not sit waiting)', `${ms} ms (budget ${BUDGET_MS} ms)`);
check((res.status ?? -1) === 0, 'and it exited cleanly', `status=${res.status} signal=${res.signal ?? '-'}`);
check(/field samples=\d+/.test(res.stdout ?? ''), 'after doing real worker work', (res.stdout ?? '').trim().slice(0, 60));
check(after <= before, 'and left no worker process behind', `before=${before} after=${after}`);
if (res.status !== 0) console.log((res.stderr ?? '').split('\n').slice(-6).join('\n'));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
