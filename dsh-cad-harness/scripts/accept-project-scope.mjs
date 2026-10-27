// Acceptance for project-scoped storage (DESIGN §13.13).
//
// The bug this locks down: every store used to be opened once, at plugin apply,
// from the plugin's own installation directory. A brand-new project therefore
// listed the previous project's parts, and `ensurePart()`'s NAME matching meant
// a new project's 底座 silently adopted the old project's 底座.
//
// What has to be true:
//   1. A project's identity is the session cwd, and it is STABLE and DISTINCT:
//      one directory = one key, different directories = different keys, and the
//      spelling of the path (`..`, trailing slash) does not change it.
//   2. The three stores of a project live under `<DSH_HOME>/cad/<key>`, and two
//      projects never share a root.
//   3. The REAL route handlers isolate corpora: `/api/cad/products`, the version
//      STL route and the run routes answer from the project named by
//      `?project=`, so `v001` in project A and `v001` in project B are two
//      different parts. A relative `?project=` is never resolved.
//   4. A tool call resolves its project from the calling agent's session header
//      (`agent.session.header.cwd`), not from the server's cwd.
//   5. Nothing addresses a store at plugin-apply time any more (the static half
//      of the same claim), and usage telemetry is deliberately profile-wide.
//   6. Every browser request carries the project: no `/api/cad` URL in the client
//      is built without `withProject`.
//
//   node scripts/accept-project-scope.mjs

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

// A private DSH_HOME, set before anything reads it: this script must never
// touch the user's real corpora. project.ts reads the env lazily, so setting it
// in module body (after the static imports resolve) is early enough.
const FAKE_HOME = mkdtempSync(join(tmpdir(), 'cad-accept-'));
process.env.DSH_HOME = FAKE_HOME;

const { dshHome, ensureProjectDir, projectCwdOf, projectKey, projectsHome, projectStores, requestCwd, telemetryRoot } =
  await import('../src/host/project.ts');
const { registerCadTools } = await import('../src/host/tools.ts');
const { cadToolsVisible, cadMissingToolsNotice } = await import('../src/client/project.ts');
const { saveVersion, listVersions } = await import('../src/host/version.ts');
const { attachVersion, ensurePart, listParts } = await import('../src/host/parts.ts');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const section = (t) => console.log(`\n--- ${t}`);

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// --- 1. identity: stable, distinct, spelling-insensitive --------------------
section('project key = the session cwd');
{
  const a = join(FAKE_HOME, 'proj-a');
  const b = join(FAKE_HOME, 'proj-b');
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });

  check(projectKey(a) === projectKey(a), 'same path → same key');
  check(projectKey(a) !== projectKey(b), 'different paths → different keys', `${projectKey(a)} vs ${projectKey(b)}`);
  check(projectKey(a) === projectKey(join(a, '.')), '`.` does not change the key');
  check(projectKey(a) === projectKey(a + '/'), 'a trailing slash does not change the key');
  check(projectKey(join(a, 'sub', '..')) === projectKey(a), '`..` resolves before hashing');

  // Same basename, different parents: the hash is what separates them.
  const twin1 = join(FAKE_HOME, 'x', 'microscope');
  const twin2 = join(FAKE_HOME, 'y', 'microscope');
  check(projectKey(twin1) !== projectKey(twin2), 'same basename in two parents stays distinct',
    `${projectKey(twin1)} vs ${projectKey(twin2)}`);
  check(projectKey('/') .length > 0, 'a path with no basename still yields a key', projectKey('/'));
}

