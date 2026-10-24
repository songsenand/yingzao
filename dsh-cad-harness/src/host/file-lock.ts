// Cross-process mutual exclusion for the manifest files, plus the atomic write
// they all need.
//
// WHY this exists: `manifest.json` (versions), `runs/manifest.json` and
// `parts/manifest.json` were all written as "read — mutate — tmp + rename". The
// rename is atomic per write, but the read-modify-write is not: two sessions on
// the same project (or two tool calls in one turn) each read the same snapshot and
// the later write drops the earlier row. The tmp file name was also FIXED
// (`manifest.json.tmp`), so two writers could rename each other's temp file and
// publish half of each other's data.
//
// The lock is a file created with O_EXCL — the one primitive that works across
// processes without a daemon. A lock older than STALE_MS is assumed abandoned
// (crashed process) and reclaimed; waiters time out rather than hang forever.
//
// Rules this module assumes (and the stores follow):
//   * the lock is held for the WHOLE read-modify-write, and the read happens
//     INSIDE it — a merge is not "read twice", it is "read under the lock";
//   * temp names are unique per writer, so a stale temp can never be published.

import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

/** A lock older than this is considered abandoned (a crashed writer). */
export const LOCK_STALE_MS = 10_000;
/** How long a waiter tolerates contention before giving up. */
export const LOCK_TIMEOUT_MS = 10_000;
const RETRY_MS = 8;

/** Run `fn` holding an exclusive lock on `file` (the lock lives beside it). */
export async function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  await mkdir(dirname(file), { recursive: true });
  const started = Date.now();
  let handle;
  for (;;) {
    try {
      handle = await open(lock, 'wx');
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
      break;
    } catch (e: unknown) {
      if ((e as { code?: string })?.code !== 'EEXIST') throw e;
      try {
        const st = await stat(lock);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          // Abandoned by a writer that died holding it.
          await unlink(lock).catch(() => {});
          continue;
        }
      } catch {
        continue; // the holder released it between our open and our stat
      }
      if (Date.now() - started > LOCK_TIMEOUT_MS) {
        throw new Error(`timed out waiting for ${lock} (another writer holds it)`);
      }
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }
  }
  try {
    return await fn();
  } finally {
    await handle.close().catch(() => {});
    await unlink(lock).catch(() => {});
  }
}

/**
 * Write JSON through a UNIQUE temp file, then rename.
 *
 * The temp name carries pid + a random suffix: with a fixed name, two writers
 * racing (even without the lock) can rename each other's partially written file
 * into place.
 */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, file);
}

/** Read a small integer counter, or 0 when absent/garbage. */
export async function readCounter(file: string): Promise<number> {
  try {
    const n = parseInt((await readFile(file, 'utf8')).trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Persist a counter (no lock of its own — callers hold the manifest lock). */
export async function writeCounter(file: string, value: number): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, String(value));
}
