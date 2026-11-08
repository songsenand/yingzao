// Assembly manifest L0 checks (v1): executable interface contracts + adjacency
// discovery. See docs/archive/ASSEMBLY-SCHEMA-PROPOSAL.md.
//
// - contract checks resolve interface endpoints ("childId.datumName") to world
//   datum features of the two referenced part versions, then run one operator:
//     distance        — point↔point distance vs tolerance interval
//     diameter-match  — hole cylinder vs shaft cylinder: measured clearance
//                       Ø = 2·(rHole − rShaft) vs tolerance interval
// - verdicts follow the adjudicated two-channel semantics: outside tolerance on
//   severity=hard → 'hard-violation' (fails the report); severity=intent →
//   'intent-flag' (for human adjudication)
// - adjacency discovery: geometrically near/interfering part pairs with no
//   interface entry anywhere in the manifest are reported as undeclared
//
// mm / z-up. Datums are part-local; transforms are applied here (rotate about
// X then Y then Z in degrees, matching Manifold rotate, then translate).

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { compileStlOnly, type DatumSet } from './compile.ts';
import { buildSolid, pairMinDistance, type PartTransform } from './assembly.ts';
import { ensurePythonWorker, workerScratchDir } from './python-worker.ts';
import {
  loadAssemblyManifest, flattenParts, allInterfaces, findNode,
  type AssemblyManifest, type ManifestNode, type ManifestInterface, type OwnedInterface,
} from './manifest.ts';
import type { VersionStore } from './version.ts';
import { listVersions, readVersionDatums } from './version.ts';
import { newestVersionPerPart, supersededVersionIds } from './latest.ts';
import type { RunEntry } from './runs.ts';

type Vec3 = [number, number, number];

const RAD = Math.PI / 180;

/** Rotate a vector about X, then Y, then Z (degrees) — Manifold rotate order. */
export function rotateVec(v: Vec3, rot: [number, number, number] | undefined): Vec3 {
  if (!rot) return v;
  let [x, y, z] = v;
  const [rx, ry, rz] = rot.map((d) => d * RAD) as typeof rot;
  // X
  const y1 = y * Math.cos(rx) - z * Math.sin(rx);
  const z1 = y * Math.sin(rx) + z * Math.cos(rx);
  y = y1; z = z1;
  // Y
  const x2 = x * Math.cos(ry) + z * Math.sin(ry);
  const z2 = -x * Math.sin(ry) + z * Math.cos(ry);
  x = x2; z = z2;
  // Z
  const x3 = x * Math.cos(rz) - y * Math.sin(rz);
  const y3 = x * Math.sin(rz) + y * Math.cos(rz);
  x = x3; y = y3;
  return [x, y, z];
}

export function translateVec(v: Vec3, t: Vec3 | undefined): Vec3 {
  return t ? [v[0] + t[0], v[1] + t[1], v[2] + t[2]] : v;
}

// ---------- affine helpers (for manifest `pose`: rotate about a datum axis) ----------

export type Mat3 = readonly [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]];
interface Affine { m: Mat3; t: Vec3 }
const IDENTITY: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const mv = (m: Mat3, v: Vec3): Vec3 => [
  m[0]![0]! * v[0] + m[0]![1]! * v[1] + m[0]![2]! * v[2],
  m[1]![0]! * v[0] + m[1]![1]! * v[1] + m[1]![2]! * v[2],
  m[2]![0]! * v[0] + m[2]![1]! * v[1] + m[2]![2]! * v[2],
];
const mm = (a: Mat3, b: Mat3): Mat3 => [0, 1, 2].map((r) =>
  [0, 1, 2].map((c) =>
    a[r]![0]! * b[0]![c]! + a[r]![1]! * b[1]![c]! + a[r]![2]! * b[2]![c]!,
  ) as unknown as readonly [number, number, number],
) as unknown as Mat3;

/** Rotation matrix about an arbitrary axis (unit dir) through point p0, by degrees. */
export function axisAngleAffine(p0: Vec3, dir: Vec3, angleDeg: number): Affine {
  const len = Math.hypot(...dir) || 1;
  const [ux, uy, uz] = dir.map((d) => d / len);
  const th = angleDeg * RAD;
  const c = Math.cos(th), s = Math.sin(th), C = 1 - c;
  const R: Mat3 = [
    [c + ux * ux * C, ux * uy * C - uz * s, ux * uz * C + uy * s],
    [uy * ux * C + uz * s, c + uy * uy * C, uy * uz * C - ux * s],
    [uz * ux * C - uy * s, uz * uy * C + ux * s, c + uz * uz * C],
  ];
  const Rp0 = mv(R, p0);
  return { m: R, t: [p0[0] - Rp0[0], p0[1] - Rp0[1], p0[2] - Rp0[2]] };
}

/** world = a ∘ b (apply b first): p → a.m·(b.m·p + b.t) + a.t. */
const composeAffine = (a: Affine, b: Affine): Affine => ({
  m: mm(a.m, b.m),
  t: mv(a.m, b.t).map((v, i) => v + a.t[i]!) as Vec3,
});

const applyAffine = (a: Affine, p: Vec3): Vec3 => mv(a.m, p).map((v, i) => v + a.t[i]!) as Vec3;

/** Euler XYZ degrees → matrix (same convention as rotateVec). */
export function eulerMatrix(rot: [number, number, number]): Mat3 {
  // Build COLUMN-major: column c of the matrix is the image of basis vector c,
  // so (M·v)[r] = Σ_c v[c]·(R·e_c)[r] = rotateVec(v)[r] — one definition of the
  // rotation convention in this file.
  const cols = [
    rotateVec([1, 0, 0], rot),
    rotateVec([0, 1, 0], rot),
    rotateVec([0, 0, 1], rot),
  ];
  return [0, 1, 2].map((r) =>
    [0, 1, 2].map((c) => cols[c]![r]!),
  ) as unknown as Mat3;
}

interface PartWorld {
  id: string;
  node: ManifestNode;
  built: Awaited<ReturnType<typeof buildSolid>> | null;
  datums: DatumSet;      // transformed to world
  warnings: string[];
  /**
   * How the WORKER can build this same placed solid: an STL path plus the exact
   * transform `buildSolid` was given (`matrix` already encodes rotate∘pose). Null
   * when the part never became a solid, which is also when the adjacency half must
   * skip it. `scratch` names a temporary file to delete once the request is done —
   * a version whose STL had to be rebuilt from model.scad has no bytes on disk.
   */
  workerMesh: { path: string; transform: PartTransform; scratch?: string } | null;
}

async function loadPartWorld(store: VersionStore, node: ManifestNode): Promise<PartWorld> {
  const warnings: string[] = [];
  const dir = join(store.root, 'versions', node.version ?? '');
  let stl: Uint8Array | null = null;
  try {
    stl = await readFile(join(dir, 'model.stl'));
  } catch {
    const scad = await readFile(join(dir, 'model.scad'), 'utf8').catch(() => null);
    if (scad) {
      const c = await compileStlOnly(scad);
      if (c.success && c.stl) { stl = c.stl; warnings.push('STL rebuilt from model.scad (was missing)'); }
      else warnings.push(`STL rebuild failed: ${c.errors.join('; ')}`);
    } else {
      warnings.push('version has no model.stl and no model.scad');
    }
  }

  let built: PartWorld['built'] = null;
  let workerMesh: PartWorld['workerMesh'] = null;
  if (stl) {
    try {
      // world = translate ∘ rotate ∘ pose; the pose (rotate about a datum axis)
      // reaches the mesh as a leading 3×3, never folded through Euler angles.
      const geo = await partWorldAffine(store, node);
      if (geo.poseError) warnings.push(geo.poseError);
      // matrix already encodes rotate∘pose — never pass both.
      const transform: PartTransform = {
        ...(geo.matrix
          ? { matrix: geo.matrix }
          : { ...(node.transform?.rotate ? { rotate: node.transform.rotate } : {}) }),
        ...(node.transform?.translate ? { translate: node.transform.translate } : {}),
      };
      built = await buildSolid(stl, transform);
      const onDisk = join(dir, 'model.stl');
      const fromDisk = stl === await readFile(onDisk).catch(() => null);
      if (fromDisk) {
        workerMesh = { path: onDisk, transform };
      } else {
        // Rebuilt from model.scad: the bytes exist only in memory, so they get a file
        // the worker can read (the same path-not-pipe rule validate_assembly follows).
        const scratch = join(await workerScratchDir(), `check-${randomUUID()}.stl`);
        await writeFile(scratch, stl);
        workerMesh = { path: scratch, transform, scratch };
      }
    } catch (e) {
      warnings.push(`solid build failed: ${(e as Error).message}`);
      workerMesh = null;
    }
  }

  const raw = await readVersionDatums(store, node.version ?? '');
  const full = await partWorldAffine(store, node);
  if (full.poseError) warnings.push(full.poseError);
  const transformPoint = (p: Vec3): Vec3 => applyAffine(full.affine, p);
  const transformDir = (d: Vec3): Vec3 => mv(full.affine.m, d);
  const datums: DatumSet = {
    points: raw.points.map((d) => ({ name: d.name, point: transformPoint(d.point) })),
    axes: raw.axes.map((d) => ({ name: d.name, point: transformPoint(d.point), dir: transformDir(d.dir) })),
    planes: raw.planes.map((d) => ({ name: d.name, point: transformPoint(d.point), normal: transformDir(d.normal) })),
    cylinders: raw.cylinders.map((d) => ({ name: d.name, point: transformPoint(d.point), dir: transformDir(d.dir), radius: d.radius })),
  };
  return { id: node.id, node, built, datums, warnings, workerMesh };
}

