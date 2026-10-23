// The single wiring point for the bundled Python runtime.
//
// WHY THIS EXISTS. The plugin runs on machines we have never seen: distro Python
// ranges from 3.8 to 3.14, PEP 668 forbids installing into the system
// interpreter, and conda/pyenv answer to their owners. "Have a usable Python" is
// therefore not a host capability we can assume — it is an artifact we ship.
// python-build-standalone publishes relocatable CPython builds for every platform
// we support, so provisioning is one code path: download the archive, verify its
// sha256, extract, build a venv from it, install a hash-locked dependency set.
// See docs/DECISION-LOG.md 2026-10-08 for the decision and the measurements.
//
// WHY AT RUNTIME AND NOT AT INSTALL TIME. pnpm 11 gates dependency build scripts:
// a postinstall downloader makes `dsh plugin install` fail and wait for a GUI
// approval, then rolls back on cancellation. Host code runs unsandboxed and
// needs no such permission, so provisioning happens on first use — or eagerly in
// the background when `pythonRuntime: 'eager'`.
//
// WHERE THINGS LIVE ($DSH_HOME/cad/runtime, shared by every project):
//   python/<version>/   the extracted interpreter
//   venv/               the dependency environment built from it
//   cache/              verified interpreter archives + the pip wheel cache
//                       (cache/pip), so a repair re-downloads nothing it
//                       already has — every cached wheel is hash-rechecked
//                       against the lock on reuse
//   requirements.lock   the exact locked set pip installs
//   state.json          phase + failure, readable without booting the plugin

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { projectsHome } from './project.ts';
import {
  PIP_INDEXES,
  PYTHON_BUILD,
  PYTHON_LOCK_PROTOCOL,
  REQUIREMENTS_LOCK,
  REQUIREMENTS_LOCK_SHA256,
  type PythonBuildTarget,
} from './python-lock.ts';
import { extractTarGz } from './tar-extract.ts';

export type PythonRuntimeMode = 'auto' | 'eager' | 'off' | 'system';
export type PythonRuntimeState = 'ready' | 'absent' | 'provisioning' | 'failed' | 'disabled' | 'unsupported';

export interface PythonRuntimePaths {
  root: string;
  target: string;
  pythonVersion: string;
  requirementsSha: string;
  interpreter: string;
  venvPython: string;
  source: 'standalone' | 'dsh-primary-runtime' | 'system';
}

export interface PythonRuntimeStatus {
  state: PythonRuntimeState;
  protocol: number;
  mode: PythonRuntimeMode;
  root: string;
  target: string | null;
  pythonVersion: string;
  requirementsSha: string;
  interpreter: string | null;
  venvPython: string | null;
  source: string | null;
  installedAt: string | null;
  phase: string | null;
  error: string | null;
  occupiedBytes: number;
  /** Packages this platform's lock deliberately leaves out, with reasons. */
  skipped: LockSkip[];
  /**
   * Locked packages the venv cannot import. Non-empty means the runtime is NOT
   * usable even though its marker matches — `state` is then `failed`, because a
   * "ready" badge over a venv that cannot import its own lock is the lie this
   * field exists to prevent.
   */
  missingPackages: string[];
  /**
   * Packages the USER installed into the overlay — their wiring, not ours.
   * Recorded and reported, never gated (see the overlay section at the bottom).
   */
  overlay: PythonOverlay;
}

export interface ProvisionOptions {
  /** Human-readable progress; also written to state.json. */
  onProgress?: (message: string) => void;
  /** Rebuild even when the marker matches (repair). */
  force?: boolean;
  /** Give up on a single pip index after this long and try the next. */
  pipTimeoutMs?: number;
}

interface RuntimeStateFile {
  protocol: number;
  target: string | null;
  pythonVersion: string;
  requirementsSha: string;
  source: string | null;
  interpreter: string | null;
  venvPython: string | null;
  installedAt: string | null;
  phase: string | null;
  error: string | null;
  skipped: LockSkip[];
}

const DEFAULT_PIP_TIMEOUT_MS = 20 * 60 * 1000;
const PROBE_TIMEOUT_MS = 15 * 1000;

// ---------------------------------------------------------------------------
// process helper (shared with python-worker.ts)
// ---------------------------------------------------------------------------

export interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface ProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Called for every complete stdout/stderr line, throttled by the caller. */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
}

/**
 * Run a child to completion, capturing output and enforcing a deadline.
 *
 * The child gets its own process group on POSIX so a deadline kills anything it
 * spawned (pip pulls in subprocesses; an orphaned one holding the pipes open is
 * how a "timed out" install hangs forever).
 */
export function runProcess(command: string, args: string[], options: ProcessOptions = {}): Promise<ProcessResult> {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const collect = (stream: 'stdout' | 'stderr') => {
      let pending = '';
      return (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        if (stream === 'stdout') stdout += text;
        else stderr += text;
        if (!options.onLine) return;
        pending += text;
        let index = pending.indexOf('\n');
        while (index >= 0) {
          options.onLine(pending.slice(0, index).trimEnd(), stream);
          pending = pending.slice(index + 1);
          index = pending.indexOf('\n');
        }
      };
    };

    child.stdout?.on('data', collect('stdout'));
    child.stderr?.on('data', collect('stderr'));

    const kill = () => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    };

    const timer = options.timeoutMs
      ? setTimeout(() => { timedOut = true; kill(); }, options.timeoutMs)
      : undefined;

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise({ code, signal, stdout, stderr, timedOut, durationMs: Date.now() - started });
    };

    child.once('error', () => finish(null, null));
    child.once('close', (code, signal) => finish(code, signal));
  });
}

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------

function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

let configuredMode: PythonRuntimeMode | null = null;

/**
 * The profile patch may set the mode (config `pythonRuntime`); the environment
 * overrides it so an operator can disable the runtime without editing YAML.
 */
