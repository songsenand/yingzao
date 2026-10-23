// Inspection tools (M3.5+): exact geometry measurements and on-demand
// section/perspective renders of saved versions.

import ManifoldModule from 'manifold-3d';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asJudgement } from '../shared/judgement.ts';
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
  /**
   * Also return the per-sample values behind the field. They are what a heatmap is
   * drawn from, and they are deliberately NOT part of the report the model reads —
   * the caller writes them into a run and hands the digest to the LLM.
   */
  withSampleField?: boolean;
}

/** The values behind an attention layer: one point per sample, in the part's frame. */
export interface AttentionFieldSamples {
  id: string;
  samples: { [layerId: string]: { p: number[]; v: number }[] };
  normalization: { [layerId: string]: { [key: string]: Json } };
}

/** The screen's report — the tool's output schema, field for field. */
export interface PrintabilityReport {
  versionId: string;
  /** Canonical since 2026-10-20 (was ok/check/unprintable). */
  verdict: 'not-excluded' | 'difficult' | 'excluded';
  minWallMm?: number;
  /** Where the thinnest wall was found — the witness a human can go and look at. */
  minWallAtMm?: number[];
  /**
   * False = the ray half measured NOTHING. `ok` is then impossible: a screen that
   * could not run has not passed anything. The worker's guard exists because a
   * venv missing `rtree` made every ray throw, every throw was swallowed per ray,
   * and the tool reported a clean part with no wall finding at all.
   */
  wallMeasured: boolean;
  thinSamples: number;
  sampled: number;
  /** Area of the thin (sub-threshold) region, derived from the 1/step sample. */
  thinAreaMm2: number;
  /** …as a percentage of the whole surface — what tells a shell from a blunt edge. */
  thinAreaPct: number;
  /**
   * The measured surface area. Published because the sampling spacing (and therefore the
   * smallest wall difference this screen can resolve) is sqrt(area / sampled) — a band
   * without it would be invented (DESIGN §27.4, 2026-10-23).
   */
  surfaceAreaMm2: number;
  overhangAreaMm2: number;
  overhangZRange: number[];
  /** The per-sample values behind the attention digest (withSampleField). */
  field?: AttentionFieldSamples;
  findings: string[];
  watertight: boolean;
  /** Where to look next, per quantity — empty layers when nothing was measured. */
  attention: AttentionField;
}

/**
 * A wall measurement only counts when the ray reaches the OTHER side of the
 * material: a hit on a coplanar sliver (a Manifold artefact at a crease or at an
 * exposed start-cap) has nearly the SAME normal and is not a wall. Measured on the
 * real corpus: a 0.012 mm² sliver reported a 0.17 mm "wall" that does not exist
 * (dot = −0.08), while a genuine 0.50 mm tube wall reports dot = −1.000.
 */
const OPPOSITE_WALL_DOT = -0.5;
/** A single sampled face must not decide a red verdict — the thin region must be sustained. */
const UNPRINTABLE_MIN_THIN_AREA_MM2 = 50;
const UNPRINTABLE_MIN_THIN_AREA_FRACTION = 0.01;

/** A JSON value, so the `probe`/`look` a tool hands out is storable as-is. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** A place the field is extreme at — the index into the picture, and a runnable re-measure. */
export interface AttentionPeak {
  atMm: number[];
  value: number;
  normalMm?: number[];
  evidence: string;
  probe: { tool: string; args: { [key: string]: Json } };
}

/** A connected region above a tier — what a human points at and an LLM can act on. */
export interface AttentionRegion {
  tier: 'warn' | 'bad';
  areaMm2: number;
  atMm: number[];
  bboxMm: number[][];
  look: { tool: string; args: { [key: string]: Json } };
  [key: string]: Json | undefined;
}

/** One scalar quantity over the part — the layer a heatmap would draw. */
export interface AttentionLayer {
  id: string;
  quantity: string;
  units: string;
  direction: string;
  domain: { [key: string]: Json };
  normalization: { [key: string]: Json };
  stats: { [key: string]: Json };
  peaks: AttentionPeak[];
  regions: AttentionRegion[];
}