/**
 * Local→world affine for a manifest node: translate ∘ rotate(euler) ∘ pose.
 * The pose axis is anchored at the named datum (resolved from the version's
 * datums.json); a pose that names nothing resolvable is reported as a warning
 * and skipped — the check proceeds on the unposed geometry rather than dying.
 */
async function partWorldAffine(
  store: VersionStore,
  node: ManifestNode,
): Promise<{ affine: Affine; matrix: Mat3 | null; poseError?: string }> {
  const tr = node.transform?.translate;
  const rot = node.transform?.rotate;
  const pose = node.transform?.pose;
  const noPose = (): { affine: Affine; matrix: Mat3 | null } => {
    const rotA: Affine = { m: rot ? eulerMatrix(rot) : IDENTITY, t: [0, 0, 0] };
    const trA: Affine = { m: IDENTITY, t: tr ? [...tr] as Vec3 : [0, 0, 0] };
    return { affine: composeAffine(trA, rotA), matrix: null };
  };
  if (!pose || typeof pose.angleDeg !== 'number' || pose.angleDeg === 0) return noPose();
  const raw = await readVersionDatums(store, node.version ?? '');
  let anchor: Vec3 | null = null;
  let dir = pose.axis ?? null;
  for (const d of raw.axes) if (d.name === pose.datum) { anchor = d.point; dir = d.dir; }
  for (const d of raw.cylinders) if (d.name === pose.datum) { anchor = d.point; dir = d.dir; }
  for (const d of raw.planes) if (d.name === pose.datum) { anchor = d.point; dir = d.normal; }
  for (const d of raw.points) if (d.name === pose.datum) anchor = d.point;
  if (!anchor || !dir) {
    return { ...noPose(), poseError: `pose datum "${pose.datum ?? '?'}" not found in version ${node.version ?? '?'}` };
  }
  const poseA = axisAngleAffine(anchor, dir, pose.angleDeg);
  const rotM = rot ? eulerMatrix(rot) : IDENTITY;
  const rotA: Affine = { m: rotM, t: [0, 0, 0] };
  const trA: Affine = { m: IDENTITY, t: tr ? [...tr] as Vec3 : [0, 0, 0] };
  return {
    // world = translate ∘ rotate ∘ pose
    affine: composeAffine(composeAffine(trA, rotA), poseA),
    // buildSolidFromStl applies `matrix` first, then euler rotate, then
    // translate — so the matrix carries rotate∘pose and rotate stays absent.
    matrix: mm(rotM, poseA.m),
  };
}

/** Resolve "childId.datumName" on an owning assembly node to a world feature. */
function resolveEndpoint(
  parts: Map<string, PartWorld>,
  owner: ManifestNode,
  address: string,
): { part: PartWorld; kind: string; feature: unknown } | { error: string } {
  const dot = address.indexOf('.');
  if (dot <= 0) return { error: `malformed address "${address}" (expected "<childId>.<datumName>")` };
  const childId = address.slice(0, dot);
  const datumName = address.slice(dot + 1);
  const child = owner.children?.find((c) => c.id === childId);
  if (!child) return { error: `address "${address}": "${childId}" is not a direct child of "${owner.id}"` };
  const part = parts.get(child.id);
  if (!part) return { error: `address "${address}": part not loaded` };
  const kind = child.datums?.find((d) => d.name === datumName)?.kind
    ?? (part.datums.points.some((p) => p.name === datumName) ? 'point'
      : part.datums.axes.some((p) => p.name === datumName) ? 'axis'
      : part.datums.planes.some((p) => p.name === datumName) ? 'plane'
      : part.datums.cylinders.some((p) => p.name === datumName) ? 'cylinder' : 'unknown');
  const point = part.datums.points.find((p) => p.name === datumName)?.point
    ?? part.datums.axes.find((p) => p.name === datumName)?.point
    ?? part.datums.planes.find((p) => p.name === datumName)?.point
    ?? part.datums.cylinders.find((p) => p.name === datumName)?.point;
  if (!point) return { error: `address "${address}": datum "${datumName}" not found in version ${child.version ?? '?'}` };
  const axis = part.datums.axes.find((p) => p.name === datumName)
    ?? part.datums.cylinders.find((p) => p.name === datumName);
  const plane = part.datums.planes.find((p) => p.name === datumName);
  const cyl = part.datums.cylinders.find((p) => p.name === datumName);
  return { part, kind, feature: { point, dir: axis?.dir, normal: plane?.normal, radius: cyl?.radius } };
}

function pointOf(feature: unknown): Vec3 {
  return (feature as { point: Vec3 }).point;
}

/**
 * Distance between two resolved datums, honoring the FEATURE KIND.
 *
 * A plane datum's meaning is the plane, not its anchor point: two coplanar
 * planes whose anchors are laterally offset would report that offset as a gap
 * if this stayed point-to-point. `resolveEndpoint` already carries `normal` for
 * planes; use it instead of throwing the direction away.
 *
 *   plane/plane  → perpendicular distance (parallel); an angled pair reports the
 *                  same point-to-plane number but names the angle so a wedge
 *                  cannot hide behind a small gap
 *   plane/point  → point-to-plane
 *   anything else → point-to-point (the pre-existing semantics)
 */
export function datumDistance(aFeature: unknown, bFeature: unknown): { measured: number; detail: string } {
  const pa = pointOf(aFeature);
  const pb = pointOf(bFeature);
  const sub = (u: Vec3, v: Vec3): Vec3 => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
  const dot = (u: Vec3, v: Vec3): number => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const len = (u: Vec3): number => Math.hypot(u[0], u[1], u[2]) || 1;
  const unit = (u: Vec3): Vec3 => [u[0] / len(u), u[1] / len(u), u[2] / len(u)];
  const na = (aFeature as { normal?: Vec3 }).normal;
  const nb = (bFeature as { normal?: Vec3 }).normal;
  if (na && nb) {
    const ua = unit(na);
    const ub = unit(nb);
    // Anti-parallel normals describe the SAME plane orientation (0°, not 180°).
    const angle = Math.acos(Math.max(-1, Math.min(1, Math.abs(dot(ua, ub))))) * 180 / Math.PI;
    const measured = +Math.abs(dot(sub(pb, pa), ua)).toFixed(4);
    if (angle <= 1.0) {
      return { measured, detail: `plane-to-plane distance ${measured}mm (normals ${angle.toFixed(3)}° apart)` };
    }
    return {
      measured,
      detail: `point-to-plane distance ${measured}mm (planes ${angle.toFixed(3)}° apart — NOT parallel)`,
    };
  }
  if (na) {
    const measured = +Math.abs(dot(sub(pb, pa), unit(na))).toFixed(4);
    return { measured, detail: `point-to-plane distance ${measured}mm` };
  }
  if (nb) {
    const measured = +Math.abs(dot(sub(pa, pb), unit(nb))).toFixed(4);
    return { measured, detail: `point-to-plane distance ${measured}mm` };
  }
  return {
    measured: +Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]).toFixed(4),
    detail: 'point-to-point distance between declared datums',
  };
}

