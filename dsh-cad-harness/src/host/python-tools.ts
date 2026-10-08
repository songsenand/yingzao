// The two model-facing tools for the bundled Python runtime.
//
// `run_python` is the general escape hatch ("run this analysis with the real
// runtime"): it provisions on demand, executes a program or an existing .py
// file, and hands back stdout/stderr plus the full Python traceback. It is the
// deliberate opposite of a curated API — the same "open the real capability"
// stance the harness takes for bash and Node (DESGIGN M4R pillar A), because a
// narrow invented API is what forces every future analysis back into our code.
//
// `python_runtime` is the honest status/repair surface: what is installed, where
// it lives, how much disk it takes, and the exact failure when provisioning did
// not finish. Without it a cold first call would look like a hang.

import { defineTool } from '@deepseek-ai/dsh-tools';
import { basename, isAbsolute, resolve } from 'node:path';
import { projectStoresFor } from './project.ts';
import {
  ensurePythonRuntime,
  pythonRuntimeStatus,
  recordRuntimeFailure,
  repairPythonRuntime,
  type PythonRuntimeStatus,
} from './python-runtime.ts';
import { runPython, type RunPythonResult } from './python-worker.ts';

type RegisterTool = (definition: { name: string }) => unknown;

interface LoggerLike {
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

interface RunPythonArgs {
  code?: string;
  script?: string;
  args?: string[];
  cwd?: string;
  timeoutSec?: number;
}

interface RuntimeToolArgs {
  action?: 'status' | 'provision' | 'repair';
}

interface RunPythonValue {
  ok: boolean;
  python: string;
  runtimeSource: string;
  scriptPath: string;
  exitCode?: number;
  signal?: string;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  traceback?: string;
  truncated: boolean;
  protocolVersion: number;
  /** Tail of the provisioning log when this call had to install the runtime. */
  provisionLog?: string[];
}

function humanBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

/** Map the runtime status onto the tool schema: absent facts are omitted, not null. */
function statusFields(status: PythonRuntimeStatus) {
  return {
    state: status.state,
    root: status.root,
    target: status.target ?? undefined,
    pythonVersion: status.pythonVersion,
    mode: status.mode,
    source: status.source ?? undefined,
    interpreter: status.interpreter ?? undefined,
    venvPython: status.venvPython ?? undefined,
    installedAt: status.installedAt ?? undefined,
    phase: status.phase ?? undefined,
    error: status.error ?? undefined,
    occupiedBytes: status.occupiedBytes,
    occupied: humanBytes(status.occupiedBytes),
    skipped: status.skipped.map((entry) => `${entry.name}==${entry.version} (${entry.reason})`),
  };
}

/**
 * The one line that keeps a platform-specific omission from reading as a bug.
 * On darwin-x64 rapier3d is absent by design and physics stays on the TS engine.
 */
function skipSummary(status: PythonRuntimeStatus): string | null {
  if (!status.skipped.length) return null;
  return `not installed on this platform: ${status.skipped.map((entry) => `${entry.name} — ${entry.reason}`).join('; ')}`;
}

function renderRunResult(value: RunPythonValue): unknown[] {
  const head = value.ok
    ? `run_python: ok in ${(value.durationMs / 1000).toFixed(2)}s`
    : value.timedOut
      ? `run_python: TIMED OUT after ${(value.durationMs / 1000).toFixed(1)}s (the process was killed)`
      : `run_python: failed (exit ${value.exitCode ?? value.signal ?? 'unknown'})`;
  const lines = [`${head} · script ${value.scriptPath} · python ${value.python}`];
  if (value.provisionLog?.length) {
    lines.push(`runtime provisioning: ${value.provisionLog.join(' | ')}`);
  }
  if (value.stdout) lines.push(`--- stdout ---\n${value.stdout.trimEnd()}`);
  if (value.traceback) lines.push(`--- traceback ---\n${value.traceback}`);
  else if (value.stderr) lines.push(`--- stderr ---\n${value.stderr.trimEnd()}`);
  if (value.truncated) lines.push('(output truncated to the last 512 KiB)');
  return [{ type: 'text', text: lines.join('\n') }];
}

function renderRuntimeStatus(status: PythonRuntimeStatus): string {
  const head =
    status.state === 'ready'
      ? 'Python runtime: ready'
      : status.state === 'disabled'
        ? 'Python runtime: disabled (DSH_CAD_PYTHON=off)'
        : status.state === 'unsupported'
          ? `Python runtime: unsupported on ${process.platform}/${process.arch}`
          : status.state === 'failed'
            ? 'Python runtime: FAILED on the last attempt'
            : 'Python runtime: not installed yet (it installs on the first run_python call)';
  const lines = [head];
  lines.push(`root: ${status.root}`);
  lines.push(`target: ${status.target ?? 'none'} · python ${status.pythonVersion} · mode ${status.mode}`);
  if (status.source) lines.push(`source: ${status.source}`);
  if (status.interpreter) lines.push(`interpreter: ${status.interpreter}`);
  if (status.venvPython) lines.push(`venv python: ${status.venvPython}`);
  if (status.installedAt) lines.push(`installed: ${status.installedAt}`);
  lines.push(`disk: ${humanBytes(status.occupiedBytes)}`);
  const skip = skipSummary(status);
  if (skip) lines.push(skip);
  if (status.phase) lines.push(`phase: ${status.phase}`);
  if (status.error) lines.push(`error: ${status.error}`);
  return lines.join('\n');
}

/**
 * Register `run_python` and `python_runtime`.
 *
 * Returns the registered names so the tool-scope filter treats them like every
 * other CAD tool (they are only visible in sessions that named the CAD preset).
 */
export function registerPythonTools(registerTool: RegisterTool, logger?: LoggerLike): readonly string[] {
  const names: string[] = [];
  const register = (definition: { name: string }) => {
    names.push(definition.name);
    registerTool(definition);
  };

  const progressLogger = (message: string) => logger?.info?.(`cad-harness: python runtime: ${message}`);

  register(defineTool({
    name: 'run_python',
    description:
      'Run Python in the plugin\'s own pinned runtime — CPython 3.13 with numpy, scipy, trimesh, manifold3d, networkx, scikit-fem and rapier3d (rapier3d only where a wheel exists for this platform; python_runtime reports what this machine has) — not the host\'s system interpreter. ' +
      'Pass `code` for a one-off program, or `script` to run an existing .py file (relative to the project directory). ' +
      'Use it for numerical analysis, mesh measurement on an exported STL, FEM/optimisation probes, or any check the CAD tools do not cover. ' +
      'The process runs with your user\'s full filesystem access (no sandbox), in the project directory, and is killed at the timeout. ' +
      'On failure the complete Python traceback comes back. ' +
      'The first call on a machine installs the runtime once (hundreds of MB, progress reported); python_runtime shows or repairs it.',
    parameters: {
      code: {
        type: 'string',
        description: 'Python source to run. Mutually exclusive with `script`; prints go to stdout, and an uncaught exception returns its traceback.',
      },
      script: {
        type: 'string',
        description: 'Path to an existing .py file — absolute, or relative to the project directory. Mutually exclusive with `code`.',
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Command-line arguments appended after the script path (sys.argv[1:]).',
      },
      cwd: {
        type: 'string',
        description: 'Working directory for the run; defaults to the project directory. Relative paths resolve against the project directory.',
      },
      timeoutSec: {
        type: 'number',
        description: 'Wall-clock budget in seconds (default 120, maximum 600). On expiry the process group is killed and the result says so.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          python: { type: 'string', required: true, description: 'Venv interpreter that ran the program.' },
          runtimeSource: { type: 'string', required: true, description: 'standalone | dsh-primary-runtime | system.' },
          scriptPath: { type: 'string', required: true, description: 'The file that was executed (inline code is written to a scratch file).' },
          exitCode: { type: 'integer', description: 'null when the process died on a signal.' },
          signal: { type: 'string' },
          timedOut: { type: 'boolean', required: true },
          durationMs: { type: 'integer', required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          traceback: { type: 'string', description: 'Extracted Python traceback when the run failed.' },
          truncated: { type: 'boolean', required: true },
          protocolVersion: { type: 'integer', required: true },
          provisionLog: { type: 'array', items: { type: 'string' }, description: 'Provisioning progress when this call had to install the runtime.' },
        },
      },
      render: (_args: unknown, value: unknown) => renderRunResult(value as RunPythonValue) as never,
    },
    timeoutMs: 900_000,
    async execute(args: unknown, exec: unknown) {
      const a = (args ?? {}) as RunPythonArgs;
      if (!a.code && !a.script) throw new Error('run_python needs either `code` or `script`');
      if (a.code && a.script) throw new Error('run_python takes `code` or `script`, not both');
      const project = await projectStoresFor(exec);
      const cwd = a.cwd
        ? (isAbsolute(a.cwd) ? a.cwd : resolve(project.cwd, a.cwd))
        : project.cwd;

      const progress: string[] = [];
      const onProgress = (message: string) => {
        progress.push(message);
        if (progress.length > 60) progress.shift();
      };

      try {
        const result = await runPython(
          {
            code: a.code,
            script: a.script,
            args: a.args,
            cwd,
            timeoutMs: a.timeoutSec === undefined ? undefined : Math.round(a.timeoutSec * 1000),
          },
          onProgress,
        );
        return {
          ...result,
          exitCode: result.exitCode ?? undefined,
          signal: result.signal ?? undefined,
          traceback: result.traceback ?? undefined,
          ...(progress.length ? { provisionLog: progress.slice(-8) } : {}),
        };
      } catch (error) {
        const message = await recordRuntimeFailure(error, { onProgress: progressLogger });
        const tail = progress.slice(-4).join(' | ');
        throw new Error(
          `run_python could not prepare the Python runtime: ${message}` +
            (tail ? `\nprovisioning log: ${tail}` : '') +
            '\nCall python_runtime with action "provision" to retry, or set DSH_CAD_PYTHON=off to silence this.',
        );
      }
    },
    finalizeContent(_exec, result) {
      const value = (result as { value?: RunPythonValue }).value;
      if (!value) return undefined;
      return renderRunResult(value) as never;
    },
  }));

  register(defineTool({
    name: 'python_runtime',
    description:
      'Status and repair for the plugin\'s bundled Python runtime (CPython 3.13 + pinned numpy/scipy/trimesh/manifold3d/networkx/scikit-fem/rtree/rapier3d). ' +
      'action "status" (default) reports where it is, whether it is usable, its size and the last error; ' +
      '"provision" installs it now instead of waiting for the first run_python call; "repair" rebuilds the dependency environment. ' +
      'Use it when run_python reports a runtime problem, or to warm the runtime before a long batch of Python work.',
    parameters: {
      action: {
        type: 'string',
        description: 'status (default) | provision | repair',
        enum: ['status', 'provision', 'repair'],
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          state: { type: 'string', required: true, description: 'ready | absent | provisioning | failed | disabled | unsupported.' },
          root: { type: 'string', required: true },
          target: { type: 'string' },
          pythonVersion: { type: 'string', required: true },
          mode: { type: 'string', required: true },
          source: { type: 'string' },
          interpreter: { type: 'string' },
          venvPython: { type: 'string' },
          installedAt: { type: 'string' },
          phase: { type: 'string' },
          error: { type: 'string' },
          occupiedBytes: { type: 'integer', required: true },
          occupied: { type: 'string', required: true },
          skipped: {
            type: 'array',
            items: { type: 'string' },
            description: 'Packages this platform\'s lock deliberately omits, with the reason (e.g. rapier3d on darwin-x64: no wheel, physics stays on the TS engine).',
          },
          provisionLog: { type: 'array', items: { type: 'string' } },
          summary: { type: 'string', required: true, description: 'Human-readable rendering of the same facts.' },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: (value as { summary?: string }).summary ?? JSON.stringify(value) }] as never,
    },
    timeoutMs: 900_000,
    async execute(args: unknown) {
      const action = ((args ?? {}) as RuntimeToolArgs).action ?? 'status';
      const progress: string[] = [];
      const onProgress = (message: string) => {
        progress.push(message);
        if (progress.length > 60) progress.shift();
      };

      if (action === 'status') {
        const status = await pythonRuntimeStatus();
        return { action, ...statusFields(status), summary: renderRuntimeStatus(status) };
      }

      try {
        const paths = action === 'repair'
          ? await repairPythonRuntime({ onProgress })
          : await ensurePythonRuntime({ onProgress });
        const status = await pythonRuntimeStatus();
        const skip = skipSummary(status);
        const summary = [
          `Python runtime ${action === 'repair' ? 'repaired' : 'ready'} at ${paths.root}`,
          `python ${paths.pythonVersion} (${paths.source})`,
          `venv: ${paths.venvPython}`,
          `disk: ${humanBytes(status.occupiedBytes)}`,
          ...(skip ? [skip] : []),
        ].join('\n');
        return {
          action,
          ...statusFields({ ...status, state: 'ready', error: null }),
          provisionLog: progress.slice(-10),
          summary,
        };
      } catch (error) {
        const message = await recordRuntimeFailure(error, { onProgress: progressLogger });
        const status = await pythonRuntimeStatus();
        return {
          action,
          ...statusFields({ ...status, state: 'failed', error: message }),
          provisionLog: progress.slice(-10),
          summary: `Python runtime ${action} FAILED: ${message}`,
        };
      }
    },
    finalizeContent(_exec, result) {
      const value = (result as { value?: { summary?: string; provisionLog?: string[] } }).value;
      if (!value?.summary) return undefined;
      const text = value.provisionLog?.length
        ? `${value.summary}\nlog: ${value.provisionLog.join(' | ')}`
        : value.summary;
      return [{ type: 'text', text }] as never;
    },
  }));

  return names;
}

/** Exported for tests: keep the human rendering honest about basenames. */
export function scriptLabel(path: string): string {
  return basename(path);
}
