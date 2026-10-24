// Acceptance for the review queue (T4.1).
//
// The queue is the ONLY channel an agent has to ask for attention, so its limits
// are the anti-spam contract: three per call, six calls per ten minutes, twenty
// unread, same target merges inside ten minutes. Each of those is a number a
// caller can trip over — this script trips them on purpose.
//
//   node scripts/accept-review-queue.mjs
import { mkdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const {
  enqueueReviews, readQueue, setReviewStatus, MAX_PER_CALL, MAX_UNREAD, RATE_MAX, RATE_WINDOW_MS,
} = await import('../src/host/review-queue.ts');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const base = join(ROOT, `.tmp-queue-${process.pid}`);
await rm(base, { recursive: true, force: true });
const T0 = Date.parse('2026-10-24T10:00:00.000Z');
const mk = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({
  title: `第 ${i + 1} 件`, body: '', target: `v00${i + 1}`, ...extra,
}));

try {
  // ── 1. per-call cap + merge ───────────────────────────────────────────────
  const a = join(base, 'cap');
  await mkdir(a, { recursive: true });
  let r = await enqueueReviews(a, mk(5), T0);
  check(r.queued.length === MAX_PER_CALL, `one call queues at most ${MAX_PER_CALL}`, `${r.queued.length}`);
  check(r.dropped === 2, 'the rest are reported as dropped, not silently lost', `${r.dropped}`);

  r = await enqueueReviews(a, [{ title: '同一目标', target: 'v001' }], T0 + 60_000);
  check(r.merged.length === 1 && r.queued.length === 0, 'same target inside 10 min merges into one item');
  const afterMerge = await readQueue(a);
  check(afterMerge.items.length === MAX_PER_CALL, 'merging does not add a row', `${afterMerge.items.length}`);

  // ── 2. status transitions ────────────────────────────────────────────────
  const first = afterMerge.items[0];
  const read = await setReviewStatus(a, first.id, 'read');
  check(read?.status === 'read', 'an item can be marked read', first.id);
  const later = await readQueue(a);
  check(later.items.filter((i) => i.status === 'unread').length === 2, 'unread count drops after reading', later.items.filter((i) => i.status === 'unread').length);
  check((await setReviewStatus(a, 'q999', 'read')) === null, 'an unknown id is null, not an exception');

  // ── 3. rate limit: six accepted calls per window ─────────────────────────
  const b = join(base, 'rate');
  await mkdir(b, { recursive: true });
  for (let i = 0; i < RATE_MAX; i++) {
    const res = await enqueueReviews(b, [{ title: `c${i}` }], T0 + i * 1000);
    if (res.rateLimited) { check(false, `call ${i + 1} should be accepted`); }
  }
  const seventh = await enqueueReviews(b, [{ title: 'c7' }], T0 + 7000);
  check(seventh.rateLimited?.reason === 'rate', 'the seventh call in the window is rate-limited', JSON.stringify(seventh.rateLimited));
  check((seventh.rateLimited?.retryAfterSec ?? 0) > 0, 'and says how long to wait', `${seventh.rateLimited?.retryAfterSec}s`);
  const afterWindow = await enqueueReviews(b, [{ title: 'c8' }], T0 + RATE_WINDOW_MS + 1000);
  check(!afterWindow.rateLimited && afterWindow.queued.length === 1, 'after the window it accepts again');

  // ── 4. queue full at MAX_UNREAD ──────────────────────────────────────────
  const c = join(base, 'full');
  await mkdir(c, { recursive: true });
  let last;
  for (let i = 0; i < 7; i++) {
    // One call per window, so the RATE limit is not what stops it — the QUEUE is.
    // Distinct titles: identical titles inside one call are the SAME finding and
    // are meant to merge (that is rule 1 above, not a way to fill the queue).
    const batch = mk(3).map((item, k) => ({ ...item, title: `批 ${i}-${k}`, target: null }));
    last = await enqueueReviews(c, batch, T0 + i * (RATE_WINDOW_MS + 1000));
  }
  const q = await readQueue(c);
  check(q.items.length === MAX_UNREAD, `the queue stops at ${MAX_UNREAD} unread`, `${q.items.length}`);
  check(last?.rateLimited?.reason === 'queue_full', 'and the refusing call says the queue is full', JSON.stringify(last?.rateLimited));

  // ── 5. concurrent writes keep every item ─────────────────────────────────
  const d = join(base, 'lock');
  await mkdir(d, { recursive: true });
  await Promise.all([
    enqueueReviews(d, [{ title: '并发 A' }], T0),
    enqueueReviews(d, [{ title: '并发 B' }], T0),
  ]);
  const both = await readQueue(d);
  check(both.items.length === 2, 'two concurrent calls both land (the file lock serializes them)', `${both.items.length}`);
} finally {
  await rm(base, { recursive: true, force: true });
}

console.log(failures ? `\nFAILED (${failures})` : '\nOK');
process.exit(failures ? 1 : 0);