/**
 * The ATTENTION half of a screen: one field, two views. The panel draws each layer as a
 * heatmap; the LLM gets this digest (peaks + regions + runnable probes) instead of a
 * grid. Both come from the same object — a picture may never outlive the geometry it
 * describes, which is why `id` carries the version and the parameters.
 */
export interface AttentionField {
  id: string;
  layers: AttentionLayer[];
}

/**
 * Union-find over 3D points with a link radius, bucketed so it stays linear.
 * Grouping only: it decides "these samples are one place", never "this is a defect".
 */
function clusterPoints(points: [number, number, number][], radiusMm = 6): number[][] {
  const cell = (v: number) => Math.floor(v / radiusMm);
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const grid = new Map<string, number[]>();
  points.forEach((p, i) => {
    const k = key(cell(p[0]), cell(p[1]), cell(p[2]));
    const bucket = grid.get(k);
    if (bucket) bucket.push(i); else grid.set(k, [i]);
  });
  const parent = points.map((_, i) => i);
  const find = (a: number): number => {
    let x = a;
    while (parent[x] !== x) { parent[x] = parent[parent[x]!]!; x = parent[x]!; }
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const r2 = radiusMm * radiusMm;
  points.forEach((p, i) => {
    const cx = cell(p[0]), cy = cell(p[1]), cz = cell(p[2]);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const j of grid.get(key(cx + dx, cy + dy, cz + dz)) ?? []) {
        if (j <= i) continue;
        const q = points[j]!;
        const d2 = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
        if (d2 <= r2) union(i, j);
      }
    }
  });
  const groups = new Map<number, number[]>();
  points.forEach((_, i) => {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(i); else groups.set(r, [i]);
  });
  return [...groups.values()];
}

/**
 * Fill the versionId into every runnable command the field hands out. The worker
 * measures a file and does not know which version it is; the caller does. Both the
 * production path and the TS oracle go through here, so their outputs stay identical.
 */
function withVersionInAttention(attention: AttentionField, versionId: string): AttentionField {
  return {
    id: `${versionId}:${attention.id}`,
    layers: attention.layers.map((layer) => ({
      ...layer,
      peaks: layer.peaks.map((peak) => ({
        ...peak,
        probe: { ...peak.probe, args: { versionId, ...peak.probe.args } },
      })),
      regions: layer.regions.map((region) => ({
        ...region,
        look: { ...region.look, args: { versionId, ...region.look.args } },
      })),
    })),
  };
}

