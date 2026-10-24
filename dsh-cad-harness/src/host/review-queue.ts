// The REVIEW QUEUE: the one channel an agent has to ask for a human's attention.
//
// WHY A QUEUE AND NOT A POPUP. The user's rule (DECISION-LOG 2026-10-23) is that
// attention can only be REQUESTED, never taken: the panel must not move the
// viewport, open a modal or steal a click because an agent finished something.
// A queue inverts the push: the agent appends, the human consumes when they
// choose, and an item that is never read costs nothing.
//
// The limits below are the anti-spam half. They are DECLARED constants, not
// heuristics: a burst of five findings becomes three items, a chatty loop hits
// `rate_limited` with the seconds to wait, and the same target inside the merge
// window updates one item instead of stacking ten.
//
// Storage is a JSON file per corpus (`<data>/panel/queue.json`), written under the
// same lock as everything else. It is UI state, not corpus truth: losing it
// loses no version, and rebuilding it needs nothing.

import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { withFileLock, writeJsonAtomic } from './file-lock.ts';

/** At most this many items are accepted from ONE call; the rest are reported. */
export const MAX_PER_CALL = 3;
/** Above this many unread items the queue refuses (the human is behind). */
export const MAX_UNREAD = 20;
/** Rate window: at most RATE_MAX accepted calls per window. */
export const RATE_WINDOW_MS = 10 * 60_000;
export const RATE_MAX = 6;
/** Same target (or same title) inside this window updates one item. */
export const MERGE_WINDOW_MS = 10 * 60_000;

export type ReviewKind = 'view' | 'revert';
export type ReviewStatus = 'unread' | 'read' | 'dismissed';

export interface ReviewItem {
  id: string;
  kind: ReviewKind;
  title: string;
  body: string;
  /** An address (`v029` / `r041` / `p005` / `u:path`) or null for a note. */
  target: string | null;
  createdAt: string;
  status: ReviewStatus;
  /** Set when an approved rollback produced a version: the id that resolved it. */
  resolvedBy?: string;
}

export interface QueueState {
  version: 1;
  nextId: number;
  items: ReviewItem[];
  /** Accepted-call timestamps (ms), pruned to the rate window on every write. */
  calls: number[];
}

export interface IncomingReview {
  kind?: ReviewKind;
  title: string;
  body?: string;
  target?: string | null;
}

export interface EnqueueResult {
  queued: { id: string; title: string }[];
  merged: { id: string; title: string }[];
  dropped: number;
  unread: number;
  rateLimited?: { reason: 'rate' | 'queue_full'; retryAfterSec: number; pending: number };
}

const empty = (): QueueState => ({ version: 1, nextId: 1, items: [], calls: [] });

export function queuePath(root: string): string {
  return join(root, 'panel', 'queue.json');
}

export async function readQueue(root: string): Promise<QueueState> {
  try {
    const raw = JSON.parse(await readFile(queuePath(root), 'utf8')) as Partial<QueueState>;
    return {
      version: 1,
      nextId: typeof raw.nextId === 'number' && raw.nextId > 0 ? raw.nextId : 1,
      items: Array.isArray(raw.items) ? raw.items.filter((i): i is ReviewItem => Boolean(i && i.id && i.title)) : [],
      calls: Array.isArray(raw.calls) ? raw.calls.filter((n): n is number => typeof n === 'number') : [],
    };
  } catch {
    return empty();
  }
}

/**
 * Append items, applying the limits. Returns what actually happened — a caller
 * that was rate-limited must be able to say so, not pretend it queued.
 */
export async function enqueueReviews(
  root: string,
  incoming: readonly IncomingReview[],
  now: number = Date.now(),
): Promise<EnqueueResult> {
  const file = queuePath(root);
  await mkdir(dirname(file), { recursive: true });
  return withFileLock(file, async () => {
    const state = await readQueue(root);
    state.calls = state.calls.filter((t) => now - t < RATE_WINDOW_MS);

    const unread = state.items.filter((i) => i.status === 'unread');
    if (state.calls.length >= RATE_MAX) {
      return {
        queued: [], merged: [], dropped: 0, unread: unread.length,
        rateLimited: {
          reason: 'rate' as const,
          retryAfterSec: Math.max(1, Math.ceil((state.calls[0]! + RATE_WINDOW_MS - now) / 1000)),
          pending: unread.length,
        },
      };
    }

    const accepted = incoming.slice(0, MAX_PER_CALL);
    const dropped = Math.max(0, incoming.length - accepted.length);
    const queued: EnqueueResult['queued'] = [];
    const merged: EnqueueResult['merged'] = [];
    let count = unread.length;
    /** Set when the queue filled mid-call: what we took is still written. */
    let full = false;

    for (const raw of accepted) {
      if (count >= MAX_UNREAD) { full = true; break; }
      const title = String(raw?.title ?? '').trim();
      if (!title) continue;
      const target = raw?.target ? String(raw.target).trim() : null;
      const body = String(raw?.body ?? '');
      const recent = state.items.find((i) => i.status === 'unread'
        && now - Date.parse(i.createdAt) < MERGE_WINDOW_MS
        && ((target && i.target === target) || i.title === title));
      if (recent) {
        // Same thing again inside ten minutes: refresh it instead of stacking.
        recent.body = body || recent.body;
        recent.createdAt = new Date(now).toISOString();
        merged.push({ id: recent.id, title: recent.title });
        continue;
      }
      const item: ReviewItem = {
        id: `q${String(state.nextId++).padStart(3, '0')}`,
        kind: raw?.kind === 'revert' ? 'revert' : 'view',
        title,
        body,
        target,
        createdAt: new Date(now).toISOString(),
        status: 'unread',
      };
      state.items.push(item);
      count += 1;
      queued.push({ id: item.id, title: item.title });
    }

    state.calls.push(now);
    await writeJsonAtomic(file, state);
    return {
      queued, merged, dropped, unread: count,
      // The cap was hit mid-batch: the items that DID fit are saved above, and
      // the caller is told the rest were refused (not silently dropped).
      ...(full ? { rateLimited: { reason: 'queue_full' as const, retryAfterSec: 0, pending: count } } : {}),
    };
  });
}

/** Change one item's status (`read` / `dismissed` / back to `unread`). */
export async function setReviewStatus(
  root: string,
  id: string,
  status: ReviewStatus,
  resolvedBy?: string,
): Promise<ReviewItem | null> {
  const file = queuePath(root);
  return withFileLock(file, async () => {
    const state = await readQueue(root);
    const item = state.items.find((i) => i.id === id) ?? null;
    if (!item) return null;
    item.status = status;
    if (resolvedBy) item.resolvedBy = resolvedBy;
    await writeJsonAtomic(file, state);
    return item;
  });
}
