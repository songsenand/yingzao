// Section (剖切) geometry — pure helpers: no React, no renderer, no DOM.
//
// WHY THIS IS ITS OWN MODULE: the interesting half of "measure two points in a
// section" is arithmetic — where a click lands once it is constrained to the cut
// plane, and which mesh vertices are worth snapping to. Arithmetic buried inside a
// 2,500-line React panel can only be checked by clicking at it; here it is checked
// by `scripts/accept-section-pick.mjs` and `scripts/accept-section-free.mjs`, which
// drive exactly these functions.
//
// The problem it solves: a three.js clip plane is a shader effect, so the cut face
// has NO geometry. A click that looks like it lands on the cut actually passes
// through the opening and hits the far interior wall, tens of millimetres behind —
// which is how two points that look adjacent in a section end up measuring the
// diagonal of the part.
//
// 2026-11-26 (U20): the plane is no longer required to be a principal axis. Every
// operation below takes a `SectionPlane` (a point + a normal), and the axis
// functions (`sectionSegments(geometry, 'z', 5)`) are thin wrappers over
// `axisPlane(axis, cut)`. An axis cut is the special case with an exact zero in
// the normal, which is also why the wrappers stay literally exact: `dot(n, p)`
// with n = (0,0,1) is `p.z` in IEEE arithmetic, so the old vertex-on-plane
// behaviour is unchanged bit for bit.

import { Box3, BufferAttribute, BufferGeometry, ShapeUtils, Vector2, Vector3 } from 'three';

export type SectionAxis = 'x' | 'y' | 'z';

/**
 * A cut plane: a point it passes through and a normal. Both may be non-unit and
 * non-principal; everything here normalises them, and `normalizePlane` is the one
 * place that decides what "degenerate" means.
 */
export interface SectionPlane {
  readonly pointMm: readonly [number, number, number];
  readonly normal: readonly [number, number, number];
}

/** A normalised plane plus its orthonormal in-plane frame. */
export interface PlaneFrame {
  readonly point: [number, number, number];
  readonly normal: [number, number, number];
  /** In-plane u axis, unit, world. */
  readonly u: [number, number, number];
  /** In-plane v axis, unit, world. `(u, v, normal)` is right-handed. */
  readonly v: [number, number, number];
}

export function axisIndex(axis: SectionAxis): number {
  return axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
}

function unit(vector: readonly [number, number, number], what: string): [number, number, number] {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (!Number.isFinite(length) || length < 1e-9) {
    throw new Error(`${what} must be a non-zero finite vector, got [${vector.join(', ')}]`);
  }
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function dot(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** Normalise a plane. Throws on a zero/NaN normal — a cut with no direction is a bug, not a default. */
export function normalizePlane(plane: SectionPlane): { pointMm: [number, number, number]; normal: [number, number, number] } {
  return {
    pointMm: [plane.pointMm[0], plane.pointMm[1], plane.pointMm[2]],
    normal: unit(plane.normal, 'section plane normal'),
  };
}

/**
 * The plane's own 2D frame, as world direction vectors.
 *
 * The rule matches the Python side (`_plane_basis` in worker.py) so that a section
 * drawn in the panel and a section measured by `measure` agree on what "u,v"
 * mean: the world axis LEAST aligned with the normal seeds u (first index wins a
 * tie), then v = normal × u keeps `(u, v, normal)` right-handed.
 *
 * A +z cut gets u=x, v=y; a +x cut gets u=y, v=z; a +y cut gets u=x, v=−z. That
 * last one used to be u=z, v=x on the TypeScript side only, which disagreed with
 * the worker for no reason: same plane, rotated/reflected frame, so the two halves
 * of the product quoted different coordinates for the same cut. The Python rule
 * wins because `measure(section)` is the artifact that gets written down.
 */
export function planeBasisFor(normal: readonly [number, number, number]): { u: [number, number, number]; v: [number, number, number] } {
  const n = unit(normal, 'section plane normal');
  const abs = [Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2])];
  let seedIndex = 0;
  for (let i = 1; i < 3; i++) if (abs[i]! < abs[seedIndex]!) seedIndex = i;
  const seed: [number, number, number] = [0, 0, 0];
  seed[seedIndex] = 1;
  const along = dot(seed, n);
  const u = unit(
    [seed[0] - along * n[0], seed[1] - along * n[1], seed[2] - along * n[2]],
    'section plane basis',
  );
  return { u, v: cross(n, u) };
}