// --- 2. layout: one cad-data/ INSIDE each project (DESIGN §19) --------------
section('storage layout');
{
  check(dshHome() === FAKE_HOME, 'DSH_HOME is honoured', dshHome());
  const a = join(FAKE_HOME, 'proj-a');
  const b = join(FAKE_HOME, 'proj-b');
  const sa = projectStores(a);
  const sb = projectStores(b);
  check(projectsHome() === join(FAKE_HOME, 'cad'), 'profile-level home stays at <DSH_HOME>/cad (telemetry)', projectsHome());
  check(sa.root === join(a, 'cad-data'), 'store root is <cwd>/cad-data — the project owns its corpus', sa.root);
  check(!sa.root.startsWith(projectsHome()), 'store root is NOT under DSH_HOME anymore', sa.root);
  check(sa.root !== sb.root, 'two projects never share a root');
  check(sa.store.root === sa.root && sa.runStore.root === join(sa.root, 'runs') && sa.partStore.root === join(sa.root, 'parts'),
    'all three stores are rooted at the project directory');
  check(sa === projectStores(join(a, '.')), 'one instance per project (memoised)');
  check(telemetryRoot() === join(projectsHome(), 'telemetry'), 'telemetry is a sibling, not a project');
}

// --- 2b. in-project semantics: delete the folder, lose the corpus ------------
{
  const { existsSync } = await import('node:fs');
  const a = join(FAKE_HOME, 'proj-del');
  const s1 = projectStores(a);
  await ensureProjectDir(s1);
  mkdirSync(join(s1.root, 'versions', 'v001'), { recursive: true });
  writeFileSync(join(s1.root, 'versions', 'v001', 'model.stl'), 'stl-bytes');
  check(existsSync(join(a, 'cad-data', 'versions', 'v001', 'model.stl')),
    'artifacts land inside the project folder', join(a, 'cad-data'));

  rmSync(join(a, 'cad-data'), { recursive: true, force: true });
  const s2 = projectStores(a);
  check(s2.root === join(a, 'cad-data') && !existsSync(s2.root),
    'deleting cad-data deletes the corpus; the next read is empty (and not an error)');
  mkdirSync(join(s2.root, 'versions', 'v001'), { recursive: true });
  writeFileSync(join(s2.root, 'versions', 'v001', 'model.stl'), 'fresh');
  check(readFileSync(join(s2.root, 'versions', 'v001', 'model.stl'), 'utf8') === 'fresh',
    'recreating the project in place starts a FRESH corpus (no inheritance)');
}

// --- 3. the real routes isolate corpora -------------------------------------
section('route handlers (real registration, fake connection)');
const routes = new Map();
const toolNames = [];
const fakeCtx = {
  tools: { register: (def) => { toolNames.push(def?.name); return () => {}; } },
  on: () => {},
  effect: (fn) => { const d = fn(); return d; },
  reflect: {
    get: (key) => (key === 'agentPresets' ? { list: async () => [{ id: 'cad', name: '造物模式' }, { id: 'standard', name: '标准模式' }] } : key === 'connection' ? {
      fetch: { register: (route) => { routes.set(route.path, route); return () => {}; } },
      rpc: { intercept: () => () => {} },
    } : undefined),
  },
};
registerCadTools(fakeCtx, { toolScope: 'preset', presets: ['cad'] });
check(routes.size > 10, 'routes registered', `${routes.size} routes, ${toolNames.length} tools`);

const get = async (path) => {
  const url = new URL(`http://localhost${path}`);
  const route = routes.get(url.pathname);
  if (!route) throw new Error(`no route ${url.pathname}`);
  const res = await route.fetch(new Request(url, { method: 'GET' }));
  const buf = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, buf, json: () => JSON.parse(new TextDecoder().decode(buf)) };
};

