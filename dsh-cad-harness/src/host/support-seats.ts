// Derive a gravity scan's supports from the assembly contract.
//
// The scan needs boundary conditions, and the honest ones are the joints the
// assembly already declares. This module answers "where is this part held?"
// without a datum-name heuristic and without asking the caller to type a coordinate.
//
// THE HOLDER TEST (2026-11-26):
//   A joint holds the target only if the OTHER part stays connected to the ground
//   when the target is removed from the structural graph. That is the difference
//   between a bearing and a rider:
//     * main_shaft's base_top joint: remove the shaft, base_top is still connected
//       to base_lower -> it holds the shaft.
//     * main_shaft's spool/disc joints: remove the shaft, the spools/discs fall off
//       the graph -> they ride on the shaft, they do not hold it.
//   The first version used "neighbor degree >= 2"; a disc chain also has degree 2,
//   so it put six supports along the shaft and moved the hotspot to mid-span. The
//   removal test plus the ground-distance filter is what makes the bearing win.
//
// WHERE ON THE JOINT:
//   The interface datum points are NOT the seat: base_top's `中轴` anchor is at
//   (0,0,0) while its bore is at z=38–54. So the support is the midpoint of the two
//   parts' bounding-box OVERLAP projected on the joint axis. That is the bore/seat
//   region, and it is geometry, not a name. If the overlap is degenerate, fall back
//   to the midpoint of the two datum points.
//
// Ground is the lowest part in WORLD space (min bbox z; tie: largest bbox volume).
// The local STL bbox is transformed by the node's rotate/translate before comparing;
// using the local z put the handwheel (local z=-25, world z=2) below the base and
// made it the ground in the first run.
//
// Joint preference: 转动副 > 固定副 > 销孔 > 贴合. A part with no such joint gets a
// clear refusal, not an invented support.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  allInterfaces, findNode, flattenParts, loadAssemblyManifest, resolveAssemblyManifestPath,
  type ManifestInterface, type ManifestNode,
} from './manifest.ts';
import { eulerMatrix, loadPartWorld, resolveEndpoint, rotateVec, translateVec, type PartWorld } from './assembly-check.ts';
import { boundingBox, parseBinaryStl, type ParsedMesh } from './mesh.ts';
import type { VersionStore } from './version.ts';

type Vec3 = [number, number, number];

export interface DerivedSupport {
  /** Point in the fetched version's LOCAL frame (what simulate_stress reads). */
  atMm: number[];
  /** The same point in assembly world coordinates, for traceability. */
  atWorldMm?: number[];
  radiusMm: number;
  source: string;
  interfaceId: string;
  neighbor: string;
  neighborDegree: number;
}

export interface DerivedSupports {
  partId: string;
  supports: DerivedSupport[];
  warnings: string[];
  manifestPath: string;
  interfacesSeen: string[];
  groundId: string | null;
}

export interface DeriveSupportsOptions {
  versionId: string;
  partId?: string;
  /** The project cwd (where `assembly/assembly.json` lives). */
  workspace: string;
  /** The cad-data root, used as the legacy manifest fallback. */
  dataRoot: string;
  /** Local cross-section radius hint from the caller (mm). */
  radiusHintMm: number;
  /** The scan's voxel size, used to refuse a bore ring thinner than 2 cells. */
  dxMm: number;
}

const STRUCTURAL = new Set(['转动副', '固定副', '销孔', '贴合']);
/** Declared structural minimum for a load-bearing FDM/PLA wall (policy, not physics). */
export const MIN_LOAD_BEARING_WALL_MM = 1.6;

export class ThinWallError extends Error {
  readonly kind: 'design' | 'resolution';
  readonly wallMm: number;
  readonly requiredMm: number;
  readonly atMm: number[];
  readonly featureId: string;

