// Background compile jobs: a submit returns an id immediately, state survives a
// restart, and cancel kills the process group rather than abandoning a promise.
//
// Scope: one compile job, dispatched by the version's backend pin. OpenSCAD is
// still an external child process; CadQuery runs through the provider (which
// owns its own subprocess). Rendering/simulation remain synchronous until they
// can check the same signal.

import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from './file-lock.ts';
import { readVersionEntry, readVersionSource, type VersionStore } from './version.ts';

export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'timeout';
export interface JobRecord {
  schemaVersion: 1;
  id: string;
  kind: 'compile';
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  project: string;
  versionId: string;
  pid?: number;
  output?: string;
  error?: string;
  timeoutMs: number;
}

export interface JobStore { root: string; }

export function openJobStore(dataRoot: string): JobStore {
  return { root: join(dataRoot, 'jobs') };
}

const alive = new Set<number>();
/** Concurrency gate: a burst of submits must not fork unlimited OpenSCADs. */
export const MAX_RUNNING_JOBS = 4;
let resolving: Promise<{ bin: string; extra: string[] }> | null = null;

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error: any) { return error?.code === 'EPERM'; }
}
function killGroup(pid: number): void {
  try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
}
function now(): string { return new Date().toISOString(); }

async function write(store: JobStore, job: JobRecord): Promise<void> {
  mkdirSync(join(store.root, job.id), { recursive: true });
  await writeJsonAtomic(join(store.root, job.id, 'job.json'), job);
}

function read(store: JobStore, id: string): JobRecord | null {
  try {
    const value = JSON.parse(readFileSync(join(store.root, id, 'job.json'), 'utf8')) as JobRecord;
    return value?.id === id ? value : null;
  } catch { return null; }
}

export function listJobs(store: JobStore): JobRecord[] {
  let ids: string[] = [];
  try { ids = readdirSync(store.root).filter((n) => /^j\d{3,}$/.test(n)).sort(); } catch { return []; }
  const out: JobRecord[] = [];
  for (const id of ids) {
    const job = read(store, id);
    if (!job) continue;
    // A running row whose pid is not one of THIS process's children is an
    // orphan from a previous server. Kill it and say so; never pretend it runs.
    if (job.status === 'running' && job.pid && !alive.has(job.pid)) {
      if (isAlive(job.pid)) killGroup(job.pid);
      job.status = 'failed';
      job.error = 'server restarted while the job was running; orphan process killed';
      job.updatedAt = now();
      void write(store, job);
    }
    out.push(job);
  }
  return out;
}

export function getJob(store: JobStore, id: string): JobRecord | null {
  const job = read(store, id);
  if (!job) return null;
  if (job.status === 'running' && job.pid && !alive.has(job.pid)) {
    if (isAlive(job.pid)) killGroup(job.pid);
    job.status = 'failed';
    job.error = 'server restarted while the job was running; orphan process killed';
    job.updatedAt = now();
    void write(store, job);
  }
  return job;
}

function nextId(store: JobStore): string {
  mkdirSync(store.root, { recursive: true });
  const max = readdirSync(store.root).reduce((m, n) => {
    const hit = /^j(\d{3,})$/.exec(n);
    return hit ? Math.max(m, Number(hit[1])) : m;
  }, 0);
  return `j${String(max + 1).padStart(3, '0')}`;
}

async function resolveOpenScad(): Promise<{ bin: string; extra: string[] }> {
  if (!resolving) {
    resolving = import('./compile.ts').then((m) => m.resolveOpenScadBinary());
  }
  return await resolving;
}

/**
 * Start a compile job for one version. The version's `sourceFile`/`backend`
 * decides the engine; a missing source is refused before the job row is written,
 * while an engine failure after it is recorded as `failed`/`timeout`.
 */
