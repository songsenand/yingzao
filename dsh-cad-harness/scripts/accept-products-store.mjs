// Acceptance for the shared products poller (T0.3).
//
// The panel and the header's "open the tab on CAD activity" watcher each polled
// `/api/cad/products` every 3 s: two full builds and two payloads per tick. The
// store owns that request — one timer, one in-flight fetch, fan-out to every
// subscriber, and no polling while the document is hidden.
//
// This runs in Node with a stubbed `fetch`, which is enough to pin the part that
// used to be duplicated: how many REQUESTS a tick costs.
//
//   node scripts/accept-products-store.mjs
const wire = {
  parts: [{ id: 'p1', name: '甲', nameSource: 'agent', lastActiveAt: '2026-01-02T00:00:00Z',
    versions: [{ type: 'version', id: 'v001', timestamp: '2026-01-01T00:00:00Z', status: 'draft',
      title: 'a', partId: 'p1', parentVersion: null, source: 'generated', solid: true }],
    runIds: [] }],
  runs: [],
  sceneRunIds: [],
};

let calls = 0;
globalThis.fetch = async () => {
  calls++;
  return new Response(JSON.stringify(wire), { status: 200, headers: { 'content-type': 'application/json' } });
};

const { subscribeProducts, refreshProducts, productsSnapshot } = await import('../src/client/products-store.ts');
const { setProjectOverride } = await import('../src/client/project.ts');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

// The panel has no default project: an empty path must not fetch at all.
setProjectOverride(null);
await refreshProducts();
check(calls === 0 && productsSnapshot().data === null,
  'no project selected → no request (no cwd/root default)', `${calls} calls`);
setProjectOverride('/tmp/cad-products-store-project');

const seen = [];
const offA = subscribeProducts((s) => seen.push(['a', s]));
const offB = subscribeProducts((s) => seen.push(['b', s]));

await new Promise((r) => setTimeout(r, 80));

check(calls === 1, 'two subscribers cost ONE request', `${calls} calls`);
check(seen.some(([who]) => who === 'a') && seen.some(([who]) => who === 'b'), 'both subscribers were notified', `${seen.length} notifications`);
check(productsSnapshot().data?.parts?.[0]?.id === 'p1', 'the wire is inflated for subscribers', productsSnapshot().data?.parts?.[0]?.name);

// A forced refresh is still one request even when called twice in a row.
calls = 0;
await Promise.all([refreshProducts(), refreshProducts()]);
check(calls === 1, 'concurrent forced refreshes are coalesced', `${calls} calls`);

// A late subscriber gets the current tree WITHOUT a new request.
calls = 0;
const offC = subscribeProducts(() => {});
await new Promise((r) => setTimeout(r, 40));
check(calls === 1, 'a late subscriber replays the snapshot, then ticks', `${calls} calls`);

offA(); offB(); offC();
await new Promise((r) => setTimeout(r, 20));
calls = 0;
await new Promise((r) => setTimeout(r, 60));
check(calls === 0, 'the last unsubscribe stops the poller', `${calls} calls`);

// A project switch while a request is in flight must not wait for it. Before
// this fix the new project reused the old request's promise, so the panel could
// show an empty list for a whole 3 s interval after the human picked a project.
setProjectOverride('/tmp/cad-store-A');
const pending = [];
globalThis.fetch = (url) => new Promise((resolve) => {
  pending.push({ url: String(url), resolve });
});
const requestA = refreshProducts();
setProjectOverride('/tmp/cad-store-B');
const requestB = refreshProducts();
check(pending.length === 2,
  'a different project starts its own request instead of reusing the in-flight one', `${pending.length} requests`);
check(pending[0].url.includes('cad-store-A') && pending[1].url.includes('cad-store-B'),
  'each request names the project it was made for');
pending[1].resolve(new Response(JSON.stringify({ ...wire, project: '/tmp/cad-store-B' }), {
  status: 200, headers: { 'content-type': 'application/json' },
}));
await requestB;
check(productsSnapshot().data?.project === '/tmp/cad-store-B' && productsSnapshot().data?.parts?.length === 1,
  'the newly selected project lands immediately', JSON.stringify(productsSnapshot().data?.project));
// The old reply arrives late: its project is no longer selected, so it must not
// repaint the tree (nor clear it with its empty part list).
pending[0].resolve(new Response(JSON.stringify({ ...wire, parts: [], project: '/tmp/cad-store-A' }), {
  status: 200, headers: { 'content-type': 'application/json' },
}));
await requestA;
check(productsSnapshot().data?.project === '/tmp/cad-store-B' && productsSnapshot().data?.parts?.length === 1,
  'a stale reply from the previous project is ignored', JSON.stringify(productsSnapshot().data?.project));
setProjectOverride(null);

console.log(failures ? `\nFAILED (${failures})` : '\nOK');
process.exit(failures ? 1 : 0);