  constructor(input: {
    kind: 'design' | 'resolution';
    wallMm: number;
    requiredMm: number;
    atMm: number[];
    featureId: string;
  }) {
    super(
      `${input.kind === 'design' ? 'load-bearing wall' : 'support wall below 2 voxels'}: ` +
      `${input.wallMm.toFixed(2)} mm < ${input.requiredMm.toFixed(2)} mm at ` +
      `[${input.atMm.map((v) => v.toFixed(2)).join(', ')}]`,
    );
    this.name = 'ThinWallError';
    this.kind = input.kind;
    this.wallMm = input.wallMm;
    this.requiredMm = input.requiredMm;
    this.atMm = input.atMm;
    this.featureId = input.featureId;
  }
}


function distance(a: number[], b: number[]): number {
  return Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
}

function partOf(address: string): string {
  return address.slice(0, address.indexOf('.'));
}

function otherOf(iface: ManifestInterface, target: string): string {
  const a = partOf(iface.a);
  return a === target ? partOf(iface.b) : a;
}

function featureOf(resolved: unknown): { point?: number[]; dir?: number[]; normal?: number[]; radius?: number } {
  return (resolved as { point?: number[]; dir?: number[]; normal?: number[]; radius?: number }) ?? {};
}

function unit(v: number[]): Vec3 {
  const n = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
  return [v[0]! / n, v[1]! / n, v[2]! / n];
}

function dot(a: number[], b: number[]): number {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
}

/** Undirected structural graph over part ids. */
function structuralGraph(root: ManifestNode): { adj: Map<string, Set<string>>; degree: Map<string, number> } {
  const adj = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  };
  for (const { iface } of allInterfaces(root)) {
    if (!STRUCTURAL.has(iface.type as string)) continue;
    const a = partOf(iface.a);
    const b = partOf(iface.b);
    if (a && b && a !== b) add(a, b);
  }
  const degree = new Map<string, number>();
  for (const [id, set] of adj) degree.set(id, set.size);
  return { adj, degree };
}

/** Is `start` connected to `ground` when `blocked` is removed? */
function connectedWithout(adj: Map<string, Set<string>>, start: string, blocked: string, ground: string): boolean {
  if (start === ground) return true;
  const seen = new Set([blocked]);
  const queue = [start];
  while (queue.length) {
    const node = queue.shift()!;
    if (node === ground) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of adj.get(node) ?? []) if (!seen.has(next)) queue.push(next);
  }
  return false;
}

/** BFS distance from `start` to `ground`, skipping `blocked`; Infinity if cut off. */
function groundDistance(adj: Map<string, Set<string>>, start: string, blocked: string, ground: string): number {
  if (start === ground) return 0;
  const seen = new Set([blocked, start]);
  let frontier = [start];
  for (let d = 1; frontier.length; d++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const n of adj.get(node) ?? []) {
        if (n === ground) return d;
        if (seen.has(n)) continue;
        seen.add(n);
        next.push(n);
      }
    }
    frontier = next;
  }
  return Number.POSITIVE_INFINITY;
}

function localBbox(store: VersionStore, version: string | undefined): { min: number[]; max: number[] } | null {
  if (!version) return null;
  const path = join(store.root, 'versions', version, 'model.stl');
  if (!existsSync(path)) return null;
  try {
    const bb = boundingBox(parseBinaryStl(readFileSync(path)));
    return { min: bb.min.map(Number), max: bb.max.map(Number) };
  } catch {
    return null;
  }
}

import { readFileSync } from 'node:fs';

/** World point -> the fetched version's local frame (translate then inverse rotate). */
function worldToLocal(point: number[], transform: ReturnType<typeof flattenParts>[number]['transform']): number[] {
  if (!transform) return [...point];
  if (transform.pose) {
    throw new Error(
      'this assembly uses a pose (rotate-about-datum) transform; the support seat cannot be mapped back to the ' +
      'version frame yet — pass supports explicitly in local coordinates',
    );
  }
  const tr = transform.translate;
  const q: Vec3 = [
    point[0]! - (tr?.[0] ?? 0),
    point[1]! - (tr?.[1] ?? 0),
    point[2]! - (tr?.[2] ?? 0),
  ];
  if (!transform.rotate) return q;
  const M = eulerMatrix(transform.rotate as [number, number, number]);
  // M is row-major with M[r][c] = image of basis e_c at row r; the inverse is M^T.
  return [
    M[0]![0]! * q[0] + M[1]![0]! * q[1] + M[2]![0]! * q[2],
    M[0]![1]! * q[0] + M[1]![1]! * q[1] + M[2]![1]! * q[2],
    M[0]![2]! * q[0] + M[1]![2]! * q[1] + M[2]![2]! * q[2],
  ];
}