{
  const cwdA = join(FAKE_HOME, 'proj-a');
  const cwdB = join(FAKE_HOME, 'proj-b');
  const A = projectStores(cwdA);
  const B = projectStores(cwdB);
  await ensureProjectDir(A);
  await ensureProjectDir(B);

  const STL_A = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const STL_B = new Uint8Array([9, 9, 9, 9]);

  const partA = await ensurePart(A.partStore, '底座', 'agent');
  const vA = await saveVersion(A.store, { scadCode: 'cube(1);', stl: STL_A, userIntent: 'A 的底座', partId: partA.id });
  await attachVersion(A.partStore, partA.id, vA);

  const partB = await ensurePart(B.partStore, '底座', 'agent');
  const vB = await saveVersion(B.store, { scadCode: 'sphere(2);', stl: STL_B, userIntent: 'B 的底座', partId: partB.id });
  await attachVersion(B.partStore, partB.id, vB);

  check(vA === 'v001' && vB === 'v001', 'both projects number their versions from v001', `${vA} / ${vB}`);
  check(partA.id === partB.id, 'both projects number their parts from p001', `${partA.id} / ${partB.id}`);

  // The bug, at the route level: a fresh project must read EMPTY.
  const prodA = (await get(`/api/cad/products?project=${encodeURIComponent(cwdA)}`)).json();
  const prodB = (await get(`/api/cad/products?project=${encodeURIComponent(cwdB)}`)).json();
  check(prodA.parts.length === 1 && prodA.parts[0].name === '底座', 'project A sees its own part');
  check(prodB.parts.length === 1, 'project B sees its own part too');
  check(prodA.parts[0].versions[0].title === 'A 的底座' && prodB.parts[0].versions[0].title === 'B 的底座',
    'the same part name and version id resolve to different designs');

  const partsB = await listParts(B.partStore);
  check(partsB.length === 1 && (await listVersions(B.store)).length === 1, 'B\'s stores carry exactly B\'s one part/version');
  check((await listParts(A.partStore)).length === 1, 'A\'s part list did not absorb B\'s work');

  // Same id, different project, different bytes.
  const stlA = await get(`/api/cad/stl?v=v001&project=${encodeURIComponent(cwdA)}`);
  const stlB = await get(`/api/cad/stl?v=v001&project=${encodeURIComponent(cwdB)}`);
  check(stlA.status === 200 && stlB.status === 200, 'v001 resolves in both projects');
  check(stlA.buf.length === STL_A.length && stlB.buf.length === STL_B.length && stlA.buf[0] === 1 && stlB.buf[0] === 9,
    'v001 returns each project\'s own geometry');

  // A project that has never been written reads as empty, not as an error.
  const fresh = join(FAKE_HOME, 'never-used');
  mkdirSync(fresh, { recursive: true });
  const prodFresh = await get(`/api/cad/products?project=${encodeURIComponent(fresh)}`);
  check(prodFresh.status === 200 && prodFresh.json().parts.length === 0 && prodFresh.json().sceneRunIds.length === 0,
    'a brand-new project lists nothing (and is not an error)');

  // The project rides the payload so a panel can drop a stale reply.
  check(prodA.project === resolve(cwdA) && prodB.project === resolve(cwdB), 'the payload echoes its project');

  // A run named by id must not leak across projects either.
  const runB = await get(`/api/cad/run?id=r001&project=${encodeURIComponent(cwdB)}`);
  check(runB.status === 404, 'no such run in an untouched project', `HTTP ${runB.status}`);
}

