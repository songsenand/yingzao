// OpenSCAD CLI wrapper: compile SCAD to STL and render PNG views.
//
// Uses the system openscad binary. M1 runs the default (CGAL) backend;
// `--backend=manifold` is added in M2 when the nightly build lands.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export interface CompileResult {
  success: boolean;
  stl?: Uint8Array;
  renders?: { view: string; png: Uint8Array }[];
  errors: string[];
  warnings: string[];
  /** Datum anchor points declared by the model via datum("name", [x,y,z]). */
  datums: { name: string; point: [number, number, number] }[];
  /** Full datum set incl. axes/planes/cylinders (assembly manifest v1). */
  datumSet?: DatumSet;
  durationMs: number;
}

/**
 * Datum anchor convention: the model declares named world-coordinate anchors
 * with `datum("hole1", [25, 0, 5]);` (top-level, final coordinates). The
 * module echoes an anchor line which parseDatums extracts after compilation.
 *
 * Extended kinds (assembly manifest v1): axes, planes and cylinders for
 * interface contracts (coaxiality, mating faces, hole/shaft diameters):
 *   datum_axis("rail",  [x,y,z], [dx,dy,dz]);
 *   datum_plane("face", [x,y,z], [nx,ny,nz]);
 *   datum_cyl("bore",   [x,y,z], [dx,dy,dz], radius);
 * Each echoes a tagged line parsed by parseDatumFeatures into a DatumSet.
 * The module is PREPENDED: OpenSCAD requires definition before use. Error-trace
 * line numbers shift by the prelude length — accepted.
 */
const DATUM_PRELUDE = `
// ---- harness datum anchors (do not remove) ----
module datum(name, p = [0, 0, 0]) {
  echo(str("__DATUM__", name, "=", p[0], ",", p[1], ",", p[2]));
}
module datum_axis(name, p = [0, 0, 0], dir = [0, 0, 1]) {
  echo(str("__DATUM_AXIS__", name, "=", p[0], ",", p[1], ",", p[2], "|", dir[0], ",", dir[1], ",", dir[2]));
}
module datum_plane(name, p = [0, 0, 0], n = [0, 0, 1]) {
  echo(str("__DATUM_PLANE__", name, "=", p[0], ",", p[1], ",", p[2], "|", n[0], ",", n[1], ",", n[2]));
}
module datum_cyl(name, p = [0, 0, 0], dir = [0, 0, 1], r = 0) {
  echo(str("__DATUM_CYL__", name, "=", p[0], ",", p[1], ",", p[2], "|", dir[0], ",", dir[1], ",", dir[2], "|", r));
}
`;

export interface DatumPoint { name: string; point: [number, number, number] }
export interface DatumAxis { name: string; point: [number, number, number]; dir: [number, number, number] }
export interface DatumPlane { name: string; point: [number, number, number]; normal: [number, number, number] }
export interface DatumCylinder { name: string; point: [number, number, number]; dir: [number, number, number]; radius: number }

/** All datum anchors declared by one compilation, in world coordinates. */
export interface DatumSet {
  points: DatumPoint[];
  axes: DatumAxis[];
  planes: DatumPlane[];
  cylinders: DatumCylinder[];
}

export function emptyDatumSet(): DatumSet {
  return { points: [], axes: [], planes: [], cylinders: [] };
}

/** Extract __DATUM__ echo lines from openscad output. */
export function parseDatums(raw: string): DatumPoint[] {
  const out: DatumPoint[] = [];
  for (const line of raw.split('\n')) {
    const m = /ECHO:\s*"__DATUM__([^"=]+)=(-?[\d.eE+-]+),(-?[\d.eE+-]+),(-?[\d.eE+-]+)"/.exec(line);
    if (m) out.push({ name: m[1]!.trim(), point: [Number(m[2]), Number(m[3]), Number(m[4])] });
  }
  return out;
}

/**
 * Extract axis/plane/cylinder datum echo lines. Point datums are NOT included
 * here — parseDatums owns them; combine via makeDatumSet.
 */