export interface InterfaceCheckResult {
  interfaceId: string;
  ownerPath: string[];
  a: string;
  b: string;
  type: ManifestInterface['type'];
  severity: ManifestInterface['severity'];
  layer: 'L0' | 'L1' | 'L2';
  check: string;
  verdict: 'pass' | 'hard-violation' | 'intent-flag' | 'skipped';
  /**
   * The REQUIREMENT this result was judged against, echoed from the manifest.
   * An ICD row without its requirement is a measurement, not a check: the panel
   * used to render a 要求 column from a field nobody populated, so every row
   * said "—" (r055: 0/25 had it).
   */
  expected?: { quantity: string; nominal?: number; min?: number; max?: number };
  measured?: number;
  detail: string;
  /** Structured half of `spring-behaviour`; optional so old report readers are untouched. */
  elastic?: ElasticCheckResult;
  /** Structured half of `snap-fit`; optional so old report readers are untouched. */
  snapFit?: SnapFitCheckResult;
}

/** One L2 row: a normalized utilization, not a raw unit. */
export interface SnapFitCheck {
  check: 'insertion' | 'retention' | 'strain' | 'selfLock';
  utilization?: number;
  marginPct?: number;
  verdict: 'ok' | 'near' | 'over' | 'unknown';
  note?: string;
}

/** L1 attention item: only over / near / unknown survive. */
export interface SnapFitAttention {
  check: string;
  verdict: 'over' | 'near' | 'unknown';
  why: string;
  next?: string;
}

/**
 * `snap-fit` facts. The beam model is an UPPER-BOUND estimate, not a contact
 * simulation: a root-fixed cantilever per lobe, load at the bead, no shell
 * curvature, no self-contact, no shoulder shear. All thresholds are USER-DECLARED.
 */
export interface SnapFitCheckResult {
  input: {
    lobeCount: number;
    lobeWidthMm: number;
    lobeThicknessMm: number;
    leverArmMm: number;
    radialInterferenceMm: number;
    youngModulusMPa: number;
    leadAngleDeg?: number;
    frictionCoeff?: number;
    retentionAngleDeg?: number;
  };
  lobeStiffnessNPerMm: number;
  lobeForceN: number;
  radialForceN: number;
  insertionForceN?: number;
  retentionCapacityN?: number;
  rootStrainPct: number;
  selfLocking: boolean;
  checks: SnapFitCheck[];
  worst?: { check: string; utilization: number; marginPct: number };
  attention: SnapFitAttention[];
  nextLook: { atMm: number[]; why: string };
}

/**
 * The facts `spring-behaviour` reports. Thresholds are USER-DECLARED
 * (`forceBudgetN`, `requiredTravelMm`, `tolerance`); the venue reports the
 * comparison and the margin, it does not invent child/adult or product limits.
 */
export interface ElasticCheckResult {
  behavior: string;
  installedLengthMm: number;
  freeLengthMm: number;
  deflectionMm: number;
  stiffnessNPerMm: number;
  forceN: number;
  /** k-tolerance band, when `stiffnessTolerancePct` is declared. */
  forceBandN?: [number, number];
  /** Order-of-magnitude display band, always present (e.g. 18.7 N -> [10, 100]). */
  forceDecadeN: [number, number];
  source: string;
  checks: {
    direction: 'ok' | 'violation' | 'unknown';
    solidHeight: 'ok' | 'violation' | 'unknown';
    travel: 'ok' | 'violation' | 'unknown';
    forceBudget: 'ok' | 'violation' | 'unknown' | 'skipped';
  };
  notes: string[];
}

/** L2 formatter: one compact line per snap-fit check, no raw unit sprawl. */
export function formatSnapFitChecks(s: SnapFitCheckResult): string {
  return s.checks
    .map((c) => `${c.check} ${c.utilization === undefined ? '?' : `${c.utilization}x`}${c.marginPct === undefined ? '' : ` (margin ${c.marginPct}%)`} ${c.verdict}`)
    .join('; ');
}

export interface UndeclaredPair {
  partA: string;
  partB: string;
  minDistance: number;
  intersectionVolume: number;
}

export interface AssemblyCheckReport {
  checkedAt: string;
  manifestPath: string;
  manifestName: string;
  /** Content hash of the manifest that was audited (`manifest@<hash8>`). */
  manifestHash?: string;
  results: InterfaceCheckResult[];
  undeclared: UndeclaredPair[];
  partWarnings: { partId: string; messages: string[] }[];
  /** Gap below which a pair counts as "near" in the undeclared-adjacency pass. */
  adjacencyThresholdMm: number;
  summary: { interfaces: number; pass: number; hardViolations: number; intentFlags: number; skipped: number; undeclared: number };
  overallStatus: 'pass' | 'check' | 'fail';
}

/** The requirement of one interface, in the shape the report/panel read. */
function expectedOf(iface?: {
  nominal?: { quantity: string; value: number };
  tolerance?: { min: number; max: number };
}): InterfaceCheckResult['expected'] {
  if (!iface?.tolerance) return undefined;
  return {
    quantity: iface.nominal?.quantity ?? '',
    ...(iface.nominal?.value !== undefined ? { nominal: iface.nominal.value } : {}),
    min: iface.tolerance.min,
    max: iface.tolerance.max,
  };
}

/** Compare a measured value against the tolerance interval; honour severity. */
function verdictFor(iface: ManifestInterface, measured: number, detail: string): InterfaceCheckResult {
  const tol = iface.tolerance;
  // No tolerance = no criterion = NOT a pass. See the Python twin
  // (_assembly_verdict): the toy-balance manifest declared none and every
  // interface "passed", including two axes 116 mm apart.
  const verdict = !tol
    ? 'skipped'
    : measured >= tol.min && measured <= tol.max
      ? 'pass'
      : iface.severity === 'hard' ? 'hard-violation' : 'intent-flag';
  if (!tol) detail += ' — no tolerance declared: add tolerance {min,max}; a missing criterion is NOT a pass';
  return {
    interfaceId: iface.id,
    // The evaluated branch builds its own object, so the requirement has to ride
    // here too — `base.expected` never reaches a verdict that went through an
    // operator (that was the bug the ICD acceptance caught).
    expected: expectedOf(iface),
    ownerPath: [],
    a: iface.a, b: iface.b,
    type: iface.type, severity: iface.severity,
    layer: iface.layer ?? 'L0',
    check: iface.check ?? 'distance',
    verdict,
    measured,
    detail,
  };
}

const DEFAULT_DERIVED: Record<ManifestInterface['type'], { layer: 'L0' | 'L1' | 'L2'; check: string }> = {
  '贴合': { layer: 'L0', check: 'distance' },
  '间隙': { layer: 'L0', check: 'distance' },
  '紧固': { layer: 'L0', check: 'diameter-match' },
  '转动副': { layer: 'L1', check: 'motion-clearance' },
  '滑动副': { layer: 'L1', check: 'motion-clearance' },
  '弹簧': { layer: 'L1', check: 'spring-behaviour' },
  '卡扣': { layer: 'L1', check: 'snap-fit' },
  '流道': { layer: 'L2', check: 'flow' },
};

/**
 * Operators this engine can actually evaluate.
 *
 * Everything else is reported as `skipped` — deliberately, because a green
 * verdict on a check nobody ran is the most expensive lie a validator can tell
 * (see the note on `motion-clearance` below for what "the check actually ran"
 * has to mean when the claim is about motion).
 */
const IMPLEMENTED_CHECKS = new Set(['distance', 'diameter-match', 'coaxial', 'motion-clearance', 'spring-preload', 'spring-behaviour', 'snap-fit']);

/**
 * Distance between two INFINITE axis lines (skew or parallel), mm. This is the
 * measured quantity of `coaxial`: for parallel axes it is the perpendicular
 * offset, for skewed axes the closest approach. The angle between the axes is
 * reported in the detail so a tilted bore cannot hide behind a small offset.
 */
