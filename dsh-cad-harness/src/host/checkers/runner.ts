// Run a checker/v1 probe as an isolated subprocess.
//
// The runner is deliberately language-agnostic: it writes one JSON document to stdin,
// reads one JSON document from stdout, and validates the result. Logs go to stderr.
// A non-zero exit, timeout, malformed JSON or invalid report is an error report, never
// a pass.

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertCheckerManifest,
  protocolError,
  validateCheckerReport,
} from './protocol.ts';
import type {
  CheckerInput,
  CheckerManifest,
  CheckerReport,
  RunCheckerResult,
} from './types.ts';
import { CHECKER_API_VERSION } from './types.ts';

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export interface RunCheckerOptions {
  /** Directory containing the checker entry file. Defaults to process.cwd(). */
  cwd?: string;
  /** Extra environment variables (never inherited wholesale). */
  env?: Record<string, string>;
  /** Custom checks: reject non-empty artifacts. */
  artifacts?: 'allow' | 'forbid';
  /** Custom checks: reject reports with more findings than this. */
  maxFindings?: number;
}

function jsonError(manifest: CheckerManifest, code: string, message: string): CheckerReport {
  return protocolError(manifest, code, message);
}

/** Run one checker. Never throws for a bad report; returns status=error instead. */
export async function runChecker(
  manifest: CheckerManifest,
  input: CheckerInput,
  options: RunCheckerOptions = {},
): Promise<RunCheckerResult> {
  assertCheckerManifest(manifest);
  if (input?.apiVersion !== CHECKER_API_VERSION) {
    throw new Error(`input.apiVersion must be "${CHECKER_API_VERSION}"`);
  }
  if (input.budget?.timeoutMs !== undefined && input.budget.timeoutMs > manifest.timeoutMs) {
    throw new Error(`input.budget.timeoutMs ${input.budget.timeoutMs} exceeds manifest timeout ${manifest.timeoutMs}`);
  }

  const cwd = options.cwd ?? process.cwd();
  const home = await mkdtemp(join(tmpdir(), 'dsh-checker-'));
  const started = Date.now();
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    LANG: process.env.LANG ?? 'C.UTF-8',
    LC_ALL: process.env.LC_ALL ?? 'C.UTF-8',
    HOME: home,
    TMPDIR: home,
    PYTHONNOUSERSITE: '1',
    ...(options.env ?? {}),
  };

  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let tooLarge = false;

  const child = spawn(manifest.entry[0]!, manifest.entry.slice(1), {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });

  const append = (which: 'out' | 'err', chunk: Buffer) => {
    if (which === 'out') {
      if (stdout.length + chunk.length > MAX_OUTPUT_BYTES) { tooLarge = true; child.kill('SIGKILL'); return; }
      stdout += chunk.toString('utf8');
    } else {
      if (stderr.length + chunk.length > MAX_OUTPUT_BYTES) return;
      stderr += chunk.toString('utf8');
    }
  };
  child.stdout.on('data', (c: Buffer) => append('out', c));
  child.stderr.on('data', (c: Buffer) => append('err', c));

  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, manifest.timeoutMs);

  child.stdin.end(JSON.stringify(input));

  const result = await new Promise<{ code: number | null; signal: string | null }>((resolvePromise) => {
    child.on('error', () => resolvePromise({ code: null, signal: 'spawn-error' }));
    child.on('close', (code, signal) => resolvePromise({ code, signal }));
  });
  clearTimeout(timeout);
  await rm(home, { recursive: true, force: true }).catch(() => {});

  const durationMs = Date.now() - started;
  if (timedOut) {
    return { report: jsonError(manifest, 'timeout', `checker exceeded ${manifest.timeoutMs} ms`), durationMs, stderr };
  }
  if (tooLarge) {
    return { report: jsonError(manifest, 'output-too-large', `stdout exceeded ${MAX_OUTPUT_BYTES} bytes`), durationMs, stderr };
  }
  if (result.signal === 'spawn-error') {
    return { report: jsonError(manifest, 'spawn-error', `could not spawn ${manifest.entry[0]}`), durationMs, stderr };
  }
  if (result.code !== 0) {
    return {
      report: jsonError(manifest, 'non-zero-exit', `checker exited ${result.code ?? result.signal}; stderr: ${stderr.slice(0, 500)}`),
      durationMs,
      stderr,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    return {
      report: jsonError(manifest, 'invalid-json', `stdout is not one JSON document: ${(error as Error).message}`),
      durationMs,
      stderr,
    };
  }

  const errors = validateCheckerReport(parsed, manifest, {
    ...(options.artifacts ? { artifacts: options.artifacts } : {}),
    ...(options.maxFindings !== undefined ? { maxFindings: options.maxFindings } : {}),
  });
  if (errors.length > 0) {
    return {
      report: jsonError(manifest, 'invalid-report', errors.join('; ')),
      durationMs,
      stderr,
    };
  }
  return { report: parsed as CheckerReport, durationMs, stderr };
}

/** Run a negative fixture; the checker must NOT return pass. */
export async function runNegativeSample(
  manifest: CheckerManifest,
  checkerDir: string,
  fixturePath: string,
): Promise<{ ok: boolean; report: CheckerReport; detail: string }> {
  const { readFile } = await import('node:fs/promises');
  const input = JSON.parse(await readFile(fixturePath, 'utf8')) as CheckerInput;
  const { report } = await runChecker(manifest, input, { cwd: checkerDir });
  if (report.status === 'pass') {
    return { ok: false, report, detail: `negative sample ${fixturePath} was NOT rejected` };
  }
  return { ok: true, report, detail: `negative sample rejected with status=${report.status}` };
}
