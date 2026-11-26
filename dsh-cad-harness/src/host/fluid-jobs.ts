// Fluid run jobs: progress, cancellation, and no orphans.
//
// A fluid run is the one CAD operation that takes minutes (measured: 161 s on a
// real part), and it used to be a single opaque HTTP request: no percentage, no
// way to stop it, and a closed tab left the run going. This registry is the
// bookkeeping half — it does not run anything itself, so it can be tested with
// fake runners (`scripts/accept-fluid-jobs.mjs`) instead of a real 161 s solve.
//
// CANCELLATION IS NOT A PROMISE FLAG. `cancel` is supplied by the caller and is
// expected to kill the thing doing the work (the Python worker) — a promise that
// simply stops being awaited would leave the process running, which is exactly
// the orphan this exists to prevent. The registry only records the outcome.

export type FluidJobStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface FluidJobRecord {
  id: string;
  status: FluidJobStatus;
  /** Steps completed, as reported by the solver. */
  done: number;
  /** Total steps, once known (0 = the caller did not say yet). */
  total: number;
  startedAt: string;
  finishedAt?: string;
  /** The version the run is about, when it came from one. */
  versionId?: string;
  error?: string;
}

export interface StartFluidJobOptions {
  versionId?: string;
  /** The work. Receives the progress sink; resolves when the run is done. */
  run: (onProgress: (done: number, total: number) => void) => Promise<unknown>;
  /** Kill the actual work. Must make `run` reject promptly. */
  cancel: () => void;
  /** Template literal id for tests (default `f<n>`); production passes randomUUID. */
  id?: string;
}

export class FluidJobRegistry {
  private readonly jobs = new Map<string, FluidJobRecord>();
  private readonly cancels = new Map<string, () => void>();
  private next = 1;

  start(options: StartFluidJobOptions): string {
    const id = options.id ?? `f${this.next++}`;
    const record: FluidJobRecord = {
      id,
      status: 'running',
      done: 0,
      total: 0,
      startedAt: new Date().toISOString(),
      ...(options.versionId ? { versionId: options.versionId } : {}),
    };
    this.jobs.set(id, record);
    this.cancels.set(id, options.cancel);
    // The run is not awaited: the caller polls `get`. Failures are recorded, not
    // thrown into the void — an unhandled rejection here would be invisible to
    // the panel, which is the state this registry exists to end.
    void (async () => {
      const onProgress = (done: number, total: number) => {
        const current = this.jobs.get(id);
        if (!current || current.status !== 'running') return;
        // Monotonic: a late frame from a killed run must not rewind the bar.
        if (done > current.done) current.done = done;
        if (total > 0) current.total = total;
      };
      try {
        await options.run(onProgress);
        const current = this.jobs.get(id);
        if (current && current.status === 'running') {
          current.status = 'done';
          current.finishedAt = new Date().toISOString();
          if (current.total > 0) current.done = current.total;
        }
      } catch (error) {
        const current = this.jobs.get(id);
        if (current && current.status === 'running') {
          current.status = 'failed';
          current.finishedAt = new Date().toISOString();
          current.error = String((error as Error)?.message ?? error);
        }
      } finally {
        this.cancels.delete(id);
      }
    })();
    return id;
  }

  get(id: string): FluidJobRecord | null {
    return this.jobs.get(id) ?? null;
  }

  list(): FluidJobRecord[] {
    return [...this.jobs.values()];
  }

  /**
   * Ask the work to stop. The record flips to `cancelled` IMMEDIATELY (the caller
   * stopped the process), so a poll 50 ms later never sees "running" again — and
   * the run's own rejection is then ignored rather than recorded as a failure.
   */
  cancel(id: string): boolean {
    const record = this.jobs.get(id);
    if (!record || record.status !== 'running') return false;
    const cancel = this.cancels.get(id);
    this.cancels.delete(id);
    record.status = 'cancelled';
    record.finishedAt = new Date().toISOString();
    try { cancel?.(); } catch { /* the process may already be gone */ }
    return true;
  }

  /** Drop finished records older than `keepMs` (the map is not a history store). */
  prune(keepMs = 60 * 60 * 1000, now = Date.now()): number {
    let removed = 0;
    for (const [id, record] of [...this.jobs.entries()]) {
      if (record.status === 'running') continue;
      const at = record.finishedAt ? Date.parse(record.finishedAt) : now;
      if (now - at > keepMs) { this.jobs.delete(id); removed++; }
    }
    return removed;
  }
}