export function axisLineDistance(p1: Vec3, d1: Vec3, p2: Vec3, d2: Vec3): { distance: number; angleDeg: number } {
  const len = (v: Vec3) => Math.hypot(...v) || 1;
  const u1 = d1.map((x) => x / len(d1)) as Vec3;
  const u2 = d2.map((x) => x / len(d2)) as Vec3;
  const w = [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]] as Vec3;
  const a = u1[0] * u1[0] + u1[1] * u1[1] + u1[2] * u1[2];
  const b = u1[0] * u2[0] + u1[1] * u2[1] + u1[2] * u2[2];
  const c = u2[0] * u2[0] + u2[1] * u2[1] + u2[2] * u2[2];
  const d = u1[0] * w[0] + u1[1] * w[1] + u1[2] * w[2];
  const e = u2[0] * w[0] + u2[1] * w[1] + u2[2] * w[2];
  const denom = a * c - b * b;
  let distance: number;
  if (Math.abs(denom) < 1e-9) {
    // parallel: perpendicular component of w
    const along = u1.map((x) => x * d) as Vec3;
    const perp = [w[0] - along[0], w[1] - along[1], w[2] - along[2]] as Vec3;
    distance = Math.hypot(...perp);
  } else {
    const sc = (b * e - c * d) / denom;
    const tc = (a * e - b * d) / denom;
    const p1c = u1.map((x) => x * sc) as Vec3;
    const p2c = u2.map((x) => x * tc) as Vec3;
    const diff = [w[0] + p1c[0] - p2c[0], w[1] + p1c[1] - p2c[1], w[2] + p1c[2] - p2c[2]] as Vec3;
    distance = Math.hypot(...diff);
  }
  const angleDeg = Math.acos(Math.max(-1, Math.min(1, Math.abs(b) / (Math.sqrt(a) * Math.sqrt(c))))) * 180 / Math.PI;
  return { distance, angleDeg };
}

