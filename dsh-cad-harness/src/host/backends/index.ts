// Kernel registry: the single lookup behind compile(source, {kernel}).
//
// A registered adapter needs only `{ id, compile }`. Planned kernels stay
// metadata-only and are refused with `backend_not_available`; an unknown id is
// refused separately, and a duplicate/invalid registration is refused at the
// boundary instead of silently replacing an engine.

import { listBackends, type EngineAdapter } from '../backend.ts';
import { OPENSCAD_ADAPTER } from './openscad.ts';
import { CADQUERY_ADAPTER } from './cadquery.ts';

const registry = new Map<string, EngineAdapter>();
registry.set(OPENSCAD_ADAPTER.id, OPENSCAD_ADAPTER);
registry.set(CADQUERY_ADAPTER.id, CADQUERY_ADAPTER);

/** Register an engine for tests/providers. Duplicate ids are refused. */
export function registerEngineAdapter(adapter: EngineAdapter): void {
  if (!adapter || typeof adapter.id !== 'string' || adapter.id.trim() === '') {
    throw new Error('engine_registration: adapter needs a non-empty id');
  }
  if (typeof adapter.compile !== 'function') {
    throw new Error(`engine_registration: adapter "${adapter.id}" has no compile()`);
  }
  if (registry.has(adapter.id)) {
    throw new Error(`engine_registration: adapter "${adapter.id}" is already registered`);
  }
  registry.set(adapter.id, adapter);
}

/** Remove a registered engine (tests/teardown); returns whether it existed. */
export function unregisterEngineAdapter(id: string): boolean {
  return registry.delete(id);
}

/** Registered engine ids, OpenSCAD first. */
export function listEngineAdapters(): string[] {
  return [...registry.keys()];
}

/**
 * Resolve the adapter for a kernel.
 *
 * A registered adapter wins even when it is not in the metadata list (the fake
 * engine in accept-engine-seam needs exactly that). Unregistered ids fall back
 * to the metadata: unknown -> unknown, planned -> planned, available-without-
 * adapter -> a distinct "no adapter" error.
 */
export function engineAdapter(kernel: string): EngineAdapter {
  const id = String(kernel ?? '').trim();
  const registered = registry.get(id);
  if (registered) return registered;
  const meta = listBackends().find((backend) => backend.id === id);
  if (!meta) {
    throw new Error(
      `backend_not_available: unknown kernel "${id}" (available: ${listEngineAdapters().join(', ')})`,
    );
  }
  if (meta.status !== 'available') {
    throw new Error(`backend_not_available: "${id}" is ${meta.status} in this build`);
  }
  throw new Error(`backend_not_available: no adapter for "${id}" in this build`);
}

/** Backwards-compatible name used by older call sites and accept-backend. */
export const backendAdapter = engineAdapter;