export function parseDatumFeatures(raw: string): { axes: DatumAxis[]; planes: DatumPlane[]; cylinders: DatumCylinder[] } {
  const axes: DatumAxis[] = [];
  const planes: DatumPlane[] = [];
  const cylinders: DatumCylinder[] = [];
  for (const line of raw.split('\n')) {
    let m: RegExpExecArray | null;
    if ((m = /ECHO:\s*"__DATUM_AXIS__([^"=]+)=(-?[\d.eE+-]+),(-?[\d.eE+-]+),(-?[\d.eE+-]+)\|(-?[\d.eE+-]+),(-?[\d.eE+-]+),(-?[\d.eE+-]+)"/.exec(line))) {
      axes.push({ name: m[1]!.trim(), point: [Number(m[2]), Number(m[3]), Number(m[4])], dir: [Number(m[5]), Number(m[6]), Number(m[7])] });
    } else if ((m = /ECHO:\s*"__DATUM_PLANE__([^"=]+)=(-?[\d.eE+-]+),(-?[\d.eE+-]+),(-?[\d.eE+-]+)\|(-?[\d.eE+-]+),(-?[\d.eE+-]+),(-?[\d.eE+-]+)"/.exec(line))) {
      planes.push({ name: m[1]!.trim(), point: [Number(m[2]), Number(m[3]), Number(m[4])], normal: [Number(m[5]), Number(m[6]), Number(m[7])] });
    } else if ((m = /ECHO:\s*"__DATUM_CYL__([^"=]+)=(-?[\d.eE+-]+),(-?[\d.eE+-]+),(-?[\d.eE+-]+)\|(-?[\d.eE+-]+),(-?[\d.eE+-]+),(-?[\d.eE+-]+)\|(-?[\d.eE+-]+)"/.exec(line))) {
      cylinders.push({ name: m[1]!.trim(), point: [Number(m[2]), Number(m[3]), Number(m[4])], dir: [Number(m[5]), Number(m[6]), Number(m[7])], radius: Number(m[8]) });
    }
  }
  return { axes, planes, cylinders };
}

/** Combine point + feature datums into one set. */
export function makeDatumSet(points: DatumPoint[], features: ReturnType<typeof parseDatumFeatures>): DatumSet {
  return { points, ...features };
}

const TIMEOUT_MS = 30_000;
const IMG_SIZE = 512;

// --- binary resolution ---
// Prefer the modern snapshot (Manifold backend, much faster and more robust
// than the 2021.01 CGAL default). Env override wins; bare 'openscad' is last.
import { existsSync } from 'node:fs';

const pluginRoot = join(new URL('../', import.meta.url).pathname);
const snapshotLibDir = join(pluginRoot, '..', 'bin', 'squashfs-root', 'usr', 'lib');
const OPENSCAD_CANDIDATES = [
  process.env.CAD_OPENSCAD_BIN,
  join(pluginRoot, '..', 'bin', 'squashfs-root', 'usr', 'bin', 'openscad'),
  'openscad',
].filter(Boolean) as string[];

let resolvedBin: string | null = null;
let backendArgs: string[] = [];
let binaryEnv: NodeJS.ProcessEnv | undefined;