/** First numeric param present, or null. */
function numParam(iface: ManifestInterface, keys: string[]): number | null {
  for (const k of keys) {
    const v = iface.params?.[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

/** JS Math.round-based 4-decimal rounding — the parity contract. */
const round4 = (v: number): number => Math.round(v * 1e4) / 1e4;

/** Read a numeric elastic field from `elastic` first, then the legacy `params` bag. */
function elasticNumber(iface: ManifestInterface, keys: readonly string[]): number | null {
  for (const key of keys) {
    const fromElastic = (iface.elastic as unknown as Record<string, unknown> | undefined)?.[key];
    if (typeof fromElastic === 'number' && Number.isFinite(fromElastic)) return fromElastic;
    const fromParams = iface.params?.[key];
    if (typeof fromParams === 'number' && Number.isFinite(fromParams)) return fromParams;
  }
  return null;
}

/**
 * `spring-behaviour` for an axial spring. Geometry measures the installed length;
 * the declared rate turns deflection into force. Everything the operator cannot
 * know (solid height, travel, force budget, direction) is reported as `unknown`
 * or `skipped` with the missing input named — never guessed, never a silent pass.
 */
function springBehaviour(
  iface: ManifestInterface,
  aFeature: unknown,
  bFeature: unknown,
): { verdict: InterfaceCheckResult['verdict']; measured: number; detail: string; elastic: ElasticCheckResult } {
  const spec = iface.elastic ?? {};
  const behavior = spec.behavior ?? 'axial-spring';
  if (behavior !== 'axial-spring') {
    throw new Error(`elastic behavior "${behavior}" is not implemented at S0 — only axial-spring is`);
  }
  const k = elasticNumber(iface, ['stiffnessNPerMm', 'springRateNPerMm', 'k']);
  const free = elasticNumber(iface, ['freeLengthMm', 'freeLength']);
  if (k === null || free === null) {
    throw new Error('spring-behaviour needs freeLengthMm and stiffnessNPerMm (elastic or params), with a and b being the spring\'s own two ends');
  }
  const pa = pointOf(aFeature);
  const pb = pointOf(bFeature);
  const installed = round4(Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]));
  const deflection = round4(free - installed);
  const force = round4(k * deflection);
  const decade = ((): [number, number] => {
    const magnitude = Math.abs(force);
    if (!(magnitude > 0)) return [0, 0];
    const lo = Math.pow(10, Math.floor(Math.log10(magnitude)));
    return [round4(lo), round4(lo * 10)];
  })();
  const direction = spec.direction ?? null;
  const solid = elasticNumber(iface, ['solidHeightMm']);
  const outerD = elasticNumber(iface, ['outerDiameterMm']);
  const guided = spec.guided === true;
  const budget = elasticNumber(iface, ['forceBudgetN']);
  const requiredTravel = elasticNumber(iface, ['requiredTravelMm']);
  const maxTravel = elasticNumber(iface, ['maxTravelMm']);
  const tol = elasticNumber(iface, ['stiffnessTolerancePct']) ?? 0;
  const source = spec.source ?? 'declared';
  const notes: string[] = [];
  let zeroMargin = false;

  let directionCheck: ElasticCheckResult['checks']['direction'] = 'unknown';
  if (direction) {
    const ok = direction === 'compression' ? deflection >= 0 : deflection <= 0;
    directionCheck = ok ? 'ok' : 'violation';
    notes.push(ok ? `direction ${direction} OK (δ${deflection}mm)` : `direction ${direction} VIOLATED (δ${deflection}mm)`);
  } else {
    notes.push('direction not declared; sign reported but not enforced');
  }

  let solidCheck: ElasticCheckResult['checks']['solidHeight'] = 'unknown';
  if (solid !== null) {
    if (free <= solid) {
      solidCheck = 'violation';
      notes.push(`solidHeight ${solid}mm exceeds freeLength ${free}mm — not a valid spring`);
    } else if (installed <= solid) {
      solidCheck = 'violation';
      notes.push(`installed ${installed}mm is below solidHeight ${solid}mm — coils clash`);
    } else {
      solidCheck = 'ok';
      notes.push(`solidHeight margin ${round4(installed - solid)}mm`);
    }
  } else {
    notes.push('solidHeightMm not declared; coil clash not checked');
  }

  let travelCheck: ElasticCheckResult['checks']['travel'] = 'unknown';
  if (requiredTravel !== null) {
    if (!direction) {
      notes.push(`requiredTravel ${requiredTravel}mm declared but direction omitted; travel not checked`);
    } else {
      let available: number | null = null;
      if (direction === 'compression') {
        if (solid !== null) available = round4(installed - solid);
      } else if (maxTravel !== null) {
        available = round4(maxTravel - (installed - free));
      }
      if (available === null) {
        notes.push(`requiredTravel ${requiredTravel}mm declared but available travel is unknown (need ${direction === 'compression' ? 'solidHeightMm' : 'maxTravelMm'})`);
      } else if (requiredTravel > available) {
        travelCheck = 'violation';
        notes.push(`required travel ${requiredTravel}mm exceeds available ${available}mm`);
      } else {
        travelCheck = 'ok';
        const margin = round4(available - requiredTravel);
        if (margin === 0) zeroMargin = true;
        notes.push(`travel margin ${margin}mm${margin === 0 ? ' (zero margin — difficult)' : ''}`);
      }
    }
  } else {
    notes.push('requiredTravelMm not declared; travel not judged');
  }

  let forceCheck: ElasticCheckResult['checks']['forceBudget'] = 'skipped';
  if (budget !== null) {
    forceCheck = Math.abs(force) <= budget ? 'ok' : 'violation';
    const margin = round4(budget - Math.abs(force));
    if (forceCheck === 'ok' && margin === 0) zeroMargin = true;
    notes.push(forceCheck === 'ok'
      ? `|force| ${Math.abs(force)}N within budget ${budget}N (margin ${margin}N${margin === 0 ? ' — zero margin, difficult' : ''})`
      : `|force| ${Math.abs(force)}N exceeds budget ${budget}N`);
  }
  if (iface.tolerance) {
    const inRange = force >= iface.tolerance.min && force <= iface.tolerance.max;
    if (!inRange) forceCheck = 'violation';
    else if (forceCheck === 'skipped') forceCheck = 'ok';
    if (inRange && (force === iface.tolerance.min || force === iface.tolerance.max)) zeroMargin = true;
    notes.push(`tolerance [${iface.tolerance.min},${iface.tolerance.max}]N ${inRange ? 'satisfied' : 'violated'}`);
  }
  if (budget === null && !iface.tolerance) {
    notes.push('no forceBudgetN/tolerance declared; force is reported, not judged');
  }

  let forceBand: [number, number] | undefined;
  if (tol > 0) {
    const lo = Math.min(k * (1 - tol / 100) * deflection, k * (1 + tol / 100) * deflection);
    const hi = Math.max(k * (1 - tol / 100) * deflection, k * (1 + tol / 100) * deflection);
    forceBand = [round4(lo), round4(hi)];
    notes.push(`force band ${forceBand[0]}–${forceBand[1]}N from k ±${tol}%`);
  } else {
    notes.push('no stiffnessTolerancePct; force is a point from the declared k');
  }

  if (outerD !== null && direction === 'compression') {
    if (guided) {
      notes.push('guided compression spring; slenderness attention suppressed');
    } else {
      const slenderness = round4(free / outerD);
      notes.push(slenderness > 2.6
        ? `slenderness free/D ${slenderness} > 2.6 — buckling ATTENTION (not a hard fail)`
        : `slenderness free/D ${slenderness} within 2.6`);
    }
  }

  const acceptance = budget !== null || iface.tolerance !== undefined || requiredTravel !== null;
  const unknownIntrinsic = directionCheck === 'unknown' || solidCheck === 'unknown';
  const hard = directionCheck === 'violation' || solidCheck === 'violation'
    || (travelCheck === 'violation' && iface.severity === 'hard')
    || (forceCheck === 'violation' && iface.severity === 'hard');
  const intent = (travelCheck === 'violation' || forceCheck === 'violation') && iface.severity !== 'hard';
  let verdict: InterfaceCheckResult['verdict'] = hard ? 'hard-violation' : intent ? 'intent-flag'
    : !acceptance ? 'skipped' : (unknownIntrinsic || zeroMargin) ? 'intent-flag' : 'pass';
  if (verdict === 'skipped') {
    notes.push('intrinsic checks have no acceptance criterion; add forceBudgetN, tolerance, or requiredTravelMm for a verdict');
  } else if (verdict === 'intent-flag' && !intent) {
    if (unknownIntrinsic) notes.push('one or more intrinsic checks are unknown; verdict is an intent flag, not a pass');
    if (zeroMargin) notes.push('zero or at-limit margin; verdict is an intent flag, not a pass');
  }

  const orderText = `order ${decade[0]}–${decade[1]}N`;
  const forceText = forceBand
    ? ` = ${force}N (band ${forceBand[0]}–${forceBand[1]}N; ${orderText})`
    : ` = ${force}N (${orderText})`;
  const detail = `installed ${installed}mm vs free ${free}mm → δ${deflection}mm × ${k}N/mm${forceText}; source ${source}; ${notes.join('; ')}`;
  return {
    verdict,
    measured: force,
    detail,
    elastic: {
      behavior,
      installedLengthMm: installed,
      freeLengthMm: round4(free),
      deflectionMm: deflection,
      stiffnessNPerMm: round4(k),
      forceN: force,
      ...(forceBand ? { forceBandN: forceBand } : {}),
      forceDecadeN: decade,
      source,
      checks: { direction: directionCheck, solidHeight: solidCheck, travel: travelCheck, forceBudget: forceCheck },
      notes,
    },
  };
}

const snapFitVerdict = (u: number): SnapFitCheck['verdict'] => (u > 1 ? 'over' : u >= 0.8 ? 'near' : 'ok');

function snapFit(
  iface: ManifestInterface,
  aFeature: unknown,
  bFeature: unknown,
): { verdict: InterfaceCheckResult['verdict']; measured: number; detail: string; snapFit: SnapFitCheckResult } {
  const spec = iface.elastic ?? {};
  const behavior = spec.behavior ?? 'snap-fit';
  if (behavior !== 'snap-fit') {
    throw new Error(`elastic behavior "${behavior}" is not snap-fit`);
  }
  const lobeCount = elasticNumber(iface, ['lobeCount']);
  const w = elasticNumber(iface, ['lobeWidthMm']);
  const t = elasticNumber(iface, ['lobeThicknessMm']);
  const L = elasticNumber(iface, ['leverArmMm']);
  const delta = elasticNumber(iface, ['radialInterferenceMm']);
  const E = elasticNumber(iface, ['youngModulusMPa']);
  const missing: string[] = [];
  if (lobeCount === null) missing.push('lobeCount');
  if (w === null) missing.push('lobeWidthMm');
  if (t === null) missing.push('lobeThicknessMm');
  if (L === null) missing.push('leverArmMm');
  if (delta === null) missing.push('radialInterferenceMm');
  if (E === null) missing.push('youngModulusMPa');
  if (missing.length > 0) {
    throw new Error(`snap-fit needs ${missing.join(', ')} (elastic); a beam model without the lobe geometry cannot be built`);
  }
  if (!Number.isInteger(lobeCount) || (lobeCount as number) < 1 || (w as number) <= 0 || (t as number) <= 0 || (L as number) <= 0 || (delta as number) < 0 || (E as number) <= 0) {
    throw new Error('snap-fit inputs are not physical: lobeCount must be a positive integer; w/t/L/E > 0; interference >= 0');
  }
  const lead = elasticNumber(iface, ['leadAngleDeg']);
  const mu = elasticNumber(iface, ['frictionCoeff']);
  const retentionAngle = elasticNumber(iface, ['retentionAngleDeg']) ?? lead;
  const budget = elasticNumber(iface, ['forceBudgetN']);
  const maxStrain = elasticNumber(iface, ['maxStrainPct']);
  const retentionLoad = elasticNumber(iface, ['retentionLoadN']);

  const I = ((w as number) * (t as number) ** 3) / 12;
  const kLobe = (3 * (E as number) * I) / (L as number) ** 3;
  const fLobe = kLobe * (delta as number);
  const radial = fLobe * (lobeCount as number);
  const strainPct = (1.5 * (t as number) * (delta as number) / (L as number) ** 2) * 100;

  const wedge = (angle: number | null): number | undefined => {
    if (angle === null || mu === null) return undefined;
    const tanA = Math.tan((angle * Math.PI) / 180);
    const denom = 1 - (mu as number) * tanA;
    if (denom <= 1e-9) return undefined;
    return (tanA + (mu as number)) / denom;
  };
  const insertWedge = wedge(lead);
  const retentionWedge = wedge(retentionAngle);
  const insertion = insertWedge === undefined ? undefined : radial * insertWedge;
  const retentionCapacity = retentionWedge === undefined ? undefined : radial * retentionWedge;
  const selfLockU = lead !== null && mu !== null
    ? (mu as number) * Math.tan((lead * Math.PI) / 180)
    : undefined;
  const selfLocking = selfLockU !== undefined && selfLockU >= 1;

  const checks: SnapFitCheck[] = [];
  const add = (check: SnapFitCheck['check'], util: number | undefined, missingWhy: string) => {
    if (util === undefined) {
      checks.push({ check, verdict: 'unknown', note: missingWhy });
      return;
    }
    const u = round4(util);
    checks.push({ check, utilization: u, marginPct: round4((1 - u) * 100), verdict: snapFitVerdict(u) });
  };
  add('insertion',
    budget !== null && insertion !== undefined ? insertion / (budget as number) : undefined,
    budget === null ? 'no forceBudgetN declared' : insertion === undefined ? 'declare leadAngleDeg + frictionCoeff (insertion is not the radial force)' : '');
  add('retention',
    retentionLoad !== null && retentionCapacity !== undefined ? (retentionLoad as number) / retentionCapacity : undefined,
    retentionLoad === null ? 'no retentionLoadN declared' : retentionCapacity === undefined ? 'declare retentionAngleDeg (or leadAngleDeg) + frictionCoeff' : '');
  add('strain',
    maxStrain !== null ? strainPct / (maxStrain as number) : undefined,
    maxStrain === null ? 'no maxStrainPct declared' : '');
  add('selfLock',
    selfLockU,
    selfLockU === undefined ? 'declare leadAngleDeg + frictionCoeff' : '');

  const numeric = checks.filter((c) => c.utilization !== undefined) as (SnapFitCheck & { utilization: number; marginPct: number })[];
  const worst = numeric.length > 0
    ? numeric.reduce((a, b) => (b.utilization > a.utilization ? b : a))
    : undefined;
  const attention: SnapFitAttention[] = checks
    .filter((c) => c.verdict === 'over' || c.verdict === 'near' || c.verdict === 'unknown')
    .slice(0, 3)
    .map((c): SnapFitAttention => {
      const verdict = c.verdict as 'over' | 'near' | 'unknown';
      if (c.check === 'insertion') {
        return verdict === 'unknown'
          ? { check: c.check, verdict: 'unknown', why: c.note ?? 'insertion cannot be judged', next: 'declare forceBudgetN + leadAngleDeg + frictionCoeff' }
          : { check: c.check, verdict, why: `insertion ${round4(insertion as number)}N / budget ${budget}N = ${c.utilization}x`, next: 'reduce bead/interference or increase the lead angle' };
      }
      if (c.check === 'retention') {
        return verdict === 'unknown'
          ? { check: c.check, verdict: 'unknown', why: c.note ?? 'retention cannot be judged', next: 'declare retentionLoadN + retentionAngleDeg/frictionCoeff' }
          : { check: c.check, verdict, why: `required ${retentionLoad}N / capacity ${round4(retentionCapacity as number)}N = ${c.utilization}x`, next: 'deepen the undercut or add a retention shoulder' };
      }
      if (c.check === 'strain') {
        return verdict === 'unknown'
          ? { check: c.check, verdict: 'unknown', why: c.note ?? 'strain cannot be judged', next: 'declare maxStrainPct' }
          : { check: c.check, verdict, why: `root strain ${round4(strainPct)}% / max ${maxStrain}% = ${c.utilization}x`, next: 'reduce wall thickness or radial interference' };
      }
      return verdict === 'unknown'
        ? { check: c.check, verdict: 'unknown', why: c.note ?? 'self-lock cannot be judged', next: 'declare leadAngleDeg + frictionCoeff' }
        : { check: c.check, verdict, why: `mu*tan(lead) = ${round4(selfLockU as number)}`, next: 'reduce lead angle or friction' };
    });

  const pa = pointOf(aFeature);
  const pb = pointOf(bFeature);
  const atMm = [round4((pa[0] + pb[0]) / 2), round4((pa[1] + pb[1]) / 2), round4((pa[2] + pb[2]) / 2)];
  const nextLook = { atMm, why: 'snap-fit root/bead: section through this point' };

  const accepted = budget !== null || retentionLoad !== null || maxStrain !== null || selfLockU !== undefined;
  const hard = checks.some((c) => c.verdict === 'over' && (c.check !== 'selfLock' || selfLocking))
    || (selfLocking && checks.some((c) => c.check === 'selfLock' && c.verdict === 'over'));
  const intent = !hard && checks.some((c) => c.verdict === 'near' || c.verdict === 'unknown') && accepted;
  const verdict: InterfaceCheckResult['verdict'] = hard ? 'hard-violation' : !accepted ? 'skipped' : intent ? 'intent-flag' : 'pass';
  const measured = round4(insertion ?? radial);

  const unknownChecks = checks.filter((c) => c.verdict === 'unknown').map((c) => c.check);
  const worstText = (() => {
    if (!worst) return '';
    const u = `${worst.utilization}x (${worst.verdict})`;
    if (worst.check === 'insertion') return `insertion ${round4(insertion as number)}N / budget ${budget}N = ${u}`;
    if (worst.check === 'retention') return `retention required ${retentionLoad}N / capacity ${round4(retentionCapacity as number)}N = ${u}`;
    if (worst.check === 'strain') return `root strain ${round4(strainPct)}% / max ${maxStrain}% = ${u}`;
    return `self-lock mu*tan(lead)=${round4(selfLockU as number)} (${worst.verdict})`;
  })();
  const headline = worst && worst.verdict === 'over'
    ? `${worstText}; radial ${round4(radial)}N, strain ${round4(strainPct)}%${unknownChecks.length > 0 ? `; also unknown: ${unknownChecks.join(', ')}` : ''}`
    : unknownChecks.length > 0
      ? `cannot judge ${unknownChecks.join(', ')}; radial ${round4(radial)}N, strain ${round4(strainPct)}%${worstText ? `; ${worstText}` : ''}`
      : worst && worst.verdict === 'near'
        ? `near the limit: ${worstText}; radial ${round4(radial)}N, strain ${round4(strainPct)}%`
        : worstText
          ? `all declared criteria comfortable; ${worstText}`
          : 'all declared criteria comfortable; no attention target';
  const action = attention[0]?.next ? `; next: ${attention[0].next}` : '';
  const detail = `${headline}${action}; nextLook [${atMm.join(', ')}] — ${nextLook.why}`;

  return {
    verdict,
    measured,
    detail,
    snapFit: {
      input: {
        lobeCount: lobeCount as number,
        lobeWidthMm: w as number,
        lobeThicknessMm: t as number,
        leverArmMm: L as number,
        radialInterferenceMm: delta as number,
        youngModulusMPa: E as number,
        ...(lead !== null ? { leadAngleDeg: lead } : {}),
        ...(mu !== null ? { frictionCoeff: mu } : {}),
        ...(retentionAngle !== null ? { retentionAngleDeg: retentionAngle } : {}),
      },
      lobeStiffnessNPerMm: round4(kLobe),
      lobeForceN: round4(fLobe),
      radialForceN: round4(radial),
      ...(insertion !== undefined ? { insertionForceN: round4(insertion) } : {}),
      ...(retentionCapacity !== undefined ? { retentionCapacityN: round4(retentionCapacity) } : {}),
      rootStrainPct: round4(strainPct),
      selfLocking,
      checks,
      ...(worst ? { worst: { check: worst.check, utilization: worst.utilization, marginPct: worst.marginPct } } : {}),
      attention,
      nextLook,
    },
  };
}

/**
 * PARITY ORACLE — the pre-migration TypeScript implementation. Do not wire new
 * callers to this: `runAssemblyCheck` below is what the tool and the HTTP path use,
 * and it evaluates the contracts in the worker. This stays because it is the only
 * independent statement of what those numbers and those detail strings were, and
 * `scripts/accept-check-assembly-parity.mjs` compares the two on real manifests.
 */
export async function runAssemblyCheckInTs(
  store: VersionStore,
  manifestPath: string,
  opts: { adjacencyThresholdMm?: number; runs?: RunEntry[] } = {},
): Promise<AssemblyCheckReport> {
  const manifest: AssemblyManifest = await loadAssemblyManifest(manifestPath);
  const parts = new Map<string, PartWorld>();
  const partWarnings: AssemblyCheckReport['partWarnings'] = [];

  // Evidence expires with the version it cites (DESIGN §22): a cited run whose
  // geometry predates the CURRENT version of any of its parts is not evidence.
  const versionList = await listVersions(store);
  const newestOfPart = newestVersionPerPart(versionList);
  const staleCitations = (run: RunEntry): string[] => supersededVersionIds(versionList, run.sourceVersionIds);

  for (const flat of flattenParts(manifest.root)) {
    if (flat.node.source === 'stock') {
      partWarnings.push({ partId: flat.id, messages: ['stock part — skipped from geometric checks (v1)'] });
      continue;
    }
    const world = await loadPartWorld(store, flat.node);
    parts.set(flat.id, world);
    if (world.warnings.length > 0) partWarnings.push({ partId: flat.id, messages: world.warnings });
  }

  const owned: OwnedInterface[] = allInterfaces(manifest.root);
  const results: InterfaceCheckResult[] = [];

  for (const { ownerPath, iface } of owned) {
    const owner = findNode(manifest.root, ownerPath[ownerPath.length - 1]!)!;
    // A manifest may name an OPERATOR in `type` when `check` says the same thing
    // (the validator tolerates that, because "coaxial" is what people write). The
    // checker then has no fit kind to derive a layer/operator from — it used to
    // crash on `derived.layer`. An interface we cannot evaluate is skipped WITH a
    // reason, like every other unevaluable one.
    const derived = DEFAULT_DERIVED[iface.type];
    const layer = iface.layer ?? derived?.layer ?? 'L0';
    const checkName = iface.check ?? derived?.check ?? null;

    const base: InterfaceCheckResult = {
      interfaceId: iface.id,
      ownerPath,
      a: iface.a, b: iface.b,
      type: iface.type, severity: iface.severity,
      layer, check: checkName ?? '(none)',
      verdict: 'skipped',
      expected: expectedOf(iface),
      detail: '',
    };

    if (!checkName) {
      results.push({
        ...base,
        detail: `interface type "${iface.type}" is not a fit kind, and no \`check\` operator names one — nothing to evaluate`,
      });
      continue;
    }
    if (layer !== 'L0' && !IMPLEMENTED_CHECKS.has(checkName)) {
      results.push({ ...base, detail: `${layer} check "${checkName}" not implemented in v1 — pending` });
      continue;
    }

    const ra = resolveEndpoint(parts, owner, iface.a);
    if ('error' in ra) { results.push({ ...base, detail: ra.error }); continue; }
    const rb = resolveEndpoint(parts, owner, iface.b);
    if ('error' in rb) { results.push({ ...base, detail: rb.error }); continue; }

    if (checkName === 'distance' || checkName === 'motion-clearance') {
      const pa = pointOf(ra.feature);
      const pb = pointOf(rb.feature);
      const d = checkName === 'distance'
        ? datumDistance(ra.feature, rb.feature)
        : {
            measured: +Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]).toFixed(4),
            detail: 'point-to-point distance between declared datums',
          };
      const r = verdictFor(iface, d.measured, d.detail);
      if (checkName === 'motion-clearance') {
        // A motion claim has two halves, and this engine can only decide one of
        // them: the relationship at the modelled pose (that is a distance, and
        // it IS evaluated above), and whether the pair survives the travel. The
        // second half is decided by `simulate_motion`; an interface that names
        // the run which proved it gets the two halves tied together here
        // instead of being reported as an unimplemented check forever.
        const cited = typeof iface.params?.runId === 'string' ? String(iface.params.runId) : null;
        if (!cited) {
          r.detail += ' — motion half NOT evidenced: run simulate_motion over the travel and cite it with params.runId';
        } else {
          const run = opts.runs?.find((x) => x.id === cited);
          if (!run) {
            r.verdict = 'hard-violation';
            r.detail += ` — params.runId "${cited}" names no run in this project`;
          } else if (run.kind !== 'motion') {
            r.verdict = 'hard-violation';
            r.detail += ` — run ${cited} is a ${run.kind} run, not a motion run`;
          } else if (run.status !== 'pass') {
            r.verdict = 'hard-violation';
            r.detail += ` — cited motion run ${cited} did not pass (${run.summary})`;
          } else if (staleCitations(run).length > 0) {
            // §22 hard gate: the run is green, but over geometry that parts have
            // since replaced. Re-run it, or the evidence does not exist.
            const stale = staleCitations(run);
            r.verdict = 'hard-violation';
            r.detail += ` — cited motion run ${cited} is STALE: it verified ${stale.join(', ')}, ` +
              'which a part has since replaced. Re-run the motion over the current versions and cite that run ' +
              '(evidence expires with the version it cites).';
          } else {
            r.detail += ` — motion evidenced by ${cited} (${run.summary}${run.supersededBy ? `, SUPERSEDED by ${run.supersededBy}` : ''})`;
          }
        }
      }
      results.push({ ...r, ownerPath });
    } else if (checkName === 'spring-behaviour') {
      try {
        const r = springBehaviour(iface, ra.feature, rb.feature);
        results.push({ ...base, ...r, ownerPath } as InterfaceCheckResult);
      } catch (err) {
        results.push({ ...base, detail: err instanceof Error ? err.message : String(err) });
      }
    } else if (checkName === 'snap-fit') {
      try {
        const r = snapFit(iface, ra.feature, rb.feature);
        results.push({ ...base, ...r, ownerPath } as InterfaceCheckResult);
      } catch (err) {
        results.push({ ...base, detail: err instanceof Error ? err.message : String(err) });
      }
    } else if (checkName === 'spring-preload') {
      // A preload is a FORCE, and the engine has no contact model. What it does
      // have is geometry: if the two endpoints are the spring's two ends and the
      // manifest declares the free length and the rate, then the installed
      // length measures the deflection and k·δ is the force — arithmetic on
      // measured geometry rather than on a declared number.
      const k = numParam(iface, ['stiffnessNPerMm', 'springRateNPerMm', 'k']);
      const free = numParam(iface, ['freeLengthMm', 'freeLength']);
      if (k === null || free === null) {
        results.push({
          ...base,
          detail: 'spring-preload needs params.freeLengthMm and params.stiffnessNPerMm, with a and b being the ' +
            'spring\'s own two ends — without them there is nothing to measure a deflection against',
        });
        continue;
      }
      const pa = pointOf(ra.feature);
      const pb = pointOf(rb.feature);
      const installed = +Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]).toFixed(4);
      const deflection = +(free - installed).toFixed(4);
      const force = +(k * deflection).toFixed(4);
      const r = verdictFor(iface, force,
        `installed ${installed}mm vs free ${free}mm → δ${deflection}mm × ${k}N/mm = ${force}N` +
        (deflection < 0 ? ' (STRETCHED past free length — negative deflection)' : ''));
      results.push({ ...r, ownerPath });
    } else if (checkName === 'coaxial') {
      // Two axis lines, not two points. This is the operator microscope3's
      // interfaces 14/15 were waiting for: a two-point distance passes even
      // when one bore is tilted, because the chosen points happen to line up.
      const dirA = (ra.feature as { dir?: Vec3 }).dir;
      const dirB = (rb.feature as { dir?: Vec3 }).dir;
      if (!dirA || !dirB) {
        results.push({
          ...base,
          detail: 'coaxial requires axis or cylinder datums (datum_axis / datum_cyl) on both endpoints — a point datum has no direction to be coaxial WITH',
        });
        continue;
      }
      const { distance, angleDeg } = axisLineDistance(pointOf(ra.feature), dirA, pointOf(rb.feature), dirB);
      const measured = +distance.toFixed(4);
      const r = verdictFor(iface, measured,
        `axis offset ${measured}mm, axes ${angleDeg.toFixed(3)}° apart (line-to-line, infinite extents)`);
      if (angleDeg > 1.0 && measured <= (iface.tolerance?.max ?? Infinity)) {
        // A tilted bore can pass the offset test while the parts will not
        // assemble; the tolerance speaks about the offset, so tilt gets its
        // own hard note rather than silently riding inside a pass.
        r.detail += ' — axes NOT parallel: offset pass does not mean the bores line up';
        if (iface.severity === 'hard') r.verdict = 'hard-violation';
      }
      results.push({ ...r, ownerPath });
    } else if (checkName === 'diameter-match') {
      const cylA = (ra.feature as { radius?: number });
      const cylB = (rb.feature as { radius?: number });
      if (typeof cylA.radius !== 'number' || typeof cylB.radius !== 'number') {
        results.push({ ...base, detail: 'diameter-match requires cylinder datums (datum_cyl) on both endpoints' });
        continue;
      }
      // a = hole (larger), b = shaft: diametral clearance
      const measured = +(2 * (cylA.radius - cylB.radius)).toFixed(4);
      const r = verdictFor(iface, measured, `diametral clearance Ø${measured} (hole Ø${2 * cylA.radius} vs shaft Ø${2 * cylB.radius})`);
      if (measured < 0 && iface.severity !== 'hard') {
        r.verdict = 'hard-violation';
        r.detail += ' — negative clearance means interference, escalated to hard';
      }
      results.push({ ...r, ownerPath });
    } else {
      results.push({ ...base, detail: `L0 check "${checkName}" is unknown — skipped` });
    }
  }

  // ---- adjacency discovery: near/interfering pairs with no declared interface ----
  const undeclared: UndeclaredPair[] = [];
  const geometric = [...parts.values()].filter((p) => p.built !== null);
  if (geometric.length >= 2) {
    const threshold = opts.adjacencyThresholdMm ?? 0.75;
    for (let i = 0; i < geometric.length; i++) {
      for (let j = i + 1; j < geometric.length; j++) {
        const A = geometric[i]!;
        const B = geometric[j]!;
        const inter = A.built!.solid.intersect(B.built!.solid);
        const interVol = inter.isEmpty() ? 0 : Math.max(0, inter.volume());
        let minDistance = 0;
        if (interVol <= 1e-6) {
          minDistance = await pairMinDistance(A.built!, B.built!);
        }
        const near = interVol > 1e-6 || minDistance < threshold;
        if (!near) continue;
        const declared = owned.some(({ iface }) => {
          const idA = iface.a.split('.')[0]!;
          const idB = iface.b.split('.')[0]!;
          return (idA === A.id && idB === B.id) || (idA === B.id && idB === A.id);
        });
        if (!declared) {
          undeclared.push({
            partA: A.id, partB: B.id,
            minDistance: +minDistance.toFixed(4),
            intersectionVolume: +interVol.toFixed(4),
          });
        }
      }
    }
  }

  const pass = results.filter((r) => r.verdict === 'pass').length;
  const hard = results.filter((r) => r.verdict === 'hard-violation').length;
  const intents = results.filter((r) => r.verdict === 'intent-flag').length;
  const skipped = results.filter((r) => r.verdict === 'skipped').length;

  const report: AssemblyCheckReport = {
    checkedAt: new Date().toISOString(),
    manifestPath,
    manifestName: manifest.name,
    manifestHash: manifest.manifestHash,
    results,
    undeclared,
    partWarnings,
    adjacencyThresholdMm: opts.adjacencyThresholdMm ?? 0.75,
    summary: {
      interfaces: results.length, pass, hardViolations: hard, intentFlags: intents,
      skipped, undeclared: undeclared.length,
    },
    // Skipped is not a pass either (missing tolerance / unimplemented operator), and
    // neither is a manifest that declares NO interface: an empty contract has not been
    // satisfied, it has not been written (2026-10-23 audit, FIX-B4).
    overallStatus: hard > 0 ? 'fail'
      : (results.length === 0 || intents + undeclared.length + skipped > 0) ? 'check'
        : 'pass',
  };
  return report;
}

