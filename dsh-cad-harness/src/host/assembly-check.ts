// Assembly manifest L0 checks (v1): executable interface contracts + adjacency
// discovery. See ASSEMBLY-SCHEMA-PROPOSAL.md.
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

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { compileStlOnly, type DatumSet } from './compile.ts';
import { buildSolid, pairMinDistance } from './assembly.ts';
import {
  loadAssemblyManifest, flattenParts, allInterfaces, findNode,
  type AssemblyManifest, type ManifestNode, type ManifestInterface, type OwnedInterface,
} from './manifest.ts';
import type { VersionStore } from './version.ts';
import { readVersionDatums } from './version.ts';
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
  if (stl) {
    try {
      // world = translate ∘ rotate ∘ pose; the pose (rotate about a datum axis)
      // reaches the mesh as a leading 3×3, never folded through Euler angles.
      const geo = await partWorldAffine(store, node);
      if (geo.poseError) warnings.push(geo.poseError);
      built = await buildSolid(stl, {
        // matrix already encodes rotate∘pose — never pass both.
        ...(geo.matrix
          ? { matrix: geo.matrix }
          : { ...(node.transform?.rotate ? { rotate: node.transform.rotate } : {}) }),
        ...(node.transform?.translate ? { translate: node.transform.translate } : {}),
      });
    } catch (e) {
      warnings.push(`solid build failed: ${(e as Error).message}`);
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
  return { id: node.id, node, built, datums, warnings };
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
  expected?: { quantity: string; min?: number; max?: number };
  measured?: number;
  detail: string;
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
  results: InterfaceCheckResult[];
  undeclared: UndeclaredPair[];
  partWarnings: { partId: string; messages: string[] }[];
  /** Gap below which a pair counts as "near" in the undeclared-adjacency pass. */
  adjacencyThresholdMm: number;
  summary: { interfaces: number; pass: number; hardViolations: number; intentFlags: number; skipped: number; undeclared: number };
  overallStatus: 'pass' | 'check' | 'fail';
}

/** Compare a measured value against the tolerance interval; honour severity. */
function verdictFor(iface: ManifestInterface, measured: number, detail: string): InterfaceCheckResult {
  const tol = iface.tolerance;
  const inRange = tol ? measured >= tol.min && measured <= tol.max : true;
  const verdict = inRange ? 'pass' : iface.severity === 'hard' ? 'hard-violation' : 'intent-flag';
  return {
    interfaceId: iface.id,
    ownerPath: [],
    a: iface.a, b: iface.b,
    type: iface.type, severity: iface.severity,
    layer: iface.layer ?? 'L0',
    check: iface.check ?? 'distance',
    verdict,
    expected: iface.nominal ? { quantity: iface.nominal.quantity, min: tol?.min, max: tol?.max } : undefined,
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
const IMPLEMENTED_CHECKS = new Set(['distance', 'diameter-match', 'coaxial', 'motion-clearance', 'spring-preload']);

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

export async function runAssemblyCheck(
  store: VersionStore,
  manifestPath: string,
  opts: { adjacencyThresholdMm?: number; runs?: RunEntry[] } = {},
): Promise<AssemblyCheckReport> {
  const manifest: AssemblyManifest = await loadAssemblyManifest(manifestPath);
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

  const owned: OwnedInterface[] = allInterfaces(manifest.root);
  const results: InterfaceCheckResult[] = [];

  for (const { ownerPath, iface } of owned) {
    const owner = findNode(manifest.root, ownerPath[ownerPath.length - 1]!)!;
    const derived = DEFAULT_DERIVED[iface.type];
    const layer = iface.layer ?? derived.layer;
    const checkName = iface.check ?? derived.check;

    const base: InterfaceCheckResult = {
      interfaceId: iface.id,
      ownerPath,
      a: iface.a, b: iface.b,
      type: iface.type, severity: iface.severity,
      layer, check: checkName,
      verdict: 'skipped',
      detail: '',
    };

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
      const measured = +Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]).toFixed(4);
      const r = verdictFor(iface, measured, `point-to-point distance between declared datums`);
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
          } else {
            r.detail += ` — motion evidenced by ${cited} (${run.summary}${run.supersededBy ? `, SUPERSEDED by ${run.supersededBy}` : ''})`;
          }
        }
      }
      results.push({ ...r, ownerPath });
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
    results,
    undeclared,
    partWarnings,
    adjacencyThresholdMm: opts.adjacencyThresholdMm ?? 0.75,
    summary: {
      interfaces: results.length, pass, hardViolations: hard, intentFlags: intents,
      skipped, undeclared: undeclared.length,
    },
    overallStatus: hard > 0 ? 'fail' : intents + undeclared.length > 0 ? 'check' : 'pass',
  };
  return report;
}

/**
 * Persist the check report next to the manifest. NOTE: distinct filename from
 * validate_assembly's `assembly-report.json` — the two reports have different
 * schemas and the panel parses the validate_assembly one.
 */
export async function saveAssemblyReport(manifestPath: string, report: AssemblyCheckReport): Promise<string> {
  const path = join(manifestPath, '..', 'assembly-check-report.json');
  await mkdir(join(manifestPath, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(report, null, 2));
  return path;
}