/** Resolve binary once; enable the Manifold backend when supported. */
async function resolveBinary(): Promise<{ bin: string; extra: string[] }> {
  if (resolvedBin) return { bin: resolvedBin, extra: backendArgs };
  for (const candidate of OPENSCAD_CANDIDATES) {
    if (candidate !== 'openscad' && !existsSync(candidate)) continue;
    const probe = await new Promise<string>((resolve) => {
      const c = spawn(candidate, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      c.stdout?.on('data', (d) => { out += d; });
      c.stderr?.on('data', (d) => { out += d; });
      c.once('close', () => resolve(out));
      c.once('error', () => resolve(''));
    });
    if (!probe) continue;
    resolvedBin = candidate;
    // 2025.06+ ships the Manifold backend; enable it explicitly.
    const year = Number(/20(\d{2})/.exec(probe)?.[1] ?? '0');
    if (year >= 25) backendArgs = ['--backend=Manifold'];
    else backendArgs = [];
    // Extracted AppImages need their bundled libs on the loader path.
    if (candidate.includes('squashfs-root') && existsSync(snapshotLibDir)) {
      binaryEnv = { ...process.env, LD_LIBRARY_PATH: `${snapshotLibDir}${process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : ''}` };
    }
    return { bin: resolvedBin, extra: backendArgs };
  }
  resolvedBin = 'openscad';
  return { bin: resolvedBin, extra: [] };
}

// --- bundled standard-parts library (BOSL2) ---
// Generated SCAD may `include <BOSL2/std.scad>` etc.; OPENSCADPATH makes the
// include resolve for every openscad invocation we spawn.
const bosl2Dir = join(pluginRoot, '..', 'lib', 'BOSL2');
if (existsSync(bosl2Dir)) {
  process.env.OPENSCADPATH = process.env.OPENSCADPATH
    ? `${bosl2Dir}:${process.env.OPENSCADPATH}`
    : bosl2Dir;
}

// --- shared headless X server ---
// xvfb-run spawns a fresh Xvfb per invocation (~3s each) which dominated the
// render pipeline (5 invocations ≈ 15s of pure startup). One shared Xvfb for
// the whole process lifetime removes that tax (~23x faster end-to-end).
let sharedXvfb: { proc: ChildProcess; display: string } | null = null;

/**
 * Start one shared Xvfb using -displayfd: Xvfb picks a free display number
 * itself and writes it to fd 3, so orphaned servers from crashed runs can
 * never wedge us onto a busy display.
 */
async function ensureDisplay(): Promise<string | null> {
  if (sharedXvfb) return sharedXvfb.display;
  const proc = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1280x1024x24'], {
    stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
  });
  const display = await new Promise<string | null>((resolve) => {
    const t = setTimeout(() => resolve(null), 3000);
    proc.once('error', () => { clearTimeout(t); resolve(null); });
    proc.once('exit', () => { clearTimeout(t); resolve(null); });
    proc.stdio[3]!.on('data', (chunk) => {
      const n = parseInt(String(chunk).trim(), 10);
      if (Number.isFinite(n)) { clearTimeout(t); resolve(`:${n}`); }
    });
  });
  if (!display) { proc.kill(); return null; }
  proc.unref();
  sharedXvfb = { proc, display };
  // Warm the GL context: the first OpenGL render on a fresh Xvfb occasionally
  // loses a GPU-driver init race and exits non-zero with an empty file.
  try {
    const warmScad = join(tmpdir(), 'cad_warm.scad');
    writeFileSync(warmScad, 'cube(1);');
    const warmPng = join(tmpdir(), 'cad_warm.png');
    const { bin } = await resolveBinary();
    const env = { ...(binaryEnv ?? process.env), DISPLAY: display };
    await spawnOpenscad(bin, ['-o', warmPng, '--imgsize=64,64', '--autocenter', warmScad], process.cwd(), env);
  } catch { /* best effort */ }
  return display;
}

function shutdownDisplay() {
  sharedXvfb?.proc.kill();
  sharedXvfb = null;
}

/** Run one openscad invocation; capture stdout/stderr lines. */
async function runOpenscad(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const { bin, extra } = await resolveBinary();
  const full = [...extra, ...args];
  // Prefer the shared display; fall back to xvfb-run when unavailable.
  const display = await ensureDisplay();
  if (display) {
    const env = { ...(binaryEnv ?? process.env), DISPLAY: display };
    let result = await spawnOpenscad(bin, full, cwd, env);
    // One retry: rapid back-to-back GL renders occasionally lose a context
    // creation race on a fresh Xvfb (non-deterministic, ~always passes 2nd).
    if (result.code !== 0 && result.code !== -1) {
      result = await spawnOpenscad(bin, full, cwd, env);
    }
    if (result.code !== -1) return result; // -1 = spawn failure → try xvfb-run
  }
  return spawnOpenscad('xvfb-run', ['-a', 'openscad', ...full], cwd);
}

