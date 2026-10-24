// Acceptance for the rollback (T3.4, host half).
//
// A rollback must be an ADDITION, never a rewrite: the approved revert becomes a
// new version whose parent is the part's head, its geometry a byte copy of the
// target, and the target itself untouched. If any of those is false the corpus
// has lost the very property (immutable history) that makes a rollback safe.
//
//   node scripts/accept-revert.mjs
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { openVersionStore, saveVersion, readManifest, revertVersion } = await import('../src/host/version.ts');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const tmp = join(ROOT, `.tmp-revert-${process.pid}`);
await rm(tmp, { recursive: true, force: true });
await mkdir(tmp, { recursive: true });
const store = openVersionStore(tmp);

// A tiny "solid": the bytes only need to be copied verbatim, not to be valid STL.
const stlOf = (n) => new TextEncoder().encode(`solid v${n}\nfacet\nendsolid v${n}\n`);

try {
  const v1 = await saveVersion(store, {
    scadCode: 'cube(10);', stl: stlOf(1), userIntent: '第一版',
    partId: 'p001',
    datumSet: { points: [{ name: '底', point: [0, 0, 0] }], axes: [], planes: [], cylinders: [] },
  });
  const v2 = await saveVersion(store, { scadCode: 'cube(12);', stl: stlOf(2), userIntent: '第二版', parentVersion: v1, partId: 'p001' });
  check(v1 === 'v001' && v2 === 'v002', 'two versions exist', `${v1}, ${v2}`);

  const before = await readManifest(store);
  const reverted = await revertVersion(store, v1, { reason: '第二版把孔打穿了' });
  check(reverted === 'v003', 'a rollback gets a NEW version id', reverted);

  const after = await readManifest(store);
  check(after.versions.length === 3, 'history grew by one (nothing was replaced)', `${before.versions.length} -> ${after.versions.length}`);
  check(after.versions.some((v) => v.id === v1) && after.versions.some((v) => v.id === v2),
    'the target and the abandoned head both still exist');

  const entry = after.versions.find((v) => v.id === reverted);
  check(entry?.parentVersion === v2, "the rollback's parent is the part's head", String(entry?.parentVersion));
  check(entry?.userIntent.includes(`回退到 ${v1}`), 'the intent says where it came from', entry?.userIntent);
  check(entry?.source?.kind === 'revert' && entry.source.fromVersionId === v1,
    'the provenance records the revert', JSON.stringify(entry?.source));

  const revertedBytes = await readFile(join(tmp, 'versions', reverted, 'model.stl'));
  const targetBytes = await readFile(join(tmp, 'versions', v1, 'model.stl'));
  check(Buffer.compare(revertedBytes, targetBytes) === 0, 'the geometry is a byte copy of the target');
  const datums = JSON.parse(await readFile(join(tmp, 'versions', reverted, 'datums.json'), 'utf8'));
  check(datums.points?.[0]?.name === '底', 'datum anchors travel with the rollback', JSON.stringify(datums.points?.[0]));

  // ── refusals ─────────────────────────────────────────────────────────────
  let threw = '';
  try { await revertVersion(store, 'v999'); } catch (e) { threw = String(e && e.message ? e.message : e); }
  check(/unknown version "v999"/.test(threw), 'an unknown target is refused by name', threw);

  // A version with no model.stl (an interrupted import) cannot be rolled back to.
  await writeFile(join(tmp, 'versions', 'v009', 'model.scad'), 'cube(1);').catch(async () => {
    await mkdir(join(tmp, 'versions', 'v009'), { recursive: true });
    await writeFile(join(tmp, 'versions', 'v009', 'model.scad'), 'cube(1);');
  });
  const m = await readManifest(store);
  m.versions.push({ id: 'v009', timestamp: new Date().toISOString(), userIntent: '空的', parentVersion: null, partId: 'p001', status: 'draft' });
  await writeFile(join(tmp, 'manifest.json'), JSON.stringify(m, null, 2));
  threw = '';
  try { await revertVersion(store, 'v009'); } catch (e) { threw = String(e && e.message ? e.message : e); }
  check(/no model\.stl/.test(threw), 'a version with no geometry says so', threw);
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log(failures ? `\nFAILED (${failures})` : '\nOK');
process.exit(failures ? 1 : 0);
