// The one place model-written Python is executed — and, since batch 0, the one
// place the resident domain worker lives.
//
// TWO SHAPES, ONE WIRING POINT (DESIGN §31.3):
//   * `runPython` — a fresh process per call, for `run_python`. The escape hatch
//     stays honest: no poisoned state, a guaranteed timeout, the real traceback.
//   * `PythonWorker` / `ensurePythonWorker` — the resident worker the migrated
//     tools call. Measured (2026-10-08): a fresh process costs 443.7 ms with the
//     tool set imported, a worker round trip 0.02 ms, and payloads beyond ~1 MiB
//     must travel by file path (1M float64: 106.4 ms inline vs 0.72 ms by file).
//
// WHAT NEITHER DOES: no confinement. The subprocess runs as the host user with
// whatever filesystem access that user has, exactly like `bash`. The plugin's
// claim is reproducibility (a pinned interpreter and dependency set), not
// sandboxing — pretending otherwise would be the kind of lie this harness exists
// to refuse.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PYTHON_LOCK_PROTOCOL } from './python-lock.ts';
import { ensurePythonRuntime, pythonRuntimeRoot, pythonRuntimeStatus, runProcess, type PythonRuntimePaths } from './python-runtime.ts';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_CAPTURE_BYTES = 512 * 1024;

export interface RunPythonRequest {
  /** Inline program; mutually exclusive with `script`. */
  code?: string;
  /** Path to an existing .py file (absolute, or relative to `cwd`). */
  script?: string;
  /** Program arguments appended after the script path. */
  args?: string[];
  /** Working directory; defaults to the session's project directory. */
  cwd: string;
  timeoutMs?: number;
  /** Extra environment entries for the child only. */
  env?: Record<string, string>;
}

export interface RunPythonResult {
  ok: boolean;
  python: string;
  runtimeSource: PythonRuntimePaths['source'];
  scriptPath: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  traceback: string | null;
  truncated: boolean;
  protocolVersion: number;
}

/** Keep the tail of an over-long stream: the last lines are the diagnosis. */
function clamp(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= MAX_CAPTURE_BYTES) return { text, truncated: false };
  const clipped = text.slice(-MAX_CAPTURE_BYTES);
  return { text: `…[truncated to the last ${Math.round(MAX_CAPTURE_BYTES / 1024)} KiB]\n${clipped}`, truncated: true };
}

/**
 * Extract the Python traceback from stderr.
 *
 * A traceback is what makes this runtime worth having: SyntaxError with a caret,
 * TypeError naming the offending argument — the diagnosis the SCAD parser never
 * gave us. The last block wins; anything after it (our own trailer) is dropped.
 */
export function extractTraceback(stderr: string): string | null {
  const starts: number[] = [];
  const pattern = /^(Traceback \(most recent call last\):|.*Error:|.*Exception:)/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(stderr)) !== null) starts.push(match.index);
  if (starts.length === 0) return null;
  const from = starts[0]!;
  const block = stderr.slice(from).trimEnd();
  const stop = block.indexOf('\nDuring handling of the above exception');
  return stop > 0 ? block.slice(0, stop).trimEnd() : block;
}

function childEnv(extra: Record<string, string> | undefined): NodeJS.ProcessEnv {
  const base = process.env;
  const env: NodeJS.ProcessEnv = {
    PATH: base.PATH,
    HOME: base.HOME,
    USERPROFILE: base.USERPROFILE,
    TMPDIR: base.TMPDIR,
    TMP: base.TMP,
    TEMP: base.TEMP,
    LANG: base.LANG,
    LC_ALL: base.LC_ALL,
    SYSTEMROOT: base.SYSTEMROOT,
    // Deterministic, UTF-8, unbuffered: these scripts print machine-readable lines.
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    ...(extra ?? {}),
  };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return env;
}

/** Drop scratch scripts older than this; they are evidence, not an archive. */
const SCRIPT_TTL_MS = 3 * 24 * 60 * 60 * 1000;

async function writeScratchScript(root: string, code: string): Promise<string> {
  const dir = join(root, 'tmp');
  await mkdir(dir, { recursive: true });
  const now = Date.now();
  try {
    for (const entry of await readdir(dir)) {
      const path = join(dir, entry);
      const info = await stat(path).catch(() => null);
      if (info && now - info.mtimeMs > SCRIPT_TTL_MS) await rm(path, { force: true });
    }
  } catch {
    // Pruning is best-effort; never fail a run over it.
  }
  const path = join(dir, `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.py`);
  await writeFile(path, code.endsWith('\n') ? code : `${code}\n`);
  return path;
}

