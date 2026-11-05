// Failure localization shared by pearl observers.
//
// Every failure says WHAT failed, WHY it may have failed, and WHERE to look.
// The location is approximate by construction: it is an AABB envelope, not a
// point cloud, and it never claims more precision than the report supports.

export type FailureSeverity = 'hard' | 'warn';

export interface SpatialLocation {
  kind: 'pair' | 'interface' | 'part' | 'manifest' | 'unknown';
  parts?: string[];
  bboxMin?: number[];
  bboxMax?: number[];
  center?: number[];
  point?: number[];
  sizeMm?: number[];
  approximate: true;
  note?: string;
}

export interface PearlFailure {
  code: string;
  severity: FailureSeverity;
  /** The failed criterion, phrased as an observation. */
  what: string;
  /** Plausible causes, not proven causes. */
  why: string[];
  /** Where to look. `approximate` is always true. */
  location: SpatialLocation;
  evidence: Record<string, unknown>;
  /** What to inspect/run next. */
  next: string[];
}

export interface Box {
  min: [number, number, number];
  max: [number, number, number];
}

export function manifestLocation(path: string, note = 'contract/evidence artifact; no geometry location'): SpatialLocation {
  return { kind: 'manifest', approximate: true, note };
}

export function unknownLocation(note: string): SpatialLocation {
  return { kind: 'unknown', approximate: true, note };
}

/** Pull part AABBs out of an assembly report (`parts[].boundingBox`). */
export function partBoxes(report: unknown): Map<string, Box> {
  const boxes = new Map<string, Box>();
  const parts = (report as { parts?: unknown } | null)?.parts;
  if (!Array.isArray(parts)) return boxes;
  for (const p of parts) {
    if (!p || typeof p !== 'object') continue;
    const name = (p as { name?: unknown }).name;
    const bb = (p as { boundingBox?: { min?: unknown; max?: unknown } }).boundingBox;
    if (typeof name !== 'string' || !bb || !Array.isArray(bb.min) || !Array.isArray(bb.max)) continue;
    if (bb.min.length < 3 || bb.max.length < 3) continue;
    const min = bb.min.slice(0, 3) as [number, number, number];
    const max = bb.max.slice(0, 3) as [number, number, number];
    if (![...min, ...max].every((n) => typeof n === 'number' && Number.isFinite(n))) continue;
    boxes.set(name, { min, max });
  }
  return boxes;
}

export function unionBoxes(boxes: Box[]): Box | null {
  if (boxes.length === 0) return null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], b.min[i]);
      max[i] = Math.max(max[i], b.max[i]);
    }
  }
  return { min, max };
}

export function intersectionBox(a: Box, b: Box): Box | null {
  const min: [number, number, number] = [Math.max(a.min[0], b.min[0]), Math.max(a.min[1], b.min[1]), Math.max(a.min[2], b.min[2])];
  const max: [number, number, number] = [Math.min(a.max[0], b.max[0]), Math.min(a.max[1], b.max[1]), Math.min(a.max[2], b.max[2])];
  if (max[0] < min[0] || max[1] < min[1] || max[2] < min[2]) return null;
  return { min, max };
}

export function locationFromBox(kind: SpatialLocation['kind'], parts: string[], box: Box | null, note: string): SpatialLocation {
  if (!box) return { kind, parts, approximate: true, note };
  const size = [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
  const center = [box.min[0] + size[0] / 2, box.min[1] + size[1] / 2, box.min[2] + size[2] / 2];
  return {
    kind, parts, bboxMin: box.min, bboxMax: box.max, center, sizeMm: size,
    approximate: true, note,
  };
}

export function pairLocation(report: unknown, a: string, b: string): SpatialLocation {
  const boxes = partBoxes(report);
  const ba = boxes.get(a);
  const bb = boxes.get(b);
  if (!ba || !bb) return { kind: 'pair', parts: [a, b], approximate: true, note: 'pair identified from report; AABB unavailable' };
  const hit = intersectionBox(ba, bb);
  if (hit) return locationFromBox('pair', [a, b], hit, 'intersection of the two part AABBs (approx.)');
  return locationFromBox('pair', [a, b], unionBoxes([ba, bb]), 'pair envelope; AABBs do not overlap (gap/clearance, approx.)');
}

export function interfaceLocation(report: unknown, iface: { id?: unknown; a?: unknown; b?: unknown }): SpatialLocation {
  const boxes = partBoxes(report);
  const ids = [iface.a, iface.b]
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.split('.')[0]!)
    .filter((s) => s.length > 0);
  const found = ids.map((id) => boxes.get(id)).filter((b): b is Box => !!b);
  const label = typeof iface.id === 'string' ? `interface ${iface.id} (${ids.join(' ↔ ')})` : `interface (${ids.join(' ↔ ')})`;
  return locationFromBox('interface', ids, unionBoxes(found), `${label}; union of endpoint part AABBs (approx.)`);
}