/**
 * Evaluate the manifest's declared interfaces and its undeclared neighbours.
 *
 * THE SOLVE IS PYTHON'S (DECISION-LOG 2026-10-12): the layer/check derivation, the
 * seven operators, the verdict-vs-tolerance rule, the adjacency discovery and the
 * summary all happen in the worker's `assembly_contracts` op. What stays here is
 * everything that needs the STORE rather than the geometry — loading the manifest,
 * building each part's placed solid, resolving interface endpoints to world datum
 * features, and computing which cited runs have gone stale.
 *
 * The split is deliberate: `coaxial` consumes the worker's `_axis_line_metrics`, the
 * same arithmetic `measure_angle` reports, and the adjacency half uses the same
 * Manifold intersection `validate_assembly` uses — so a declared interface's verdict
 * and an undeclared pair's interference volume can no longer disagree about which
 * engine measured them.
 */
export async function runAssemblyCheck(
  store: VersionStore,
  manifestPath: string,
  opts: { adjacencyThresholdMm?: number; runs?: RunEntry[] } = {},
): Promise<AssemblyCheckReport> {
  const manifest = await loadAssemblyManifest(manifestPath);
  const parts = new Map<string, PartWorld>();
  const partWarnings: AssemblyCheckReport['partWarnings'] = [];
  for (const flat of flattenParts(manifest.root)) {
    if (flat.node.source === 'stock') {
      partWarnings.push({ partId: flat.id, messages: ['stock part — skipped from geometric checks (v1)'] });
      continue;
    }
    const world = await loadPartWorld(store, flat.node);
    parts.set(flat.id, world);
    if (world.warnings.length > 0) partWarnings.push({ partId: flat.id, messages: world.warnings });
  }

  // Endpoint resolution stays here: it needs the manifest tree (which child owns the
  // address) and each version's datum set. The worker receives resolved features.
  const owned: OwnedInterface[] = allInterfaces(manifest.root);
  const interfaces = owned.map(({ ownerPath, iface }) => {
    const owner = findNode(manifest.root, ownerPath[ownerPath.length - 1]!)!;
    const record = (address: string) => {
      const resolved = resolveEndpoint(parts, owner, address);
      if ('error' in resolved) return { address, error: resolved.error };
      return { address, kind: resolved.kind, ...(resolved.feature as Record<string, unknown>) };
    };
    return {
      id: iface.id,
      ownerPath,
      // The report echoes these ADDRESS strings (that is what the pre-migration
      // implementation produced and what the stored reports contain); the resolved
      // world features go in aFeature/bFeature for the operators to use.
      a: iface.a,
      b: iface.b,
      aFeature: record(iface.a),
      bFeature: record(iface.b),
      type: iface.type,
      severity: iface.severity,
      layer: iface.layer,
      check: iface.check,
      nominal: iface.nominal,
      tolerance: iface.tolerance,
      params: iface.params,
      elastic: iface.elastic,
    };
  });

  // Evidence expires with the version it cites (DESIGN §22): a cited run whose
  // geometry predates the CURRENT version of any of its parts is not evidence. That
  // is a store question, so the worker is told the answer per run rather than the
  // whole version history.
  const versionList = await listVersions(store);
  const newestOfPart = newestVersionPerPart(versionList);
  const runPayload: Record<string, unknown> = {};
  for (const run of opts.runs ?? []) {
    const staleVersionIds = supersededVersionIds(versionList, run.sourceVersionIds);
    runPayload[run.id] = {
      kind: run.kind,
      status: run.status,
      summary: run.summary,
      supersededBy: run.supersededBy ?? null,
      staleVersionIds,
    };
  }

  const adjacencyThresholdMm = opts.adjacencyThresholdMm ?? 0.75;
  const scratch: string[] = [];
  const payloadParts = [...parts.values()]
    .filter((part) => part.workerMesh !== null)
    .map((part) => {
      if (part.workerMesh!.scratch) scratch.push(part.workerMesh!.scratch);
      return { id: part.id, path: part.workerMesh!.path, transform: part.workerMesh!.transform };
    });

  try {
    const worker = await ensurePythonWorker();
    const solved = await worker.request<{
      results: AssemblyCheckReport['results'];
      undeclared: AssemblyCheckReport['undeclared'];
      summary: AssemblyCheckReport['summary'];
      overallStatus: AssemblyCheckReport['overallStatus'];
    }>('assembly_contracts', {
      parts: payloadParts,
      interfaces,
      runs: runPayload,
      thresholds: { adjacencyThresholdMm },
    });

    // The worker judges geometry, not paperwork: the requirement is attached here,
    // from the interfaces the worker was handed (same list, same ids).
    const reqById = new Map(interfaces.map((it) => [it.id, it]));
    return {
      checkedAt: new Date().toISOString(),
      manifestPath,
      manifestName: manifest.name,
      manifestHash: manifest.manifestHash,
      results: solved.results.map((r) => ({ ...r, expected: expectedOf(reqById.get(r.interfaceId)) })),
      undeclared: solved.undeclared,
      partWarnings,
      adjacencyThresholdMm,
      summary: solved.summary,
      overallStatus: solved.overallStatus,
    };
  } finally {
    await Promise.all(scratch.map((path) => rm(path, { force: true }).catch(() => {})));
  }
}

