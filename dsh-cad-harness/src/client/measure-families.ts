// Measurement families for the viewport — pure geometry, no React, no three.js.
//
// The panel shipped exactly ONE measurement (the distance between two picked
// points) while the host's `measure` tool already answered five questions. That
// gap is the user's: "角度/间隙/面积/孔 都得回会话里问 agent". This module is the
// arithmetic those families need, so it can be checked without clicking
// (`scripts/accept-measure-families.mjs`):
//
//   * angle   — three points, the angle AT the middle one;
//   * section — which cut loop a click landed in, its area/perimeter, and whether
//               that loop is material or a HOLE in the material;
//   * hole    — an equivalent diameter for a bore (exact for a circle, stated as
//               equivalent for anything else);
//   * history — named, deletable measurements that travel with a screenshot.
//
// Units are millimetres and degrees; the caller never converts.

import { pointInLoop, signedArea2 } from './section.ts';

export interface Vec3 {
  readonly 0: number;
  readonly 1: number;
  readonly 2: number;
  readonly length?: number;
}

/** Angle at `b` between the rays b→a and b→c, in degrees. Null when a ray is degenerate. */
export function angleDeg(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  c: readonly [number, number, number],
): number | null {
  const ab = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cb = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
  const lab = Math.hypot(ab[0], ab[1], ab[2]);
  const lcb = Math.hypot(cb[0], cb[1], cb[2]);
  if (lab < 1e-9 || lcb < 1e-9) return null;
  const dot = (ab[0] * cb[0] + ab[1] * cb[1] + ab[2] * cb[2]) / (lab * lcb);
  // Floating error can push a nearly-collinear triple just outside [-1, 1]; clamp
  // instead of returning NaN — 0°/180° are real answers.
  return (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
}

/** Distance between two points, mm. */
export function distanceMm(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export type Loop = readonly (readonly [number, number])[];

export interface LoopMeasure {
  /** Index in the input array. */
  index: number;
  /** Material area of this loop (never negative). */
  areaMm2: number;
  perimeterMm: number;
  /** Area centroid, in the plane's own 2D frame. */
  centroid: [number, number];
  /**
   * Nesting depth: the number of other loops containing it. Even = material
   * boundary, odd = a hole in the material (see `capTriangles` for the same rule).
   */
  depth: number;
  isHole: boolean;
}

/** Perimeter of a closed loop (the first point is not repeated). */
export function loopPerimeter(loop: Loop): number {
  let total = 0;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    total += Math.hypot(loop[i]![0] - loop[j]![0], loop[i]![1] - loop[j]![1]);
  }
  return total;
}

/** Area centroid of a loop (polygon formula; falls back to the vertex average). */
export function loopCentroid(loop: Loop): [number, number] {
  let twiceArea = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const [xi, yi] = loop[i]!;
    const [xj, yj] = loop[j]!;
    const cross = xj * yi - xi * yj;
    twiceArea += cross;
    cx += (xj + xi) * cross;
    cy += (yj + yi) * cross;
  }
  if (twiceArea === 0) {
    const sum = loop.reduce((acc, point) => [acc[0] + point[0], acc[1] + point[1]], [0, 0]);
    return [sum[0]! / loop.length, sum[1]! / loop.length];
  }
  return [cx / (3 * twiceArea), cy / (3 * twiceArea)];
}

/** The loops of one section, with their nesting depth and signed facts. */
export function describeLoops(loops: readonly Loop[]): LoopMeasure[] {
  return loops.map((loop, index) => {
    const depth = loops.reduce((total, other, otherIndex) => (
      otherIndex === index ? total : total + (pointInLoop(loop[0]!, other) ? 1 : 0)
    ), 0);
    return {
      index,
      areaMm2: Math.abs(signedArea2(loop)),
      perimeterMm: loopPerimeter(loop),
      centroid: loopCentroid(loop),
      depth,
      isHole: depth % 2 === 1,
    };
  });
}

/**
 * The measurement a click at `point2` means: the SMALLEST loop containing it.
 *
 * Smallest, not first: a plane through a plate with a boss produces a big outer
 * loop and a small island; a click on the island must report the island, or every
 * "hole area" on a part with features reads as the part's outer face.
 */
export function loopAt(loops: readonly Loop[], point2: readonly [number, number]): LoopMeasure | null {
  const described = describeLoops(loops);
  const hits = described.filter((measure) => pointInLoop(point2, loops[measure.index]!));
  if (hits.length === 0) return null;
  return hits.reduce((smallest, measure) => (measure.areaMm2 < smallest.areaMm2 ? measure : smallest));
}

/** Bore diameter from a section's area, mm. Exact for a circle, "equivalent" otherwise. */
export function equivalentDiameterMm(areaMm2: number): number {
  return areaMm2 > 0 ? 2 * Math.sqrt(areaMm2 / Math.PI) : 0;
}

// ── measurement history ──────────────────────────────────────────────────────

export type MeasureKind = 'distance' | 'angle' | 'section' | 'hole';

export interface Measurement {
  id: string;
  kind: MeasureKind;
  /** A name the user can edit; `null` means "auto" (the panel derives one). */
  name: string | null;
  /** mm for distance/hole, degrees for angle, mm² for section. */
  value: number;
  /** The point(s) that produced it, for drawing and for the screenshot caption. */
  points: [number, number, number][];
}

/**
 * A default name for a measurement: `kind-N`, where N counts within that kind.
 *
 * Derived from the list rather than from a counter in state, so deleting the third
 * of five entries cannot produce a duplicate id/name later.
 */
export function autoName(kind: MeasureKind, existing: readonly Measurement[]): string {
  const used = existing.filter((entry) => entry.kind === kind).length;
  const label = kind === 'distance' ? '距离' : kind === 'angle' ? '角度' : kind === 'section' ? '面积' : '孔';
  return `${label}-${used + 1}`;
}

/** Append, with a unique id and an auto name when none was given. */
export function addMeasurement(
  existing: readonly Measurement[],
  entry: Omit<Measurement, 'id' | 'name'> & { name?: string | null },
): Measurement[] {
  let next = 1;
  while (existing.some((item) => item.id === `m${next}`)) next++;
  const measurement: Measurement = {
    id: `m${next}`,
    kind: entry.kind,
    name: entry.name ?? autoName(entry.kind, existing),
    value: entry.value,
    points: entry.points,
  };
  return [...existing, measurement];
}

/** Remove by id (unknown ids are a no-op, not an error). */
export function removeMeasurement(existing: readonly Measurement[], id: string): Measurement[] {
  return existing.filter((entry) => entry.id !== id);
}

/** Rename by id; an empty/blank name reverts to the auto name. */
export function renameMeasurement(
  existing: readonly Measurement[],
  id: string,
  name: string,
): Measurement[] {
  return existing.map((entry) => {
    if (entry.id !== id) return entry;
    const trimmed = name.trim();
    return { ...entry, name: trimmed === '' ? null : trimmed };
  });
}

/** The one-line summary a screenshot caption carries. */
export function measurementSummary(entry: Measurement): string {
  const name = entry.name ?? '';
  switch (entry.kind) {
    case 'angle': return `${name} ${entry.value.toFixed(1)}°`;
    case 'section': return `${name} ${entry.value.toFixed(2)}mm²`;
    case 'hole': return `${name} Ø${entry.value.toFixed(2)}`;
    default: return `${name} ${entry.value.toFixed(2)}mm`;
  }
}