/** The principal-axis plane through `cut` (the pre-U20 case). */
export function axisPlane(axis: SectionAxis, cut: number): SectionPlane {
  const pointMm: [number, number, number] = [0, 0, 0];
  pointMm[axisIndex(axis)] = cut;
  const normal: [number, number, number] = [0, 0, 0];
  normal[axisIndex(axis)] = 1;
  return { pointMm, normal };
}

export function planeFrame(plane: SectionPlane): PlaneFrame {
  const { pointMm, normal } = normalizePlane(plane);
  const { u, v } = planeBasisFor(normal);
  return { point: pointMm, normal, u, v };
}

/** Backwards-compatible axis basis. */
export function planeBasis(axis: SectionAxis): { u: [number, number, number]; v: [number, number, number] } {
  return planeBasisFor(axisPlane(axis, 0).normal);
}

/** Shoelace area of a closed 2D loop (sign = winding). */
export function signedArea2(loop: readonly (readonly [number, number])[]): number {
  let total = 0;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    total += loop[j]![0] * loop[i]![1] - loop[i]![0] * loop[j]![1];
  }
  return total / 2;
}

/** Ray-casting point-in-polygon, used to decide which loop is nested in which. */
export function pointInLoop(point: readonly [number, number], loop: readonly (readonly [number, number])[]): boolean {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const [xi, yi] = loop[i]!;
    const [xj, yj] = loop[j]!;
    if ((yi > point[1]) !== (yj > point[1])
      && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Chain a flat list of 2D segment endpoints into closed loops.
 *
 * The quantization is not optional: the same surface point reached from two
 * triangles that share an edge is interpolated in two different orders, so the two
 * endpoints differ in the last bits and an exact match leaves the loops OPEN. A
 * micrometre is three orders below anything a printed part cares about. (The Python
 * side learned the same lesson from GEOS, where un-noded linework makes `polygonize`
 * return nothing at all.)
 */
export function chainLoops(points2: readonly [number, number][], toleranceMm = 1e-6): [number, number][][] {
  const quantize = (point: readonly [number, number]): [number, number] => [
    Math.round(point[0] / toleranceMm),
    Math.round(point[1] / toleranceMm),
  ];
  const nodes = new Map<string, { point: [number, number]; edges: Map<string, number> }>();
  const ensure = (grid: [number, number]) => {
    const key = `${grid[0]},${grid[1]}`;
    let node = nodes.get(key);
    if (!node) {
      node = { point: [grid[0] * toleranceMm, grid[1] * toleranceMm], edges: new Map() };
      nodes.set(key, node);
    }
    return { key, node };
  };
  for (let i = 0; i + 1 < points2.length; i += 2) {
    const a = ensure(quantize(points2[i]!));
    const b = ensure(quantize(points2[i + 1]!));
    if (a.key === b.key) continue;
    a.node.edges.set(b.key, (a.node.edges.get(b.key) ?? 0) + 1);
    b.node.edges.set(a.key, (b.node.edges.get(a.key) ?? 0) + 1);
  }

  const loops: [number, number][][] = [];
  // HIERHOLZER, not a greedy walk. A greedy "follow any unused edge" walk stops
  // early whenever it reaches a node whose remaining edges form a separate circuit
  // (and a section can legitimately produce a duplicated edge if a mesh carries
  // coincident triangles): measured on a square whose first side appeared twice, the
  // greedy version returned a 7-point loop instead of the full outline, silently
  // dropping geometry from the cap. Hierholzer consumes the whole edge set.
  for (const startKey of [...nodes.keys()]) {
    const degree = (key: string) => [...nodes.get(key)!.edges.values()].reduce((a, b) => a + b, 0);
    if (degree(startKey) === 0) continue;
    const stack = [startKey];
    const circuit: string[] = [];
    while (stack.length) {
      const key = stack[stack.length - 1]!;
      const step = [...nodes.get(key)!.edges.entries()].find(([, count]) => count > 0);
      if (!step) {
        circuit.push(stack.pop()!);
        continue;
      }
      const nextKey = step[0];
      const node = nodes.get(key)!;
      node.edges.set(nextKey, step[1] - 1);
      const back = nodes.get(nextKey)!;
      back.edges.set(key, (back.edges.get(key) ?? 0) - 1);
      stack.push(nextKey);
    }
    // `circuit` comes back end-first and repeats the start node at the end.
    const ordered = circuit.slice(0, -1).reverse();
    if (ordered.length >= 3) loops.push(ordered.map((key) => nodes.get(key)!.point));
  }
  return loops;
}

/**
 * Area centroid of each closed loop, in the plane's frame.
 *
 * This is what makes a section's HOLES snappable: the centre of a bore that the cut
 * opens is not a mesh vertex, so vertex snapping alone can never reach it — yet
 * "the centre of that hole" is exactly what a user measuring hole spacing in a
 * section is aiming at. The polygon centroid formula (not the average of the
 * vertices) is what puts the point at the middle of a tessellated circle.
 */
export function loopCentroids(loops: readonly (readonly [number, number][])[]): [number, number][] {
  return loops.map((loop) => {
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
      // Degenerate (collinear) loop: the vertex average is the only usable answer.
      const sum = loop.reduce((acc, point) => [acc[0] + point[0], acc[1] + point[1]], [0, 0]);
      return [sum[0]! / loop.length, sum[1]! / loop.length];
    }
    return [cx / (3 * twiceArea), cy / (3 * twiceArea)];
  });
}

/** Lift an in-plane 2D point onto the cut plane, in world coordinates. */
export function frameToWorld(frame: PlaneFrame, point: readonly [number, number]): [number, number, number] {
  return [
    frame.point[0] + frame.u[0] * point[0] + frame.v[0] * point[1],
    frame.point[1] + frame.u[1] * point[0] + frame.v[1] * point[1],
    frame.point[2] + frame.u[2] * point[0] + frame.v[2] * point[1],
  ];
}

/** Lift an in-plane 2D point onto a principal-axis plane (pre-U20 signature). */
export function planeToWorld(
  point: readonly [number, number],
  axis: SectionAxis,
  cut: number,
): [number, number, number] {
  return frameToWorld(planeFrame(axisPlane(axis, cut)), point);
}

/**
 * The cut plane's outline as closed 2D loops in the plane's own frame.
 *
 * Exported (not only used by `capTriangles`) because "the loops are right" is the
 * property worth asserting directly: an outer square plus an inner one, not one
 * merged ring and not two loops with missing vertices.
 */
export function sectionLoopsOnPlane(geometry: BufferGeometry, plane: SectionPlane): [number, number][][] {
  const frame = planeFrame(plane);
  const flat = sectionSegmentsOnPlane(geometry, plane);
  if (flat.length === 0) return [];
  const points2: [number, number][] = [];
  for (let i = 0; i < flat.length; i += 3) {
    points2.push([
      flat[i]! * frame.u[0] + flat[i + 1]! * frame.u[1] + flat[i + 2]! * frame.u[2],
      flat[i]! * frame.v[0] + flat[i + 1]! * frame.v[1] + flat[i + 2]! * frame.v[2],
    ]);
  }
  return chainLoops(points2);
}

/** Pre-U20 signature: loops of a principal-axis cut. */
export function sectionLoops(geometry: BufferGeometry, axis: SectionAxis, cut: number): [number, number][][] {
  return sectionLoopsOnPlane(geometry, axisPlane(axis, cut));
}

/**
 * The cut face as triangles (flat xyz), so the section can be drawn as SOLID
 * material instead of a hollow shell.
 *
 * Loops are nested-classified rather than "largest is the outer one": a plane that
 * cuts two separate bodies produces two outer loops, and calling the second one a
 * hole would punch a spurious opening through the cap. Depth is the number of other
 * loops containing the loop, so even = a material boundary, odd = a hole, and depth
 * two (an island inside a hole) comes back as its own cap.
 */
export function capTrianglesOnPlane(geometry: BufferGeometry, plane: SectionPlane): number[] {
  const frame = planeFrame(plane);
  const loops = sectionLoopsOnPlane(geometry, plane);
  if (loops.length === 0) return [];

  const depths = loops.map((loop, index) => loops.reduce((depth, other, otherIndex) => (
    otherIndex === index ? depth : depth + (pointInLoop(loop[0]!, other) ? 1 : 0)
  ), 0));
  // Immediate parent = the SMALLEST loop that contains this one. Testing a single
  // vertex is sound because section loops never cross: nested loops are either
  // wholly inside or wholly outside each other.
  const parents = loops.map((loop, index) => {
    let parent = -1;
    let smallest = Infinity;
    loops.forEach((other, otherIndex) => {
      if (otherIndex === index || !pointInLoop(loop[0]!, other)) return;
      const area = Math.abs(signedArea2(other));
      if (area < smallest) {
        smallest = area;
        parent = otherIndex;
      }
    });
    return parent;
  });

  const triangles: number[] = [];
  for (const [index, outer] of loops.entries()) {
    if (depths[index]! % 2 !== 0) continue;
    const mine = loops.filter((_hole, holeIndex) => parents[holeIndex] === index);
    const contour = outer.map(([a, b]) => new Vector2(a, b));
    if (signedArea2(outer) < 0) contour.reverse();
    const holes = mine.map((hole) => {
      const ring = hole.map(([a, b]) => new Vector2(a, b));
      if (signedArea2(hole) > 0) ring.reverse();
      return ring;
    });
    const vertices = contour.concat(...holes);
    for (const face of ShapeUtils.triangulateShape(contour, holes)) {
      for (const corner of face) {
        triangles.push(...frameToWorld(frame, [vertices[corner]!.x, vertices[corner]!.y]));
      }
    }
  }
  return triangles;
}

/** Pre-U20 signature: cap triangles of a principal-axis cut. */
export function capTriangles(geometry: BufferGeometry, axis: SectionAxis, cut: number): number[] {
  return capTrianglesOnPlane(geometry, axisPlane(axis, cut));
}

/**
 * Cut coordinate along the section axis, in world units.
 *
 * The plane keeps `axis <= cut`, so the removed half is the one facing the default
 * camera and the view looks INTO the part.
 */
export function clipCut(box: Box3, clip: { pos: number; axis: SectionAxis }): number {
  const i = axisIndex(clip.axis);
  const lo = box.min.getComponent(i);
  const hi = box.max.getComponent(i);
  return lo + (hi - lo) * clip.pos;
}

function components(point: Vector3 | readonly [number, number, number]): [number, number, number] {
  return point instanceof Vector3
    ? [point.x, point.y, point.z]
    : [point[0], point[1], point[2]];
}

/** Constrain a picked point to the cut plane: keep the two in-plane components. */
export function projectToCutPlane(
  point: Vector3 | readonly [number, number, number],
  axis: SectionAxis,
  cut: number,
): [number, number, number] {
  const out = components(point);
  out[axisIndex(axis)] = cut;
  return out;
}

/** Signed distance from a point to the plane (positive on the normal's side). */
export function planeDistance(plane: SectionPlane, point: readonly [number, number, number]): number {
  const { pointMm: origin, normal } = normalizePlane(plane);
  return (point[0] - origin[0]) * normal[0]
    + (point[1] - origin[1]) * normal[1]
    + (point[2] - origin[2]) * normal[2];
}

/** Constrain a picked point to an arbitrary cut plane (keeps the in-plane part). */
export function projectToPlane(
  point: Vector3 | readonly [number, number, number],
  plane: SectionPlane,
): [number, number, number] {
  const p = components(point);
  const d = planeDistance(plane, p);
  const { normal } = normalizePlane(plane);
  return [p[0] - normal[0] * d, p[1] - normal[1] * d, p[2] - normal[2] * d];
}

/**
 * The same plane in three.js `Plane` form: `normal·p + constant = 0`.
 *
 * `flip` swaps which half is CUT AWAY. three.js CLIPS what lies on the negative
 * side, so without a flip the plane keeps the half the normal points at. The
 * axis path historically kept the low half (normal = −axis), which is just
 * `flip = true` on the axis plane — the panel passes that explicitly instead of
 * relying on a sign hidden in the caller.
 */
export function clippingPlane(plane: SectionPlane, flip = false): { normal: [number, number, number]; constant: number } {
  const { pointMm, normal } = normalizePlane(plane);
  const sign = flip ? -1 : 1;
  const n: [number, number, number] = [normal[0] * sign, normal[1] * sign, normal[2] * sign];
  return { normal: n, constant: -(n[0] * pointMm[0] + n[1] * pointMm[1] + n[2] * pointMm[2]) };
}

/**
 * The cut plane's intersection with the mesh, as flat segment pairs
 * `[ax,ay,az, bx,by,bz, ...]` for a `LineSegments`.
 *
 * This is the outline the user needs in order to SEE where the plane is; without
 * it the cut has no visual edge at all (a clip plane removes material and leaves
 * nothing behind). Plane-vs-triangle by the book: a triangle contributes a segment
 * when exactly two of its three edges change side, and a vertex lying exactly ON the
 * plane counts as a crossing for both edges that touch it — otherwise an
 * axis-aligned cut through a cube's own vertices comes back with gaps.
 */
export function sectionSegmentsOnPlane(geometry: BufferGeometry, plane: SectionPlane): number[] {
  const position = geometry.getAttribute('position') as BufferAttribute | undefined;
  if (!position) return [];
  const { pointMm: origin, normal } = normalizePlane(plane);
  const offset = origin[0] * normal[0] + origin[1] * normal[1] + origin[2] * normal[2];
  const index = geometry.getIndex();
  const triangles = index ? index.count / 3 : position.count / 3;
  const out: number[] = [];
  const seen = new Set<string>();

  const vertex = (i: number): [number, number, number] => [
    position.getX(i),
    position.getY(i),
    position.getZ(i),
  ];
  // Signed distance in one expression: for a principal normal the x/y terms are
  // exactly 0 and this reduces to `p_axis − cut`, the pre-U20 expression, bit for
  // bit. Exact zeros therefore still mean "the vertex is on the plane".
  const distance = (corner: number): number => (
    position.getX(corner) * normal[0]
    + position.getY(corner) * normal[1]
    + position.getZ(corner) * normal[2]
    - offset
  );

  for (let t = 0; t < triangles; t++) {
    const corners = [0, 1, 2].map((offsetIndex) => (index ? index.getX(t * 3 + offsetIndex) : t * 3 + offsetIndex));
    const distances = corners.map(distance);

    const hits: [number, number, number][] = [];
    for (let edge = 0; edge < 3; edge++) {
      const from = corners[edge]!;
      const to = corners[(edge + 1) % 3]!;
      const dFrom = distances[edge]!;
      const dTo = distances[(edge + 1) % 3]!;
      if (dFrom === 0) {
        hits.push(vertex(from));
        continue;
      }
      // Strict sign change only: a zero at the far end is already counted by that
      // vertex's own edge, and counting it twice would duplicate the point.
      if (dFrom * dTo < 0) {
        const w = dFrom / (dFrom - dTo);
        const a = vertex(from);
        const b = vertex(to);
        hits.push([
          a[0] + (b[0] - a[0]) * w,
          a[1] + (b[1] - a[1]) * w,
          a[2] + (b[2] - a[2]) * w,
        ]);
      }
    }
    if (hits.length !== 2) continue;
    // A segment lying along a SHARED edge is emitted by BOTH triangles that own
    // that edge (a 45° cut makes the plane coincide with the cube's own edges).
    // The doubled multiset makes `chainLoops` walk out and back, so the loop's
    // signed area cancels to 0 and the cap comes back EMPTY — measured as
    // "45° cube: 1 loop of 8 points, area 0.0000mm²" before this dedupe. GEOS does
    // the same thing on the Python side: `unary_union` merges coincident lines.
    // Key on the quantized endpoint pair so the two triangles' last bits agree.
    const key = [hits[0]!, hits[1]!].map((point) => `${Math.round(point[0] * 1e6)},${Math.round(point[1] * 1e6)},${Math.round(point[2] * 1e6)}`);
    key.sort();
    const id = `${key[0]}|${key[1]}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(...hits[0]!, ...hits[1]!);
  }
  return out;
}

/** Pre-U20 signature: outline segments of a principal-axis cut. */
export function sectionSegments(geometry: BufferGeometry, axis: SectionAxis, cut: number): number[] {
  return sectionSegmentsOnPlane(geometry, axisPlane(axis, cut));
}

/**
 * Nearest mesh vertex within `maxDistanceMm`, or null.
 *
 * A click is never exact, and a vertex is the one point on a triangulated part that
 * is unambiguously "there" — so snapping to a vertex turns "aim at the corner" into
 * "click near the corner". A linear scan is used deliberately: it runs once per
 * click over the part's own vertex array (tens of thousands of points, ~0.1 ms), and
 * a spatial index here would be a second copy of the geometry's positions to keep in
 * sync with the one the renderer owns.
 */
export function nearestVertex(
  positions: ArrayLike<number>,
  point: readonly [number, number, number],
  maxDistanceMm: number,
): [number, number, number] | null {
  let best = maxDistanceMm * maxDistanceMm;
  let bestIndex = -1;
  for (let i = 0; i < positions.length; i += 3) {
    const dx = positions[i]! - point[0];
    const dy = positions[i + 1]! - point[1];
    const dz = positions[i + 2]! - point[2];
    const distance = dx * dx + dy * dy + dz * dz;
    if (distance < best) {
      best = distance;
      bestIndex = i;
    }
  }
  if (bestIndex < 0) return null;
  return [positions[bestIndex]!, positions[bestIndex + 1]!, positions[bestIndex + 2]!];
}

/**
 * World millimetres per screen pixel at a point, so a snap radius can be stated in
 * the units the user actually aims with (pixels) instead of millimetres, which
 * change meaning as soon as the part is scaled or the camera zooms.
 */
export function millimetresPerPixel(
  options: { fovDeg: number; viewportHeightPx: number; distanceMm: number },
): number {
  const { fovDeg, viewportHeightPx, distanceMm } = options;
  if (viewportHeightPx <= 0) return 0;
  const visibleHeight = 2 * Math.abs(distanceMm) * Math.tan((fovDeg * Math.PI) / 360);
  return visibleHeight / viewportHeightPx;
}