function spawnOpenscad(bin: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(bin, args, { cwd, env: env ?? process.env });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, TIMEOUT_MS);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolvePromise({ code: -1, stdout, stderr: `${stderr}\n${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) stderr += `\nERROR: openscad timed out after ${TIMEOUT_MS}ms`;
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });
}

export interface PngRenderOptions {
  /** Camera rotation degrees [rx,ry,rz] (openscad --camera rot). */
  rotate: [number, number, number];
  /** 1 = auto-fit; 2 = twice as close. Implemented via camera distance (2021.01 has no --zoom). */
  zoom?: number;
  /** Camera target; defaults to origin with --viewall/--autocenter. */
  target?: [number, number, number];
  /** Model bounding-box diagonal — required with target to compute distance. */
  modelDiagonal?: number;
  /** Pixel size (default 512). */
  imgSize?: number;
  /** Colorscheme (default Tomorrow). */
  colorscheme?: string;
}

/** Render an arbitrary SCAD file to PNG using the shared X display. */
export async function renderScadPng(scadPath: string, pngPath: string, opts: PngRenderOptions): Promise<boolean> {
  const args: string[] = ['-o', pngPath];
  if (opts.target && opts.modelDiagonal) {
    const dist = ((opts.modelDiagonal * 1.8) / (opts.zoom && opts.zoom > 0 ? opts.zoom : 1)).toFixed(3);
    args.push(`--camera=${opts.target.join(',')},${opts.rotate.join(',')},${dist}`);
  } else {
    args.push(`--camera=0,0,0,${opts.rotate.join(',')},0`, '--viewall', '--autocenter');
  }
  args.push(`--imgsize=${opts.imgSize ?? IMG_SIZE},${opts.imgSize ?? IMG_SIZE}`,
    '--projection=p', `--colorscheme=${opts.colorscheme ?? 'Tomorrow'}`, scadPath);
  const { bin, extra } = await resolveBinary();
  const full = [...extra, ...args];
  const display = await ensureDisplay();
  if (display) {
    const env = { ...(binaryEnv ?? process.env), DISPLAY: display };
    const r = await spawnOpenscad(bin, full, process.cwd(), env);
    if (r.code === 0) return true;
  }
  const r = await spawnOpenscad('xvfb-run', ['-a', 'openscad', ...full], process.cwd());
  return r.code === 0;
}

export interface ScadParam {
  name: string;
  value: number;
  desc: string;
}

/**
 * Parse tunable parameters from SCAD source. Convention: a top-level numeric
 * assignment annotated with `// PARAMS <description>`:
 *   wall = 3; // PARAMS 壁厚
 */
export function parseParams(scad: string): ScadParam[] {
  const params: ScadParam[] = [];
  for (const line of scad.split('\n')) {
    const m = /^\s*([A-Za-z_]\w*)\s*=\s*(-?\d+(?:\.\d+)?)\s*;\s*\/\/\s*PARAMS\s*(.*)$/.exec(line);
    if (m) params.push({ name: m[1]!, value: Number(m[2]), desc: (m[3] ?? '').trim() });
  }
  return params;
}

/**
 * Convert a SCAD file to a mesh export format (stl/3mf/obj/off/wrl) using the
 * resolved binary and shared display. Returns the output bytes.
 */
export async function exportScad(scadPath: string, outPath: string, format: string): Promise<Uint8Array> {
  const { bin, extra } = await resolveBinary();
  const full = [...extra, '-o', outPath, '--export-format', format, scadPath];
  const display = await ensureDisplay();
  if (display) {
    const env = { ...(binaryEnv ?? process.env), DISPLAY: display };
    const r = await spawnOpenscad(bin, full, process.cwd(), env);
    if (r.code === 0) return new Uint8Array(await readFile(outPath));
  }
  const r = await spawnOpenscad('xvfb-run', ['-a', 'openscad', ...full], process.cwd());
  if (r.code !== 0) throw new Error(`export ${format} failed`);
  return new Uint8Array(await readFile(outPath));
}

/** Extract ERROR:/WARNING: lines from openscad output. */
export function parseMessages(raw: string): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (t.startsWith('ERROR:')) errors.push(t.slice(6).trim());
    else if (t.startsWith('WARNING:')) warnings.push(t.slice(8).trim());
    else if (t.startsWith('Trace:') || t.startsWith('In file')) errors.push(t);
  }
  return { errors, warnings };
}