// --- 3b. the panel can tell "no CAD tools in this session" -------------------
section('tool-scope reporting (the trap that produced a skill error)');
{
  const scope = await get('/api/cad/scope');
  check(scope.status === 200 && scope.json().toolScope === 'preset' && scope.json().presets.includes('cad'),
    'the host reports its tool scope and the presets that open the tools',
    JSON.stringify(scope.json()));
  check(scope.json().names?.cad === '造物模式',
    'the host resolves preset display names from the roster', JSON.stringify(scope.json().names));
  // The client predicate mirrors src/host/tool-scope.ts (minus delegation).
  const s = { toolScope: 'preset', presets: ['cad'] };
  check(cadToolsVisible(s, 'cad') === true, 'CAD preset session: no warning');
  check(cadToolsVisible(s, 'standard') === false, 'standard session: warn (this is the bug we hit)');
  check(cadToolsVisible(s, null) === true, 'unknown preset: stay silent');
  check(cadToolsVisible(null, 'standard') === true, 'scope not fetched yet: stay silent');
  check(cadToolsVisible({ toolScope: 'global', presets: [] }, 'standard') === true,
    'global tool scope: every session has the tools');

  // The banner must name the situation, because the two are not the same thing:
  // a blank session can still be switched, a started one cannot. Reporting the
  // wrong one sends the human down a path that cannot work.
  const noTools = { toolScope: 'preset', presets: ['cad'], names: { cad: '造物模式', standard: '标准模式' } };
  check(cadMissingToolsNotice(noTools, 'cad', false) === null, 'CAD preset: no banner');
  const blankNotice = cadMissingToolsNotice(noTools, 'standard', true);
  const lockedNotice = cadMissingToolsNotice(noTools, 'standard', false);
  const unknownNotice = cadMissingToolsNotice(noTools, 'standard', null);
  check(blankNotice !== null && /还没开始|重新选/.test(blankNotice),
    'blank session: the banner says the choice is still recoverable', blankNotice);
  check(lockedNotice !== null && /锁定|默认预设/.test(lockedNotice),
    'started session: the banner offers a new session or a new default', lockedNotice);
  check(/造物模式/.test(lockedNotice) && !/「cad」/.test(lockedNotice),
    'the banner names the preset the way the human sees it');
  check(unknownNotice !== null && unknownNotice !== lockedNotice,
    'unknown blank state: the banner makes no claim it cannot back', unknownNotice);
}

// --- 3c. reading the sessions store the way the real store is read ----------
section('client session lookups (the reader that silently returned undefined)');
{
  const client = await import('../src/client/project.ts');
  // The REAL store is a uSES SnapshotStore: `getSnapshot()` only. A fake that
  // exposes just that method is the regression test for the bug that made the
  // part list empty in every session.
  const summary = { cwd: '/home/u/proj', blank: true, projectionValues: { agentPreset: 'cad' } };
  client.setProjectServices({
    sessions: { list: { getSnapshot: () => ({ current: 's1', byId: { s1: summary } }) } },
  });
  check(client.currentSessionCwd() === '/home/u/proj', 'the cwd is read from a getSnapshot-only store',
    client.currentSessionCwd());
  check(client.currentSessionPreset() === 'cad', 'the preset is read from the same snapshot');
  check(client.currentSessionBlank() === true, 'the blank bit is read from the same snapshot');
  const { switched } = client.refreshProjectScope();
  check(switched && client.currentProject() === '/home/u/proj', 'the project scope picks the cwd up');
  const url = client.withProject('/api/cad/products');
  check(url === `/api/cad/products?project=${encodeURIComponent('/home/u/proj')}`,
    'every CAD URL then carries the project', url);
  check(client.withProject('/api/cad/stl?v=v001').endsWith(`&project=${encodeURIComponent('/home/u/proj')}`),
    'an existing query string is appended to, not replaced');
  // A store whose snapshot has no cwd must not invent one.
  client.setProjectServices({ sessions: { list: { getSnapshot: () => ({ current: 's2', byId: { s2: {} } }) } } });
  client.refreshProjectScope();
  check(client.currentProject() === '' && client.withProject('/api/cad/products') === '/api/cad/products',
    'an unknown cwd sends no project rather than a wrong one');
}

// --- 4. request/tool project resolution -------------------------------------
section('project resolution');
{
  const cwdA = join(FAKE_HOME, 'proj-a');
  check(requestCwd(new Request(`http://x/api/cad/products?project=${encodeURIComponent(cwdA)}`)) === cwdA,
    '?project= names the project');
  check(requestCwd(new Request('http://x/api/cad/products?project=../secrets')) === process.cwd(),
    'a RELATIVE ?project= is refused, not resolved', requestCwd(new Request('http://x/api/cad/products?project=../secrets')));
  check(requestCwd(new Request('http://x/api/cad/products')) === process.cwd(),
    'no ?project= falls back to the server cwd');
  check(requestCwd(new Request('http://x/api/cad/products?project=')) === process.cwd(),
    'an empty ?project= falls back too');

  check(projectCwdOf({ agent: { session: { header: { cwd: cwdA } } } }) === cwdA,
    'a tool call takes its project from the agent session cwd');
  check(projectCwdOf({}) === process.cwd(), 'a call with no agent falls back to the server cwd');
  check(projectCwdOf({ agent: { session: { header: {} } } }) === process.cwd(), 'a session without a cwd falls back too');
}

