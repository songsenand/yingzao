// The panel's view of the review queue: one poller, one snapshot, many listeners.
//
// Why a store and not a fetch in the panel: the badge (status band) and the
// overlay must not disagree, and the tab-level UI may want the count later. Same
// shape as products-store: visibility-aware (a hidden tab does not poll), one
// in-flight request, and a 304-like "nothing new" is just an unchanged snapshot.
//
// The poll is deliberately NOT tied to the products tick: the products reply is
// conditional (304 when the corpus did not change), so a queue-only change would
// never be seen.

import { withProject } from './project.ts';

export interface ReviewItem {
  id: string;
  kind: 'view' | 'revert';
  title: string;
  body: string;
  target: string | null;
  createdAt: string;
  status: 'unread' | 'read' | 'dismissed';
  resolvedBy?: string;
}

export interface ReviewSnapshot {
  items: ReviewItem[];
  unread: number;
  error: string | null;
}

const POLL_MS = 5000;

let snapshot: ReviewSnapshot = { items: [], unread: 0, error: null };
const listeners = new Set<(s: ReviewSnapshot) => void>();
let inflight: Promise<void> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

const emit = () => { for (const fn of [...listeners]) fn(snapshot); };

function startPolling(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    void refreshReviewQueue();
  }, POLL_MS);
}

function stopPolling(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function reviewSnapshot(): ReviewSnapshot {
  return snapshot;
}

export async function refreshReviewQueue(): Promise<void> {
  if (inflight) return inflight;
  inflight = fetch(withProject('/api/cad/review/queue'))
    .then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json() as { items?: ReviewItem[]; unread?: number };
      snapshot = { items: data.items ?? [], unread: data.unread ?? 0, error: null };
      emit();
    })
    .catch((e: unknown) => {
      snapshot = { ...snapshot, error: String((e as Error)?.message ?? e) };
      emit();
    })
    .finally(() => { inflight = null; });
  return inflight;
}

/** Subscribe to the queue; fires once with the current snapshot. */
export function subscribeReviewQueue(fn: (s: ReviewSnapshot) => void): () => void {
  listeners.add(fn);
  fn(snapshot);
  void refreshReviewQueue();
  startPolling();
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0) stopPolling();
  };
}

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const r = await fetch(withProject(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({})) as Record<string, unknown>;
  if (!r.ok) throw new Error(String(data?.error ?? `HTTP ${r.status}`));
  return data;
}

/** Mark an item read / dismissed / unread. Optimistic: the poll reconciles. */
export async function setReviewItemStatus(id: string, status: ReviewItem['status']): Promise<void> {
  const items = snapshot.items.map((i) => (i.id === id ? { ...i, status } : i));
  snapshot = { ...snapshot, items, unread: items.filter((i) => i.status === 'unread').length };
  emit();
  await post('/api/cad/review/status', { id, status });
  void refreshReviewQueue();
}

/** Approve a rollback proposal: the host adds a version and resolves the item. */
export async function approveReviewItem(id: string): Promise<{ versionId: string; from: string }> {
  const data = await post('/api/cad/review/approve', { id });
  void refreshReviewQueue();
  return { versionId: String(data.versionId ?? ''), from: String(data.from ?? '') };
}