export function configurePythonRuntime(config: { mode?: PythonRuntimeMode }): void {
  if (config?.mode) configuredMode = config.mode;
}

export function pythonRuntimeMode(): PythonRuntimeMode {
  const raw = envValue('DSH_CAD_PYTHON')?.toLowerCase();
  if (raw) {
    if (raw === 'off' || raw === '0' || raw === 'false') return 'off';
    if (raw === 'system') return 'system';
    if (raw === 'eager') return 'eager';
    return 'auto';
  }
  return configuredMode ?? 'auto';
}

/** `$DSH_HOME/cad/runtime` — profile level, shared across projects by design. */
export function pythonRuntimeRoot(): string {
  const override = envValue('DSH_CAD_PYTHON_ROOT');
  return override ? resolve(override) : join(projectsHome(), 'runtime');
}

/** The primary runtime payload a Desktop/SDK carrier may ship (see §12 / DECISION-LOG). */
function dshPrimaryRuntimePython(): string | null {
  const carrier = envValue('DSH_PRIMARY_RUNTIME') ?? envValue('DSH_BUNDLED_PRIMARY_RUNTIME');
  if (!carrier) return null;
  const root = resolve(carrier);
  const candidates = [
    join(root, 'dependencies', 'python', 'bin', 'python3'),
    join(root, 'dependencies', 'python', 'python.exe'),
    join(root, 'python', 'bin', 'python3'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function muslLinux(): boolean {
  const report = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined;
  return !report?.header?.glibcVersionRuntime;
}

/** Lock key for this machine, or null when the platform is not shipped. */
export function detectPythonTarget(): string | null {
  const { platform, arch } = process;
  if (platform === 'linux') {
    if (arch === 'x64') return muslLinux() ? 'linux-x64-musl' : 'linux-x64-gnu';
    if (arch === 'arm64') return muslLinux() ? 'linux-arm64-musl' : 'linux-arm64-gnu';
    return null;
  }
  if (platform === 'darwin') return arch === 'arm64' ? 'darwin-arm64' : arch === 'x64' ? 'darwin-x64' : null;
  if (platform === 'win32') return arch === 'x64' ? 'win32-x64' : null;
  return null;
}

function venvPythonPath(root: string): string {
  return process.platform === 'win32'
    ? join(root, 'venv', 'Scripts', 'python.exe')
    : join(root, 'venv', 'bin', 'python');
}

function statePath(root: string): string {
  return join(root, 'state.json');
}

function markerPath(root: string): string {
  return join(root, 'venv', '.cad-harness-python.json');
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function readState(root: string): Promise<RuntimeStateFile | null> {
  try {
    const text = await readFile(statePath(root), 'utf8');
    const parsed = JSON.parse(text) as RuntimeStateFile;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function writeState(root: string, patch: Partial<RuntimeStateFile>): Promise<RuntimeStateFile> {
  const previous = (await readState(root)) ?? {
    protocol: PYTHON_LOCK_PROTOCOL,
    target: detectPythonTarget(),
    pythonVersion: PYTHON_BUILD.pythonVersion,
    requirementsSha: REQUIREMENTS_LOCK_SHA256,
    source: null,
    interpreter: null,
    venvPython: null,
    installedAt: null,
    phase: null,
    error: null,
    skipped: [],
  };
  const next: RuntimeStateFile = { ...previous, ...patch, protocol: PYTHON_LOCK_PROTOCOL };
  await mkdir(root, { recursive: true });
  await writeFile(statePath(root), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

async function directorySize(path: string, budget = { bytes: 0, entries: 0 }): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(path);
  } catch {
    return budget.bytes;
  }
  for (const entry of entries) {
    if (budget.entries++ > 20000) break;
    const child = join(path, entry);
    try {
      // lstat, not stat: a venv is full of symlinks (lib64 -> lib, bin/python ->
      // python3.13) and following them double-counts whole trees — the first
      // version of this reported 813 MiB for a ~390 MiB runtime.
      const info = await lstat(child);
      if (info.isDirectory()) budget.bytes = await directorySize(child, budget);
      else budget.bytes += info.size;
    } catch {
      // A racing delete is not a status failure.
    }
  }
  return budget.bytes;
}

/** Never throws: a status call is what the user reaches for when things are broken. */
export async function pythonRuntimeStatus(): Promise<PythonRuntimeStatus> {
  const root = pythonRuntimeRoot();
  const mode = pythonRuntimeMode();
  const target = detectPythonTarget();
  const state = await readState(root);
  const base: PythonRuntimeStatus = {
    state: mode === 'off' ? 'disabled' : target ? 'absent' : 'unsupported',
    protocol: PYTHON_LOCK_PROTOCOL,
    mode,
    root,
    target,
    pythonVersion: PYTHON_BUILD.pythonVersion,
    requirementsSha: REQUIREMENTS_LOCK_SHA256,
    interpreter: state?.interpreter ?? null,
    venvPython: state?.venvPython ?? null,
    source: state?.source ?? null,
    installedAt: state?.installedAt ?? null,
    phase: state?.phase ?? null,
    error: state?.error ?? null,
    occupiedBytes: await directorySize(root),
    // A warm venv still has to explain what it does not contain, so this comes
    // from the lock plan rather than only from the recorded install.
    skipped: state?.skipped ?? lockPlanForTarget(target).skipped,
    missingPackages: [],
    overlay: await readPythonOverlay(),
  };
  if (mode === 'off' || !target) return base;
  if (state?.interpreter && state?.venvPython && existsSync(state.interpreter) && existsSync(state.venvPython)) {
    // Existence is not readiness: check that the locked set actually imports.
    const missing = await missingLockedImports(state.venvPython, target);
    if (missing.length > 0) {
      return {
        ...base,
        state: 'failed',
        missingPackages: missing,
        error: `the venv cannot import ${missing.join(', ')} (present on disk, not importable) — run python_runtime action=repair`,
      };
    }
    return { ...base, state: 'ready', error: null };
  }
  if (state?.error) return { ...base, state: 'failed' };
  return base;
}

// ---------------------------------------------------------------------------
// provenance: system interpreter and archive cache
// ---------------------------------------------------------------------------

async function probeInterpreter(command: string): Promise<{ major: number; minor: number; micro: number } | null> {
  const probe = await runProcess(
    command,
    ['-c', 'import sys;print("%d.%d.%d" % sys.version_info[:3])'],
    { timeoutMs: PROBE_TIMEOUT_MS },
  );
  if (probe.code !== 0) return null;
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(probe.stdout);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), micro: Number(match[3]) };
}

async function resolveSystemInterpreter(): Promise<string> {
  const explicit = envValue('DSH_CAD_PYTHON_BIN');
  const candidates = explicit
    ? [explicit]
    : process.platform === 'win32'
      ? ['python.exe', 'python3.exe', 'python']
      : ['python3', 'python'];
  for (const candidate of candidates) {
    const resolved = candidate.includes('/') || candidate.includes('\\') ? resolve(candidate) : await which(candidate);
    if (!resolved) continue;
    const version = await probeInterpreter(resolved);
    if (!version) continue;
    if (version.major < 3 || (version.major === 3 && version.minor < 10)) continue;
    return resolved;
  }
  throw new Error(
    'DSH_CAD_PYTHON=system but no CPython 3.10+ was found on PATH; ' +
      'set DSH_CAD_PYTHON_BIN to an absolute interpreter path, or unset DSH_CAD_PYTHON to use the bundled runtime',
  );
}

async function which(command: string): Promise<string | null> {
  const locator = process.platform === 'win32' ? 'where' : 'which';
  const result = await runProcess(locator, [command], { timeoutMs: PROBE_TIMEOUT_MS });
  const first = result.stdout.split('\n').map((line) => line.trim()).find(Boolean);
  return result.code === 0 && first ? first : null;
}

function assetUrl(base: string, target: PythonBuildTarget): string {
  // The '+' in the version/build part is legal in a URL path but escape it so
  // servers that treat '+' as a space still find the asset.
  const asset = target.asset.replace(/\+/g, '%2B');
  return `${base.replace(/\/$/, '')}/${PYTHON_BUILD.buildTag}/${asset}`;
}

async function downloadArchive(
  target: PythonBuildTarget,
  root: string,
  onProgress: (message: string) => void,
): Promise<string> {
  const cacheDir = join(root, 'cache');
  const cached = join(cacheDir, target.asset);
  if (existsSync(cached)) {
    const digest = await hashFile(cached);
    if (digest === target.sha256) return cached;
    await rm(cached, { force: true });
  }

  await mkdir(cacheDir, { recursive: true });
  const override = envValue('DSH_CAD_PYTHON_MIRROR');
  const bases = override ? [override] : [PYTHON_BUILD.baseUrl, ...PYTHON_BUILD.mirrors];
  const failures: string[] = [];

  for (const base of bases) {
    const url = assetUrl(base, target);
    const partial = `${cached}.part`;
    try {
      onProgress(`downloading ${target.asset} from ${new URL(url).host}`);
      const response = await fetch(url, { redirect: 'follow' });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      const hash = createHash('sha256');
      const handle = await import('node:fs/promises').then((fs) => fs.open(partial, 'w'));
      let received = 0;
      let lastReport = 0;
      try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          const bytes = Buffer.from(chunk);
          hash.update(bytes);
          await handle.write(bytes);
          received += bytes.length;
          if (received - lastReport > 8 * 1024 * 1024) {
            lastReport = received;
            onProgress(`downloading ${target.asset}: ${(received / 1048576).toFixed(1)} MiB`);
          }
        }
      } finally {
        await handle.close();
      }
      const digest = hash.digest('hex');
      if (digest !== target.sha256) {
        await rm(partial, { force: true });
        throw new Error(`sha256 mismatch: expected ${target.sha256}, got ${digest}`);
      }
      await rename(partial, cached);
      onProgress(`verified ${target.asset} (${(received / 1048576).toFixed(1)} MiB)`);
      return cached;
    } catch (error) {
      await rm(`${cached}.part`, { force: true });
      failures.push(`${new URL(url).host}: ${String((error as Error)?.message ?? error)}`);
    }
  }
  throw new Error(`could not download ${target.asset} — ${failures.join('; ')}`);
}

async function hashFile(path: string): Promise<string> {
  const { createReadStream } = await import('node:fs');
  const hash = createHash('sha256');
  await new Promise<void>((resolvePromise, reject) => {
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolvePromise());
  });
  return hash.digest('hex');
}

async function ensureStandaloneInterpreter(
  target: PythonBuildTarget,
  root: string,
  onProgress: (message: string) => void,
  force: boolean,
): Promise<string> {
  const finalDir = join(root, 'python', PYTHON_BUILD.pythonVersion);
  const interpreter = join(finalDir, ...target.interpreter.split('/'));
  if (!force && existsSync(interpreter) && (await probeInterpreter(interpreter))) return interpreter;

  const archive = await downloadArchive(target, root, onProgress);
  await writeState(root, { phase: 'extracting', error: null });
  onProgress(`extracting ${target.asset}`);
  const staging = join(root, 'python', `.staging-${process.pid}-${Date.now()}`);
  await rm(staging, { recursive: true, force: true });
  try {
    await extractTarGz(archive, staging, {
      stripPrefix: PYTHON_BUILD.archiveRoot,
      onProgress: (done) => {
        if (done % (32 * 1024 * 1024) < 65536) onProgress(`extracting ${target.asset}: ${(done / 1048576).toFixed(0)} MiB`);
      },
    });
    const stagedInterpreter = join(staging, ...target.interpreter.split('/'));
    if (!existsSync(stagedInterpreter)) {
      throw new Error(`archive did not contain ${target.interpreter}`);
    }
    await rm(finalDir, { recursive: true, force: true });
    await mkdir(join(root, 'python'), { recursive: true });
    await rename(staging, finalDir);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }

  const version = await probeInterpreter(interpreter);
  if (!version) throw new Error(`the extracted interpreter at ${interpreter} did not run`);
  onProgress(`python ${version.major}.${version.minor}.${version.micro} ready`);
  return interpreter;
}

// ---------------------------------------------------------------------------
// venv + dependency install
// ---------------------------------------------------------------------------

interface VenvMarker {
  protocol: number;
  pythonVersion: string;
  requirementsSha: string;
  target: string;
  source: string;
  createdAt: string;
}

async function venvIsCurrent(root: string, target: string, source: string): Promise<boolean> {
  try {
    const marker = JSON.parse(await readFile(markerPath(root), 'utf8')) as VenvMarker;
    return (
      marker.protocol === PYTHON_LOCK_PROTOCOL &&
      marker.pythonVersion === PYTHON_BUILD.pythonVersion &&
      marker.requirementsSha === REQUIREMENTS_LOCK_SHA256 &&
      marker.target === target &&
      marker.source === source
    );
  } catch {
    return false;
  }
}

/**
 * The locked packages, by import name.
 *
 * Kept here so "installed" can be CHECKED rather than assumed. The marker only
 * proves that a pip run finished; it does not prove the packages are importable.
 * On 2026-10-11 this machine held a venv whose marker matched perfectly and which
 * was missing `rtree` and `shapely` — so `python_runtime status` said `ready`
 * while `check_printability`'s ray half silently measured nothing (every ray
 * raised, every exception was swallowed, and the tool called the part clean).
 * A readiness claim that cannot be falsified is how that stays invisible.
 */
const LOCKED_IMPORTS: { pkg: string; module: string }[] = [
  { pkg: 'numpy', module: 'numpy' },
  { pkg: 'scipy', module: 'scipy' },
  { pkg: 'trimesh', module: 'trimesh' },
  { pkg: 'manifold3d', module: 'manifold3d' },
  // MPM kernel JIT engine (2026-10-14). Excluded targets (musl, darwin-x64) are
  // skipped by the lock plan below, so "absent by design" stays distinct from
  // "broken" — the worker's `_mpm_engine` falls back to the numpy kernel there.
  { pkg: 'numba', module: 'numba' },
  { pkg: 'networkx', module: 'networkx' },
  { pkg: 'scikit-fem', module: 'skfem' },
  { pkg: 'rtree', module: 'rtree' },
  { pkg: 'rapier3d', module: 'rapier3d' },
  { pkg: 'shapely', module: 'shapely' },
  // Import formats are capability claims too. Without these the runtime reports
  // `ready` while `import_part` fails at use time with a worker error — the same
  // unfalsifiable readiness the rtree/shapely incident exposed. cascadio is
  // excluded on musl by the lock plan, so "absent by design" still differs from
  // "broken" (the skip list is applied below).
  { pkg: 'cascadio', module: 'cascadio' },
  { pkg: 'ezdxf', module: 'ezdxf' },
  { pkg: 'lxml', module: 'lxml' },
];

/**
 * Which locked packages this venv cannot actually import.
 *
 * Empty array = the venv is what the marker claims. Packages the lock
 * deliberately omits for this target are NOT reported: "absent by design" and
 * "broken" must not look the same (that distinction is the lock's own
 * `cad-exclude` contract).
 */
export async function missingLockedImports(venvPython: string, target: string): Promise<string[]> {
  const skipped = new Set(lockPlanForTarget(target).skipped.map((s) => s.name));
  const wanted = LOCKED_IMPORTS.filter((entry) => !skipped.has(entry.pkg));
  if (wanted.length === 0) return [];
  const modules = JSON.stringify(wanted.map((entry) => entry.module));
  const program = [
    'import importlib, json, sys',
    `failed = []`,
    `for name in ${modules}:`,
    '    try:',
    '        importlib.import_module(name)',
    '    except BaseException:',
    '        failed.append(name)',
    'sys.stdout.write("__MISSING__" + json.dumps(failed))',
  ].join('\n');
  const probe = await runProcess(venvPython, ['-I', '-c', program], { timeoutMs: 120_000 });
  const marker = probe.stdout.lastIndexOf('__MISSING__');
  if (probe.code !== 0 || marker < 0) {
    // The interpreter itself did not run: that is every package missing, not none.
    return wanted.map((entry) => entry.pkg);
  }
  let failedModules: string[] = [];
  try {
    failedModules = JSON.parse(probe.stdout.slice(marker + '__MISSING__'.length).trim()) as string[];
  } catch {
    return wanted.map((entry) => entry.pkg);
  }
  return wanted.filter((entry) => failedModules.includes(entry.module)).map((entry) => entry.pkg);
}

export interface LockSkip {
  name: string;
  version: string;
  targets: string[];
  reason: string;
}

export interface LockPlan {
  /** The requirements text pip will read. */
  text: string;
  /** Packages this target's lock drops, each with the reason it carries. */
  skipped: LockSkip[];
}

/**
 * Resolve the lock for one target.
 *
 * The lock is a single file so a review sees the whole dependency set, but some
 * packages have no wheel for some platforms — rapier3d has none for darwin-x64.
 * Rather than a PEP 508 marker (pip's requirements-file parser rejected that
 * form next to `--hash` continuations, measured 2026-10-08), a generated
 * directive drops the block AND carries the reason, because the user decision
 * for that case is "keep the TS engine there", not "physics is unavailable".
 * A skip that is only visible as a missing import is a skip nobody understands.
 */
export function lockPlanForTarget(target: string | null): LockPlan {
  const out: string[] = [];
  const skipped: LockSkip[] = [];
  let pending: { targets: string[]; reason: string } | null = null;
  let dropping = false;
  for (const line of REQUIREMENTS_LOCK.split('\n')) {
    const directive = /^#\s*cad-exclude:\s*([^|]+)\|\s*(.+)$/.exec(line.trim());
    if (directive) {
      pending = {
        targets: directive[1]!.split(',').map((part) => part.trim()).filter(Boolean),
        reason: directive[2]!.trim(),
      };
      dropping = pending.targets.includes(target ?? '');
      continue;
    }
    if (dropping) {
      const requirement = /^([A-Za-z0-9_.-]+)==([^\s\\]+)/.exec(line.trim());
      if (requirement && pending && !skipped.some((entry) => entry.name === requirement[1])) {
        skipped.push({ name: requirement[1]!, version: requirement[2]!, targets: pending.targets, reason: pending.reason });
      }
      if (line.trim() === '') {
        dropping = false;
        pending = null;
      }
      continue;
    }
    out.push(line);
  }
  return { text: out.join('\n'), skipped };
}

/** Convenience: the requirements text for one target. */
export function lockForTarget(target: string | null): string {
  return lockPlanForTarget(target).text;
}

async function installDependencies(
  venvPython: string,
  root: string,
  target: string | null,
  onProgress: (message: string) => void,
  timeoutMs: number,
): Promise<{ index: string; skipped: LockSkip[] }> {
  const plan = lockPlanForTarget(target);
  const lockPath = join(root, 'requirements.lock');
  await writeFile(lockPath, plan.text);
  for (const skip of plan.skipped) {
    onProgress(`not installed on ${target}: ${skip.name}==${skip.version} — ${skip.reason}`);
  }

  const override = envValue('DSH_CAD_PYTHON_INDEX_URL');
  const indexes = override ? [override] : [...PIP_INDEXES];
  const failures: string[] = [];

  // The wheel cache lives INSIDE the runtime root — never the user's global
  // ~/.cache/pip — so reinstalls (the common trigger being a lock bump) reuse
  // every unchanged wheel while the cache still dies with the runtime it
  // belongs to. This is safe under --require-hashes: pip re-verifies each
  // cached wheel against the lock hashes, so a tampered cache entry fails the
  // install instead of silently shipping different bytes. (It does NOT make a
  // single cold install faster — pip does not resume partial downloads.) A
  // deployment can share one cache across homes via DSH_CAD_PIP_CACHE_DIR;
  // the acceptance scripts point it at a repo-ignored dir so reruns are warm.
  const pipCache = envValue('DSH_CAD_PIP_CACHE_DIR') ?? join(root, 'cache', 'pip');
  await mkdir(pipCache, { recursive: true });

  for (const index of indexes) {
    onProgress(`installing locked dependencies from ${new URL(index).host}`);
    const result = await runProcess(
      venvPython,
      [
        '-m', 'pip', 'install',
        '--require-hashes',
        // --no-deps because the lock IS the closure: gen-python-lock.mjs lists
        // every package the worker actually imports, and xlb's DECLARED list is
        // deliberately not honored (matplotlib/pyvista/vtk/numpy-stl/pydantic/
        // ruff — ~726 MB for an unused visualization import the wrapper stubs).
        // Without this flag pip would demand hashes for those declared-but-
        // excluded packages and refuse to install. The cost of the trade: a
        // genuinely needed transitive dep must be added to the lock by hand —
        // which LOCKED_IMPORTS (readiness probe) and the acceptances catch.
        '--no-deps',
        '--only-binary=:all:',
        '--cache-dir', pipCache,
        '--disable-pip-version-check',
        '--no-input',
        '--index-url', index,
        '-r', lockPath,
      ],
      {
        timeoutMs,
        onLine: (line) => {
          if (/^(Collecting|Downloading|Installing|Successfully|ERROR)/.test(line)) onProgress(line.slice(0, 200));
        },
      },
    );
    if (result.code === 0) return { index, skipped: plan.skipped };
    const reason = result.timedOut
      ? `timed out after ${Math.round(timeoutMs / 60000)} min`
      : (result.stderr.trim().split('\n').slice(-3).join(' | ') || `exit ${result.code}`);
    failures.push(`${new URL(index).host}: ${reason}`);
  }
  throw new Error(`pip could not install the locked dependencies — ${failures.join('; ')}`);
}

// ---------------------------------------------------------------------------
// provisioning
// ---------------------------------------------------------------------------

let inflight: Promise<PythonRuntimePaths> | null = null;

/**
 * Idempotent: concurrent callers share one provisioning run.
 *
 * The disabled check happens BEFORE the cache on purpose — a runtime provisioned
 * earlier in this process must not stay reachable after the operator sets
 * `DSH_CAD_PYTHON=off` (that is exactly what an off switch is for).
 */
export function ensurePythonRuntime(options: ProvisionOptions = {}): Promise<PythonRuntimePaths> {
  if (pythonRuntimeMode() === 'off') {
    return Promise.reject(new Error('the bundled Python runtime is disabled (DSH_CAD_PYTHON=off)'));
  }
  if (!inflight || options.force) {
    inflight = provision(options).catch((error) => {
      inflight = null;
      throw error;
    });
  }
  return inflight;
}

async function provision(options: ProvisionOptions): Promise<PythonRuntimePaths> {
  const mode = pythonRuntimeMode();
  if (mode === 'off') {
    throw new Error('the bundled Python runtime is disabled (DSH_CAD_PYTHON=off)');
  }
  const root = pythonRuntimeRoot();
  const target = detectPythonTarget();
  const progress = (message: string) => options.onProgress?.(message);

  if (mode === 'system') {
    const interpreter = await resolveSystemInterpreter();
    // Keep the machine's target key so per-target lock exclusions still apply.
    const paths = await prepareVenv(root, detectPythonTarget() ?? 'system', interpreter, 'system', progress, options);
    return paths;
  }
  if (!target) {
    throw new Error(
      `no bundled Python runtime for ${process.platform}/${process.arch}; ` +
        'set DSH_CAD_PYTHON=system to use a system interpreter instead',
    );
  }

  const lockTarget = PYTHON_BUILD.targets[target];
  if (!lockTarget) throw new Error(`python lock has no target ${target} (regenerate it with scripts/gen-python-lock.mjs)`);

  const carrierPython = dshPrimaryRuntimePython();
  let interpreter: string;
  let source: PythonRuntimePaths['source'];
  if (carrierPython && !options.force) {
    const version = await probeInterpreter(carrierPython);
    if (version) {
      interpreter = carrierPython;
      source = 'dsh-primary-runtime';
      progress(`using the DSH carrier interpreter at ${carrierPython}`);
    } else {
      interpreter = await standalone(root, lockTarget, progress, options.force);
      source = 'standalone';
    }
  } else {
    interpreter = await standalone(root, lockTarget, progress, options.force);
    source = 'standalone';
  }

  return await prepareVenv(root, target, interpreter, source, progress, options);
}

async function standalone(
  root: string,
  target: PythonBuildTarget,
  progress: (message: string) => void,
  force = false,
): Promise<string> {
  await writeState(root, { phase: 'interpreter', error: null, target: detectPythonTarget() });
  return await ensureStandaloneInterpreter(target, root, progress, force);
}

async function prepareVenv(
  root: string,
  target: string,
  interpreter: string,
  source: PythonRuntimePaths['source'],
  progress: (message: string) => void,
  options: ProvisionOptions,
): Promise<PythonRuntimePaths> {
  const venvPython = venvPythonPath(root);
  // The lock plan is what "installed on this platform" means; on a warm venv it
  // still has to be reported, so the skip list survives a no-op provisioning.
  let skipped: LockSkip[] = lockPlanForTarget(target).skipped;
  let current = !options.force && (await venvIsCurrent(root, target, source)) && existsSync(venvPython);
  if (current) {
    // A matching marker proves a pip run FINISHED, not that the packages are
    // importable. Verify, and treat a venv that cannot import the locked set as
    // not current — otherwise a half-installed venv keeps its "ready" badge and
    // every tool that needs the missing package degrades instead of failing.
    const missing = await missingLockedImports(venvPython, target);
    if (missing.length > 0) {
      progress(`runtime is missing ${missing.join(', ')} — reinstalling the locked set`);
      current = false;
    }
  }

  if (!current) {
    await writeState(root, { phase: 'venv', error: null, target, source, interpreter });
    progress('creating the runtime venv');
    await rm(join(root, 'venv'), { recursive: true, force: true });
    const created = await runProcess(interpreter, ['-m', 'venv', join(root, 'venv')], {
      timeoutMs: 5 * 60 * 1000,
      onLine: (line) => progress(`venv: ${line.slice(0, 160)}`),
    });
    if (created.code !== 0) {
      throw new Error(`python -m venv failed: ${created.stderr.trim().split('\n').slice(-3).join(' | ')}`);
    }
    const installed = await installDependencies(
      venvPython,
      root,
      target,
      progress,
      options.pipTimeoutMs ?? DEFAULT_PIP_TIMEOUT_MS,
    );
    // BEFORE the marker: a pip run that exits 0 has not thereby installed
    // anything. The marker is what makes this venv "current" forever after, so
    // writing it over a venv that cannot import the locked set is exactly how a
    // `ready` runtime ends up with a silently dead ray engine.
    const stillMissing = await missingLockedImports(venvPython, target);
    if (stillMissing.length > 0) {
      throw new Error(
        `the dependency install finished but ${stillMissing.join(', ')} cannot be imported — ` +
        'the runtime is NOT ready (marker not written, so the next call retries)',
      );
    }
    const marker: VenvMarker = {
      protocol: PYTHON_LOCK_PROTOCOL,
      pythonVersion: PYTHON_BUILD.pythonVersion,
      requirementsSha: REQUIREMENTS_LOCK_SHA256,
      target,
      source,
      createdAt: new Date().toISOString(),
    };
    await writeFile(markerPath(root), `${JSON.stringify(marker, null, 2)}\n`);
    progress(`dependencies installed via ${new URL(installed.index).host}`);
    if (installed.skipped.length) {
      skipped = installed.skipped;
    }
  }

  const state = await writeState(root, {
    phase: null,
    error: null,
    target,
    source,
    interpreter,
    venvPython,
    skipped,
    installedAt: new Date().toISOString(),
  });
  return {
    root,
    target,
    pythonVersion: PYTHON_BUILD.pythonVersion,
    requirementsSha: REQUIREMENTS_LOCK_SHA256,
    interpreter,
    venvPython,
    source: (state.source as PythonRuntimePaths['source']) ?? source,
  };
}

/** Record a provisioning failure so the next status call can explain it. */
export async function recordRuntimeFailure(error: unknown, options: ProvisionOptions = {}): Promise<string> {
  const root = pythonRuntimeRoot();
  const message = String((error as Error)?.message ?? error);
  await writeState(root, { phase: null, error: message });
  options.onProgress?.(`python runtime provisioning failed: ${message}`);
  return message;
}

/** Drop the venv (keeps the interpreter and the archive cache) so the next call rebuilds it. */
export async function repairPythonRuntime(options: ProvisionOptions = {}): Promise<PythonRuntimePaths> {
  const root = pythonRuntimeRoot();
  await rm(join(root, 'venv'), { recursive: true, force: true });
  inflight = null;
  return await ensurePythonRuntime({ ...options, force: true });
}

// ---------------------------------------------------------------------------
// user overlay: the packages the USER installs — their wiring, not ours
// ---------------------------------------------------------------------------
//
// WHY A SEPARATE DIRECTORY. Provisioning owns `venv/` and DELETES it whenever the
// lock changes (`venvIsCurrent` -> `rm -rf venv`), so a package pip-installed
// into the venv disappears on the next runtime update — silently. The overlay
// lives BESIDE `venv/` and provision/repair never touch it, so the user's own
// packages survive exactly like the interpreter and the archive cache do.
//
// WHY NOT PYTHONPATH. Both the worker and one-off scripts start with `-I`, which
// ignores PYTHONPATH and the user site directory ON PURPOSE (python-worker.ts):
// that isolation is what makes "what actually ran" answerable. The overlay is
// therefore attached EXPLICITLY — `site.addsitedir` in the launch bootstrap
// (`pythonLaunchArgs`) — so the visible set stays enumerable and recordable.
//
// TWO DIRECTORIES, TWO POLICIES.
//
//   user-site/            ADDITIVE. Appended (addsitedir), so a package the lock
//                         also provides keeps the LOCKED version. Adding a library
//                         must not silently fork numpy.
//   user-site-override/   EXPLICIT OVERRIDE. Only `python_runtime action=install
//                         override=true reason="…"` writes here, and the bootstrap
//                         puts it at the FRONT of sys.path, so its copy really
//                         replaces the locked one — not merely reported.
//
// The default is therefore "not allowed" (an additive copy that happens to be
// locked is shadowed and says so); the forced update needs a DECLARATION. That
// declaration is not ceremony: a replaced numpy is part of what a number came
// out of, so it is recorded in the overlay's installed.json, shown by status, and
// carried into every run's provenance.

export interface PythonOverlayPackage {
  name: string;
  version: string;
  /** Installed into the override directory: this copy REPLACES the locked one. */
  override?: boolean;
}

export interface PythonOverlay {
  /** The additive directory (appended). */
  dir: string;
  /** The explicit-override directory (front of sys.path). */
  overrideDir: string;
  /** The EFFECTIVE set: additive packages plus the overriding copy where both exist. */
  packages: PythonOverlayPackage[];
  /** Packages installed with an explicit override. */
  overrides: PythonOverlayPackage[];
  /** sha256 over the sorted `name==version` list (an override is marked `!`); '' when empty. */
  digest: string;
  bytes: number;
}

/** `$DSH_HOME/cad/runtime/user-site`; `DSH_CAD_USER_SITE` overrides (tests/ops). */
export function pythonOverlayDir(): string {
  const override = envValue('DSH_CAD_USER_SITE');
  return override ? resolve(override) : join(pythonRuntimeRoot(), 'user-site');
}

/**
 * `…/user-site-override` beside the additive dir; `DSH_CAD_OVERRIDE_SITE` overrides.
 * Derived from the overlay path so a test that redirects the overlay cannot
 * accidentally write overrides into the developer's real runtime.
 */
export function pythonOverrideDir(): string {
  const explicit = envValue('DSH_CAD_OVERRIDE_SITE');
  if (explicit) return resolve(explicit);
  const base = pythonOverlayDir();
  return join(dirname(base), `${basename(base)}-override`);
}

/** Read one site dir's own `.dist-info` records — the packages ARE the record. */
async function readSiteDir(dir: string, override: boolean): Promise<PythonOverlayPackage[]> {
  let entries: string[] = [];
  try { entries = await readdir(dir); } catch { entries = []; }
  const packages: PythonOverlayPackage[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.dist-info')) continue;
    try {
      const metadata = await readFile(join(dir, entry, 'METADATA'), 'utf8');
      const name = /^Name:\s*(.+)$/m.exec(metadata)?.[1]?.trim();
      const version = /^Version:\s*(.+)$/m.exec(metadata)?.[1]?.trim();
      if (name && version) packages.push(override ? { name, version, override: true } : { name, version });
    } catch { /* a half-written dist-info is not a status failure */ }
  }
  return packages;
}

/**
 * Read both site dirs. The effective set is the additive one plus the override
 * copy where both carry the same name — the override is what actually imports.
 */
export async function readPythonOverlay(): Promise<PythonOverlay> {
  const dir = pythonOverlayDir();
  const overrideDir = pythonOverrideDir();
  const additive = await readSiteDir(dir, false);
  const overrides = (await readSiteDir(overrideDir, true)).sort((a, b) => a.name.localeCompare(b.name));
  const effective = new Map<string, PythonOverlayPackage>();
  for (const pkg of additive) effective.set(pkg.name.toLowerCase(), pkg);
  for (const pkg of overrides) effective.set(pkg.name.toLowerCase(), pkg);
  const packages = [...effective.values()].sort((a, b) => a.name.localeCompare(b.name));
  const digest = packages.length === 0
    ? ''
    : createHash('sha256')
      .update(packages.map((p) => `${p.name}==${p.version}${p.override ? '!' : ''}`).join('\n'))
      .digest('hex');
  return {
    dir,
    overrideDir,
    packages,
    overrides,
    digest,
    bytes: (await directorySize(dir)) + (await directorySize(overrideDir)),
  };
}

/** Package names the lock provides for this target (parsed from the generated text). */
function lockedPackageNames(target: string | null): Set<string> {
  if (!target) return new Set();
  const names = new Set<string>();
  for (const line of lockPlanForTarget(target).text.split('\n')) {
    const match = /^([A-Za-z0-9._-]+)==/.exec(line);
    if (match) names.add(match[1]!.toLowerCase().replace(/_/g, '-'));
  }
  return names;
}

export interface OverlayInstallResult {
  /** The directory written: the additive one, or the override one. */
  dir: string;
  /** Every package in the effective overlay after the install. */
  packages: PythonOverlayPackage[];
  /** Additive packages the locked venv ALSO provides — the LOCKED one wins. */
  shadowed: PythonOverlayPackage[];
  /** Packages installed with an explicit override (they replace the locked copy). */
  overrides: PythonOverlayPackage[];
  output: string;
}

/**
 * Install packages into the user overlay — the user's wiring.
 *
 * Default (additive): the copy lands in `user-site/` and a package the lock also
 * provides stays SHADOWED — the locked version keeps precedence.
 *
 * `override: true` is the explicit declaration: the copy lands in
 * `user-site-override/`, which the launch bootstrap puts at the front of
 * sys.path, so it really replaces the locked package. That needs a `reason` —
 * not ceremony: a replaced dependency is part of what a run's numbers came from.
 *
 * No `--require-hashes` here ON PURPOSE: the lock's hashes exist so that what WE
 * ship is verifiable; the user's own packages are theirs. `--target` keeps them
 * out of `venv/`, which is what makes them survive a runtime update.
 */
export async function installIntoPythonOverlay(
  packages: readonly string[],
  options: {
    onProgress?: (message: string) => void;
    timeoutMs?: number;
    /** Explicitly replace a locked package (requires `reason`). */
    override?: boolean;
    /** Why the override is needed; recorded next to the packages. */
    reason?: string;
  } = {},
): Promise<OverlayInstallResult> {
  const wanted = packages.map((p) => p.trim()).filter(Boolean);
  if (wanted.length === 0) throw new Error('no packages named (e.g. packages: ["six==1.17.0"])');
  if (options.override && !options.reason?.trim()) {
    throw new Error(
      'override=true REPLACES a package the lock pins, so it needs a declared reason (recorded with the install and carried into run provenance). ' +
      'State why it cannot be done with the locked version — and confirm it with the human — then retry with reason: "…". ' +
      'Without override the package is only ADDED: the locked version keeps precedence.',
    );
  }
  const runtime = await ensurePythonRuntime({ onProgress: options.onProgress });
  const dir = options.override ? pythonOverrideDir() : pythonOverlayDir();
  await mkdir(dir, { recursive: true });
  const index = envValue('DSH_CAD_PYTHON_INDEX_URL') ?? PIP_INDEXES[0];
  options.onProgress?.(`installing into the user overlay ${dir} from ${new URL(index).host}`);
  const result = await runProcess(
    runtime.venvPython,
    [
      '-m', 'pip', 'install',
      '--target', dir,
      '--upgrade',
      '--disable-pip-version-check',
      '--no-input',
      '--index-url', index,
      ...wanted,
    ],
    {
      timeoutMs: options.timeoutMs ?? 15 * 60 * 1000,
      onLine: (line) => {
        if (/^(Collecting|Downloading|Installing|Successfully|ERROR)/.test(line)) options.onProgress?.(line.slice(0, 200));
      },
    },
  );
  if (result.code !== 0) {
    const reason = result.timedOut
      ? 'timed out'
      : (result.stderr.trim().split('\n').slice(-3).join(' | ') || `exit ${result.code}`);
    throw new Error(`pip could not install ${wanted.join(', ')} into the overlay — ${reason}`);
  }
  const overlay = await readPythonOverlay();
  const locked = lockedPackageNames(runtime.target);
  const isOverride = options.override === true;
  // Record when/why next to the packages themselves (the dist-info is the what).
  const recordPath = join(dir, 'installed.json');
  let record: {
    packages: { name: string; version: string; at: string; requested: string[]; override?: boolean; reason?: string }[];
  } = { packages: [] };
  try { record = JSON.parse(await readFile(recordPath, 'utf8')); } catch { /* first install */ }
  const at = new Date().toISOString();
  const installedHere = await readSiteDir(dir, isOverride);
  for (const pkg of installedHere) {
    const existing = record.packages.find((p) => p.name === pkg.name);
    const entry = {
      name: pkg.name,
      version: pkg.version,
      at,
      requested: [...new Set([...(existing?.requested ?? []), ...wanted])],
      ...(isOverride ? { override: true, reason: options.reason?.trim() } : {}),
    };
    if (existing) Object.assign(existing, entry);
    else record.packages.push(entry);
  }
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  // Shadowing is about the ADDITIVE dir only: an override deliberately wins, so
  // reporting it as "shadowed" would be the opposite of what happens.
  const shadowed = isOverride
    ? []
    : installedHere.filter((p) => locked.has(p.name.toLowerCase().replace(/_/g, '-')));
  return {
    dir,
    packages: overlay.packages,
    shadowed,
    overrides: overlay.overrides,
    output: result.stdout.trim(),
  };
}

/**
 * argv for BOTH spawn sites (the resident worker and one-off scripts).
 *
 * `-I` stays: the interpreter's view must be exactly the venv we built plus the
 * overlay we can enumerate. The overlay is attached by this bootstrap rather
 * than by PYTHONPATH, which `-I` ignores. `site.addsitedir` on a missing
 * directory is a no-op, so an absent overlay costs nothing.
 */
export function pythonLaunchArgs(scriptPath: string, args: readonly string[] = []): string[] {
  const overlay = pythonOverlayDir();
  const overrideDir = pythonOverrideDir();
  const bootstrap = [
    'import os, runpy, site, sys',
    `overlay = ${JSON.stringify(overlay)}`,
    `override = ${JSON.stringify(overrideDir)}`,
    'if overlay:',
    '    site.addsitedir(overlay)          # additive: appended, the locked set wins',
    'if override and os.path.isdir(override):',
    '    site.addsitedir(override)',
    '    sys.path.remove(override)',
    '    sys.path.insert(0, override)      # explicit override: really replaces the locked copy',
    'script = sys.argv[1]',
    'sys.argv = sys.argv[1:]',
    "runpy.run_path(script, run_name='__main__')",
  ].join('\n');
  return ['-I', '-c', bootstrap, scriptPath, ...args];
}

export { PYTHON_BUILD, REQUIREMENTS_LOCK_SHA256, PYTHON_LOCK_PROTOCOL };
