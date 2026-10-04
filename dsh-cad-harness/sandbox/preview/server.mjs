// Sandbox preview server for the CAD panel UI.
//
// Serves the REAL panel bundle against the REAL `data/` store, so layout work
// can be reviewed headlessly without touching the live dsh web GUI (which needs
// auth and lives outside the writable sandbox).
//
//   node sandbox/preview/server.mjs [port]        # CAD_SANDBOX_DATA overrides data/
//
// Routes:
//   /                -> sandbox/preview/index.html
//   /bundle.js       -> sandbox/preview/dist/bundle.js (esbuild output)
//   /api/cad/*       -> mapped onto dsh-cad-harness/data/*
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..', '..');          // dsh-cad-harness
// The real store by default; CAD_SANDBOX_DATA points at a throwaway copy so
// states the live corpus does not contain (an empty part, say) can be captured
// without writing anything into data/.
const DATA = process.env.CAD_SANDBOX_DATA ?? join(ROOT, 'data');
const PORT = Number(process.argv[2] ?? 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.stl': 'model/stl',
  '.png': 'image/png',
};

// 1x1 transparent PNG — used by /slow.png to hold the page `load` event open so
// `firefox --screenshot` (which fires on load) captures the post-fetch render.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': MIME['.json'] } });
const notFound = (what) => new Response(`no ${what}`, { status: 404 });

async function readMaybe(path) {
  try { return await readFile(path); } catch { return null; }
}

// `name = value; // PARAMS desc` — mirrors src/host/compile.ts parseParams.
function parseParams(scad) {
  const out = [];
  for (const line of scad.split('\n')) {
    const m = /^\s*([A-Za-z_]\w*)\s*=\s*(-?\d+(?:\.\d+)?)\s*;\s*\/\/\s*PARAMS\s*(.*)$/.exec(line);
    if (m) out.push({ name: m[1], value: Number(m[2]), desc: (m[3] ?? '').trim() });
  }
  return out;
}

async function api(req, url) {
  const p = url.pathname;
  const v = url.searchParams.get('v');

  // --- products: the same tree the host builds, from the same stores --------
  // The host's builder is imported (not re-implemented) so the sandbox cannot
  // drift from what the real route serves.
  if (p === '/api/cad/products') {
    const { buildProducts } = await import('../../src/host/products.ts');
    const { listParts, openPartStore } = await import('../../src/host/parts.ts');
    const { listRuns, openRunStore } = await import('../../src/host/runs.ts');
    const vm = JSON.parse((await readMaybe(join(DATA, 'manifest.json')))?.toString('utf8') ?? '{"versions":[]}');
    const payload = buildProducts(
      vm.versions ?? [],
      await listParts(openPartStore(DATA)),
      await listRuns(openRunStore(DATA)),
    );
    return json(payload);
  }

  if (p === '/api/cad/params') {
    const scad = await readMaybe(join(DATA, 'versions', v ?? '', 'model.scad'));
    if (!scad) return notFound('version');
    return json({ versionId: v, params: parseParams(scad.toString('utf8')) });
  }

  if (p === '/api/cad/stl') {
    const stl = await readMaybe(join(DATA, 'versions', v ?? '', 'model.stl'));
    if (!stl) return notFound('stl');
    return new Response(stl, { headers: { 'content-type': MIME['.stl'] } });
  }

  // --- run-addressed artifacts ---------------------------------------------
  // The name guard must be the ROUTE's guard, not a private one: a local
  // ASCII-only regex rejected every CJK part name (齿轮轴.stl …) and made the
  // sandbox report "几何体读取失败" for corpora the real host serves fine. The
  // host uses safeArtifactName (path separators / control chars only).
  const { safeArtifactName } = await import('../../src/host/runs.ts');
  const runId = url.searchParams.get('id') ?? '';
  const runFile = (...rel) =>
    /^r\d{3,}$/.test(runId) && rel.every((x) => safeArtifactName(x) !== null)
      ? join(DATA, 'runs', runId, ...rel)
      : null;
  const runBinary = async (rel, type, missing) => {
    const f = runFile(...rel);
    const raw = f ? await readMaybe(f) : null;
    return raw ? new Response(raw, { headers: { 'content-type': type } }) : notFound(missing);
  };

  if (p === '/api/cad/run') {
    const rm = JSON.parse((await readMaybe(join(DATA, 'runs', 'manifest.json')))?.toString('utf8') ?? '{"runs":[]}');
    const entry = (rm.runs ?? []).find((x) => x.id === runId);
    return entry ? json(entry) : notFound('run');
  }
  if (p === '/api/cad/run/report') return runBinary(['report.json'], MIME['.json'], 'run report');
  if (p === '/api/cad/run/trajectory') return runBinary(['trajectory.json'], MIME['.json'], 'run trajectory');
  if (p === '/api/cad/run/fluid-manifest') return runBinary(['fluid-manifest.json'], MIME['.json'], 'fluid manifest');
  if (p === '/api/cad/run/stl') {
    const part = url.searchParams.get('part') ?? '';
    return runBinary(['parts', `${part}.stl`], MIME['.stl'], 'run part');
  }
  if (p === '/api/cad/run/image') {
    const name = url.searchParams.get('name') ?? '';
    return runBinary(['frames', name], MIME['.png'], 'run frame image');
  }
  if (p === '/api/cad/run/frame') {
    const i = Number(url.searchParams.get('i') ?? '0');
    const mf = runFile('fluid-manifest.json');
    const raw = mf ? await readMaybe(mf) : null;
    if (!raw) return notFound('fluid manifest');
    const entry = (JSON.parse(raw.toString('utf8')).frames ?? [])[i];
    if (!entry) return notFound('frame index');
    return runBinary(['frames', entry.file], 'application/octet-stream', 'frame');
  }

  // Parameter-override preview: emit one of the stored host renders as a stand-in.
  if (p === '/api/cad/preview' && req.method === 'POST') {
    const png = await readMaybe(join(DATA, 'versions', v ?? 'v003', 'render_iso.png'))
      ?? await readMaybe(join(DATA, 'versions', 'v003', 'render_iso.png'));
    if (png) return new Response(png, { headers: { 'content-type': MIME['.png'] } });
    return notFound('preview');
  }

  return notFound(p);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  let out;
  try {
    if (url.pathname === '/slow.png') {
      await sleep(Number(url.searchParams.get('ms') ?? 2500));
      out = new Response(TINY_PNG, { headers: { 'content-type': MIME['.png'] } });
    } else if (url.pathname.startsWith('/api/cad/')) {
      out = await api(req, url);
    } else if (url.pathname === '/' || url.pathname === '/index.html') {
      out = new Response(await readFile(join(HERE, 'index.html')), { headers: { 'content-type': MIME['.html'] } });
    } else {
      const file = join(HERE, url.pathname.replace(/^\/+/, ''));
      const raw = await readMaybe(file);
      out = raw
        ? new Response(raw, { headers: { 'content-type': MIME[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream' } })
        : notFound(url.pathname);
    }
  } catch (e) {
    out = new Response(`sandbox server error: ${String(e?.message ?? e)}`, { status: 500 });
  }
  const buf = Buffer.from(await out.arrayBuffer());
  res.writeHead(out.status, Object.fromEntries(out.headers));
  res.end(buf);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[cad-ui-sandbox] http://127.0.0.1:${PORT}/`);
});
