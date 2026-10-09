// Inspection tools (M3.5+): exact geometry measurements and on-demand
// section/perspective renders of saved versions.

import ManifoldModule from 'manifold-3d';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensurePythonWorker } from './python-worker.ts';
import { buildMeshBvh } from './measure.ts';
import { Vector3, Ray, DoubleSide } from 'three';
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
/** Options the printability screen takes (all optional except the version). */
export interface PrintabilityOptions {
  versionId: string;
  wallMinMm?: number;
  overhangDeg?: number;
  samples?: number;
}

/** The screen's report — the tool's output schema, field for field. */
export interface PrintabilityReport {
  versionId: string;
  verdict: 'ok' | 'check' | 'unprintable';
  minWallMm?: number;
  thinSamples: number;
  sampled: number;
  overhangAreaMm2: number;
  overhangZRange: number[];
  findings: string[];
  watertight: boolean;
}

/**
 * The TS implementation — the parity oracle for the worker's `check_printability`.
 *
 * The overhang area is pure arithmetic over a deterministic sample of triangles, so
 * it must match the worker's bit for bit; only the ray cast (a spatial-index query)
 * can differ in the last digits.
 */
export async function checkPrintabilityInTs(store: VersionStore, options: PrintabilityOptions): Promise<PrintabilityReport> {
      const wallMinMm = options.wallMinMm ?? 1.2;
      const overhangDeg = options.overhangDeg ?? 45;
      const targetSamples = Math.max(100, Math.min(options.samples ?? 600, 4000));

      const bytes = new Uint8Array(await readFile(join(store.root, 'versions', options.versionId, 'model.stl')));
      const mesh = parseBinaryStl(bytes);
      const watertight = isWatertight(mesh).watertight;
      // Sample the mesh AS PARSED. `buildMeshBvh` hands three-mesh-bvh the live index
      // array and the library REORDERS that index in place for cache locality — so
      // building the BVH first silently changed which triangles the sample visited
      // (244.1 vs 647.6 mm² of overhang on the same part, and 34 vs 18 thin samples).
      // The screen is documented as "every Nth triangle", so the parse order is the
      // contract; the BVH gets its own copy to reorder as it likes.
      const bvh = buildMeshBvh({ vertProperties: mesh.vertProperties, triVerts: mesh.triVerts.slice() });

      const triCount = mesh.triVerts.length / 3;
      const step = Math.max(1, Math.floor(triCount / targetSamples));
      const v = (i: number) => new Vector3(mesh.vertProperties[i * 3]!, mesh.vertProperties[i * 3 + 1]!, mesh.vertProperties[i * 3 + 2]!);
      const bb = boundingBox(mesh);
      const zFloor = bb.min[2];

      let minWall = Infinity;
      let minWallAt: [number, number, number] | null = null;
      let thinSamples = 0;
      let sampled = 0;
      let overhangArea = 0;
      let overhangZMin = Infinity;
      let overhangZMax = -Infinity;
      const overhangSin = Math.sin((overhangDeg * Math.PI) / 180);

      for (let t = 0; t < triCount; t += step) {
        const ia = mesh.triVerts[t * 3]!, ib = mesh.triVerts[t * 3 + 1]!, ic = mesh.triVerts[t * 3 + 2]!;
        const va = v(ia), vb = v(ib), vc = v(ic);
        const centroid = va.clone().add(vb).add(vc).multiplyScalar(1 / 3);
        const n = vb.clone().sub(va).cross(vc.clone().sub(va)).normalize();
        const area = vb.clone().sub(va).cross(vc.clone().sub(va)).length() / 2;
        sampled++;

        // down-facing overhang: normal points below horizontal by overhangDeg
        if (n.z < -overhangSin && centroid.z - zFloor > 0.8) {
          overhangArea += area;
          overhangZMin = Math.min(overhangZMin, centroid.z);
          overhangZMax = Math.max(overhangZMax, centroid.z);
        }

        // wall thickness: from 0.05 outside the surface, march along -n; the
        // FIRST hit is the sample triangle's own plane (DoubleSide backface at
        // ≈0.05), the SECOND is the opposite wall → wall = dist − 0.05.
        const ray = new Ray(centroid.clone().addScaledVector(n, 0.05), n.clone().negate());
        let wall: number | null = null;
        try {
          const hits = bvh.raycast(ray, DoubleSide) as { distance: number }[];
          // The NEAREST hit above the skip distance. This used to take the first
          // hit in the returned order, on the assumption it was the nearest — but
          // `MeshBVH.raycast` returns hits in BVH TRAVERSAL order, not distance
          // order (measured on a real part: [292.93, 289.92, …, 11.05, 3.06]), so
          // the old loop picked the FAR wall and under-reported thin walls: 0.2mm
          // reported instead of the true 0.026mm, and 15 thin samples instead of
          // 34, on 整机.stl. The migration to Python (which takes the minimum)
          // surfaced it.
          let nearest = Infinity;
          for (const h of hits) if (h.distance > 0.075 && h.distance < nearest) nearest = h.distance;
          if (Number.isFinite(nearest)) wall = nearest - 0.05;
        } catch { /* degenerate region — skip this sample */ }
        if (wall !== null && Number.isFinite(wall)) {
          if (wall < minWall) { minWall = wall; minWallAt = [centroid.x, centroid.y, centroid.z]; }
          if (wall < wallMinMm) thinSamples++;
        }
      }

      const findings: string[] = [];
      if (!watertight) {
        findings.push('mesh is NOT watertight — printability numbers below are computed on an open surface and are unreliable; fix the mesh first');
      }
      if (minWallAt && minWall < wallMinMm) {
        findings.push(
          `最薄壁 ${minWall.toFixed(2)}mm @ [${minWallAt.map((x) => x.toFixed(1)).join(',')}]（阈值 ${wallMinMm}mm；` +
          `${sampled} 个采样面中 ${thinSamples} 个低于阈值）— 薄壁打印要么断要么翘，加厚、加筋或改朝向`,
        );
      }
      if (overhangArea > 20) {
        findings.push(
          `${overhangArea.toFixed(0)}mm² 朝下悬垂面比 ${overhangDeg}° 更平（z ∈ [${overhangZMin.toFixed(0)}, ${overhangZMax.toFixed(0)}]）` +
          ' — 需要支撑、改打印朝向、或改成 45° 以内/桥接',
        );
      }

      const severe = Number.isFinite(minWall) && minWall < wallMinMm * 0.4;
      const verdict = severe ? 'unprintable' : findings.length > 0 ? 'check' : 'ok';
      return {
        versionId: options.versionId,
        verdict,
        ...(Number.isFinite(minWall) ? { minWallMm: +minWall.toFixed(3) } : {}),
        thinSamples,
        sampled,
        overhangAreaMm2: +overhangArea.toFixed(1),
        overhangZRange: Number.isFinite(overhangZMin) ? [+overhangZMin.toFixed(1), +overhangZMax.toFixed(1)] : [],
        findings,
        watertight,
      };
}

/** The geometry half of the worker's answer (everything but the versionId). */
type PrintabilitySolve = Omit<PrintabilityReport, 'versionId'>;

/**
 * Manufacturability screen (Q1=B: the stored STL is the contract).
 *
 * Wall thickness is a ray cast along the inward normal — a spatial-index query,
 * which the matrix's negative-return table flagged as a risk. It was measured
 * BEFORE porting: 601 rays against the 28,830-triangle real part take 0.121 s with
 * trimesh's RayMeshIntersector, against this tool's 120 s budget — so the query is
 * not a reason to keep the screen in TypeScript.
 */
export async function checkPrintability(store: VersionStore, options: PrintabilityOptions): Promise<PrintabilityReport> {
  const path = join(store.root, 'versions', options.versionId, 'model.stl');
  const worker = await ensurePythonWorker();
  const solved = await worker.request<PrintabilitySolve>('check_printability', {
    path,
    wallMinMm: options.wallMinMm ?? 1.2,
    overhangDeg: options.overhangDeg ?? 45,
    samples: Math.max(100, Math.min(options.samples ?? 600, 4000)),
  });
  return { versionId: options.versionId, ...solved };
}

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
