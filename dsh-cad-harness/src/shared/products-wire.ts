// The compact browse payload, and the one function that expands it.
//
// WHY two shapes: `buildProducts` puts a run under EVERY part whose geometry it
// used, which is right for reading and wrong for the wire — microscope5 stores 69
// runs and the inflated tree serialises them 438 times (211 KB) on a poll that
// fires every three seconds. The wire carries each run ONCE plus `runIds` per
// part; `inflateProducts` rebuilds the tree the rest of the panel already reads.
//
// Shared (no node: imports) because the client inflates exactly what the host
// serialised, and the sandbox serves the same wire.

import type { PartProduct, ProductsResponse, RunProduct, VersionProduct } from './types.ts';

/** A part on the wire: its versions plus the ids of the runs that belong to it. */
export interface PartWire {
  id: string;
  name: string;
  nameSource: 'agent' | 'intent';
  lastActiveAt: string;
  versions: VersionProduct[];
  /** Runs shown under this part, newest first. Ids only — the objects are in `runs`. */
  runIds: string[];
}

export interface ProductsWire {
  parts: PartWire[];
  /** Every run exactly once, newest first. */
  runs: RunProduct[];
  /** Runs that belong to no single part (0 owners, or ≥2): the cross-part bucket. */
  sceneRunIds: string[];
  /** Session cwd this tree was read from; echoed for project-switch guards. */
  project?: string;
}

/** Expand the wire into the tree shape the panel and the tools read. O(parts + runs). */
export function inflateProducts(wire: ProductsWire): ProductsResponse {
  const byId = new Map(wire.runs.map((r) => [r.id, r]));
  const take = (ids: readonly string[]): RunProduct[] => {
    const out: RunProduct[] = [];
    for (const id of ids) {
      const r = byId.get(id);
      if (r) out.push(r);
    }
    return out;
  };
  const parts: PartProduct[] = wire.parts.map((p) => ({
    id: p.id,
    name: p.name,
    nameSource: p.nameSource,
    lastActiveAt: p.lastActiveAt,
    versions: p.versions,
    runs: take(p.runIds),
  }));
  const scene = take(wire.sceneRunIds);
  return wire.project === undefined ? { parts, scene } : { parts, scene, project: wire.project };
}

/**
 * Accept either shape.
 *
 * The host and the panel ship together, but a page keeps running while the host
 * restarts (and the sandbox can serve either). A client that only understood the
 * new wire would blank the whole panel against an older host — a compatibility
 * shim here is cheaper than that failure mode.
 */
export function coerceProducts(payload: unknown): ProductsResponse {
  const p = payload as Partial<ProductsWire> & Partial<ProductsResponse>;
  if (Array.isArray(p?.runs) && Array.isArray(p?.parts) && p.parts.every((x) => Array.isArray((x as PartWire).runIds))) {
    return inflateProducts(p as ProductsWire);
  }
  return p as ProductsResponse;
}
