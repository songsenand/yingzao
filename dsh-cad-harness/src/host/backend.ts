// Geometry-kernel selection (A3).
//
// The product-level choice is ONE field: `kernel`. `compileBackend` is an
// OpenSCAD-adapter detail, not a second product concept. The preview ships one
// real adapter (OpenSCAD); other kernels are listed as planned and refused
// explicitly rather than silently falling back.
//
// Config precedence: env (`DSH_CAD_KERNEL`, `DSH_CAD_COMPILE_BACKEND`) >
// `$DSH_HOME/cad/backend.json` > defaults. A project-level pin is written into
// the version manifest, not read here: switching affects NEW versions.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { CompileResult } from './compile.ts';

export type CompileBackend = 'auto' | 'manifold' | 'cgal';

export interface BackendConfig {
  kernel: 'openscad' | 'cadquery';
  compileBackend: CompileBackend;
  /** Optional explicit OpenSCAD executable. */
  binaryPath?: string | null;
}

/**
 * An authoring engine's ONE required operation. Rendering and export are not
 * adapter methods: the STL/STEP a provider returns is rendered and exported by
 * the shared OpenSCAD path, so a new kernel cannot fork those behaviours.
 */
export interface EngineCompileOptions {
  /** OpenSCAD can render its views during compile; other engines ignore this. */
  render?: boolean;
  /** Provider subprocess deadline; ignored by OpenSCAD (it has its own). */
  timeoutMs?: number;
  /** Ask the provider for a native STEP (CadQuery only). */
  step?: boolean;
  /** Abort the provider's child (job cancel); adapters that spawn must honor it. */
  signal?: AbortSignal;
  /** Report the child pid so a job can kill the exact process group. */
  onSpawn?: (pid: number) => void;
}

export interface EngineAdapter {
  id: string;
  compile(source: string, opts?: EngineCompileOptions): Promise<CompileResult>;
}

/** Metadata for the backend list/doctor. It deliberately has no compile surface. */
export interface CadBackend {
  id: string;
  label: string;
  sourceLanguage: 'scad' | 'py';
  fileExtension: string;
  capabilities: { exactCsg: boolean; manifold: boolean; twoD: boolean };
  status: 'available' | 'planned';
  detect(): Promise<{ ok: boolean; version?: string; reason?: string }>;
}

export const DEFAULT_BACKEND: BackendConfig = { kernel: 'openscad', compileBackend: 'auto', binaryPath: null };

export function dshHomeDir(): string {
  const fromEnv = process.env.DSH_HOME?.trim();
  return fromEnv && isAbsolute(fromEnv) ? fromEnv : join(homedir(), '.dsh');
}

export function backendConfigPath(): string {
  return join(dshHomeDir(), 'cad', 'backend.json');
}

/** Never throws: a broken config falls back to the default with a reason. */
export function readBackendConfig(): { config: BackendConfig; requestedKernel: string; warnings: string[] } {
  const warnings: string[] = [];
  const envKernel = process.env.DSH_CAD_KERNEL?.trim();
  const envCompile = process.env.DSH_CAD_COMPILE_BACKEND?.trim();
  let file: Partial<BackendConfig> = {};
  const path = backendConfigPath();
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<BackendConfig>;
      if (parsed && typeof parsed === 'object') file = parsed;
    } catch (error) {
      warnings.push(`cannot read ${path}: ${String((error as Error)?.message ?? error)}; using defaults`);
    }
  }
  const kernel = (envKernel || file.kernel || DEFAULT_BACKEND.kernel) as BackendConfig['kernel'];
  const compile = (envCompile || file.compileBackend || DEFAULT_BACKEND.compileBackend) as CompileBackend;
  const binaryPath = typeof file.binaryPath === 'string' ? file.binaryPath : null;
  if (kernel !== 'openscad' && kernel !== 'cadquery') {
    warnings.push(`kernel "${kernel}" is not available in this build; use openscad or cadquery`);
  }
  if (!['auto', 'manifold', 'cgal'].includes(compile)) {
    warnings.push(`compileBackend "${compile}" is unknown; using auto`);
  }
  return {
    config: {
      kernel: kernel === 'cadquery' ? 'cadquery' : 'openscad',
      compileBackend: (['auto', 'manifold', 'cgal'] as const).includes(compile as CompileBackend) ? compile as CompileBackend : 'auto',
      binaryPath,
    },
    requestedKernel: kernel,
    warnings,
  };
}

export function writeBackendConfig(config: BackendConfig): string {
  const path = backendConfigPath();
  mkdirSync(join(dshHomeDir(), 'cad'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return path;
}

/** The OpenSCAD adapter. One real adapter in 0.1.0-preview. */
export const OPENSCAD_BACKEND: CadBackend = {
  id: 'openscad',
  label: 'OpenSCAD',
  sourceLanguage: 'scad',
  fileExtension: '.scad',
  capabilities: { exactCsg: true, manifold: true, twoD: true },
  status: 'available',
  async detect() {
    const { execFile } = await import('node:child_process');
    const bin = process.env.CAD_OPENSCAD_BIN?.trim()
      || readBackendConfig().config.binaryPath
      || 'openscad';
    return await new Promise((resolve) => {
      execFile(bin, ['--version'], { timeout: 8000 }, (error, stdout, stderr) => {
        const output = `${stdout ?? ''}${stderr ?? ''}`.trim();
        if (error) resolve({ ok: false, reason: error.message });
        else resolve({ ok: true, version: output.split('\n')[0] || 'unknown' });
      });
    });
  },
};

/** CadQuery is available as an engine; the pack itself is a separate capability. */
export const CADQUERY_BACKEND: CadBackend = {
  id: 'cadquery', label: 'CadQuery', sourceLanguage: 'py', fileExtension: '.py',
  capabilities: { exactCsg: true, manifold: false, twoD: true }, status: 'available',
  async detect() {
    const root = process.env.DSH_CAD_CQ_PACK?.trim() || join(dshHomeDir(), 'cad', 'packs', 'cadquery');
    const installed = existsSync(join(root, 'cadquery', '__init__.py')) && existsSync(join(root, 'OCP'));
    return installed
      ? { ok: true, version: 'pack' }
      : { ok: false, reason: `pack not installed at ${root}` };
  },
};

export const PLANNED_BACKENDS: CadBackend[] = [
  {
    id: 'freecad', label: 'FreeCAD', sourceLanguage: 'py', fileExtension: '.py',
    capabilities: { exactCsg: true, manifold: false, twoD: true }, status: 'planned',
    async detect() { return { ok: false, reason: 'planned: no adapter in this build' }; },
  },
];

export function listBackends(): CadBackend[] {
  return [OPENSCAD_BACKEND, CADQUERY_BACKEND, ...PLANNED_BACKENDS];
}

export function selectBackend(kernel: string): CadBackend {
  const found = listBackends().find((b) => b.id === kernel);
  if (!found) throw new Error(`backend_not_available: unknown kernel "${kernel}" (available: openscad)`);
  if (found.status !== 'available') throw new Error(`backend_not_available: "${kernel}" is ${found.status} in this build`);
  return found;
}
