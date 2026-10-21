// Every step gets a budget, and a blown budget is REPORTED — never swallowed.
//
// WHY: the recurring complaint is "it ran halfway and just sat there". The worker has a
// 120 s default timeout, so a hung step costs two silent minutes; a delivery sequence of
// five such steps is ten minutes of nothing. A tool that cannot answer in a bounded time
// must say so and hand back a partial report — waiting is not a feature.
//
// NOTE: a JS promise cannot be cancelled — the timeout abandons the promise (the worker
// finishes or is reset on the next call). That is why the caller must treat a timeout as
// "unknown", never as a result.

export type DeadlineResult<T> = { ok: true; value: T; ms: number } | { ok: false; reason: string; ms: number };

export async function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<DeadlineResult<T>> {
  const t0 = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded its ${ms} ms budget`)), ms);
  });
  try {
    const value = await Promise.race([p, timeout]);
    return { ok: true, value, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, reason: String((e as Error)?.message ?? e), ms: Date.now() - t0 };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
