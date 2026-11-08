// Row regressions found by the two-color click-pen audit:
// - make must honor `role: stock` from parts/manifest.json (not just assembly.source)
// - fit must allow a flexible part intentionally omitted from static assembly
//   via assembly/static-scope.json
//
//   node scripts/accept-row-regressions.mjs

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeFit } from '../src/host/pearls/observe.ts';
import { observeMake } from '../src/host/pearls/ledger.ts';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const json = (v) => JSON.stringify(v, null, 2);
const iso = '2026-01-01T00:00:00.000Z';

async function write(path, value) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, typeof value === 'string' ? value : json(value));
}

const tmp = await mkdtemp(join(tmpdir(), 'v1-row-regressions-'));
try {
  // ---------------------------------------------------------------- fit
  const fitRoot = join(tmp, 'fit');
  await write(join(fitRoot, 'assembly/assembly.json'), {
    schemaVersion: 1, name: 'fit-fixture', unit: 'mm', up: 'z',
    root: {
      id: 'root', name: 'root', kind: 'assembly',
      children: [{ id: 'leaf', name: 'leaf', kind: 'part', version: 'v2' }],
    },
  });
  await write(join(fitRoot, 'cad-data/runs/manifest.json'), {
    schemaVersion: 1,
    runs: [
      { id: 'r1', kind: 'assembly', timestamp: '2026-01-01T00:01:00.000Z', status: 'pass', sourceVersionIds: ['v1'] },
      { id: 'r2', kind: 'assembly-check', timestamp: '2026-01-01T00:02:00.000Z', status: 'pass', sourceVersionIds: ['v1', 'v2'] },
    ],
  });
  await write(join(fitRoot, 'cad-data/runs/r1/report.json'), { overallStatus: 'pass', pairs: [] });
  await write(join(fitRoot, 'cad-data/runs/r2/report.json'), {
    summary: { interfaces: 1, hardViolations: 0, undeclared: 0 },
    undeclared: [], results: [],
  });

  const withoutScope = await observeFit(join(fitRoot, 'cad-data'));
  check(
    withoutScope.findings.some((f) => f.code === 'stale-contract'),
    'fit: exact-set mismatch is stale without a declaration',
    JSON.stringify(withoutScope.findings.map((f) => f.code)),
  );
  check(withoutScope.coverage.interfaces === false, 'fit: coverage is not claimed without a declaration');

  await write(join(fitRoot, 'assembly/static-scope.json'), {
    schemaVersion: 1,
    parts: ['leaf'],
    reason: 'flexure; static pose differs per state',
  });
  const withScope = await observeFit(join(fitRoot, 'cad-data'));
  check(
    !withScope.findings.some((f) => f.code === 'stale-contract'),
    'fit: static-scope suppresses the intentional omission',
    JSON.stringify(withScope.findings.map((f) => f.code)),
  );
  check(withScope.coverage.interfaces === true, 'fit: coverage is restored');
  check(withScope.status === 'pass', 'fit: status passes', withScope.status);

  // --------------------------------------------------------------- make
  const makeRoot = join(tmp, 'make');
  await write(join(makeRoot, 'assembly/assembly.json'), {
    schemaVersion: 1, name: 'make-fixture', unit: 'mm', up: 'z',
    root: {
      id: 'root', name: 'root', kind: 'assembly',
      children: [
        { id: 'p1', name: 'printed', kind: 'part', version: 'v1' },
        { id: 'p2', name: 'stock', kind: 'part', version: 'v2' },
      ],
    },
  });
  await write(join(makeRoot, 'cad-data/parts/manifest.json'), {
    schemaVersion: 1,
    parts: [
      { id: 'p1', name: 'printed', nameSource: 'agent', role: 'printed', createdAt: iso, lastActiveAt: iso, versionIds: ['v1'] },
      { id: 'p2', name: 'stock', nameSource: 'agent', role: 'stock', createdAt: iso, lastActiveAt: iso, versionIds: ['v2'] },
    ],
  });
  await write(join(makeRoot, 'cad-data/manifest.json'), {
    versions: [
      { id: 'v1', timestamp: iso, userIntent: 'printed', parentVersion: null, partId: 'p1', status: 'draft' },
      { id: 'v2', timestamp: iso, userIntent: 'stock', parentVersion: null, partId: 'p2', status: 'draft' },
    ],
  });
  await write(join(makeRoot, 'cad-data/runs/manifest.json'), {
    schemaVersion: 1,
    runs: [{
      id: 'r1', kind: 'printability', timestamp: '2026-01-01T00:03:00.000Z',
      status: 'pass', sourceVersionIds: ['v1'],
    }],
  });
  await write(join(makeRoot, 'cad-data/runs/r1/report.json'), {
    verdict: 'not-excluded', minWallMm: 2, minWallAtMm: [0, 0, 0], findings: [],
  });

  const make = await observeMake(makeRoot);
  check(make.status === 'pass', 'make: passes with a stock part', make.status);
  check(
    !make.failures.some((f) => f.code === 'make.coverage' && f.what.includes('p2')),
    'make: no printability coverage demand for role=stock',
    JSON.stringify(make.failures.map((f) => f.what)),
  );
  check(
    Array.isArray(make.evidence?.currentVersions)
      && !make.evidence.currentVersions.includes('v2'),
    'make: stock version is not in the printed set',
    JSON.stringify(make.evidence?.currentVersions),
  );
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