const meshCache = new Map<string, ParsedMesh>();

function meshFor(store: VersionStore, version: string | undefined): ParsedMesh | null {
  if (!version) return null;
  const hit = meshCache.get(version);
  if (hit) return hit;
  const path = join(store.root, 'versions', version, 'model.stl');
  if (!existsSync(path)) return null;
  try {
    const mesh = parseBinaryStl(readFileSync(path));
    meshCache.set(version, mesh);
    return mesh;
  } catch {
    return null;
  }
}

/** Moller-Trumbore; returns t > 0 or null. */
function rayTriangle(o: Vec3, d: Vec3, a: Vec3, b: Vec3, c: Vec3): number | null {
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as Vec3;
  const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]] as Vec3;
  const p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]] as Vec3;
  const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  const t0 = [o[0] - a[0], o[1] - a[1], o[2] - a[2]] as Vec3;
  const u = (t0[0] * p[0] + t0[1] * p[1] + t0[2] * p[2]) * inv;
  if (u < -1e-9 || u > 1 + 1e-9) return null;
  const q = [t0[1] * e1[2] - t0[2] * e1[1], t0[2] * e1[0] - t0[0] * e1[2], t0[0] * e1[1] - t0[1] * e1[0]] as Vec3;
  const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) * inv;
  if (v < -1e-9 || u + v > 1 + 1e-9) return null;
  const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv;
  return t > 1e-9 ? t : null;
}

function insideMesh(point: Vec3, mesh: ParsedMesh): boolean {
  const d: Vec3 = [0.998, 0.0431, 0.0197];
  let hits = 0;
  const vp = mesh.vertProperties;
  const idx = mesh.triVerts;
  for (let t = 0; t < idx.length; t += 3) {
    const ia = idx[t]! * 3;
    const ib = idx[t + 1]! * 3;
    const ic = idx[t + 2]! * 3;
    const a: Vec3 = [vp[ia]!, vp[ia + 1]!, vp[ia + 2]!];
    const b: Vec3 = [vp[ib]!, vp[ib + 1]!, vp[ib + 2]!];
    const c: Vec3 = [vp[ic]!, vp[ic + 1]!, vp[ic + 2]!];
    if (rayTriangle(point, d, a, b, c) !== null) hits++;
  }
  return hits % 2 === 1;
}

/** Smallest/largest positive distance from the axis line to the local surface in a slab. */
function radialRange(mesh: ParsedMesh, at: Vec3, axis: Vec3, slab: number): { min: number; max: number } {
  const vp = mesh.vertProperties;
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  for (let i = 0; i < vp.length; i += 3) {
    const d: Vec3 = [vp[i]! - at[0], vp[i + 1]! - at[1], vp[i + 2]! - at[2]];
    const along = d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2];
    if (Math.abs(along) > slab) continue;
    const radial = Math.hypot(d[0] - axis[0] * along, d[1] - axis[1] * along, d[2] - axis[2] * along);
    if (radial > 0.3) {
      if (radial < min) min = radial;
      if (radial > max) max = radial;
    }
  }
  return { min, max };
}

/**
 * Thickness of the FIRST material shell around the axis (bore wall -> hub OD),
 * not max-min: the handwheel's rim sits at the same x as its hub, so max-min
 * would report the whole wheel (18.8 mm) and miss the 0.8 mm hub wall.
 */
function firstWallThickness(mesh: ParsedMesh, at: Vec3, axis: Vec3, slab: number): number {
  const vp = mesh.vertProperties;
  const radials: number[] = [];
  for (let i = 0; i < vp.length; i += 3) {
    const d: Vec3 = [vp[i]! - at[0], vp[i + 1]! - at[1], vp[i + 2]! - at[2]];
    const along = d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2];
    if (Math.abs(along) > slab) continue;
    const radial = Math.hypot(d[0] - axis[0] * along, d[1] - axis[1] * along, d[2] - axis[2] * along);
    if (radial > 0.3) radials.push(radial);
  }
  if (radials.length === 0) return Number.POSITIVE_INFINITY;
  radials.sort((a, b) => a - b);
  const clusters: number[] = [];
  for (const r of radials) {
    if (clusters.length === 0 || r - clusters[clusters.length - 1]! > 0.25) clusters.push(r);
  }
  return clusters.length >= 2 ? clusters[1]! - clusters[0]! : Number.POSITIVE_INFINITY;
}

