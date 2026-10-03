// Give the versions that predate part identity a part to live in.
//
// There is no explicit signal in the old corpus, so the buckets are derived and
// every part created here is marked `nameSource: 'intent'` — the panel says so
// out loud ("零件名由 userIntent 推导"). Two signals, in this order:
//
// Only one signal is used: exact `userIntent` text — the same part re-generated
// as a fresh root (调焦轴 appears as v011/v016/v021/v026/v031, each an
// independent root).
//
// `parentVersion` is deliberately NOT used: the corpus has exactly one such link
// and it is wrong (v003, a Ø12 shaft, points at v002, a square base plate).
// Trusting it would file a shaft under a base plate — the very bug that made
// part identity necessary. After the tool change the link is validated, but the
// legacy corpus cannot be repaired by inference.
//
// What it cannot do: tell "same part, different parameter" from "different
// part". 调焦轴 Ø8 and 负样本: 轴 Ø9.2 end up in different buckets even though
// the second is a variant of the first. That is exactly why identity is declared
// going forward instead of inferred.
//
//   node scripts/migrate-parts.mjs            # dry run (prints the buckets)
//   node scripts/migrate-parts.mjs --write    # stamp partId + write the index
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  attachVersion, createUniquePart, derivePartName, openPartStore, readPartManifest,
} from '../src/host/parts.ts';

const DATA = join(new URL('../', import.meta.url).pathname, 'data');
const partStore = openPartStore(DATA);
const write = process.argv.includes('--write');

const manifestPath = join(DATA, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const versions = manifest.versions ?? [];
const byId = new Map(versions.map((v) => [v.id, v]));

if ((await readPartManifest(partStore)).parts.length > 0 && write) {
  console.error('data/parts/manifest.json already has parts — refusing to re-bucket.');
  console.error('Delete it (and the partId fields) first if you really mean to redo this.');
  process.exit(1);
}

// --- bucket: identical intent text -----------------------------------------
const byBucket = new Map();
for (const v of versions) {
  const key = (v.userIntent ?? '').trim();
  if (!byBucket.has(key)) byBucket.set(key, []);
  byBucket.get(key).push(v);
}
const buckets = [...byBucket.entries()].map(([key, list]) => ({
  key,
  name: derivePartName(list[0].userIntent),
  versions: list.map((v) => v.id),
}));

console.log(`将 ${versions.length} 个版本分成 ${buckets.length} 个零件：`);
for (const b of buckets) {
  const tag = b.versions.length > 1 ? `×${b.versions.length}` : '  ';
  console.log(`  ${tag} ${b.name.padEnd(26)} ${b.versions.join(' ')}`);
}

if (!write) {
  console.log('\n(dry run — pass --write to create the parts and stamp partId)');
  process.exit(0);
}

for (const b of buckets) {
  const part = await createUniquePart(partStore, b.name, 'intent');
  for (const vid of b.versions) {
    const entry = byId.get(vid);
    entry.partId = part.id;
    await attachVersion(partStore, part.id, vid);
  }
}
await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`\nwrote data/parts/manifest.json (${buckets.length} parts) and stamped partId on ${versions.length} versions`);