/** Camera rotations for the four fixed views: [rx, ry, rz]. */
// z-up convention: [0,0,0] looks at the xy plane from +z = TOP view.
const VIEWS: Record<string, [number, number, number]> = {
  top: [0, 0, 0],
  front: [90, 0, 0],
  side: [0, 90, 0],
  iso: [65, 0, 25],
};

/**
 * Compile SCAD to STL and render four fixed-view PNGs.
 * Renders are skipped when compilation fails.
 */
export async function compileAndRender(scadCode: string): Promise<CompileResult> {
  const started = Date.now();
  const dir = await mkdtemp(join(tmpdir(), 'cad-harness-'));
  try {
    const scadPath = join(dir, 'model.scad');
    const stlPath = join(dir, 'model.stl');
    await writeFile(scadPath, DATUM_PRELUDE + scadCode, 'utf8');

    const compile = await runOpenscad(
      ['-o', stlPath, '--export-format', 'binstl', '-D', '$fn=64', scadPath],
      dir,
    );
    const rawOutput = `${compile.stderr}\n${compile.stdout}`;
    const { errors, warnings } = parseMessages(rawOutput);
    const datums = parseDatums(rawOutput);
    const datumSet = makeDatumSet(datums, parseDatumFeatures(rawOutput));
    if (compile.code !== 0) {
      return {
        success: false,
        errors: errors.length > 0 ? errors : [`openscad exited with code ${compile.code}`],
        warnings,
        datums,
        datumSet,
        durationMs: Date.now() - started,
      };
    }

    // Render the four views. Per-view failures are warnings: STL already valid.
    const renders: { view: string; png: Uint8Array }[] = [];
    for (const [view, [rx, ry, rz]] of Object.entries(VIEWS)) {
      const pngPath = join(dir, `${view}.png`);
      const res = await runOpenscad([
        '-o', pngPath,
        `--camera=0,0,0,${rx},${ry},${rz},0`,
        `--imgsize=${IMG_SIZE},${IMG_SIZE}`,
        '--viewall',
        '--autocenter',
        '--projection=p',
        '--colorscheme=Tomorrow',
        scadPath,
      ], dir);
      if (res.code !== 0) {
        warnings.push(`render ${view} failed: ${parseMessages(res.stderr).errors.join('; ') || `exit ${res.code}`}`);
        continue;
      }
      renders.push({ view, png: await readFile(pngPath) });
    }

    return { success: true, stl: await readFile(stlPath), renders, errors: [], warnings, datums, datumSet, durationMs: Date.now() - started };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Compile SCAD to STL only (no renders). Used by assembly validation where
 * per-part renders would multiply OpenSCAD invocations pointlessly.
 */
export async function compileStlOnly(scadCode: string): Promise<CompileResult> {
  const started = Date.now();
  const dir = await mkdtemp(join(tmpdir(), 'cad-harness-'));
  try {
    const scadPath = join(dir, 'model.scad');
    const stlPath = join(dir, 'model.stl');
    await writeFile(scadPath, DATUM_PRELUDE + scadCode, 'utf8');
    const compile = await runOpenscad(
      ['-o', stlPath, '--export-format', 'binstl', '-D', '$fn=64', scadPath],
      dir,
    );
    const rawOutput = `${compile.stderr}\n${compile.stdout}`;
    const { errors, warnings } = parseMessages(rawOutput);
    const datums = parseDatums(rawOutput);
    const datumSet = makeDatumSet(datums, parseDatumFeatures(rawOutput));
    if (compile.code !== 0) {
      return {
        success: false,
        errors: errors.length > 0 ? errors : [`openscad exited with code ${compile.code}`],
        warnings,
        datums,
        datumSet,
        durationMs: Date.now() - started,
      };
    }
    return { success: true, stl: await readFile(stlPath), errors: [], warnings, datums, datumSet, durationMs: Date.now() - started };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export { delay };