function perpendicular(axis: Vec3): Vec3 {
  const pick = Math.abs(axis[0]) <= Math.abs(axis[1]) && Math.abs(axis[0]) <= Math.abs(axis[2])
    ? [1, 0, 0]
    : Math.abs(axis[1]) <= Math.abs(axis[2]) ? [0, 1, 0] : [0, 0, 1];
  const u: Vec3 = [
    axis[1] * pick[2] - axis[2] * pick[1],
    axis[2] * pick[0] - axis[0] * pick[2],
    axis[0] * pick[1] - axis[1] * pick[0],
  ];
  return unit(u);
}

function ringPoints(at: Vec3, axis: Vec3, radius: number, n: number): Vec3[] {
  const u = perpendicular(axis);
  const v: Vec3 = [
    axis[1] * u[2] - axis[2] * u[1],
    axis[2] * u[0] - axis[0] * u[2],
    axis[0] * u[1] - axis[1] * u[0],
  ];
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    return [
      at[0] + radius * (u[0] * Math.cos(a) + v[0] * Math.sin(a)),
      at[1] + radius * (u[1] * Math.cos(a) + v[1] * Math.sin(a)),
      at[2] + radius * (u[2] * Math.cos(a) + v[2] * Math.sin(a)),
    ] as Vec3;
  });
}

function lineDistance(point: number[], anchorPoint: number[], dir: number[]): number {
  const u = unit(dir);
  const v = [point[0]! - anchorPoint[0]!, point[1]! - anchorPoint[1]!, point[2]! - anchorPoint[2]!];
  const t = dot(v, u);
  return Math.hypot(v[0] - u[0] * t, v[1] - u[1] * t, v[2] - u[2] * t);
}

/** A part axis/cylinder whose line passes near the contact point (world coords). */
function nearbyAxis(part: PartWorld | undefined, atWorld: number[], tolerance: number): { name: string; dir: number[] } | null {
  if (!part) return null;
  let best: { name: string; dir: number[] } | null = null;
  let bestD = tolerance;
  for (const a of part.datums.axes ?? []) {
    const d = lineDistance(atWorld, a.point, a.dir);
    if (d <= bestD) { bestD = d; best = { name: a.name, dir: a.dir }; }
  }
  for (const c of part.datums.cylinders ?? []) {
    const d = lineDistance(atWorld, c.point, c.dir);
    if (d <= bestD) { bestD = d; best = { name: c.name, dir: c.dir }; }
  }
  return best;
}

/** Ring on the OD (solid) or the bore wall (hollow); a centre sphere would miss both. */
function contactRing(
  store: VersionStore,
  version: string | undefined,
  atLocal: Vec3,
  axisLocal: Vec3,
  radiusHint: number,
  dxMm: number,
): { ring: Vec3[]; pointRadius: number; radial: number } {
  const mesh = meshFor(store, version);
  let radial = radiusHint;
  if (mesh) {
    if (insideMesh(atLocal, mesh)) {
      radial = radiusHint;
    } else {
      const range = radialRange(mesh, atLocal, axisLocal, Math.max(2, 2 * dxMm));
      if (Number.isFinite(range.min)) {
        const wall = firstWallThickness(mesh, atLocal, axisLocal, Math.max(2, 2 * dxMm));
        // Two different blocks, in order:
        //   1. wall below the structural policy -> a DESIGN decision (designException);
        //   2. wall above policy but below 2 voxels -> a RESOLUTION limit (finer dx/submodel).
        // The handwheel's 0.8 mm hub at dx=2 hit both; the design block wins.
        if (Number.isFinite(wall) && wall < MIN_LOAD_BEARING_WALL_MM) {
          throw new ThinWallError({
            kind: 'design',
            wallMm: wall,
            requiredMm: MIN_LOAD_BEARING_WALL_MM,
            atMm: atLocal,
            featureId: `${version ?? 'version'}:support-ring`,
          });
        }
        if (Number.isFinite(wall) && wall < 2 * dxMm) {
          throw new ThinWallError({
            kind: 'resolution',
            wallMm: wall,
            requiredMm: 2 * dxMm,
            atMm: atLocal,
            featureId: `${version ?? 'version'}:support-ring`,
          });
        }
        radial = Math.min(radiusHint, range.min + 0.5);
      }
    }
  }
  radial = Math.max(1.5, radial);
  return {
    ring: ringPoints(atLocal, axisLocal, radial, 6),
    pointRadius: Math.max(1.5, Math.min(3, radial * 0.3)),
    radial,
  };
}

