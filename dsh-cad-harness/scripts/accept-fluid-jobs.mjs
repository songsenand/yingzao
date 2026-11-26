// N15 acceptance — fluid run progress and cancellation, without a fluid run.
//
// A real fluid solve is 161 s; testing "it shows a percentage" by waiting 161 s is
// not a test anyone will rerun. The two halves are separable:
//
//   * the REGISTRY — who is running, how far, and whether a cancel stuck;
//   * the WORKER PROTOCOL — progress frames in, monotonic percentages out, and a
//     killed process that takes its pending request with it.
//
// The protocol half drives a real child process (a Node script that speaks the
// worker's JSON-lines frames), so "cancel leaves no orphan" is checked against a
// real pid, not a mock.
//
//   node scripts/accept-fluid-jobs.mjs

import { spawn } from 'node:child_process';
import { FluidJobRegistry } from '../src/host/fluid-jobs.ts';
import { PythonWorker } from '../src/host/python-worker.ts';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (fn, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(25); }
  return false;
};

console.log('fluid jobs acceptance\n');

// ── 1. registry: progress, completion, monotonicity ────────────────────────
{
  const registry = new FluidJobRegistry();
  const id = registry.start({
    versionId: 'v010',
    run: async (onProgress) => {
      for (let step = 10; step <= 50; step += 10) { onProgress(step, 50); await sleep(5); }
      return { stepsRun: 50 };
    },
    cancel: () => {},
  });
  check(registry.get(id)?.status === 'running', 'a started job is running');
  await waitFor(() => registry.get(id)?.status === 'done');
  const record = registry.get(id);
  check(record?.status === 'done', 'it completes', record?.status);
  check(record?.done === 50 && record?.total === 50, 'the final record is 100%', `${record?.done}/${record?.total}`);
  check(Boolean(record?.finishedAt), 'and carries a finish time');
  check(record?.versionId === 'v010', 'the version it is about is kept');

  // A late frame must not rewind the bar.
  const id2 = registry.start({
    run: async (onProgress) => {
      onProgress(30, 100); onProgress(20, 100);   // out of order on purpose
      await sleep(5);
      return null;
    },
    cancel: () => {},
  });
  await waitFor(() => registry.get(id2)?.status === 'done');
  check(registry.get(id2)?.done === 100, 'progress never moves backwards (and completes)', String(registry.get(id2)?.done));
}

// ── 2. registry: cancellation is recorded immediately, failure is not ──────
{
  const registry = new FluidJobRegistry();
  let killed = 0;
  let rejectRun = null;
  const id = registry.start({
    run: (onProgress) => new Promise((resolve, reject) => {
      rejectRun = reject;
      onProgress(5, 200);
      // never resolves: the cancel must be what ends it
    }),
    cancel: () => { killed++; rejectRun?.(new Error('worker killed')); },
  });
  await sleep(20);
  check(registry.get(id)?.status === 'running' && registry.get(id)?.done === 5, 'a long job reports partial progress');
  const cancelled = registry.cancel(id);
  check(cancelled === true, 'cancel reports that it took effect');
  check(registry.get(id)?.status === 'cancelled', 'the record is cancelled SYNCHRONOUSLY (a poll cannot see "running" again)');
  check(killed === 1, 'the caller\'s killer ran exactly once', String(killed));
  await sleep(50);
  check(registry.get(id)?.status === 'cancelled' && registry.get(id)?.error === undefined,
    'the rejection that follows a cancel is NOT recorded as a failure');
  check(registry.cancel(id) === false, 'cancelling twice is a no-op');
}

// ── 3. registry: a real failure is recorded ────────────────────────────────
{
  const registry = new FluidJobRegistry();
  const id = registry.start({
    run: async () => { throw new Error('solver diverged'); },
    cancel: () => {},
  });
  await waitFor(() => registry.get(id)?.status === 'failed');
  check(registry.get(id)?.status === 'failed', 'a failing run is recorded as failed');
  check(/solver diverged/.test(registry.get(id)?.error ?? ''), 'with its message', registry.get(id)?.error);
}

// ── 4. registry: prune keeps running jobs ─────────────────────────────────
{
  const registry = new FluidJobRegistry();
  const id = registry.start({ run: () => new Promise(() => {}), cancel: () => {} });
  check(registry.prune(0) === 0 && registry.get(id) !== null, 'prune never drops a running job');
}

// ── 5. worker protocol: progress frames reach the caller in order ──────────
{
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const readline = (await import('node:readline')).createInterface({ input: process.stdin });
    console.log(JSON.stringify({ type: 'hello', protocolVersion: 3, python: 'fake', pid: process.pid, ops: ['fluid_run'] }));
    readline.on('line', async (line) => {
      const frame = JSON.parse(line);
      if (frame.op !== 'fluid_run') return;
      const steps = frame.params.steps ?? 40;
      for (let done = 10; done <= steps; done += 10) {
        console.log(JSON.stringify({ type: 'progress', id: frame.id, done, total: steps }));
      }
      console.log(JSON.stringify({ id: frame.id, ok: true, result: { stepsRun: steps } }));
    });
  `], { stdio: ['pipe', 'pipe', 'pipe'] });
  const worker = new PythonWorker(child);
  await waitFor(() => worker.hello !== null, 5000);
  check(worker.hello?.ops?.includes('fluid_run') === true, 'the fake worker completed its handshake');
  const seen = [];
  const result = await worker.request('fluid_run', { steps: 40 }, {
    onProgress: (done, total) => seen.push(`${done}/${total}`),
  });
  check(JSON.stringify(result) === JSON.stringify({ stepsRun: 40 }), 'the request still resolves with its result');
  check(seen.join(' ') === '10/40 20/40 30/40 40/40', 'progress frames arrive in order', seen.join(' '));
  worker.stop();
}

// ── 6. worker protocol: cancel kills the process and rejects the request ───
{
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const readline = (await import('node:readline')).createInterface({ input: process.stdin });
    console.log(JSON.stringify({ type: 'hello', protocolVersion: 3, python: 'fake', pid: process.pid, ops: ['fluid_run'] }));
    readline.on('line', () => {
      console.log(JSON.stringify({ type: 'progress', id: 1, done: 1, total: 1000 }));
      // never finishes: only the kill ends this
    });
  `], { stdio: ['pipe', 'pipe', 'pipe'] });
  const worker = new PythonWorker(child);
  await waitFor(() => worker.hello !== null, 5000);
  const pid = worker.processId;
  const seen = [];
  let rejected = '';
  const pending = worker.request('fluid_run', {}, { onProgress: (done) => seen.push(done) })
    .catch((error) => { rejected = String(error?.message ?? error); });
  check(await waitFor(() => seen.length > 0), 'the long op reports at least one progress frame');
  const t0 = Date.now();
  worker.stop();
  await pending;
  const elapsed = Date.now() - t0;
  check(elapsed < 1000, 'the pending request settles within a second of the kill', `${elapsed}ms`);
  check(/stopped|exited/i.test(rejected), 'and it rejects (the caller is not left waiting)', rejected);
  // No orphan: the process is gone.
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  await sleep(50);
  try { process.kill(pid, 0); } catch { alive = false; }
  check(alive === false, 'the worker process is gone (no orphan)', `pid ${pid}`);
}

console.log(failures ? `\naccept-fluid-jobs: ${failures} FAILURE(S)` : '\naccept-fluid-jobs: PASS');
process.exit(failures ? 1 : 0);