/**
 * Run Python with the provisioned runtime.
 *
 * `-I` isolates the child from PYTHONPATH and the user site directory, so the
 * interpreter's view is exactly the venv we built — not "mostly that, plus
 * whatever the host had exported".
 */
export async function runPython(request: RunPythonRequest, onProgress?: (message: string) => void): Promise<RunPythonResult> {
  const runtime = await ensurePythonRuntime({ onProgress });
  const timeoutMs = Math.min(
    Math.max(1_000, request.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    MAX_TIMEOUT_MS,
  );
  const cwd = resolve(request.cwd);

  let scriptPath: string;
  if (request.script) {
    scriptPath = isAbsolute(request.script) ? request.script : resolve(cwd, request.script);
  } else if (request.code !== undefined) {
    scriptPath = await writeScratchScript(runtime.root, request.code);
  } else {
    throw new Error('run_python needs either `code` or `script`');
  }

  const started = Date.now();
  const result = await runProcess(
    runtime.venvPython,
    ['-I', scriptPath, ...(request.args ?? [])],
    { cwd, env: childEnv(request.env), timeoutMs },
  );

  const stdout = clamp(result.stdout);
  const stderr = clamp(result.stderr);
  const ok = result.code === 0 && !result.timedOut;
  const traceback = ok ? null : extractTraceback(stderr.text);

  return {
    ok,
    python: runtime.venvPython,
    runtimeSource: runtime.source,
    scriptPath,
    exitCode: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    durationMs: result.durationMs || Date.now() - started,
    stdout: stdout.text,
    stderr: stderr.text,
    traceback,
    truncated: stdout.truncated || stderr.truncated,
    protocolVersion: PYTHON_LOCK_PROTOCOL,
  };
}

// ---------------------------------------------------------------------------
// batch 0: the resident domain worker (DESIGN §31.3)
// ---------------------------------------------------------------------------

export interface PythonWorkerHello {
  protocolVersion: number;
  python: string;
  pid: number;
  ops: string[];
}

export interface PythonWorkerOptions {
  onLog?: (line: string) => void;
  /** Handshake budget; measured startup is ~16 ms, so this only catches a hang. */
  startupTimeoutMs?: number;
}

interface PendingRequest {
  op: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_WORKER_TIMEOUT_MS = 120_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 30_000;

/**
 * `python/cad_worker/worker.py`, from the bundle or from the sources.
 *
 * The same module is loaded two ways: `<plugin>/lib/index.js` when bundled and
 * `<plugin>/src/host/python-worker.ts` when run from source, so the walk up has
 * to accept both depths rather than assume one.
 */
export function resolveWorkerScript(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', '..', 'python', 'cad_worker', 'worker.py'), // src/host → <plugin>
    join(here, '..', 'python', 'cad_worker', 'worker.py'), // lib/ → <plugin>
    join(here, 'python', 'cad_worker', 'worker.py'),
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  throw new Error(`cad_worker/worker.py not found; looked in ${candidates.join(', ')}`);
}

/** Scratch directory for by-file payloads (STL bytes, point arrays, results). */
export async function workerScratchDir(): Promise<string> {
  const dir = join(pythonRuntimeRoot(), 'tmp', 'worker');
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * A resident worker: one process, JSON-lines frames, id-correlated replies.
 *
 * Single-threaded by design (the worker answers one frame at a time), so the
 * host must budget for QUEUEING when it issues concurrent requests — the
 * acceptance measures two in-flight requests finishing in the serial sum. A
 * deadline that expires therefore marks the worker unusable and forces a
 * restart: the request may still be running, and reusing a half-broken worker
 * is how a timeout turns into a corrupted answer.
 */
export class PythonWorker {
  hello: PythonWorkerHello | null = null;
  private readonly child: ChildProcess;
  private readonly onLog?: (line: string) => void;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private failure: Error | null = null;
  private helloWaiter: { resolve: (hello: PythonWorkerHello) => void; reject: (error: Error) => void } | null = null;

  // NOTE: no TypeScript parameter properties here (`constructor(private x)`) —
  // the sources are loaded by Node's strip-only type stripping in tests, which
  // rejects that syntax outright.
  constructor(child: ChildProcess, onLog?: (line: string) => void) {
    this.child = child;
    this.onLog = onLog;
    child.stdout?.on('data', (chunk: Buffer) => this.ingest(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) if (line.trim()) this.onLog?.(line.trim());
    });
    child.once('error', (error: Error) => this.fail(new Error(`python worker failed: ${error.message}`)));
    child.once('exit', (code, signal) => this.fail(new Error(`python worker exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`)));
  }

  get alive(): boolean {
    return this.failure === null;
  }

  get processId(): number | undefined {
    return this.child.pid;
  }

  private ingest(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      index = this.buffer.indexOf('\n');
      if (!line) continue;
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.onLog?.(`unparsable worker frame: ${line.slice(0, 200)}`);
        continue;
      }
      if (frame.type === 'hello') {
        this.hello = frame as unknown as PythonWorkerHello;
        const waiter = this.helloWaiter;
        this.helloWaiter = null;
        waiter?.resolve(this.hello);
        continue;
      }
      const id = Number(frame.id);
      const entry = this.pending.get(id);
      if (!entry) {
        this.onLog?.(`unsolicited worker frame id=${String(frame.id)}`);
        continue;
      }
      this.pending.delete(id);
      clearTimeout(entry.timer);
      if (frame.ok) entry.resolve(frame.result);
      else {
        const traceback = typeof frame.traceback === 'string' ? `\n${frame.traceback}` : '';
        entry.reject(new Error(`${entry.op} failed: ${String(frame.error)}${traceback}`));
      }
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    const waiter = this.helloWaiter;
    this.helloWaiter = null;
    waiter?.reject(error);
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  async waitForHello(timeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS): Promise<PythonWorkerHello> {
    if (this.hello) return this.hello;
    if (this.failure) throw this.failure;
    return await new Promise<PythonWorkerHello>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.helloWaiter = null;
        rejectPromise(new Error(`python worker handshake timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.helloWaiter = {
        resolve: (hello) => {
          clearTimeout(timer);
          resolvePromise(hello);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectPromise(error);
        },
      };
    });
  }

  /** Send one request. Replies are correlated by id, not by order. */
  request<T = unknown>(op: string, params: Record<string, unknown> = {}, options: { timeoutMs?: number } = {}): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS;
    return new Promise<T>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`python worker ${op} timed out after ${timeoutMs} ms`);
        this.fail(error);
        rejectPromise(error);
      }, timeoutMs);
      this.pending.set(id, {
        op,
        resolve: resolvePromise as (value: unknown) => void,
        reject: rejectPromise,
        timer,
      });
      this.child.stdin?.write(`${JSON.stringify({ id, op, params })}\n`);
    });
  }

  stop(): void {
    this.fail(new Error('python worker stopped'));
    if (this.child.pid === undefined) return;
    try {
      if (process.platform === 'win32') this.child.kill('SIGKILL');
      else process.kill(-this.child.pid, 'SIGKILL');
    } catch {
      try {
        this.child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
}

let sharedWorker: PythonWorker | null = null;

/** The process-wide worker; starts it on first use and restarts it after a death. */
export async function ensurePythonWorker(options: PythonWorkerOptions = {}): Promise<PythonWorker> {
  if (sharedWorker?.alive) return sharedWorker;
  sharedWorker = null;
  // A migrated TOOL must not spend its 60–180 s timeout installing a runtime that
  // measured 6–11 minutes cold. Refuse with something actionable instead: the
  // python_runtime tool provisions with progress and is not bound by the caller's
  // deadline. (Eager mode provisions at startup, so this never fires there.)
  const status = await pythonRuntimeStatus();
  if (status.state !== 'ready') {
    throw new Error(
      `the bundled Python runtime is not ready (state: ${status.state}) — run the python_runtime tool with action "provision" ` +
        '(it reports progress and is not bound by this tool\'s timeout), then call this tool again',
    );
  }
  const runtime = await ensurePythonRuntime({ onProgress: options.onLog });
  const child = spawn(runtime.venvPython, ['-I', resolveWorkerScript()], {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  const worker = new PythonWorker(child, options.onLog);
  try {
    await worker.waitForHello(options.startupTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS);
  } catch (error) {
    worker.stop();
    throw error;
  }
  sharedWorker = worker;
  return worker;
}

export function resetPythonWorker(): void {
  sharedWorker?.stop();
  sharedWorker = null;
}