export async function startCompileJob(opts: {
  store: JobStore;
  versions: VersionStore;
  project: string;
  versionId: string;
  timeoutMs?: number;
}): Promise<JobRecord> {
  // `versionId` is caller-controlled in the HTTP route. A manifest lookup both
  // validates the id and keeps `join()` from ever seeing `../`; the old direct
  // join let an attacker point the job at an arbitrary model.py and execute it.
  const entry = await readVersionEntry(opts.versions, opts.versionId);
  if (!entry || !/^v\d{3,}$/.test(opts.versionId)) throw new Error(`unknown version: ${opts.versionId}`);
  const versionDir = join(opts.versions.root, 'versions', opts.versionId);
  const source = await readVersionSource(opts.versions, opts.versionId);
  if (!source) throw new Error(`unknown version or missing source: ${opts.versionId}`);
  if (source.kernel !== 'openscad' && source.kernel !== 'cadquery') {
    throw new Error(`backend_not_available: version ${opts.versionId} pins unknown kernel "${source.kernel}"`);
  }
  const sourcePath = join(versionDir, source.sourceFile);
  if (!existsSync(sourcePath)) throw new Error(`unknown version or missing ${source.sourceFile}: ${opts.versionId}`);
  const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 120_000, 1_000), 600_000);
  const running = listJobs(opts.store).filter((job) => job.status === 'running').length;
  if (running >= MAX_RUNNING_JOBS) throw new Error(`job concurrency limit reached (${MAX_RUNNING_JOBS}); wait for a job or cancel one`);
  const id = nextId(opts.store);
  const dir = join(opts.store.root, id);
  mkdirSync(dir, { recursive: true });
  const output = join(dir, 'model.stl');
  const log = join(dir, source.kernel === 'cadquery' ? 'cadquery.log' : 'openscad.log');
  const job: JobRecord = {
    schemaVersion: 1, id, kind: 'compile', status: 'running', createdAt: now(), updatedAt: now(),
    project: opts.project, versionId: opts.versionId, output, timeoutMs,
  };
  await write(opts.store, job);

  let child: ChildProcess | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const finish = async (status: JobStatus, error?: string): Promise<void> => {
    if (timer) { clearTimeout(timer); timer = null; }
    const current = read(opts.store, id) ?? job;
    if (current.status !== 'running') return; // cancel/timeout already won
    current.status = status;
    current.updatedAt = now();
    current.finishedAt = current.updatedAt;
    if (current.pid) alive.delete(current.pid);
    if (error) current.error = error;
    if (status === 'done' && !existsSync(output)) current.status = 'failed', current.error = 'openscad exited 0 but wrote no STL';
    await write(opts.store, current);
  };

  if (source.kernel === 'cadquery') {
    // CadQuery owns its own child process, so this branch is asynchronous like
    // OpenSCAD's. The pid reaches the job through onSpawn; cancel kills that
    // child and the row's cancelled state wins over a late result.
    const controller = new AbortController();
    void (async () => {
      try {
        const { compileStlOnly } = await import('./compile.ts');
        const compiled = await compileStlOnly(source.code, {
          kernel: 'cadquery',
          timeoutMs,
          signal: controller.signal,
          onSpawn: (pid) => {
            job.pid = pid;
            alive.add(pid);
            void write(opts.store, job);
          },
        });
        writeFileSync(log, [...compiled.errors, ...compiled.warnings].join('\n'));
        if (read(opts.store, id)?.status !== 'running') return;
        if (compiled.success && compiled.stl) {
          writeFileSync(output, compiled.stl);
          await finish('done');
        } else {
          await finish(
            compiled.errorCode === 'cadquery_timeout' ? 'timeout' : 'failed',
            compiled.errors.join('; ') || 'CadQuery compile failed',
          );
        }
      } catch (error) {
        await finish('failed', String((error as Error)?.message ?? error));
      }
    })();
    return job;
  }

  try {
    const { bin, extra } = await resolveOpenScad();
    // The job must produce the SAME artifact compileOpenScad does: ASCII STL
    // with no datum prelude is not a mesh this codebase can parse (parseBinaryStl
    // reads binary), and `datum()` would be an unknown module. Compose the
    // prelude into a job-local source; never write into the version directory.
    const { datumPrelude } = await import('./compile.ts');
    const prelude = await datumPrelude();
    const jobSource = join(dir, 'model.scad');
    writeFileSync(jobSource, prelude + source.code, 'utf8');
    const fd = openSync(log, 'a');
    child = spawn(bin, [...extra, '-o', output, '--export-format', 'binstl', '-D', '$fn=64', jobSource], {
      detached: true,
      stdio: ['ignore', fd, fd],
    });
    closeSync(fd);
    if (child.pid) {
      job.pid = child.pid;
      alive.add(child.pid);
      await write(opts.store, job);
    }
    child.on('exit', (code, signal) => {
      if (child?.pid) alive.delete(child.pid);
      const tail = (() => { try { return readFileSync(log, 'utf8').slice(-800); } catch { return ''; } })();
      if (code === 0) void finish('done');
      else void finish('failed', `openscad exited ${code ?? signal}${tail ? `: ${tail}` : ''}`);
    });
    child.on('error', (error) => {
      if (child?.pid) alive.delete(child.pid);
      void finish('failed', String(error?.message ?? error));
    });
    timer = setTimeout(() => {
      timer = null;
      // Claim the row BEFORE killing, for the reason cancelJob documents: the
      // child's exit handler runs on its own tick, and whichever write lands
      // first wins. Killing first let a timeout be recorded as
      // `failed: SIGTERM` on macOS CI, where the exit event beats the timer's
      // own write. Claiming first makes the verdict deterministic.
      void (async () => {
        const claimed = read(opts.store, id) ?? job;
        if (claimed.status === 'running') {
          claimed.status = 'timeout';
          claimed.updatedAt = now();
          claimed.finishedAt = claimed.updatedAt;
          claimed.error = `exceeded ${timeoutMs} ms`;
          await write(opts.store, claimed);
        }
        if (child?.pid) { killGroup(child.pid); alive.delete(child.pid); }
      })();
    }, timeoutMs);
  } catch (error) {
    await finish('failed', String((error as Error)?.message ?? error));
  }
  return read(opts.store, id) ?? job;
}

export async function cancelJob(store: JobStore, id: string): Promise<JobRecord | null> {
  const job = read(store, id);
  if (!job) return null;
  if (job.status !== 'running') return job;
  // Claim the row BEFORE killing: the child's exit handler may run first and
  // try to record `failed: SIGTERM`, which would turn a user cancel into an error.
  job.status = 'cancelled';
  job.updatedAt = now();
  job.finishedAt = job.updatedAt;
  job.error = 'cancelled by user';
  await write(store, job);
  if (job.pid) { killGroup(job.pid); alive.delete(job.pid); }
  return job;
}

export function removeJob(store: JobStore, id: string): void {
  const job = read(store, id);
  if (job?.status === 'running') throw new Error(`cannot remove running job ${id}`);
  rmSync(join(store.root, id), { recursive: true, force: true });
}
