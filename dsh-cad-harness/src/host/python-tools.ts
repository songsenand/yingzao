// The two model-facing tools for the bundled Python runtime.
//
// `run_python` is the general escape hatch ("run this analysis with the real
// runtime"): it provisions on demand, executes a program or an existing .py
// file, and hands back stdout/stderr plus the full Python traceback. It is the
// deliberate opposite of a curated API — the same "open the real capability"
// stance the harness takes for bash and Node (DESIGN M4R pillar A), because a
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
  installIntoPythonOverlay,
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
  action?: 'status' | 'provision' | 'repair' | 'install';
  /** action=install: package specs, e.g. ["six==1.17.0", "svgpathtools"]. */
  packages?: string[];
  /** action=install: explicitly REPLACE a locked package (requires `reason`). */
  override?: boolean;
  /** action=install + override: why the locked version cannot be used (recorded). */
  reason?: string;
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
    // Absent facts must be ABSENT keys, not undefined-valued ones: the framework's
    // lossless-JSON check (`snapshotToolValue` → `walkJsonValue`) rejects any
    // property whose value is `undefined` — that check runs BEFORE schema
    // validation, so `?? undefined` here made every python_runtime call fail with
    // "value is not lossless JSON". Conditional spreads keep the comment above
    // ("omitted, not null") literally true.
    ...(status.target ? { target: status.target } : {}),
    pythonVersion: status.pythonVersion,
    mode: status.mode,
    ...(status.source ? { source: status.source } : {}),
    ...(status.interpreter ? { interpreter: status.interpreter } : {}),
    ...(status.venvPython ? { venvPython: status.venvPython } : {}),
    ...(status.installedAt ? { installedAt: status.installedAt } : {}),
    ...(status.phase ? { phase: status.phase } : {}),
    ...(status.error ? { error: status.error } : {}),
    occupiedBytes: status.occupiedBytes,
    occupied: humanBytes(status.occupiedBytes),
    skipped: status.skipped.map((entry) => `${entry.name}==${entry.version} (${entry.reason})`),
    missingPackages: status.missingPackages,
    // The user's own packages: always present as a field (an empty list is a
    // fact, not an omission), so a run can record "the overlay was empty".
    overlay: {
      dir: status.overlay.dir,
      overrideDir: status.overlay.overrideDir,
      packages: status.overlay.packages.map((p) => `${p.name}==${p.version}`),
      overrides: status.overlay.overrides.map((p) => `${p.name}==${p.version}`),
      digest: status.overlay.digest,
      bytes: status.overlay.bytes,
    },
  };
}

/**
 * The one line that keeps "absent by design" and "broken" from reading the same.
 *
 * `skipped` is the lock's deliberate omission for this platform; `missingPackages`
 * is a venv that cannot import what its own lock says it installed — the state a
 * matching marker used to hide.
 */
