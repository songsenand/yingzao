// Acceptance for stale-evidence marking (DESGIGN §22).
//
// The rule the user asked to enforce: updating a part does NOT update the
// whole-machine results that cite it — a rigid-body/physics/assembly run keeps
// saying "pass" over geometry that no longer exists. The plugin now marks such
// runs (`staleVersionIds`) so the row and the report say it out loud.
//
// Verified against the REAL buildProducts (pure function, same code the host
// route and the UI sandbox both call):
//
//   1. a run citing a superseded version → staleVersionIds names it;
//   2. a run citing the newest version → not marked;
//   3. a run citing the only version of a part → not marked;
//   4. scene runs (no version ids) are never marked.
//
//   node scripts/accept-stale-evidence.mjs

import { buildProducts } from '../src/host/products.ts';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const version = (id, partId, timestamp) => ({ id, partId, timestamp, userIntent: id, status: 'draft' });
const part = (id, name, versionIds) => ({
  id, name, nameSource: 'agent',
  createdAt: '2026-10-01T00:00:00.000Z',
  lastActiveAt: '2026-10-02T00:00:00.000Z',
  versionIds,
});
const run = (id, sourceVersionIds, kind = 'physics') => ({
  id, kind, timestamp: '2026-10-02T01:00:00.000Z',
  title: `${kind} over ${sourceVersionIds.join('+') || 'inline'}`,
  status: 'pass', summary: 'looks green', sourceVersionIds,
  hasGeometry: true, parts: ['轴'],
});

const versions = [
  version('v001', 'p1', '2026-10-01T10:00:00.000Z'),
  version('v002', 'p1', '2026-10-01T11:00:00.000Z'),   // newest of p1
  version('v003', 'p2', '2026-10-01T12:00:00.000Z'),   // only version of p2
];
const parts = [part('p1', '轴', ['v001', 'v002']), part('p2', '座', ['v003'])];
const runs = [
  run('r001', ['v001']),   // superseded → stale
  run('r002', ['v002']),   // newest → fine
  run('r003', ['v003']),   // only version → fine
  run('r004', []),         // inline scene → fine
  run('r005', ['v999']),   // unknown id → not our call to judge
];

const payload = buildProducts(versions, parts, runs);
const byId = new Map();
for (const p of payload.parts) for (const r of p.runs) byId.set(r.id, r);
for (const r of payload.scene) byId.set(r.id, r);

const stale = (id) => byId.get(id)?.staleVersionIds;

check(JSON.stringify(stale('r001')) === JSON.stringify(['v001']),
  'a run citing a superseded version IS marked', JSON.stringify(stale('r001')));
check(stale('r002') === undefined,
  'a run citing the newest version is NOT marked', JSON.stringify(stale('r002')));
check(stale('r003') === undefined,
  'a run citing a part\'s only version is NOT marked', JSON.stringify(stale('r003')));
check(stale('r004') === undefined,
  'an inline-scene run (no versions) is NOT marked', JSON.stringify(stale('r004')));
check(stale('r005') === undefined,
  'an unknown version id is not judged', JSON.stringify(stale('r005')));

// Multiple stale citations in one run are all named.
{
  const multi = buildProducts(versions, parts, [run('r006', ['v001', 'v003'])]);
  const got = multi.parts.flatMap((p) => p.runs).find((r) => r.id === 'r006')?.staleVersionIds;
  check(JSON.stringify(got) === JSON.stringify(['v001']),
    'only the superseded citation is named, not the current one', JSON.stringify(got));
}

console.log(`\n${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
