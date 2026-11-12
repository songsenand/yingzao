#!/usr/bin/env node
// N15/N17 acceptance: a compile job returns an id, finishes, can be cancelled,
// survives a new store instance, and a restart kills an orphan process.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openVersionStore } from '../src/host/version.ts';
import { getJob, listJobs, openJobStore, startCompileJob } from '../src/host/jobs.ts';
import { apply } from '../src/host/index.ts';

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(store, id, want, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const job = getJob(store, id);
    if (job && job.status === want) return job;
    await sleep(100);
  }
  return getJob(store, id);
}
function dead(pid) {
  try { process.kill(pid, 0); return false; } catch { return true; }
}

const project = mkdtempSync(join(tmpdir(), 'cad-jobs-'));
try {
  const data = join(project, 'cad-data');
  mkdirSync(join(data, 'versions', 'v001'), { recursive: true });
  writeFileSync(join(data, 'versions', 'v001', 'model.scad'), 'cube([2,2,2]);\n');
  mkdirSync(join(data, 'versions', 'v002'), { recursive: true });
  writeFileSync(join(data, 'versions', 'v002', 'model.scad'),
    'for (i=[0:30]) translate([i*2,0,0]) sphere($fn=120);\n');
  mkdirSync(join(data, 'versions', 'v003'), { recursive: true });
  writeFileSync(join(data, 'versions', 'v003', 'model.scad'),
    'for (i=[0:2000]) translate([i*3,0,0]) sphere($fn=64);\n');
  const versions = openVersionStore(data);
  const store = openJobStore(data);

  const done = await startCompileJob({ store, versions, project, versionId: 'v001', timeoutMs: 20_000 });
  check('submit returns an id immediately', done.id === 'j001' && done.status === 'running', JSON.stringify(done));
  const finished = await waitFor(store, 'j001', 'done');
  check('job finishes', finished?.status === 'done', finished?.error);
  check('job wrote an STL', Boolean(finished?.output) && existsSync(finished.output));

  const cancelled = await startCompileJob({ store, versions, project, versionId: 'v002', timeoutMs: 20_000 });
  const cancelResult = await (await import('../src/host/jobs.ts')).cancelJob(store, cancelled.id);
  check('cancel returns cancelled', cancelResult?.status === 'cancelled', cancelResult?.status);
  await sleep(300);
  check('canceled pid is gone', !cancelled.pid || dead(cancelled.pid));

  const timed = await startCompileJob({ store, versions, project, versionId: 'v003', timeoutMs: 1_000 });
  const timedOut = await waitFor(store, timed.id, 'timeout', 10_000);
  check('timeout is marked timeout, not failed', timedOut?.status === 'timeout', timedOut?.status);

  const cancelledIds = [];
  for (let i = 0; i < 10; i++) {
    const job = await startCompileJob({ store, versions, project, versionId: 'v002', timeoutMs: 20_000 });
    await (await import('../src/host/jobs.ts')).cancelJob(store, job.id);
    cancelledIds.push({ id: job.id, pid: job.pid });
  }
  await sleep(400);
  check('10 cancels all reach cancelled', cancelledIds.every(({ id }) => getJob(store, id)?.status === 'cancelled'));
  check('10 cancels leave no live pid', cancelledIds.every(({ pid }) => !pid || dead(pid)));

  const burst = [];
  for (let i = 0; i < 4; i++) burst.push(await startCompileJob({ store, versions, project, versionId: 'v002', timeoutMs: 20_000 }));
  let limited = '';
  try { await startCompileJob({ store, versions, project, versionId: 'v002', timeoutMs: 20_000 }); }
  catch (error) { limited = String(error?.message ?? error); }
  check('concurrency gate refuses the fifth job', limited.includes('concurrency limit'), limited);
  await Promise.all(burst.map((job) => (import('../src/host/jobs.ts')).then((m) => m.cancelJob(store, job.id))));
  await sleep(200);

  const listed = listJobs(openJobStore(data));
  check('a new store instance sees all jobs', listed.length >= 13 && listed.some((j) => j.id === 'j001') && listed.some((j) => j.id === 'j002'));

  // Orphan: a running row from a previous server whose pid is alive.
  const orphan = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  const orphanDir = join(data, 'jobs', 'j099');
  mkdirSync(orphanDir, { recursive: true });
  writeFileSync(join(orphanDir, 'job.json'), JSON.stringify({
    schemaVersion: 1, id: 'j099', kind: 'compile', status: 'running',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    project, versionId: 'v001', pid: orphan.pid, timeoutMs: 20_000,
  }, null, 2));
  const after = listJobs(openJobStore(data)).find((j) => j.id === 'j099');
  check('restart marks the orphan failed', after?.status === 'failed', after?.status);
  await sleep(300);
  check('restart kills the orphan process', orphan.pid ? dead(orphan.pid) : true);

  // HTTP surface: submit returns an id, one/id exposes the same row.
  const routes = new Map();
  const connection = { fetch: { register(route) { routes.set(route.path, route); return async () => {}; } } };
  const ctx = {
    connection,
    reflect: { get: (key) => (key === 'connection' ? connection : undefined), set: () => {} },
    tools: { register() { return () => {}; }, restrict() {} },
    attachments: {},
    on() { return () => {}; },
    effect(fn) { try { fn(); } catch { /* startup effects are not under test */ } },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
  apply(ctx, { toolScope: 'all' });
  const submit = routes.get('/api/cad/jobs/compile');
  const one = routes.get('/api/cad/jobs/one');
  check('job routes are registered', Boolean(submit) && Boolean(one));
  const submitted = await submit.fetch(new Request(`http://x/api/cad/jobs/compile?project=${encodeURIComponent(project)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ versionId: 'v001' }),
  }));
  const submittedBody = await submitted.json();
  check('HTTP submit returns 202 + id', submitted.status === 202 && Boolean(submittedBody.job?.id), `${submitted.status} ${JSON.stringify(submittedBody)}`);
  const remote = await one.fetch(new Request(`http://x/api/cad/jobs/one?project=${encodeURIComponent(project)}&id=${submittedBody.job.id}`));
  const remoteBody = await remote.json();
  check('HTTP status sees the job', remote.status === 200 && remoteBody.job?.id === submittedBody.job.id);
  check('HTTP job is the same kind', remoteBody.job?.kind === 'compile');
} finally {
  rmSync(project, { recursive: true, force: true });
}

console.log(`\naccept-jobs: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