/**
 * A POINTER to the immutable run, written next to the manifest under the historical
 * filename. It is not a second copy of the report (2026-10-23 audit, FIX-C1).
 *
 * WHY: the report used to be written here AND into the run store. Two copies of the same
 * conclusion drift — microscope2 still holds two `assembly-check-report.json` files that
 * disagree by 25 minutes, one of them naming a manifest path that has since moved — and
 * a fixed filename always describes "the last check", with no way to tell which run it
 * was. The run is immutable and addressable; this file exists so scripts and humans have
 * a stable path to FIND it, and it carries the `runId` that makes that possible.
 */
export interface AssemblyCheckPointer {
  runId: string;
  checkedAt: string;
  /** The manifest this check read, as resolved at run time. */
  manifestPath: string;
  /**
   * Content hash of that manifest (`manifest@<hash8>`). The path alone cannot tell
   * two revisions apart, so a pointer without this says "some version of the file
   * was checked" — which is exactly what an ICD must not say.
   */
  manifestHash?: string;
  /** What the pointer replaced: readers that expected a full report must follow `runId`. */
  schema: 'assembly-check-pointer/v1';
}

export async function saveAssemblyCheckPointer(
  manifestPath: string,
  pointer: AssemblyCheckPointer,
): Promise<string> {
  const path = join(manifestPath, '..', 'assembly-check-report.json');
  await mkdir(join(manifestPath, '..'), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(pointer, null, 2));
  await rename(tmp, path);
  return path;
}
