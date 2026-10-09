// Inspection tools (M3.5+): exact geometry measurements and on-demand
// section/perspective renders of saved versions.

import ManifoldModule from 'manifold-3d';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensurePythonWorker } from './python-worker.ts';
import { parseBinaryStl, isWatertight, boundingBox } from './mesh.ts';
import { renderScadPng } from './compile.ts';
import type { VersionStore } from './version.ts';

export interface MeasureReport {
  versionId: string;
  watertight: boolean;
  triangles: number;
  boundingBoxMm: { min: [number, number, number]; max: [number, number, number]; size: [number, number, number] };
  volumeMm3: number;
  surfaceAreaMm2: number;
  /** Volume-weighted centroid, mm. */
  centerOfMassMm: [number, number, number];
  /**
   * Genus of the solid — for simple parts this equals the number of through
   * holes (a plate with N drilled holes has genus N).
   */
  genus: number;
}

/** Geometry fields the worker computes (everything but the caller's versionId). */
interface MeasureSolve {
  watertight: boolean;
  triangles: number;
  boundingBoxMm: MeasureReport['boundingBoxMm'];
  volumeMm3: number;
  surfaceAreaMm2: number;
  centerOfMassMm: [number, number, number];
  genus: number;
}

/**
 * Whole-part ground truth (Q1=B: the stored STL is the contract).
 *
 * The worker reads the stored file BY PATH — nothing is copied — and returns every
 * measured field; this side only adds the versionId. The geometry is Manifold +
 * trimesh work, which is domain, not platform.
 */
export async function measureVersion(store: VersionStore, versionId: string): Promise<MeasureReport> {
  const path = join(store.root, 'versions', versionId, 'model.stl');
  const worker = await ensurePythonWorker();
  const solved = await worker.request<MeasureSolve>('measure_part', { path });
  return { versionId, ...solved };
}

/**
 * The TS implementation — the parity oracle for the worker's `measure_part` (and
 * the darwin-x64 fallback, which needs no special branch here: this half is pure
 * TypeScript and only the WORKER half is platform-dependent).
 */
export async function measureVersionInTs(store: VersionStore, versionId: string): Promise<MeasureReport> {
  const stl = await readFile(join(store.root, 'versions', versionId, 'model.stl'));
  const mesh = parseBinaryStl(stl);
  const M = await ManifoldModule(); M.setup();
  const gm = new M.Mesh({ numProp: 3, vertProperties: mesh.vertProperties, triVerts: mesh.triVerts });
  gm.merge();
  const solid = new M.Manifold(gm); // throws on non-manifold

  // Surface area from triangle cross products.
  let area = 0;
  for (let t = 0; t < mesh.triVerts.length; t += 3) {
    const a = mesh.triVerts[t]! * 3, b = mesh.triVerts[t + 1]! * 3, c = mesh.triVerts[t + 2]! * 3;
    const ux = mesh.vertProperties[b]! - mesh.vertProperties[a]!;
    const uy = mesh.vertProperties[b! + 1]! - mesh.vertProperties[a! + 1]!;
    const uz = mesh.vertProperties[b! + 2]! - mesh.vertProperties[a! + 2]!;
    const vx = mesh.vertProperties[c]! - mesh.vertProperties[a]!;
    const vy = mesh.vertProperties[c! + 1]! - mesh.vertProperties[a! + 1]!;
    const vz = mesh.vertProperties[c! + 2]! - mesh.vertProperties[a! + 2]!;
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    area += Math.hypot(cx, cy, cz) / 2;
  }

  // Volume-weighted centroid.
  let vol6 = 0, cx = 0, cy = 0, cz = 0;
  for (let t = 0; t < mesh.triVerts.length; t += 3) {
    const a = mesh.triVerts[t]! * 3, b = mesh.triVerts[t + 1]! * 3, c = mesh.triVerts[t + 2]! * 3;
    const ax = mesh.vertProperties[a]!, ay = mesh.vertProperties[a! + 1]!, az = mesh.vertProperties[a! + 2]!;
    const bx = mesh.vertProperties[b]!, by = mesh.vertProperties[b! + 1]!, bz = mesh.vertProperties[b! + 2]!;
    const mx = mesh.vertProperties[c]!, my = mesh.vertProperties[c! + 1]!, mz = mesh.vertProperties[c! + 2]!;
    const v = (ax * (by * mz - bz * my) - ay * (bx * mz - bz * mx) + az * (bx * my - by * mx));
    vol6 += v;
    cx += (ax + bx + mx) * v; cy += (ay + by + my) * v; cz += (az + bz + mz) * v;
  }
  const com: [number, number, number] = vol6 !== 0
    ? [cx / (4 * vol6), cy / (4 * vol6), cz / (4 * vol6)]
    : [0, 0, 0];

  const bb = boundingBox(mesh);
  return {
    versionId,
    watertight: isWatertight(mesh).watertight,
    triangles: mesh.triVerts.length / 3,
    boundingBoxMm: {
      min: bb.min.map(round3) as [number, number, number],
      max: bb.max.map(round3) as [number, number, number],
      size: [round3(bb.max[0] - bb.min[0]), round3(bb.max[1] - bb.min[1]), round3(bb.max[2] - bb.min[2])],
    },
    volumeMm3: round3(solid.volume()),
    surfaceAreaMm2: round3(area),
    centerOfMassMm: com.map(round3) as [number, number, number],
    genus: solid.genus(),
  };
}

