// Acceptance: the manifest files survive concurrent writers (T0.4).
//
// All three stores wrote `read — mutate — tmp + rename` with a FIXED temp name.
// The rename was atomic per write; the read-modify-write was not. Two writers on
// one project (two sessions, or two tool calls in a turn) each read the same
// snapshot, and the later write dropped the earlier row — while both could rename
// each other's `manifest.json.tmp`.
//
//   node scripts/accept-manifest-lock.mjs
import { mkdir, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { saveVersion, openVersionStore } = await import('../src/host/version.ts');
const { createUniquePart, openPartStore } = await import('../src/host/parts.ts');
const { beginRun, openRunStore } = await import('../src/host/runs.ts');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const tmp = join(ROOT, `.tmp-manifest-lock-${process.pid}`);
await rm(tmp, { recursive: true, force: true });
await mkdir(tmp, { recursive: true });

try {
  // ---- versions -------------------------------------------------------------
  const vs = openVersionStore(tmp);
  const ids = await Promise.all(
    Array.from({ length: 20 }, (_, i) => saveVersion(vs, { userIntent: `并发第 ${i} 版` })),
  );
  check(new Set(ids).size === 20, '20 concurrent saves get 20 distinct ids', `${new Set(ids).size} ids`);
  const vm = JSON.parse(await readFile(join(tmp, 'manifest.json'), 'utf8'));
  check(vm.versions.length === 20, 'the version index kept all 20 rows', `${vm.versions.length} rows`);
  check(ids.every((id) => existsSync(join(tmp, 'versions', id))), 'every id has its directory');

  // Control: the allocation WITHOUT exclusion collapses — this is the race the
  // lock removes, shown rather than asserted from memory.
  const snap = await readdir(join(tmp, 'versions'));
  const naiveMax = snap.reduce((m, n) => (/^v(\d{3,})$/.test(n) ? Math.max(m, parseInt(n.slice(1), 10)) : m), 0);
  const naive = Array.from({ length: 20 }, () => `v${String(naiveMax + 1).padStart(3, '0')}`);
  check(new Set(naive).size === 1, 'control: 20 unlocked allocations collapse onto one id', `${new Set(naive).size} distinct`);

  // ---- parts ----------------------------------------------------------------
  const ps = openPartStore(tmp);
  const created = await Promise.all(Array.from({ length: 20 }, () => createUniquePart(ps, '甲')));
  const pm = JSON.parse(await readFile(join(tmp, 'parts', 'manifest.json'), 'utf8'));
  check(new Set(created.map((p) => p.id)).size === 20, '20 concurrent parts get 20 ids');
  check(new Set(created.map((p) => p.name)).size === 20, '20 concurrent same-name parts get 20 distinct names');
  check(pm.parts.length === 20, 'the part index kept all 20 rows', `${pm.parts.length} rows`);

  // ---- runs -----------------------------------------------------------------
  const rs = openRunStore(tmp);
  const committed = await Promise.all(Array.from({ length: 20 }, async (_, i) => {
    const w = await beginRun(rs, { kind: 'printability', title: `并发运行 ${i}` });
    await w.json('report.json', { i });
    return w.commit({ status: 'pass', summary: `第 ${i} 次` });
  }));
  const rmf = JSON.parse(await readFile(join(tmp, 'runs', 'manifest.json'), 'utf8'));
  check(new Set(committed.map((r) => r.id)).size === 20, '20 concurrent runs get 20 distinct ids');
  check(rmf.runs.length === 20, 'the run index kept all 20 rows', `${rmf.runs.length} rows`);

  // ---- a stale lock is reclaimed, not waited out ----------------------------
  const lock = join(tmp, 'manifest.json.lock');
  await writeFile(lock, '999999 2000-01-01T00:00:00Z\n');
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  const t0 = performance.now();
  await saveVersion(vs, { userIntent: '崩溃的写者留下的锁' });
  const waited = performance.now() - t0;
  check(waited < 3000, 'a stale lock is reclaimed instead of blocking the writer', `${waited.toFixed(0)} ms`);
  check(!existsSync(lock), 'the lock is released after the write');
  const after = JSON.parse(await readFile(join(tmp, 'manifest.json'), 'utf8'));
  check(after.versions.length === 21, 'the write after a stale lock landed', `${after.versions.length} rows`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log(failures ? `\nFAILED (${failures})` : '\nOK');
process.exit(failures ? 1 : 0);