function localToWorld(point: Vec3, transform: ReturnType<typeof flattenParts>[number]['transform']): Vec3 {
  if (!transform) return point;
  const rot = transform.rotate as [number, number, number] | undefined;
  const tr = transform.translate as [number, number, number] | undefined;
  return translateVec(rotateVec(point, rot), tr);
}

function worldDirToLocal(dir: Vec3, transform: ReturnType<typeof flattenParts>[number]['transform']): Vec3 {
  if (!transform?.rotate) return dir;
  const M = eulerMatrix(transform.rotate as [number, number, number]);
  return [
    M[0]![0]! * dir[0] + M[1]![0]! * dir[1] + M[2]![0]! * dir[2],
    M[0]![1]! * dir[0] + M[1]![1]! * dir[1] + M[2]![1]! * dir[2],
    M[0]![2]! * dir[0] + M[1]![2]! * dir[1] + M[2]![2]! * dir[2],
  ];
}

/** Local bbox transformed by the node's rotate/translate (pose is ignored here: ground ranking only). */
function worldBbox(store: VersionStore, flat: ReturnType<typeof flattenParts>[number]): { min: number[]; max: number[] } | null {
  const bb = localBbox(store, flat.node.version);
  if (!bb) return null;
  const rot = flat.transform?.rotate as [number, number, number] | undefined;
  const tr = flat.transform?.translate as [number, number, number] | undefined;
  const corners: Vec3[] = [];
  for (const x of [bb.min[0]!, bb.max[0]!]) {
    for (const y of [bb.min[1]!, bb.max[1]!]) {
      for (const z of [bb.min[2]!, bb.max[2]!]) {
        corners.push(translateVec(rotateVec([x, y, z], rot), tr));
      }
    }
  }
  return {
    min: [0, 1, 2].map((i) => Math.min(...corners.map((c) => c[i]!))),
    max: [0, 1, 2].map((i) => Math.max(...corners.map((c) => c[i]!))),
  };
}

function intersectionCentroid(
  a: { min: number[]; max: number[] },
  b: { min: number[]; max: number[] },
): Vec3 | null {
  const min = [0, 1, 2].map((i) => Math.max(a.min[i]!, b.min[i]!));
  const max = [0, 1, 2].map((i) => Math.min(a.max[i]!, b.max[i]!));
  if (max.some((v, i) => v <= min[i]!)) return null;
  return [(min[0]! + max[0]!) / 2, (min[1]! + max[1]!) / 2, (min[2]! + max[2]!) / 2];
}

function projectInterval(bb: { min: number[]; max: number[] }, axis: Vec3): [number, number] {
  const values: number[] = [];
  for (const x of [bb.min[0]!, bb.max[0]!]) {
    for (const y of [bb.min[1]!, bb.max[1]!]) {
      for (const z of [bb.min[2]!, bb.max[2]!]) values.push(x * axis[0] + y * axis[1] + z * axis[2]);
    }
  }
  return [Math.min(...values), Math.max(...values)];
}

