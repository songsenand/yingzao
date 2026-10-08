// The one place model-written Python is executed.
//
// WHY ONE-SHOT PROCESSES (for now). HARNESS §12.3 specifies a resident worker
// with a JSON-lines protocol for the *domain* ops (geometry, simulation) where
// per-call startup cost and shared state matter. `run_python` is the general
// escape hatch: "run this analysis script with the real runtime". A fresh
// process per call is what makes its failure story honest — no poisoned state
// from the previous run, a guaranteed timeout, and the full traceback of the
// code the model actually wrote. When the domain worker lands, it mounts beside
// this (same wiring point, same venv) rather than replacing it.
//
// WHAT IT DOES NOT DO: no confinement. The subprocess runs as the host user with
// whatever filesystem access that user has, exactly like `bash`. The plugin's
// claim is reproducibility (a pinned interpreter and dependency set), not
// sandboxing — pretending otherwise would be the kind of lie this harness exists
// to refuse.

import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PYTHON_LOCK_PROTOCOL } from './python-lock.ts';
import { ensurePythonRuntime, runProcess, type PythonRuntimePaths } from './python-runtime.ts';

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