function skipSummary(status: PythonRuntimeStatus): string | null {
  const lines: string[] = [];
  if (status.missingPackages.length) {
    lines.push(`BROKEN: the venv cannot import ${status.missingPackages.join(', ')} — run action=repair`);
  }
  if (status.skipped.length) {
    lines.push(`not installed on this platform: ${status.skipped.map((entry) => `${entry.name} — ${entry.reason}`).join('; ')}`);
  }
  return lines.length ? lines.join('\n') : null;
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
  // The user's own packages: reported like everything else, never hidden and
  // never treated as a fault. Empty is the normal state.
  const add = status.overlay.packages.filter((p) => !p.override);
  const forced = status.overlay.overrides;
  lines.push(add.length === 0
    ? `user overlay: empty (${status.overlay.dir}) — python_runtime action=install adds packages here`
    : `user overlay: ${add.length} added package(s) in ${status.overlay.dir} — ` +
      `${add.map((p) => `${p.name}==${p.version}`).join(', ')} ` +
      `(digest ${status.overlay.digest.slice(0, 12)}); the locked venv wins on duplicates`);
  if (forced.length > 0) {
    // Explicit overrides are a fact with consequences: say it, don't bury it.
    lines.push(
      `overrides (explicit, replacing locked packages): ${forced.map((p) => `${p.name}==${p.version}`).join(', ')} ` +
      `in ${status.overlay.overrideDir} — runs record them in pythonOverlay.overrides; ` +
      'if a tool now fails on import, this is the first thing to suspect',
    );
  }
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
      'It also sees the USER OVERLAY (python_runtime action=install): installing a library is a normal act on the user\'s own machine, not an exception — ' +
      'the overlay survives runtime updates and is recorded in run provenance, so add one when the task needs what we do not ship. ' +
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
        // Null-valued results must be ABSENT keys, not `?? undefined` — and not
        // carried through by `...result` either. The framework's lossless-JSON
        // check rejects undefined-valued properties BEFORE schema validation (so
        // every run_python call failed with "value is not lossless JSON", even
        // `print("hello")`: a successful run still has signal=null and
        // traceback=null); a null that survived into the object would then fail
        // the schema's `type: integer` / `type: string` rows instead. Destructure
        // the three nullable fields out, then re-add only when they have values.
        const { exitCode: _ec, signal: _sig, traceback: _tb, ...rest } = result;
        return {
          ...rest,
          ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
          ...(result.signal ? { signal: result.signal } : {}),
          ...(result.traceback ? { traceback: result.traceback } : {}),
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
      'Status, repair and EXTENSION for the plugin\'s bundled Python runtime (CPython 3.13 + pinned numpy/scipy/trimesh/manifold3d/networkx/scikit-fem/rtree/rapier3d). ' +
      'action "status" (default) reports where it is, whether it is usable, its size, the last error and the USER OVERLAY; ' +
      '"provision" installs it now instead of waiting for the first run_python call; "repair" rebuilds the dependency environment; ' +
      '"install" adds packages to the user overlay — the runtime is the user\'s machine, so installing is a normal act, not a favour: ' +
      'the packages land in a directory provisioning never deletes, the worker and run_python both see them, and the overlay is recorded (status + run provenance). ' +
      'DEFAULT: adding is not overriding — a package the lock also provides keeps the LOCKED version (reported as shadowed). ' +
      'EXPLICIT: override:true + reason:"…" installs into a separate directory placed at the FRONT of sys.path, so the new version really replaces the locked one; ' +
      'agree it with the human first and expect runs to carry it in pythonOverlay.overrides. ' +
      'Use it when run_python reports a runtime problem, to warm the runtime before a long batch, or when a task needs a library we do not ship.',
    parameters: {
      action: {
        type: 'string',
        description: 'status (default) | provision | repair | install',
        enum: ['status', 'provision', 'repair', 'install'],
      },
      packages: {
        type: 'array',
        items: { type: 'string' },
        description: 'action=install only: package specs for pip, e.g. ["six==1.17.0", "svgpathtools"]. They go into the user overlay (not the locked venv), so a runtime update cannot erase them.',
      },
      override: {
        type: 'boolean',
        description: 'action=install only: explicitly REPLACE a package the lock pins. Default false = the copy is additive and the locked version keeps precedence. Requires reason.',
      },
      reason: {
        type: 'string',
        description: 'action=install + override: why the locked version cannot be used. Recorded with the install and carried into run provenance — this is the declaration, not ceremony.',
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
          missingPackages: {
            type: 'array',
            items: { type: 'string' },
            description: 'Locked packages the venv cannot actually import. NON-EMPTY MEANS THE RUNTIME IS BROKEN even though its marker matches — tools needing those packages degrade; action=repair rebuilds.',
          },
          overlay: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              dir: { type: 'string', required: true, description: 'The additive dir (appended; locked wins on duplicates).' },
              overrideDir: { type: 'string', required: true, description: 'The explicit-override dir (front of sys.path).' },
              packages: { type: 'array', items: { type: 'string' }, required: true, description: 'name==version in the user overlay; empty means none.' },
              overrides: { type: 'array', items: { type: 'string' }, required: true, description: 'name==version installed with an explicit override — these REPLACE the locked copies.' },
              digest: { type: 'string', required: true, description: 'sha256 over the sorted package list (an override is marked !); \'\' when empty. Recorded in run provenance.' },
              bytes: { type: 'integer', required: true },
            },
          },
          installed: {
            type: 'array', items: { type: 'string' },
            description: 'action=install: every package in the overlay after the install.',
          },
          overrides: {
            type: 'array', items: { type: 'string' },
            description: 'action=install: packages installed with an explicit override (they replace the locked copies).',
          },
          shadowed: {
            type: 'array', items: { type: 'string' },
            description: 'action=install: overlay packages the locked venv also provides — the LOCKED version wins (adding is not overriding).',
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

      if (action === 'install') {
        const wanted = ((args ?? {}) as RuntimeToolArgs).packages ?? [];
        try {
          const parsed = (args ?? {}) as RuntimeToolArgs;
          const result = await installIntoPythonOverlay(wanted, {
            onProgress,
            override: parsed.override === true,
            reason: parsed.reason,
          });
          const status = await pythonRuntimeStatus();
          const summary = [
            `installed into the user overlay ${result.dir}`,
            `overlay now: ${result.packages.map((p) => `${p.name}==${p.version}`).join(', ') || '(empty)'}`,
            ...(result.overrides.length
              ? [`OVERRIDE active: ${result.overrides.map((p) => `${p.name}==${p.version}`).join(', ')} REPLACE the locked copies (front of sys.path); recorded in run provenance`]
              : []),
            ...(result.shadowed.length
              ? [`note: the lock also provides ${result.shadowed.map((p) => p.name).join(', ')} — the LOCKED version wins (add override:true + reason to replace it)`]
              : []),
            `visible to the worker and to run_python; recorded in run provenance (digest ${status.overlay.digest.slice(0, 12) || '—'})`,
          ].join('\n');
          return {
            action,
            ...statusFields(status),
            installed: result.packages.map((p) => `${p.name}==${p.version}`),
            overrides: result.overrides.map((p) => `${p.name}==${p.version}`),
            shadowed: result.shadowed.map((p) => `${p.name}==${p.version}`),
            provisionLog: progress.slice(-10),
            summary,
          };
        } catch (error) {
          const message = String((error as Error)?.message ?? error);
          const status = await pythonRuntimeStatus();
          return {
            action,
            ...statusFields(status),
            provisionLog: progress.slice(-10),
            summary: `install into the user overlay FAILED: ${message}`,
          };
        }
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