// --- 5. static invariants: nothing is captured at apply time ----------------
section('static invariants');
{
  const tools = read('src/host/tools.ts');
  check(!/open(Version|Run|Part)Store\(/.test(tools), 'tools.ts opens no store of its own (it resolves per call)');
  check(!/ctxRevisionRoot/.test(tools), 'the plugin-root data path is gone from tools.ts');
  const blocks = tools.split(/registerTool\(defineTool\(\{/).slice(1);
  // `simulate_lbm` is a global lattice channel: it reads no project store, so
  // there is no execution context for it to receive. Every other tool must take
  // `exec` — that is what keeps a project-scoped body from silently losing it.
  const unscoped = blocks
    .filter((b) => /async execute\(args: unknown\)/.test(b))
    .map((b) => /name: '([^']+)'/.exec(b)?.[1] ?? '?');
  const scopedExecutes = blocks.filter((b) => /async execute\(args: unknown, exec: unknown\)/.test(b)).length;
  // Counted against the registration sites rather than a literal: adding a tool
  // must not be able to leave this check passing while a body silently loses its
  // execution context (the whole point of the invariant).
  const registrations = (tools.match(/registerTool\(defineTool\(\{/g) ?? []).length;
  check(unscoped.length === 1 && unscoped[0] === 'simulate_lbm' && scopedExecutes === registrations - 1,
    'every project-scoped tool body receives its execution context',
    `${scopedExecutes} scoped, ${unscoped.join(',') || 'none'} global, ${registrations} registrations`);
  check(!/\bstore\b\s*:\s*VersionStore\s*=/.test(tools), 'no module-level VersionStore remains');

  // Every route registration resolves a project (the two globals excepted).
  const region = tools.slice(tools.indexOf('const registerWhenReady'));
  const globals = new Set(['/api/cad/usage', '/api/cad/scope']);
  let routesChecked = 0;
  for (const chunk of region.split('connection.fetch.register({').slice(1)) {
    const path = /path: '([^']+)'/.exec(chunk)?.[1];
    if (!path) continue;
    routesChecked++;
    if (globals.has(path)) continue;
    check(/requestStores\(request\)|requestStores\(req/.test(chunk), `route ${path} resolves its project`);
  }
  check(routesChecked >= 15, 'checked every registered route', `${routesChecked} routes`);
  for (const helper of ['runFileRoute', 'latestFileRoute', 'partRoute', 'runQuery']) {
    const body = new RegExp(`const ${helper} =[\\s\\S]{0,700}`).exec(region)?.[0] ?? '';
    if (helper === 'runQuery') continue; // pure query parsing, no store access
    check(/requestStores\(request\)/.test(body), `helper ${helper} resolves its project`);
  }

  // Usage telemetry is profile-wide by design.
  const usage = read('src/host/usage.ts');
  check(!/from '\.\/version\.ts'/.test(usage), 'usage.ts no longer takes a project store');
  check(/registerUsageObserver\(ctx: any\)/.test(usage) && /registerUsageObserver\(ctx\)/.test(tools),
    'the usage observer is registered profile-wide');
  check(/telemetryRoot\(\)/.test(usage), 'usage telemetry writes under the telemetry root');

  // The client: every PROJECT-scoped /api/cad URL either goes through
  // withProject or carries `project=` explicitly. The unregistered list and the
  // local-file preview are session-scoped by design (they must not follow the
  // pinned corpus), so they build the URL by hand. `/api/cad/scope` and
  // `/api/cad/projects` are global (profile-wide decision; workspace discovery)
  // and must NOT carry a project.
  const globalUrls = new Set(['/api/cad/scope', '/api/cad/projects']);
  const stray = [];
  for (const file of ['src/client/panel.ts', 'src/client/playback.ts', 'src/client/index.ts', 'src/client/project.ts']) {
    for (const line of read(file).split('\n')) {
      if (!/\/api\/cad/.test(line)) continue;
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;      // comment
      if (/withProject/.test(line)) continue;
      if (/[?&]project=/.test(line)) continue;            // explicit, session-scoped
      if ([...globalUrls].some((u) => line.includes(u))) continue;
      stray.push(`${file}: ${line.trim()}`);
    }
  }
  check(stray.length === 0, 'no client request is built without the project', stray.join(' | '));
  check(/export function withProject/.test(read('src/client/project.ts')), 'withProject is the one URL builder');

  // The migration script and the runtime must agree on the project key.
  const migration = read('scripts/migrate-to-projects.mjs');
  check(/from '\.\.\/src\/host\/project\.ts'/.test(migration),
    'the migration script uses the runtime key function rather than a copy');
}

// ── client: which session is on stage (DESIGN §18) ─────────────────────────
// The 2026-10-03 dsh upgrade removed the list snapshot's `current` field; the
// panel could no longer resolve the session on stage, every request lost its
// `?project=`, and every project showed the host's own corpus. The fix mirrors
// the shipped preset picker: current = live binding + mainView retention.
{
  const {
    refreshProjectScope, currentSessionCwd, currentSessionPreset,
    setProjectServices, withProject,
  } = await import('../src/client/project.ts');

  const A = '/home/songsenand/Project/ToyMarker';
  const B = '/home/songsenand/Project/ToyMarker/examples/microscope4';
  const newShapeStore = (activeId) => ({
    list: {
      getSnapshot: () => ({
        byId: {
          sA: { id: 'sA', cwd: A, projectionValues: { agentPreset: 'cad' }, blank: false },
          sB: { id: 'sB', cwd: B, projectionValues: { agentPreset: 'standard' }, blank: true },
        },
        // deliberately NO `current` — the post-upgrade shape
      }),
      subscribe: () => () => {},
    },
    binding: (id) => (id === activeId ? { sessionId: activeId } : undefined),
    retainInfo: (id) => ({ getSnapshot: () => ({ retainedBy: { mainView: id === activeId ? 1 : 0 } }) }),
  });

  setProjectServices({ sessions: newShapeStore('sA') });
  refreshProjectScope();
  check(currentSessionCwd() === A, 'client (new shape): the bound+retained session is on stage', currentSessionCwd());
  check(currentSessionPreset() === 'cad', 'client (new shape): preset reads from the resolved id');
  check(withProject('/api/cad/products') === `/api/cad/products?project=${encodeURIComponent(A)}`,
    'client (new shape): requests carry ?project=<cwd>');

  setProjectServices({ sessions: newShapeStore('sB') });
  refreshProjectScope();
  check(currentSessionCwd() === B && refreshProjectScope().cwd === B,
    'client (new shape): switching the binding switches the project', currentSessionCwd());
  check(currentSessionPreset() === 'standard', 'client (new shape): preset follows the switch');

  setProjectServices({ sessions: newShapeStore(null) });
  refreshProjectScope();
  check(currentSessionCwd() === '' && withProject('/api/cad/products') === '/api/cad/products',
    'client (new shape): no bound session → bare URL (host-side fallback), never a stale project');

  setProjectServices({
    sessions: { list: { getSnapshot: () => ({ current: 'sL', byId: { sL: { cwd: A } } }) } },
  });
  refreshProjectScope();
  check(currentSessionCwd() === A, 'client (legacy shape): `current` still honored (older deployments)');

  setProjectServices({ sessions: newShapeStore('sA') });
  refreshProjectScope();
  setProjectServices({ sessions: newShapeStore('sB') });
  check(refreshProjectScope().switched === true, 'client: refreshProjectScope reports the switch');
}

rmSync(FAKE_HOME, { recursive: true, force: true });
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