/**
 * The TS implementation — the parity oracle for the worker's `check_printability`.
 *
 * The overhang area is pure arithmetic and is computed over EVERY triangle on both
 * sides, so it must match the worker's bit for bit; only the ray cast (a spatial-index
 * query) can differ in the last digits. Sampling the arithmetic half was a biased-low
 * estimate (real 5.7" propeller: 200 mm² sampled against 2022 mm² true).
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
      // A hit's `faceIndex` addresses the BVH's index buffer, which `MeshBVH`
      // REORDERS in place (that is why `buildMeshBvh` gets a copy). Resolving it
      // against `mesh.triVerts` therefore returns a different triangle: measured on
      // the 0.8mm-wall box, the true far wall resolves to dot 0.000 through
      // `mesh.triVerts` and to dot −1.000 through the BVH. Resolve it here, against
      // the BVH's own arrays.
      const bvhIndex = bvh.geometry.getIndex()!.array as ArrayLike<number>;
      const bvhPos = bvh.geometry.getAttribute('position').array as ArrayLike<number>;
      const faceNormalCache = new Vector3();
      const exitNormalAt = (faceIndex: number): Vector3 => {
        const a = bvhIndex[faceIndex * 3]! * 3, b = bvhIndex[faceIndex * 3 + 1]! * 3, c = bvhIndex[faceIndex * 3 + 2]! * 3;
        const ux = bvhPos[b]! - bvhPos[a]!, uy = bvhPos[b + 1]! - bvhPos[a + 1]!, uz = bvhPos[b + 2]! - bvhPos[a + 2]!;
        const vx = bvhPos[c]! - bvhPos[a]!, vy = bvhPos[c + 1]! - bvhPos[a + 1]!, vz = bvhPos[c + 2]! - bvhPos[a + 2]!;
        return faceNormalCache.set(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx).normalize();
      };

      const triCount = mesh.triVerts.length / 3;
      const step = Math.max(1, Math.floor(triCount / targetSamples));
      const v = (i: number) => new Vector3(mesh.vertProperties[i * 3]!, mesh.vertProperties[i * 3 + 1]!, mesh.vertProperties[i * 3 + 2]!);
      const bb = boundingBox(mesh);
      const zFloor = bb.min[2];

      let minWall = Infinity;
      let minWallAt: [number, number, number] | null = null;
      let thinSamples = 0;
      let thinArea = 0;
      const thinPts: { p: [number, number, number]; n: [number, number, number]; wall: number; area: number }[] = [];
      const overTris: number[] = [];
      let measured = 0;
      let sampled = 0;
      let overhangArea = 0;
      let overhangZMin = Infinity;
      let overhangZMax = -Infinity;
      // Threshold margin: a face sitting exactly on the limit (mathematically 45.000°) is
      // one ULP away from it in float64 and a different ULP in float32, so a strict `<`
      // lets rounding decide whether it needs support. Measured on toy-balance v069: 8
      // such faces, 50.1 mm² = 3.4% of the overhang area, flipped between the two
      // implementations. A face ON the limit is bridge-able, so it is not an overhang;
      // the 1e-9 slack is 7 orders above the noise and 7 below any meaningful angle.
      const OVERHANG_SIN_SLACK = 1e-9;
      const overhangSin = Math.sin((overhangDeg * Math.PI) / 180) + OVERHANG_SIN_SLACK;
      // The overhang half is arithmetic, so it runs over EVERY triangle: summing only
      // the sampled 1/step of them measures a fraction of the true area and reports it
      // as mm². The wall half stays sampled — it is the expensive ray cast.
      let surfaceArea = 0;
      const normalOf = (tri: number) => {
        const ia = mesh.triVerts[tri * 3]!, ib = mesh.triVerts[tri * 3 + 1]!, ic = mesh.triVerts[tri * 3 + 2]!;
        const va = v(ia), vb = v(ib), vc = v(ic);
        return {
          centroid: va.clone().add(vb).add(vc).multiplyScalar(1 / 3),
          n: vb.clone().sub(va).cross(vc.clone().sub(va)).normalize(),
          area: vb.clone().sub(va).cross(vc.clone().sub(va)).length() / 2,
        };
      };

      for (let t = 0; t < triCount; t++) {
        const { centroid, n, area } = normalOf(t);
        surfaceArea += area;
        // down-facing overhang: normal points below horizontal by overhangDeg
        if (n.z < -overhangSin && centroid.z - zFloor > 0.8) {
          overhangArea += area;
          overTris.push(t);
          overhangZMin = Math.min(overhangZMin, centroid.z);
          overhangZMax = Math.max(overhangZMax, centroid.z);
        }
        if (t % step !== 0) continue;
        sampled++;

        // wall thickness: from 0.05 outside the surface, march along -n; the
        // FIRST hit is the sample triangle's own plane (DoubleSide backface at
        // ≈0.05), the NEXT facing us is the opposite wall → wall = dist − 0.05.
        const ray = new Ray(centroid.clone().addScaledVector(n, 0.05), n.clone().negate());
        let wall: number | null = null;
        let hits: { distance: number; faceIndex?: number }[] = [];
        try {
          hits = bvh.raycast(ray, DoubleSide) as { distance: number; faceIndex?: number }[];
        } catch { hits = []; }
        // The NEAREST hit above the skip distance that FACES BACK at us is the
        // opposite wall — wall = distance − 0.05.
        //
        // NEAREST, not first: `MeshBVH.raycast` returns hits in BVH TRAVERSAL order,
        // not distance order (measured on a real part: [292.93, 289.92, …, 11.05,
        // 3.06]), so taking the first hit above the skip distance picked the FAR wall
        // and under-reported thin walls (0.2mm reported against a true 0.026mm).
        //
        // FACING BACK, because a coplanar sliver — a Manifold artefact at a crease or
        // at an exposed start-cap — returns a hit with nearly the SAME normal, and
        // calling that "the opposite wall" invented a 0.17mm wall on a 0.012mm²
        // artefact.
        //
        // The hit loop stays OUTSIDE the try on purpose: a bug in this arithmetic
        // must not be swallowed into "nothing measured", which is exactly how the
        // first version of this filter silently reported every part as wall-free.
        let nearest = Infinity;
        for (const h of hits) {
          if (!(h.distance > 0.075) || h.distance >= nearest) continue;
          if (h.faceIndex === undefined) continue;
          if (exitNormalAt(h.faceIndex).dot(n) < OPPOSITE_WALL_DOT) nearest = h.distance;
        }
        if (Number.isFinite(nearest)) wall = nearest - 0.05;
        if (wall !== null && Number.isFinite(wall)) {
          measured++;
          if (wall < minWall) { minWall = wall; minWallAt = [centroid.x, centroid.y, centroid.z]; }
          if (wall < wallMinMm) {
            thinSamples++;
            thinArea += area;
            thinPts.push({ p: [centroid.x, centroid.y, centroid.z], n: [n.x, n.y, n.z], wall, area });
          }
        }
      }

      // the thin half is measured on a 1/step sample → scale it back to the surface
      thinArea *= triCount / Math.max(1, sampled);
      const thinAreaPct = surfaceArea > 0 ? (thinArea / surfaceArea) * 100 : 0;
      const wallMeasured = measured > 0;

      // ---- the attention field: one field, two views -------------------------
      // A screen used to answer "thin area = x mm²" plus one thinnest point. A defect is
      // a PLACE; this groups the samples (and the overhang triangles) into layers, each
      // with peaks, regions and a runnable next observation. Grouping changes no verdict.
      const layers: AttentionLayer[] = [];
      const scale = triCount / Math.max(1, sampled);
      // +v.toFixed(d) turns a tiny negative coordinate into -0, and JSON cannot
      // round-trip -0 losslessly (-0 → "0" → +0), which failed the reply
      // validator as "value is not lossless JSON". Normalise it at the source.
      const round = (v: number, d: number) => { const r = +v.toFixed(d); return Object.is(r, -0) ? 0 : r; };
      const wallLayer: AttentionLayer = {
        id: 'wall',
        quantity: 'wall-thickness',
        units: 'mm',
        direction: 'smaller-is-worse',
        domain: { kind: 'surface-samples', samples: sampled, measured },
        normalization: { mode: 'absolute', warnAt: wallMinMm, badAt: round(wallMinMm * 0.4, 3), source: 'declared-arg' },
        stats: {
          minWallMm: Number.isFinite(minWall) ? round(minWall, 3) : null,
          thinSamples,
          thinAreaMm2: round(thinArea, 1),
        },
        peaks: [],
        regions: [],
      };
      if (thinPts.length) {
        const thinGroups = clusterPoints(thinPts.map((sp) => sp.p));
        const clusters = thinGroups.map((idx) => {
          const walls = idx.map((i) => thinPts[i]!.wall);
          const minW = Math.min(...walls);
          const at = thinPts[idx[walls.indexOf(minW)]!]!;
          const xs = idx.map((i) => thinPts[i]!.p[0]);
          const ys = idx.map((i) => thinPts[i]!.p[1]);
          const zs = idx.map((i) => thinPts[i]!.p[2]);
          return {
            n: idx.length,
            minW,
            at,
            bbox: [[Math.min(...xs), Math.min(...ys), Math.min(...zs)],
                   [Math.max(...xs), Math.max(...ys), Math.max(...zs)]],
            area: idx.reduce((acc, i) => acc + thinPts[i]!.area, 0) * scale,
          };
        });
        wallLayer.peaks = [...clusters].sort((a, b) => a.minW - b.minW).slice(0, 6).map((c) => ({
          atMm: c.at.p.map((v) => round(v, 2)),
          value: round(c.minW, 3),
          normalMm: c.at.n.map((v) => round(v, 4)),
          evidence: `${c.n} 个采样面低于 ${wallMinMm}mm，最薄 ${c.minW.toFixed(2)}mm，约 ${c.area.toFixed(1)}mm²`,
          probe: {
            tool: 'measure_thickness',
            args: {
              from: c.at.p.map((v, k) => round(v + c.at.n[k]! * 0.5, 3)),
              directionVector: c.at.n.map((v) => round(-v, 4)),
            },
          },
        }));
        wallLayer.regions = [...clusters].sort((a, b) => b.area - a.area).slice(0, 8).map((c) => {
          const ext = [0, 1, 2].map((k) => c.bbox[1]![k]! - c.bbox[0]![k]!);
          const axisIndex = ext.indexOf(Math.min(...ext));
          const atMm = (c.bbox[0]![axisIndex]! + c.bbox[1]![axisIndex]!) / 2;
          return {
            tier: (c.minW < wallMinMm * 0.4 ? 'bad' : 'warn') as 'warn' | 'bad',
            areaMm2: round(c.area, 1),
            samples: c.n,
            minWallMm: round(c.minW, 3),
            atMm: c.at.p.map((v) => round(v, 2)),
            bboxMm: c.bbox.map((row) => row.map((v) => round(v, 2))),
            look: { tool: 'render_part', args: { section: { axis: 'xyz'[axisIndex]!, atMm: round(atMm, 2) } } },
          };
        });
      }
      layers.push(wallLayer);

      if (overTris.length) {
        const edgeMap = new Map<string, number[]>();
        const corners = (t: number) => [mesh.triVerts[t * 3]!, mesh.triVerts[t * 3 + 1]!, mesh.triVerts[t * 3 + 2]!];
        for (const t of overTris) {
          const [a, b, c] = corners(t);
          for (const [u, vv] of [[a, b], [b, c], [c, a]]) {
            const k = u! < vv! ? `${u},${vv}` : `${vv},${u}`;
            const arr = edgeMap.get(k);
            if (arr) arr.push(t); else edgeMap.set(k, [t]);
          }
        }
        const parent = new Map<number, number>();
        overTris.forEach((t) => parent.set(t, t));
        const find = (a: number): number => {
          let x = a;
          while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x)!)!); x = parent.get(x)!; }
          return x;
        };
        const union = (a: number, b: number) => {
          const ra = find(a), rb = find(b);
          if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb));
        };
        for (const faces of edgeMap.values()) for (let i = 1; i < faces.length; i++) union(faces[0]!, faces[i]!);
        const patchGroups = new Map<number, number[]>();
        for (const t of overTris) {
          const r = find(t);
          const g = patchGroups.get(r);
          if (g) g.push(t); else patchGroups.set(r, [t]);
        }
        const z0 = bb.min[2], z1 = bb.max[2];
        const patches = [...patchGroups.values()].map((tris) => {
          let areaP = 0;
          const acc: [number, number, number] = [0, 0, 0];
          let best = -1, bestArea = -1, bestAt: [number, number, number] = [0, 0, 0];
          let xmin = Infinity, ymin = Infinity, zmin = Infinity, xmax = -Infinity, ymax = -Infinity, zmax = -Infinity;
          for (const t of tris) {
            const { centroid, area } = normalOf(t);
            areaP += area;
            acc[0] += centroid.x * area; acc[1] += centroid.y * area; acc[2] += centroid.z * area;
            if (area > bestArea) { bestArea = area; best = t; bestAt = [centroid.x, centroid.y, centroid.z]; }
            for (const vi of corners(t)) {
              const x = mesh.vertProperties[vi * 3]!, y = mesh.vertProperties[vi * 3 + 1]!, z = mesh.vertProperties[vi * 3 + 2]!;
              xmin = Math.min(xmin, x); ymin = Math.min(ymin, y); zmin = Math.min(zmin, z);
              xmax = Math.max(xmax, x); ymax = Math.max(ymax, y); zmax = Math.max(zmax, z);
            }
          }
          void best;
          return {
            area: areaP,
            triangles: tris.length,
            centroid: [acc[0] / Math.max(1e-12, areaP), acc[1] / Math.max(1e-12, areaP), acc[2] / Math.max(1e-12, areaP)] as [number, number, number],
            at: bestAt,
            bbox: [[xmin, ymin, zmin], [xmax, ymax, zmax]] as number[][],
          };
        }).sort((a, b) => b.area - a.area);
        const look = (c: [number, number, number]) => ({
          tool: 'render_part',
          args: { section: { axis: 'z', fraction: round((c[2] - z0) / Math.max(1e-9, z1 - z0), 3) } },
        });
        layers.push({
          id: 'overhang',
          quantity: 'down-facing-area',
          units: 'mm2',
          direction: 'larger-is-more-support',
          domain: { kind: 'triangles', triangles: overTris.length },
          normalization: { mode: 'absolute', warnAt: 20, source: 'declared-arg' },
          stats: {
            areaMm2: round(overhangArea, 1),
            zRangeMm: Number.isFinite(overhangZMin) ? [round(overhangZMin, 1), round(overhangZMax, 1)] : [],
          },
          peaks: patches.slice(0, 6).map((pch) => ({
            atMm: pch.at.map((v) => round(v, 2)),
            value: round(pch.area, 1),
            evidence: `${pch.area.toFixed(0)}mm² 朝下悬垂（${pch.triangles} 个三角面）`,
            probe: look(pch.at),
          })),
          regions: patches.filter((pch) => pch.area >= 5).slice(0, 8).map((pch) => ({
            tier: 'warn' as const,
            areaMm2: round(pch.area, 1),
            triangles: pch.triangles,
            atMm: pch.centroid.map((v) => round(v, 2)),
            bboxMm: pch.bbox.map((row) => row.map((v) => round(v, 2))),
            look: look(pch.centroid),
          })),
        });
      }
      const attention: AttentionField = {
        id: `check_printability:s${sampled}-w${wallMinMm}-o${overhangDeg}`,
        layers,
      };

      const findings: string[] = [];
      if (!watertight) {
        findings.push('mesh is NOT watertight — printability numbers below are computed on an open surface and are unreliable; fix the mesh first');
      }
      if (!wallMeasured) {
        findings.push(
          `壁厚**未测到**：${sampled} 个采样面沿内法线都没有打到对面壁。闭合实体不该出现这个结果，` +
          '最可能是射线引擎不可用——**本次一个壁厚都没量过，下面的结论不能当通过读**；先修运行时再重跑',
        );
      } else if (minWallAt && minWall < wallMinMm) {
        findings.push(
          `最薄壁 ${minWall.toFixed(2)}mm @ [${minWallAt.map((x) => x.toFixed(1)).join(',')}]（阈值 ${wallMinMm}mm；` +
          `${sampled} 个采样面中 ${thinSamples} 个低于阈值，薄区≈${thinArea.toFixed(1)}mm²` +
          `（占表面 ${thinAreaPct.toFixed(1)}%））` +
          ' — 薄**壳**（两自由面近似平行、成片）会断或翘；实心件收敛到棱线的**薄边**（翼型前后缘那种）不属此列，用薄区面积占比区分',
        );
      }
      if (overhangArea > 20) {
        findings.push(
          `${overhangArea.toFixed(0)}mm² 朝下悬垂面比 ${overhangDeg}° 更平（z ∈ [${overhangZMin.toFixed(0)}, ${overhangZMax.toFixed(0)}]）` +
          ' — 需要支撑、改打印朝向、或改成 45° 以内/桥接',
        );
      }

      // A single sampled face must not decide a red verdict, and a screen that could
      // not measure the wall has not passed anything — so it can never be `ok`.
      const severe = wallMeasured && Number.isFinite(minWall) && minWall < wallMinMm * 0.4 &&
        thinArea >= Math.max(UNPRINTABLE_MIN_THIN_AREA_MM2, UNPRINTABLE_MIN_THIN_AREA_FRACTION * surfaceArea);
      const verdict = severe ? 'excluded' : wallMeasured && findings.length === 0 ? 'not-excluded' : 'difficult';
      return {
        versionId: options.versionId,
        verdict,
        wallMeasured,
        thinAreaMm2: +thinArea.toFixed(1),
        thinAreaPct: +thinAreaPct.toFixed(2),
        surfaceAreaMm2: +surfaceArea.toFixed(2),
        ...(Number.isFinite(minWall) ? { minWallMm: +minWall.toFixed(3) } : {}),
        ...(minWallAt ? { minWallAtMm: minWallAt.map((v) => +v.toFixed(2)) } : {}),
        thinSamples,
        sampled,
        overhangAreaMm2: +overhangArea.toFixed(1),
        overhangZRange: Number.isFinite(overhangZMin) ? [+overhangZMin.toFixed(1), +overhangZMax.toFixed(1)] : [],
        findings,
        watertight,
        attention: withVersionInAttention(attention, options.versionId),
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
  const solved = await worker.request<PrintabilitySolve & { field?: AttentionFieldSamples }>('check_printability', {
    path,
    wallMinMm: options.wallMinMm ?? 1.2,
    overhangDeg: options.overhangDeg ?? 45,
    samples: Math.max(100, Math.min(options.samples ?? 600, 4000)),
    ...(options.withSampleField ? { withSampleField: true } : {}),
  });
  const { field, ...rest } = solved;
  // The worker measures but does not know which version it is reading; the caller
  // does. Every "go look here" command must be runnable as-is, so inject it once —
  // and the field's id carries the version, so a picture cannot outlive its geometry.
  return {
    versionId: options.versionId,
    ...rest,
    // One normalisation point: the engine's own word (ok / check / unprintable, produced by
    // the Python path too) becomes the canonical three (src/shared/judgement.ts). Doing it
    // HERE rather than in the worker keeps the engine vocabulary internal and stops the two
    // implementations from drifting — which is what the parity acceptance compares.
    verdict: asJudgement(rest.verdict),
    attention: withVersionInAttention(rest.attention, options.versionId),
    ...(field ? { field } : {}),
  };
}

/** One place worth looking at, from the geometry scan — a location, not a verdict. */
export interface AttentionScanSuspect {
  kind: 'reentrant-corner' | 'degenerate-faces' | 'non-manifold' | 'multi-body';
  where: { atMm?: number[]; bboxMm: number[][] };
  why: string;
  severity: 'likely-defect' | 'look';
  look?: { tool: string; args: { [key: string]: Json } };
}

export interface AttentionScanReport {
  versionId: string;
  stats: { [key: string]: Json };
  suspects: AttentionScanSuspect[];
}

/**
 * Where to look, geometrically: mesh health plus reentrant corners (concave edges
 * sharper than a right angle, chained and located). The measurement is the worker's;
 * this side adds the version and fills the versionId into every runnable command.
 */
export async function scanAttention(
  store: VersionStore,
  options: { versionId: string; concaveMinDeg?: number; minChainMm?: number },
): Promise<AttentionScanReport> {
  const path = join(store.root, 'versions', options.versionId, 'model.stl');
  const worker = await ensurePythonWorker();
  const solved = await worker.request<Omit<AttentionScanReport, 'versionId'>>('scan_attention', {
    path,
    ...(options.concaveMinDeg !== undefined ? { concaveMinDeg: options.concaveMinDeg } : {}),
    ...(options.minChainMm !== undefined ? { minChainMm: options.minChainMm } : {}),
  });
  return {
    versionId: options.versionId,
    ...solved,
    suspects: (solved.suspects ?? []).map((suspect) => ({
      ...suspect,
      ...(suspect.look ? { look: { ...suspect.look, args: { versionId: options.versionId, ...suspect.look.args } } } : {}),
    })),
  };
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