/**
 * Round to the reported 0.001mm, and normalise -0 to 0.
 *
 * A symmetric part has a centroid coordinate that rounds to `-0`, and
 * `JSON.stringify(-0)` is `"0"` — so the tool result could not round-trip and
 * the harness rejected it as "not lossless JSON", which made `measure_part`
 * fail on *every* part. -0 and 0 are the same measurement; report the one JSON
 * can carry.
 */
function round3(v: number): number {
  const r = Math.round(v * 1000) / 1000;
  return r === 0 ? 0 : r;
}

// z-up convention: [0,0,0] looks at the xy plane from +z = TOP view.
// The names are a literal tuple (not Object.keys) so the four views are typed
// and enumerated in one place.
const VIEW_NAMES = ['top', 'front', 'side', 'iso'] as const;
export type ViewName = typeof VIEW_NAMES[number];
const VIEW_ROTATIONS: Record<ViewName, [number, number, number]> = {
  top: [0, 0, 0], front: [90, 0, 0], side: [0, 90, 0], iso: [65, 0, 25],
};

export interface StlFrameOptions {
  view?: 'front' | 'side' | 'top' | 'iso';
  /** Custom camera rotation; overrides view preset. */
  rotate?: [number, number, number];
  /** 1 = auto-fit; 2 = twice as close; 0.5 = half as close. */
  zoom?: number;
  imgSize?: number;
  /** Cut the model: keep the part beyond `fraction` along axis (0..1 of bbox). */
  section?: { axis: 'x' | 'y' | 'z'; fraction: number };
}

export interface RenderPartRequest extends StlFrameOptions {
  versionId: string;
}

/**
 * Render one frame from an STL file.
 *
 * The mesh — not the source — is the input, which is the property that lets an
 * imported part be reviewed exactly like a generated one: the four views, the
 * section cut, the zoom and the framing all work on geometry that never had a
 * single line of SCAD. It is also why historical versions still render after
 * their source has been superseded.
 *
 * Scratch files live in a temp directory, not in the version directory: a
 * read-only view of a version must not litter it (`inspect_*.scad` used to
 * accumulate there, one pair per render).
 */
export async function renderStlFramePng(
  stlPath: string,
  opts: StlFrameOptions,
  stem = 'frame',
): Promise<{ png: Uint8Array; label: string }> {
  // Read once: an imported STL can be tens of megabytes, and the original
  // implementation re-read it for every bbox it needed.
  const stlBytes = await readFile(stlPath); // throws if missing
  const bb = boundingBox(parseBinaryStl(stlBytes));
  const dir = await mkdtemp(join(tmpdir(), 'cad-frame-'));
  try {
    const lines = [`import("${stlPath}");`];
    if (opts.section) {
      const axisIdx = { x: 0, y: 1, z: 2 }[opts.section.axis];
      // The cut plane sits at a fraction of the model's own bounding box.
      const cut = bb.min[axisIdx]! + (bb.max[axisIdx]! - bb.min[axisIdx]!) * Math.min(1, Math.max(0, opts.section.fraction));
      const BIG = Math.max(...bb.max.map((v, i) => Math.abs(v - bb.min[i]!))) * 10 + 100;
      const center = [0, 1, 2].map((i) => (i === axisIdx ? cut + BIG / 2 : 0));
      const sizes = [0, 1, 2].map(() => BIG);
      lines[0] = `intersection() { import("${stlPath}"); translate([${center.map((v) => v.toFixed(3)).join(',')}]) cube([${sizes.join(',')}], center=true); }`;
    }
    const scadPath = join(dir, `${stem}.scad`);
    await writeFile(scadPath, lines.join('\n'), 'utf8');

    const rotate = opts.rotate ?? VIEW_ROTATIONS[opts.view ?? 'iso']!;
    const diagonal = Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]);
    const pngPath = join(dir, `${stem}.png`);
    const ok = await renderScadPng(scadPath, pngPath, {
      rotate,
      zoom: opts.zoom,
      imgSize: opts.imgSize,
      target: [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, (bb.min[2] + bb.max[2]) / 2],
      modelDiagonal: diagonal,
    });
    if (!ok) throw new Error(`render failed for ${stlPath}`);
    const sectionLabel = opts.section ? ` section:${opts.section.axis}@${opts.section.fraction}` : '';
    const label = `${opts.rotate ? `rot(${opts.rotate.join(',')})` : (opts.view ?? 'iso')}${opts.zoom && opts.zoom !== 1 ? ` zoom×${opts.zoom}` : ''}${sectionLabel}`;
    return { png: await readFile(pngPath), label };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The four fixed views of an STL, shaped exactly like `compileAndRender`'s
 * renders so an imported version reaches the model through the same channel as
 * a generated one (four images, same view names, same order).
 */
export async function renderStlViews(
  stlPath: string,
  opts: { imgSize?: number } = {},
): Promise<{ view: string; png: Uint8Array }[]> {
  const out: { view: string; png: Uint8Array }[] = [];
  for (const view of VIEW_NAMES) {
    const { png } = await renderStlFramePng(stlPath, { view, imgSize: opts.imgSize }, `view_${view}`);
    out.push({ view, png });
  }
  return out;
}

/** Render one frame of a saved version (thin wrapper over the STL path). */
export async function renderVersionFrame(
  store: VersionStore,
  req: RenderPartRequest,
  outName: string,
): Promise<{ png: Uint8Array; label: string }> {
  const stlPath = join(store.root, 'versions', req.versionId, 'model.stl');
  return renderStlFramePng(stlPath, req, `inspect_${outName}`);
}
