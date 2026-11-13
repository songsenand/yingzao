// Acceptance for "only the current conversation may auto-open the CAD tab".
//
// The user-visible bug: another running conversation wrote to the same project,
// the shared products poller saw new activity, and the right-side viewer popped
// open with content this conversation had never asked for. Two independent
// pieces have to hold:
//
//   1. Every version/run committed by a tool carries the calling session id,
//      and concurrent tool calls cannot overwrite each other's identity
//      (AsyncLocalStorage, not a module variable).
//   2. The client's open decision compares that id with the conversation on
//      screen; unknown provenance fails closed (no popup).
//
//   node scripts/accept-cad-activity.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const { projectStores } = await import('../src/host/project.ts');
const { ensurePart, attachVersion, listParts } = await import('../src/host/parts.ts');
const { saveVersion, readManifest } = await import('../src/host/version.ts');
const { beginRun, listRuns } = await import('../src/host/runs.ts');
const { buildProducts, buildProductsWire } = await import('../src/host/products.ts');
const { withOriginSession } = await import('../src/host/provenance.ts');
const { decideActivityOpen } = await import('../src/client/activity.ts');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const section = (text) => console.log(`\n--- ${text}`);

const base = mkdtempSync(join(tmpdir(), 'cad-activity-'));
try {
  // --- 1. the pure decision ------------------------------------------------
  section('auto-open decision');
  const activity = (id, sessionId) => ({ at: '2026-01-01T00:00:00.000Z', kind: 'version', id, sessionId });
  {
    const first = decideActivityOpen({ activity: activity('v001', 's1'), newestAt: 100, lastSeen: null, sessionId: 's1' });
    check(!first.open && first.reason === 'baseline' && first.lastSeen === 100,
      'the first observation only establishes the baseline');

    const current = decideActivityOpen({ activity: activity('v002', 's1'), newestAt: 200, lastSeen: 100, sessionId: 's1' });
    check(current.open && current.reason === 'current' && current.lastSeen === 200,
      'a newer artifact from this conversation opens the tab');

    const other = decideActivityOpen({ activity: activity('v003', 's2'), newestAt: 300, lastSeen: 200, sessionId: 's1' });
    check(!other.open && other.reason === 'other-session' && other.lastSeen === 300,
      'another conversation\'s artifact never opens this tab (and advances the baseline)');

    const legacy = decideActivityOpen({ activity: activity('v004', undefined), newestAt: 400, lastSeen: 300, sessionId: 's1' });
    check(!legacy.open && legacy.reason === 'no-provenance',
      'unknown provenance fails closed rather than opening an unrelated panel');

    const unknownSession = decideActivityOpen({ activity: activity('v005', 's1'), newestAt: 500, lastSeen: 400, sessionId: '' });
    check(!unknownSession.open && unknownSession.reason === 'no-session',
      'when the on-screen conversation cannot be told, nothing auto-opens');

    const stale = decideActivityOpen({ activity: activity('v001', 's1'), newestAt: 500, lastSeen: 500, sessionId: 's1' });
    check(!stale.open && stale.reason === 'stale', 'nothing new → no decision to act on');
  }

  // --- 2. host provenance: versions ---------------------------------------
  section('versions carry the writing session');
  const project = projectStores(join(base, 'project'));
  const part = await ensurePart(project.partStore, '底座', 'agent');
  let vA = '';
  let vB = '';
  await Promise.all([
    withOriginSession('session-A', async () => {
      vA = await saveVersion(project.store, {
        scadCode: 'cube(1);', stl: new Uint8Array([1, 2]), userIntent: 'A', partId: part.id,
      });
    }),
    withOriginSession('session-B', async () => {
      vB = await saveVersion(project.store, {
        scadCode: 'cube(2);', stl: new Uint8Array([3, 4]), userIntent: 'B', partId: part.id,
      });
    }),
  ]);
  await attachVersion(project.partStore, part.id, vA);
  await attachVersion(project.partStore, part.id, vB);

  const manifest = await readManifest(project.store);
  const origin = (id) => manifest.versions.find((v) => v.id === id)?.originSessionId;
  check(origin(vA) === 'session-A' && origin(vB) === 'session-B',
    'two concurrent tool calls keep their own session ids', `${vA}→${origin(vA)}, ${vB}→${origin(vB)}`);

  // A write with no session scope (an HTTP route or a script) has no origin.
  const routeVersion = await saveVersion(project.store, {
    userIntent: 'route import', partId: part.id, stl: new Uint8Array([5]),
  });
  await attachVersion(project.partStore, part.id, routeVersion);
  check(origin(routeVersion) === undefined, 'a route/script write is not attributed to a conversation');

  // --- 3. host provenance: runs + the products activity echo --------------
  section('runs and the products activity payload');
  const writer = await withOriginSession('session-C', async () => {
    const run = await beginRun(project.runStore, { kind: 'analyze', title: '检查' });
    await run.commit({ status: 'pass', summary: 'ok', sourceVersionIds: [vA] });
    return run;
  });
  const versions = (await readManifest(project.store)).versions;
  const parts = await listParts(project.partStore);
  const runs = await listRuns(project.runStore);
  const products = buildProducts(versions, parts, runs);
  const wire = buildProductsWire(versions, parts, runs);
  check(products.activity?.kind === 'run' && products.activity?.id === writer.id,
    'the newest commit is the activity', JSON.stringify(products.activity));
  check(products.activity?.sessionId === 'session-C',
    'the activity names the conversation that committed the run', JSON.stringify(products.activity));
  check(wire.activity?.sessionId === 'session-C',
    'the compact wire carries the same provenance (the panel reads that shape)');
} finally {
  rmSync(base, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAIL` : '\nall PASS');
process.exit(failures ? 1 : 0);
