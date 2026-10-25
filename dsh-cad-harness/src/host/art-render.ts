// The optional art backend for `render_part`.
//
// L1 exposed the bpy lane through `run_python` + `read_image`: two calls, no
// image attachment, no structured error. L2 keeps bpy user-installed and
// out-of-worker, but wraps the same `render_studio.py` in a native tool result:
// the PNGs are attached, the metadata is parsed, and a missing bpy is either a
// structured error or an explicit OpenSCAD fallback — never a stdout scrape.
//
// IMPORTANT: this module never imports bpy. It launches the runtime's interpreter
// with the user overlay attached (`runPython` -> `pythonLaunchArgs`) in a child
// process, because bpy writes to stdout and the resident worker's stdout is the
// JSON-lines protocol. The backend selection is:
//
//   openscad : the existing fast path (one frame, or four frames)
//   bpy      : the user-installed Blender lane (materials/lighting); required for hero
//   auto     : prefer bpy when available; fall back to OpenSCAD for single/views
//
// `hero` and `section` are not silently downgraded: hero needs materials (bpy),
// section is an OpenSCAD-only cut today.
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderStlFramePng, renderVersionFrame, type RenderPartRequest, type ViewName } from './inspect.ts';
import { runPython } from './python-worker.ts';
import { pythonRuntimeStatus } from './python-runtime.ts';
import { safeArtifactName } from './runs.ts';
import { appearancePath, readAppearance } from './appearance.ts';

export type ArtEngine = 'openscad' | 'bpy' | 'auto';
export type ArtMode = 'single' | 'views' | 'hero';
export type ArtRenderer = 'workbench' | 'cycles';
export type ArtMaterial = 'plastic' | 'metal' | 'clay' | 'none';
export type ArtBackground = 'light' | 'dark' | 'transparent';
export type ArtRig = 'sun' | 'area';

export interface ArtRenderOptions extends RenderPartRequest {
  /** Backend, not the renderer. Default openscad (preserves render_part's old behavior). */
  engine?: ArtEngine;
  /** single (default) | views (four) | hero (one material shot; bpy only). */
  mode?: ArtMode;
  /** bpy renderer; default workbench for single/views, cycles for hero. */
  renderer?: ArtRenderer;
  material?: ArtMaterial;
  background?: ArtBackground;
  samples?: number;
  exposure?: number;
  rig?: ArtRig;
  /** Render versions/<id>/appearance.glb with its materials; requires bpy. */
  appearance?: boolean;
}

export interface ArtImage {
  data: Uint8Array;
  /** front/side/top/iso/hero — the attachment's human name. */
  view: string;
  name: string;
}

export interface ArtRenderResult {
  /** The backend that actually ran. */
  engine: 'openscad' | 'bpy';
  /** True when engine=auto chose OpenSCAD because bpy was unavailable. */
  fallback: boolean;
  fallbackReason?: string;
  /** True when the source was the version's attached GLB, not model.stl. */
  appearance: boolean;
  mode: ArtMode;
  label: string;
  files: string[];
  images: ArtImage[];
  metadata: Record<string, unknown>;
  elapsedMs: number;
  warnings: string[];
}

export type ArtErrorCode = 'invalid' | 'runtime-missing' | 'bpy-missing' | 'render-failed' | 'store-missing';

export class ArtRenderError extends Error {
  readonly code: ArtErrorCode;
  constructor(message: string, code: ArtErrorCode) {
    super(message);
    this.name = 'ArtRenderError';
    this.code = code;
  }
}

const VIEWS: ViewName[] = ['front', 'side', 'top', 'iso'];

function studioScriptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', '..', 'skills', 'cad-art', 'render_studio.py'), // src/host -> <plugin>
    join(here, '..', 'skills', 'cad-art', 'render_studio.py'), // lib/ -> <plugin>
    join(here, 'skills', 'cad-art', 'render_studio.py'),
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  throw new ArtRenderError(
    `render_studio.py not found; looked in ${candidates.join(', ')}`,
    'invalid',
  );
}