export async function deriveAssemblySupports(store: VersionStore, opts: DeriveSupportsOptions): Promise<DerivedSupports> {
  const resolved = await resolveAssemblyManifestPath(undefined, {
    workspace: opts.workspace,
    dataRoot: opts.dataRoot,
  });
  if (!existsSync(resolved.path)) {
    throw new Error(`no assembly manifest at ${resolved.path} — cannot derive supports (pass supports explicitly)`);
  }
  const manifest = await loadAssemblyManifest(resolved.path);
  const flats = flattenParts(manifest.root);
  const flatById = new Map(flats.map((f) => [f.id, f]));
  const candidates = flats.filter((f) => f.node.kind === 'part' && f.node.version === opts.versionId);
  if (candidates.length === 0) {
    throw new Error(
      `version ${opts.versionId} is not placed in ${resolved.path} — cannot derive supports; ` +
      'pass supports explicitly or declare the part in the assembly',
    );
  }
  const target = opts.partId
    ? candidates.find((c) => c.id === opts.partId)
    : candidates.length === 1
      ? candidates[0]
      : undefined;
  if (!target) {
    throw new Error(
      `${opts.versionId} appears ${candidates.length} times in the assembly (${candidates.map((c) => c.id).join(', ')}); ` +
      'pass `part` to name the instance',
    );
  }

  const parts = new Map<string, PartWorld>();
  for (const flat of flats) {
    if (flat.node.source === 'stock' && !flat.node.version) continue;
    try {
      parts.set(flat.id, await loadPartWorld(store, flat.node));
    } catch {
      // An unloadable part only removes a possible endpoint; the target's own
      // interfaces are still resolved and a real failure is reported below.
    }
  }

  const { adj, degree } = structuralGraph(manifest.root);
  const owned = allInterfaces(manifest.root);
  const relevant = owned.filter(({ iface }) => partOf(iface.a) === target.id || partOf(iface.b) === target.id);
  const interfacesSeen = relevant.map(({ iface }) => `${iface.id}:${iface.type}:${iface.a}<->${iface.b}`);

  // Ground: lowest WORLD bbox z; ties go to the larger bbox volume.
  let groundId: string | null = null;
  let groundZ = Number.POSITIVE_INFINITY;
  let groundVol = -1;
  for (const flat of flats) {
    if (flat.node.kind !== 'part') continue;
    const bb = worldBbox(store, flat);
    if (!bb) continue;
    const vol = (bb.max[0]! - bb.min[0]!) * (bb.max[1]! - bb.min[1]!) * (bb.max[2]! - bb.min[2]!);
    if (bb.min[2]! < groundZ - 1e-6 || (Math.abs(bb.min[2]! - groundZ) <= 1e-6 && vol > groundVol)) {
      groundId = flat.id;
      groundZ = bb.min[2]!;
      groundVol = vol;
    }
  }
  if (target.id === groundId) {
    throw new Error(
      `${target.id} (${opts.versionId}) is the assembly's ground (lowest world bbox z); ` +
      'there is no holder above it. Pass a ground/face support explicitly, or scan a held part.',
    );
  }

  const rank = (iface: ManifestInterface): number => {
    // The manifest type union is narrower than what real contracts use (固定副 /
    // 销孔 are accepted by the JSON validator but absent from InterfaceType).
    const type = iface.type as string;
    if (type === '转动副') return 0;
    if (type === '固定副') return 1;
    if (type === '销孔') return 2;
    if (type === '贴合') return 3;
    return 9;
  };

  // A holder is a structural neighbor that remains connected to ground when the
  // target is removed. Rank by ground distance first (a bearing is closer to the
  // base than the spool stack), then by joint type.
  const ranked = relevant
    .filter(({ iface }) => STRUCTURAL.has(iface.type as string))
    .map(({ ownerPath, iface }) => {
      const other = otherOf(iface, target.id);
      const d = groundId ? groundDistance(adj, other, target.id, groundId) : 0;
      return { ownerPath, iface, other, d, held: groundId !== null && connectedWithout(adj, other, target.id, groundId) };
    })
    .filter((x) => x.other !== target.id && x.held)
    .sort((a, b) => a.d - b.d || rank(a.iface) - rank(b.iface) || a.iface.id.localeCompare(b.iface.id));
  // A revolute/fixed/pin joint outranks a contact seat. Only if the part has no
  // such joint (a handwheel sitting on a D tenon is 贴合 + 同轴) do we use 贴合.
  const loadBearing = ranked.filter((x) => (x.iface.type as string) !== '贴合');
  const pool = loadBearing.length > 0 ? loadBearing : ranked;
  const bestDistance = pool[0]?.d ?? 0;
  const holders = pool.filter((x) => x.d <= bestDistance);

  const warnings: string[] = [];
  const supports: DerivedSupport[] = [];
  for (const { ownerPath, iface, other } of holders) {
    const owner = findNode(manifest.root, ownerPath[ownerPath.length - 1]!);
    if (!owner) {
      warnings.push(`${iface.id}: owner node not found`);
      continue;
    }
    const A = resolveEndpoint(parts, owner, iface.a);
    const B = resolveEndpoint(parts, owner, iface.b);
    if ('error' in A || 'error' in B) {
      warnings.push(`${iface.id}: ${'error' in A ? A.error : (B as { error: string }).error}`);
      continue;
    }
    const fa = featureOf(A.feature);
    const fb = featureOf(B.feature);
    const pA = fa.point as Vec3 | undefined;
    const pB = fb.point as Vec3 | undefined;
    if (!pA && !pB) {
      warnings.push(`${iface.id}: neither endpoint resolved to a point`);
      continue;
    }
    // A plane's normal is NOT a joint axis. For a 贴合 face contact the support is
    // a 3-D overlap centroid; only a true axis/cylinder `dir` (or, for a revolute/
    // fixed joint, the two endpoint points) defines an axis.
    const dirRaw = fa.dir ?? fb.dir;
    const delta = [(pB?.[0] ?? 0) - (pA?.[0] ?? 0), (pB?.[1] ?? 0) - (pA?.[1] ?? 0), (pB?.[2] ?? 0) - (pA?.[2] ?? 0)];
    const allowDelta = (iface.type as string) !== '贴合';
    const axisLen = dirRaw
      ? Math.hypot(dirRaw[0]!, dirRaw[1]!, dirRaw[2]!)
      : allowDelta ? Math.hypot(delta[0]!, delta[1]!, delta[2]!) : 0;
    const hasAxis = axisLen > 1e-6;
    const axis = hasAxis ? unit(dirRaw ?? delta) : ([0, 0, 1] as Vec3);
    const basePoint = (pA ?? pB)!;

    // The seat is the overlap of the two parts along the joint axis, not the datum
    // anchor: base_top's anchor is at the origin while its bore is at z=38–54.
    const targetFlat = flatById.get(target.id);
    const otherFlat = flatById.get(other);
    let at: Vec3 | null = null;
    const bbTarget = targetFlat ? worldBbox(store, targetFlat) : null;
    const bbOther = otherFlat ? worldBbox(store, otherFlat) : null;
    if (!hasAxis) {
      // A plane/face contact (wall base, handwheel hub face): the support is the
      // 3-D overlap centroid. Using the other part's datum point put the wall
      // support at the assembly centre (x=0), 77 mm outside the wall.
      at = (bbTarget && bbOther ? intersectionCentroid(bbTarget, bbOther) : null);
    } else if (bbTarget && bbOther) {
      const [a0, a1] = projectInterval(bbTarget, axis);
      const [b0, b1] = projectInterval(bbOther, axis);
      const lo = Math.max(a0, b0);
      const hi = Math.min(a1, b1);
      // A small overlap is a seat (base_top's 20 mm bore, a spool's 18 mm hub).
      // A large overlap means the other part is a frame spanning the whole axis
      // (base_mid's crank opening), where the bbox midpoint is not a bearing;
      // there the interface datum point is the seat.
      if (hi > lo && hi - lo <= 4 * opts.radiusHintMm) {
        const mid = (lo + hi) / 2;
        const t = mid - dot(basePoint, axis);
        at = [basePoint[0] + axis[0] * t, basePoint[1] + axis[1] * t, basePoint[2] + axis[2] * t];
      }
    }
    if (!at && pA && pB) {
      at = [(pA[0] + pB[0]) / 2, (pA[1] + pB[1]) / 2, (pA[2] + pB[2]) / 2];
    }
    if (!at) {
      warnings.push(`${iface.id}: no overlap or point to place a support`);
      continue;
    }
    const atLocal = worldToLocal(at, targetFlat?.transform) as Vec3;
    if (!hasAxis) {
      // A 贴合 seat (handwheel hub back face, wall base) has no joint axis. If the
      // part (or its mate) carries an axis/cylinder datum through the contact, use
      // it: the handwheel's 手轮轴 lets us ring the bore wall instead of clamping a
      // solid 7.7 mm sphere over the hub, whose patch edge read 757 MPa (an
      // artefact, but an alarming one).
      const near = nearbyAxis(parts.get(target.id), at, Math.max(2, opts.radiusHintMm))
        ?? nearbyAxis(parts.get(other), at, Math.max(2, opts.radiusHintMm));
      if (near) {
        const axisLocal = worldDirToLocal(unit(near.dir), targetFlat?.transform) as Vec3;
        const { ring, pointRadius } = contactRing(store, target.node.version, atLocal, axisLocal, opts.radiusHintMm, opts.dxMm);
        for (const p of ring) {
          if (supports.some((s) => distance(s.atMm, p) < pointRadius * 0.8)) continue;
          supports.push({
            atMm: p.map((v) => +v.toFixed(3)),
            atWorldMm: localToWorld(p, targetFlat?.transform).map((v) => +v.toFixed(3)),
            radiusMm: +pointRadius.toFixed(2),
            source: `${iface.id} ${iface.type} → ${other} (axis ${near.name})`,
            interfaceId: iface.id,
            neighbor: other,
            neighborDegree: degree.get(other) ?? 0,
          });
          if (supports.length >= 12) break;
        }
        continue;
      }
      // No axis through the seat: one patch of the local contact radius is the
      // honest model (a broad wall base is the case this is for).
      const patchRadius = Math.max(2, Math.min(8, opts.radiusHintMm));
      if (!supports.some((s) => distance(s.atMm, atLocal) < patchRadius * 0.8)) {
        supports.push({
          atMm: atLocal.map((v) => +v.toFixed(3)),
          atWorldMm: at.map((v) => +v.toFixed(3)),
          radiusMm: +patchRadius.toFixed(2),
          source: `${iface.id} ${iface.type} → ${other} (contact patch)`,
          interfaceId: iface.id,
          neighbor: other,
          neighborDegree: degree.get(other) ?? 0,
        });
      }
      continue;
    }
    const axisLocal = worldDirToLocal(axis, targetFlat?.transform) as Vec3;
    const { ring, pointRadius } = contactRing(store, target.node.version, atLocal, axisLocal, opts.radiusHintMm, opts.dxMm);
    for (const p of ring) {
      if (supports.some((s) => distance(s.atMm, p) < pointRadius * 0.8)) continue;
      supports.push({
        atMm: p.map((v) => +v.toFixed(3)),
        atWorldMm: localToWorld(p, targetFlat?.transform).map((v) => +v.toFixed(3)),
        radiusMm: +pointRadius.toFixed(2),
        source: `${iface.id} ${iface.type} → ${other} (ground d=${groundDistance(adj, other, target.id, groundId ?? '')})`,
        interfaceId: iface.id,
        neighbor: other,
        neighborDegree: degree.get(other) ?? 0,
      });
      if (supports.length >= 12) break;
    }
    if (supports.length >= 12) break;
  }

  if (supports.length === 0) {
    const why = relevant.length === 0
      ? 'it has no interface in the assembly'
      : `no joint keeps its neighbor connected to ground ${groundId ?? '?'} when the part is removed; ` +
        `its interfaces are ${interfacesSeen.join('; ')}`;
    throw new Error(
      `cannot derive supports for ${target.id} (${opts.versionId}, ground ${groundId ?? '?'}): ${why}. ` +
      'Pass supports explicitly (e.g. the bearing seat datum) or add a structural joint to the assembly.',
    );
  }
  return {
    partId: target.id,
    supports,
    warnings,
    manifestPath: resolved.path,
    interfacesSeen,
    groundId,
  };
}
