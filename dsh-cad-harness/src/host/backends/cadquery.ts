// CadQuery provider: execute one authoring script in a subprocess with the
// pack on PYTHONPATH, then return STL + the same DatumSet schema OpenSCAD uses.
//
// The pack is never merged into the runtime venv; nothing here downloads. A
// missing pack is a classified `cadquery_pack_missing` failure with the exact
// install command, not an exception that hides the rest of the compile path.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CompileResult, DatumSet } from '../compile.ts';
import type { EngineAdapter, EngineCompileOptions } from '../backend.ts';
import { cadqueryInstallHint, cadqueryPackStatus, cadqueryPythonEnv } from '../cadquery-pack.ts';
import { pythonRuntimeStatus } from '../python-runtime.ts';
import { resolveWorkerScript } from '../python-worker.ts';

const DEFAULT_TIMEOUT_MS = 30_000;
const STDERR_LIMIT = 20_000;

interface DriverResult {
  ok: boolean;
  error_code?: string;
  message?: string;
  fix?: string;
  line?: number | null;
  column?: number | null;
  traceback?: string;
  version?: string;
  datums?: DatumSet;
  warnings?: string[];
  brepValid?: boolean | null;
  toleranceMm?: number;
}

function failure(code: string, message: string, fix: string, durationMs: number): CompileResult {
  return {
    success: false,
    errors: [`[${code}] ${message}`],
    warnings: [],
    errorCode: code,
    fix,
    datums: [],
    datumSet: { points: [], axes: [], planes: [], cylinders: [] },
    durationMs,
  };
}

/** Run one source string with the pack; classify every failure. */
async function compileCadQuery(source: string, opts: EngineCompileOptions = {}): Promise<CompileResult> {
  const started = Date.now();
  if (typeof source !== 'string' || source.trim() === '') {
    return failure('cadquery_empty_source', 'the CadQuery source is empty', 'provide a Python authoring script', 0);
  }

  const pack = await cadqueryPackStatus();
  if (!pack.installed) {
    return failure(
      'cadquery_pack_missing',
      `the CadQuery pack is not installed at ${pack.root}${pack.issues.length ? ` (${pack.issues.join('; ')})` : ''}`,
      cadqueryInstallHint(),
      Date.now() - started,
    );
  }

  const runtime = await pythonRuntimeStatus();
  if (runtime.state !== 'ready' || !runtime.venvPython) {
    return failure(
      'cadquery_python_not_ready',
      `the bundled Python runtime is ${runtime.state}; CadQuery needs it as the pack host`,
      'run python_runtime action=provision (or repair) first',
      Date.now() - started,
    );
  }

  const driver = join(dirname(dirname(resolveWorkerScript())), 'cadquery_compile.py');
  if (!existsSync(driver)) {
    return failure(
      'cadquery_driver_missing',
      `the CadQuery driver is missing: ${driver}`,
      'reinstall the package; python/cadquery_compile.py ships with it',
      Date.now() - started,
    );
  }

  const dir = await mkdtemp(join(tmpdir(), 'cad-cq-'));
  try {
    const sourcePath = join(dir, 'model.py');
    const stlPath = join(dir, 'model.stl');
    const resultPath = join(dir, 'result.json');
    await writeFile(sourcePath, source, 'utf8');

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const stepPath = join(dir, 'model.step');
    const child = spawn(runtime.venvPython, [
      driver,
      '--source', sourcePath,
      '--stl', stlPath,
      '--result', resultPath,
      ...(opts.step ? ['--step', stepPath] : []),
    ], {
      cwd: dir,
      env: { ...cadqueryPythonEnv(process.env), PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    if (child.pid) opts.onSpawn?.(child.pid);
    const abort = () => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    };
    if (opts.signal?.aborted) abort();
    else opts.signal?.addEventListener('abort', abort, { once: true });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      if (stdout.length < STDERR_LIMIT) stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < STDERR_LIMIT) stderr += String(chunk);
    });
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('error', () => resolve({ code: null, signal: null }));
      child.once('close', (code, signal) => resolve({ code, signal }));
    }).finally(() => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abort);
    });

    const durationMs = Date.now() - started;
    let result: DriverResult | null = null;
    try {
      result = JSON.parse(await readFile(resultPath, 'utf8')) as DriverResult;
    } catch { /* classified below */ }

    if (timedOut) {
      return failure(
        'cadquery_timeout',
        `CadQuery compile exceeded ${timeoutMs} ms`,
        'reduce the model/boolean work, or raise timeoutMs for this compile',
        durationMs,
      );
    }

    if (!result) {
      const tail = `${stderr || stdout}`.trim().split('\n').slice(-4).join(' | ');
      return failure(
        'cadquery_crash',
        `the CadQuery subprocess produced no result (exit ${exit.code ?? exit.signal ?? 'unknown'})${tail ? `: ${tail}` : ''}`,
        'run the source with the pack Python directly; dsh-cad-doctor checks the pack and runtime',
        durationMs,
      );
    }

    if (!result.ok) {
      const code = result.error_code || 'cadquery_failed';
      const mapped = code === 'cadquery_import' ? 'cadquery_pack_broken' : code;
      const fix = code === 'cadquery_import'
        ? `reinstall the pack (${cadqueryInstallHint()})`
        : (result.fix || 'read the traceback and fix the authoring script');
      const where = result.line ? ` at line ${result.line}${result.column ? `:${result.column}` : ''}` : '';
      return failure(
        mapped,
        `${result.message || 'CadQuery failed'}${where}`,
        fix,
        durationMs,
      );
    }

    let stl: Uint8Array;
    try {
      stl = new Uint8Array(await readFile(stlPath));
    } catch {
      return failure(
        'cadquery_export',
        'the driver reported success but wrote no STL',
        'check that the result is a closed solid and the pack is complete',
        durationMs,
      );
    }

    const datumSet: DatumSet = {
      points: result.datums?.points ?? [],
      axes: result.datums?.axes ?? [],
      planes: result.datums?.planes ?? [],
      cylinders: result.datums?.cylinders ?? [],
    };
    let step: Uint8Array | undefined;
    if (opts.step) {
      try {
        step = new Uint8Array(await readFile(stepPath));
      } catch {
        return failure('cadquery_step_export', 'the driver reported success but wrote no STEP', 'check that the result is a solid', durationMs);
      }
    }
    return {
      success: true,
      stl,
      ...(step ? { step } : {}),
      renders: [],
      errors: [],
      warnings: result.warnings ?? [],
      datums: datumSet.points,
      datumSet,
      durationMs,
      meta: {
        kernel: 'cadquery',
        version: result.version ?? undefined,
        units: 'mm',
        durationMs,
        ...(typeof result.brepValid === 'boolean' ? { brepValid: result.brepValid } : {}),
        ...(typeof result.toleranceMm === 'number' ? { toleranceMm: result.toleranceMm } : {}),
      },
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export const CADQUERY_ADAPTER: EngineAdapter = {
  id: 'cadquery',
  compile: compileCadQuery,
};