function fileNameLabel(text: string): string {
  const cleaned = text.replace(/[:/\\]+/g, '-').replace(/\s+/g, '_');
  return safeArtifactName(cleaned) ?? `render-${Date.now()}`;
}

async function writeRenderFile(storeRoot: string, label: string, data: Uint8Array): Promise<string> {
  const dir = join(storeRoot, 'render');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${fileNameLabel(label)}.png`);
  await writeFile(path, data);
  return path;
}

function installMessage(): string {
  return (
    'bpy is not installed in the user overlay. Install it with ' +
    'python_runtime action=install packages:["bpy==5.2.3"], then retry. ' +
    'The preflight at skills/cad-art/preflight.py explains platform/Python/disk blockers; ' +
    'bpy is GPL-3.0, user-installed, and about 403 MB download / 1 GB disk.'
  );
}

function runtimeMessage(state: string): string {
  return (
    `the plugin Python runtime is not ready (state: ${state}). ` +
    'Run python_runtime action=provision, then install bpy with ' +
    'python_runtime action=install packages:["bpy==5.2.3"].'
  );
}

function tail(text: string, lines = 3): string {
  return text.split('\n').filter(Boolean).slice(-lines).join(' | ');
}

function warningsFromStderr(stderr: string): string[] {
  const noise = /MESA|ZINK|EGL|Extensions: writing cache|Timer 'STL Import'|^Blender quit$|^Saved:/i;
  return stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !noise.test(line))
    .slice(0, 8);
}

async function renderOpenScad(
  storeRoot: string,
  opts: ArtRenderOptions,
  mode: ArtMode,
  fallbackReason?: string,
): Promise<ArtRenderResult> {
  const started = Date.now();
  const versionId = opts.versionId;
  if (opts.appearance) {
    throw new ArtRenderError(
      'appearance renders need engine "bpy"; OpenSCAD cannot read a GLB material design. ' +
      'Use engine "bpy" or "auto" (with bpy installed).',
      'invalid',
    );
  }
  const stl = join(storeRoot, 'versions', versionId, 'model.stl');
  if (!existsSync(stl)) throw new ArtRenderError(`no STL for version ${versionId} at ${stl}`, 'store-missing');

  if (mode === 'hero') {
    throw new ArtRenderError(
      'mode "hero" needs materials and lighting, which OpenSCAD cannot produce. ' +
      'Use engine "bpy" (or "auto" with bpy installed), or use mode "views".',
      'invalid',
    );
  }

  const images: ArtImage[] = [];
  const files: string[] = [];
  if (mode === 'single') {
    const { png, label } = await renderVersionFrame({ root: storeRoot }, opts, `${Date.now()}`);
    const file = await writeRenderFile(storeRoot, `${versionId}-${label}`, png);
    files.push(file);
    images.push({ data: png, view: label, name: `art-${versionId}-${fileNameLabel(label)}` });
    return {
      engine: 'openscad',
      appearance: false,
      fallback: Boolean(fallbackReason),
      fallbackReason,
      mode,
      label,
      files,
      images,
      metadata: {
        engine: 'openscad',
        mode,
        versionId,
        label,
        imgSize: opts.imgSize ?? 512,
        files,
      },
      elapsedMs: Date.now() - started,
      warnings: [],
    };
  }

  for (const view of VIEWS) {
    const { png } = await renderStlFramePng(stl, { view, imgSize: opts.imgSize }, `view_${view}`);
    const file = await writeRenderFile(storeRoot, `${versionId}-${view}`, png);
    files.push(file);
    images.push({ data: png, view, name: `art-${versionId}-${view}` });
  }
  return {
    engine: 'openscad',
    appearance: false,
    fallback: Boolean(fallbackReason),
    fallbackReason,
    mode,
    label: 'openscad:views',
    files,
    images,
    metadata: {
      engine: 'openscad',
      mode,
      versionId,
      imgSize: opts.imgSize ?? 512,
      files,
    },
    elapsedMs: Date.now() - started,
    warnings: [],
  };
}

async function renderBpy(
  storeRoot: string,
  cwd: string,
  opts: ArtRenderOptions,
  mode: ArtMode,
): Promise<ArtRenderResult> {
  const started = Date.now();
  const versionId = opts.versionId;
  const appearance = Boolean(opts.appearance);
  const source = appearance
    ? appearancePath(storeRoot, versionId)
    : join(storeRoot, 'versions', versionId, 'model.stl');
  if (!existsSync(source)) {
    throw new ArtRenderError(
      appearance
        ? `no appearance.glb for ${versionId}; attach one with attach_appearance({versionId, file}) first`
        : `no STL for version ${versionId} at ${source}`,
      'store-missing',
    );
  }
  const appearanceRecord = appearance ? await readAppearance(storeRoot, versionId) : null;
  if (opts.section) {
    throw new ArtRenderError(
      'section cuts are OpenSCAD-only in L2. Use engine "openscad", or render the full part with bpy.',
      'invalid',
    );
  }
  if (opts.rotate) {
    throw new ArtRenderError(
      'arbitrary rotate is OpenSCAD-only. Use view (front|side|top|iso) with bpy, or engine "openscad".',
      'invalid',
    );
  }

  let status;
  try {
    status = await pythonRuntimeStatus();
  } catch (error) {
    throw new ArtRenderError(
      `cannot read the plugin Python runtime status: ${String(error)}. ` +
      'Run python_runtime action=status, then install bpy with ' +
      'python_runtime action=install packages:["bpy==5.2.3"].',
      'runtime-missing',
    );
  }
  if (status.state !== 'ready') {
    throw new ArtRenderError(runtimeMessage(status.state), 'runtime-missing');
  }

  const script = studioScriptPath();
  const temp = await mkdtemp(join(tmpdir(), 'cad-art-'));
  try {
    const out = join(temp, 'out');
    const metadataPath = join(temp, 'metadata.json');
    const renderer: ArtRenderer = opts.renderer ?? (mode === 'hero' ? 'cycles' : 'workbench');
    const args = [
      source,
      '--out', out,
      '--mode', mode,
      '--engine', renderer,
      '--size', String(opts.imgSize ?? 512),
      '--samples', String(opts.samples ?? 32),
      '--material', opts.material ?? 'plastic',
      '--background', opts.background ?? 'light',
      '--exposure', String(opts.exposure ?? 0),
      '--rig', opts.rig ?? 'sun',
      '--json', metadataPath,
      '--quiet',
    ];
    if (appearance) args.push('--keep-materials');
    if (mode === 'single') args.push('--view', opts.view ?? 'iso');
    if (opts.zoom && opts.zoom !== 1) args.push('--zoom', String(opts.zoom));

    const result = await runPython({
      script,
      args,
      cwd,
      timeoutMs: mode === 'hero' ? 180_000 : 120_000,
    });
    if (!result.ok) {
      if (result.exitCode === 3 && /bpy is not importable/.test(result.stderr)) {
        throw new ArtRenderError(installMessage(), 'bpy-missing');
      }
      throw new ArtRenderError(
        `bpy render failed (exit ${result.exitCode ?? result.signal ?? 'unknown'}): ` +
        `${tail(result.stderr) || result.traceback || 'no stderr'}`,
        'render-failed',
      );
    }

    let metadata: Record<string, unknown>;
    try {
      metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>;
    } catch (error) {
      throw new ArtRenderError(`render_studio.py wrote no readable metadata: ${String(error)}`, 'render-failed');
    }
    const tempFiles = Array.isArray(metadata.files) ? metadata.files.filter((f): f is string => typeof f === 'string') : [];
    const expected = mode === 'views' ? VIEWS.length : 1;
    if (tempFiles.length !== expected) {
      throw new ArtRenderError(
        `render_studio.py returned ${tempFiles.length} image(s), expected ${expected}`,
        'render-failed',
      );
    }

    const files: string[] = [];
    const images: ArtImage[] = [];
    for (let index = 0; index < tempFiles.length; index += 1) {
      const file = tempFiles[index]!;
      const data = await readFile(file);
      const view = mode === 'views' ? VIEWS[index]! : mode === 'hero' ? 'hero' : (opts.view ?? 'iso');
      const final = await writeRenderFile(storeRoot, `${versionId}-bpy-${view}`, data);
      files.push(final);
      images.push({ data, view, name: `art-${versionId}-${view}` });
    }
    const label = mode === 'hero'
      ? `bpy:hero:${opts.material ?? 'plastic'}`
      : mode === 'views'
        ? 'bpy:views'
        : `bpy:${opts.view ?? 'iso'}`;
    return {
      engine: 'bpy',
      appearance,
      fallback: false,
      mode,
      label,
      files,
      images,
      metadata: {
        ...metadata,
        files,
        renderer,
        appearance,
        ...(appearanceRecord
          ? { appearance_sha256: appearanceRecord.sha256, appearance_materials: appearanceRecord.materials }
          : {}),
      },
      elapsedMs: Date.now() - started,
      warnings: warningsFromStderr(result.stderr),
    };
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Render a saved version through OpenSCAD (default) or the user-installed bpy lane.
 *
 * `auto` prefers bpy but only falls back for single/views; a hero render and a
 * section cut are never silently downgraded. The returned `files` are already in
 * `<store>/render/`; the caller only has to attach `images`.
 */
export async function renderArt(
  storeRoot: string,
  cwd: string,
  options: ArtRenderOptions,
): Promise<ArtRenderResult> {
  const mode = options.mode ?? 'single';
  const engine = options.engine ?? 'openscad';

  // An attached appearance is a GLB; OpenSCAD has no material path for it and auto
  // must not fall back to STL (that would silently drop the color design).
  if (options.appearance) {
    if (engine === 'openscad') {
      throw new ArtRenderError(
        'appearance renders need engine "bpy" (or "auto" with bpy installed); ' +
        'OpenSCAD cannot read a GLB material design.',
        'invalid',
      );
    }
    if (options.rotate || options.section) {
      throw new ArtRenderError(
        'rotate/section are OpenSCAD-only; appearance renders support single/views/hero with bpy.',
        'invalid',
      );
    }
    return renderBpy(storeRoot, cwd, options, mode);
  }

  if (mode !== 'single' && (options.rotate || options.section || (options.zoom && options.zoom !== 1))) {
    throw new ArtRenderError('rotate, section and zoom are single-mode only', 'invalid');
  }
  if (mode === 'hero' && engine === 'openscad') {
    throw new ArtRenderError(
      'mode "hero" needs engine "bpy" (or "auto" with bpy installed); OpenSCAD has no materials/lighting.',
      'invalid',
    );
  }
  if (engine === 'bpy' && (options.rotate || options.section)) {
    throw new ArtRenderError(
      'rotate/section are OpenSCAD-only; use view or mode views with engine "bpy".',
      'invalid',
    );
  }

  // section/rotate are OpenSCAD features; auto must not send them to bpy.
  if (engine === 'auto' && (options.rotate || options.section)) {
    return renderOpenScad(storeRoot, options, mode, 'auto: rotate/section are OpenSCAD-only');
  }
  if (engine === 'openscad') return renderOpenScad(storeRoot, options, mode);

  if (engine === 'bpy') return renderBpy(storeRoot, cwd, options, mode);

  // engine === 'auto'
  let status;
  try {
    status = await pythonRuntimeStatus();
  } catch {
    status = null;
  }
  if (!status || status.state !== 'ready') {
    if (mode === 'hero') {
      throw new ArtRenderError(
        status ? runtimeMessage(status.state) : 'python runtime status is unavailable; run python_runtime action=status',
        'runtime-missing',
      );
    }
    return renderOpenScad(storeRoot, options, mode, 'python runtime is not ready');
  }

  try {
    return await renderBpy(storeRoot, cwd, options, mode);
  } catch (error) {
    if (error instanceof ArtRenderError && error.code === 'bpy-missing' && mode !== 'hero') {
      return renderOpenScad(storeRoot, options, mode, 'bpy is not installed');
    }
    throw error;
  }
}
