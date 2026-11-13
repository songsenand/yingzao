#!/usr/bin/env node
// C1c acceptance: the HTTP door, not only the pure classifier.
//
// Calls the registered /api/cad/export route with a real blocked corpus:
//   1. no confirm -> 409 JSON, no file bytes
//   2. confirm without reason -> 400
//   3. confirm + reason -> 200, _UNVERIFIED name, audit record
//
// The corpus is a copy: the test must not write exports/ into examples/.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { apply } from '../src/host/index.ts';
import { projectStores } from '../src/host/project.ts';
import { listVersions, openVersionStore, saveVersion } from '../src/host/version.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const routes = new Map();
const connection = { fetch: { register(route) { routes.set(route.path, route); return async () => {}; } } };
const ctx = {
  connection,
  reflect: { get: (key) => (key === 'connection' ? connection : undefined), set: () => {} },
  tools: { register() { return () => {}; }, restrict() {} },
  attachments: {},
  on() { return () => {}; },
  effect(fn) { try { fn(); } catch { /* startup effects are not under test */ } },
  logger: { debug() {}, info() {}, warn() {}, error() {} },
};
apply(ctx, { toolScope: 'all' });

const route = routes.get('/api/cad/export');
check('export route is registered', Boolean(route));

const tmp = mkdtempSync(join(tmpdir(), 'cad-http-'));
try {
  // Build a tiny corpus from a TRACKED STL. The old copy of
  // examples/roberval-balance/cad-data only worked on the author's machine:
  // cad-data/ is gitignored, so CI had nothing to copy.
  mkdirSync(join(tmp, 'cad-data'), { recursive: true });
  writeFileSync(join(tmp, 'cad-data', 'project.json'), JSON.stringify({ schemaVersion: 1, id: 'http-fixture' }, null, 2));
  const fixtureStl = readFileSync(join(ROOT, '..', 'examples', 'bench', 'subjects', '06-measure', 'part.stl'));
  const versionStore = openVersionStore(join(tmp, 'cad-data'));
  const versionId = await saveVersion(versionStore, {
    stl: fixtureStl,
    userIntent: 'export-http fixture',
    partId: 'http-fixture',
  });
  mkdirSync(join(tmp, 'assembly'), { recursive: true });
  writeFileSync(join(tmp, 'assembly', 'assembly.json'), JSON.stringify({
    schemaVersion: 1, name: 'http-fixture', unit: 'mm', up: 'z',
    root: {
      id: 'root', name: 'http-fixture', kind: 'assembly',
      children: [{ id: 'part-1', name: 'part', kind: 'part', version: versionId, transform: { translate: [0, 0, 0] } }],
    },
    interfaces: [],
  }, null, 2));
  const project = projectStores(tmp);
  const versions = await listVersions(project.store);
  const version = versions.find((v) => existsSync(join(project.store.root, 'versions', v.id, 'model.stl')));
  check('test corpus has an exportable version', Boolean(version), `${versions.length} versions`);

  const url = (extra) => {
    const params = new URLSearchParams({ v: version.id, format: 'stl', project: tmp, ...extra });
    return `http://x/api/cad/export?${params.toString()}`;
  };

  const blocked = await route.fetch(new Request(url({})));
  const blockedBody = await blocked.json().catch(() => null);
  check('blocked export returns 409', blocked.status === 409, `status=${blocked.status}`);
  check('blocked body is export-blocked', blockedBody?.kind === 'export-blocked');
  check('blocked body carries findings', Array.isArray(blockedBody?.findings) && blockedBody.findings.length > 0);

  const noReason = await route.fetch(new Request(url({ confirm: '1' })));
  check('confirm without reason returns 400', noReason.status === 400, `status=${noReason.status}`);

  const confirmed = await route.fetch(new Request(url({ confirm: '1', reason: 'acceptance test' })));
  const bytes = await confirmed.arrayBuffer();
  const disposition = confirmed.headers.get('content-disposition') ?? '';
  check('confirmed export returns 200', confirmed.status === 200, `status=${confirmed.status}`);
  check('confirmed export has bytes', bytes.byteLength > 0, `${bytes.byteLength}`);
  check('filename carries _UNVERIFIED', disposition.includes('_UNVERIFIED'), disposition);
  check('verdict header says blocked', confirmed.headers.get('x-cad-verdict') === 'blocked');
  const exportId = confirmed.headers.get('x-cad-export-id');
  check('export id is present', Boolean(exportId), exportId ?? '');
  const record = join(tmp, 'exports', exportId ?? '', 'manifest.json');
  check('audit record is written', existsSync(record), record);
  if (existsSync(record)) {
    const manifest = JSON.parse(readFileSync(record, 'utf8'));
    check('audit record records the override reason', manifest.override?.reason === 'acceptance test');
    check('audit record records the blocked verdict', manifest.verdict === 'blocked');
  }

  const zipRoute = routes.get('/api/cad/project/export');
  check('project export route is registered', Boolean(zipRoute));
  const zipUrl = (extra) => {
    const params = new URLSearchParams({ format: 'zip', project: tmp, ...extra });
    return `http://x/api/cad/project/export?${params.toString()}`;
  };
  const zipBlocked = await zipRoute.fetch(new Request(zipUrl({})));
  check('blocked ZIP returns 409', zipBlocked.status === 409, `status=${zipBlocked.status}`);
  const zipConfirmed = await zipRoute.fetch(new Request(zipUrl({ confirm: '1', reason: 'acceptance zip' })));
  const zipBytes = new Uint8Array(await zipConfirmed.arrayBuffer());
  const zipDisposition = zipConfirmed.headers.get('content-disposition') ?? '';
  check('confirmed ZIP returns 200', zipConfirmed.status === 200, `status=${zipConfirmed.status}`);
  check('ZIP filename carries _UNVERIFIED', zipDisposition.includes('_UNVERIFIED.zip'), zipDisposition);
  const zipPath = join(tmp, 'project.zip');
  writeFileSync(zipPath, zipBytes);
  const listing = spawnSync('unzip', ['-l', zipPath], { encoding: 'utf8' });
  check('ZIP contains UNVERIFIED.md', listing.stdout.includes('UNVERIFIED.md'), listing.stderr);
  check('ZIP contains export-manifest.json', listing.stdout.includes('export-manifest.json'));

  const stlUrl = (extra) => {
    const params = new URLSearchParams({ format: 'stl', project: tmp, ...extra });
    return `http://x/api/cad/project/export?${params.toString()}`;
  };
  const stlBlocked = await zipRoute.fetch(new Request(stlUrl({})));
  check('blocked merged STL returns 409', stlBlocked.status === 409, `status=${stlBlocked.status}`);
  const stlConfirmed = await zipRoute.fetch(new Request(stlUrl({ confirm: '1', reason: 'acceptance stl' })));
  const stlDisposition = stlConfirmed.headers.get('content-disposition') ?? '';
  const stlBytes = await stlConfirmed.arrayBuffer();
  check('confirmed merged STL returns 200', stlConfirmed.status === 200, `status=${stlConfirmed.status}`);
  check('merged STL filename carries _UNVERIFIED', stlDisposition.includes('_UNVERIFIED.stl'), stlDisposition);
  check('merged STL has bytes', stlBytes.byteLength > 0);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\naccept-export-http: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
