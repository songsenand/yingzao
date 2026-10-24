// ONE fetch of `/api/cad/products` for the whole client half.
//
// WHY: two independent 3 s pollers hit the same endpoint — the panel's refresh and
// the header's "open the tab on CAD activity" watcher. That was two full builds and
// two payloads per tick, and neither stopped while the tab was hidden.
//
// The store is the single owner of that request:
//   * one timer, one in-flight request, fan-out to every subscriber;
//   * polls ONLY while the document is visible (a hidden tab costs nothing);
//   * `refreshProducts()` forces a tick — the panel calls it after a write it just
//     made (import, a run) instead of waiting up to 3 s.
//
// It deliberately holds no UI state: it serves the *wire* payload, inflated once
// (`coerceProducts`), and lets each subscriber apply its own selection rules.

import type { ProductsResponse } from '../shared/types.ts';
import { coerceProducts } from '../shared/products-wire.ts';
import { currentProject, withProject } from './project.ts';

export interface ProductsSnapshot {
  /** The last good tree, or null before the first success. */
  data: ProductsResponse | null;
  /** Last failure message; cleared by the next success (a host restart must not
   *  leave a permanent red row). */
  error: string | null;
  /** When `data` was received. */
  at: number;
}

type Listener = (snapshot: ProductsSnapshot) => void;

const POLL_MS = 3000;

let snapshot: ProductsSnapshot = { data: null, error: null, at: 0 };
// Conditional-request state: the corpus this tree came from, the read port's
// sequence and the ETag. A 304 means "nothing changed" — the client keeps what it
// has and emits nothing, so a quiet corpus costs zero builds and ~0 bytes.
let lastProject: string | null = null;
let lastSeq = 0;
let lastEtag: string | null = null;
let listeners = new Set<Listener>();
let timer: ReturnType<typeof setInterval> | null = null;
let inflight: Promise<void> | null = null;

const visible = (): boolean =>
  typeof document === 'undefined' || document.visibilityState !== 'hidden';

function emit(): void {
  for (const fn of listeners) {
    try { fn(snapshot); } catch { /* a subscriber must not break the others */ }
  }
}

function startTimer(): void {
  if (timer) return;
  timer = setInterval(() => { void tick(); }, POLL_MS);
  // A tab that comes back should not wait out the interval.
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
  }
}

function stopTimer(): void {
  if (timer) clearInterval(timer);
  timer = null;
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibility);
  }
}

function onVisibility(): void {
  if (visible()) void tick();
}

/** Fetch now (coalesced: concurrent callers share one request). */
export function tick(): Promise<void> {
  if (inflight) return inflight;
  if (!visible()) return Promise.resolve();
  const project = currentProject();
  const sameProject = lastProject === project;
  const url = withProject(`/api/cad/products${sameProject && lastSeq > 0 ? `?since=${lastSeq}` : ''}`);
  const headers: Record<string, string> =
    sameProject && lastEtag ? { 'if-none-match': lastEtag } : {};
  inflight = fetch(url, { headers })
    .then(async (r) => {
      if (r.status === 304) return; // unchanged: keep the tree, tell nobody
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const payload = await r.json() as { seq?: number } & Record<string, unknown>;
      lastProject = project;
      lastSeq = typeof payload.seq === 'number' ? payload.seq : 0;
      lastEtag = r.headers.get('etag');
      snapshot = { data: coerceProducts(payload), error: null, at: Date.now() };
      emit();
    })
    .catch((e: unknown) => {
      snapshot = { ...snapshot, error: String((e as Error)?.message ?? e) };
      emit();
    })
    .finally(() => { inflight = null; });
  return inflight;
}

/** Force a tick; safe to call from an event handler. */
export function refreshProducts(): Promise<void> {
  return tick();
}

export function productsSnapshot(): ProductsSnapshot {
  return snapshot;
}

/**
 * Subscribe to the shared tree. Replays the current snapshot immediately, so a
 * panel that mounts late does not wait a tick.
 *
 * @returns unsubscribe — the last subscriber stops the poller
 */
export function subscribeProducts(fn: Listener): () => void {
  listeners.add(fn);
  startTimer();
  if (snapshot.data || snapshot.error) fn(snapshot);
  void tick();
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0) stopTimer();
  };
}
