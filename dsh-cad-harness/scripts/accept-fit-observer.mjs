// Acceptance for the observe-only fit pearl.
// The observation must not report pass when the contract has zero interfaces.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { observeFit } from '../src/host/pearls/observe.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (ok, label, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };

async function project({ assembly = true, contract = true, interference = 0, interfaces = 3, hard = 0, undeclared = 1, assemblyVersions = ['v1'], contractVersions = ['v1'] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'fit-observe-'));
  const runs = join(dir, 'runs');
  await mkdir(runs, { recursive: true });
  const entries = [];
  if (assembly) {
    entries.push({ id: 'r001', kind: 'assembly', timestamp: '2026-11-03T00:00:00Z', sourceVersionIds: assemblyVersions });
    await mkdir(join(runs, 'r001'), { recursive: true });
    await writeFile(join(runs, 'r001/report.json'), JSON.stringify({
      overallStatus: interference > 0 ? 'fail' : 'pass',
      interferenceEpsilonMm3: 1,
      parts: Array.from({ length: 10 }, (_, i) => ({
        name: `a${i}`, boundingBox: { min: [0, 0, 0], max: [10, 10, 10] },
      })).concat(Array.from({ length: 10 }, (_, i) => ({
        name: `b${i}`, boundingBox: { min: [5, 5, 5], max: [15, 15, 15] },
      }))),
      pairs: Array.from({ length: 10 }, (_, i) => ({
        partA: `a${i}`, partB: `b${i}`,
        intersectionVolume: i < interference ? 2 : 0,
        status: i < interference ? 'fail' : 'ok',
      })),
    }));
  }
  if (contract) {
    entries.push({ id: 'r002', kind: 'assembly-check', timestamp: '2026-11-03T00:00:01Z', sourceVersionIds: contractVersions });
    await mkdir(join(runs, 'r002'), { recursive: true });
    await writeFile(join(runs, 'r002/report.json'), JSON.stringify({
      summary: { interfaces, hardViolations: hard, undeclared },
    }));
  }
  await writeFile(join(runs, 'manifest.json'), JSON.stringify({ schemaVersion: 1, runs: entries }));
  return dir;
}

const good = await project();
const goodObs = await observeFit(good);
const goodStrict = await observeFit(good, { requireUndeclaredZero: true });
check(goodStrict.status === 'blocked', 'strict policy blocks undeclared contacts', goodStrict.status);
check(goodObs.status === 'pass' && goodObs.coverage.complete, 'pass when interference=0 and contract has interfaces', `${goodObs.status}/${goodObs.coverage.complete}`);

const vacuous = await project({ interfaces: 0, undeclared: 44 });
const vacuousObs = await observeFit(vacuous);
check(vacuousObs.status === 'blocked' && vacuousObs.findings.some((f) => f.code === 'no-declared-interfaces'),
  '0 interfaces is blocked, not a green check', vacuousObs.findings.map((f) => f.code).join(','));
check(vacuousObs.coverage.interfaces === false && vacuousObs.coverage.complete === false, 'coverage says interfaces are missing');

const clean = await project({ undeclared: 0 });
const cleanStrict = await observeFit(clean, { requireUndeclaredZero: true });
check(cleanStrict.status === 'pass' && cleanStrict.coverage.complete, 'strict policy passes when undeclared=0', `${cleanStrict.status}/${cleanStrict.coverage.complete}`);

const hit = await project({ interference: 2 });
const hitObs = await observeFit(hit);
check(hitObs.status === 'fail' && hitObs.findings.some((f) => f.code === 'interference'), 'real interference fails fit', hitObs.findings.map((f) => f.code).join(','));
check(hitObs.failures.some((f) => f.code === 'interference' && f.location.kind === 'pair' && !!f.location.center), 'interference carries a pair AABB location', JSON.stringify(hitObs.failures.find((f) => f.code === 'interference')?.location));

const stale = await project({ assemblyVersions: ['v2'], contractVersions: ['v1'] });
const staleObs = await observeFit(stale);
check(staleObs.status === 'blocked' && staleObs.findings.some((f) => f.code === 'stale-contract'), 'contract from a different version set is blocked', staleObs.findings.map((f) => f.code).join(','));

const noContract = await project({ contract: false });
const noContractObs = await observeFit(noContract);
check(noContractObs.status === 'blocked' && noContractObs.findings.some((f) => f.code === 'missing-contract'), 'missing contract is blocked', noContractObs.findings.map((f) => f.code).join(','));

check(goodObs.budgetUsed.distinctTools === 2 && goodObs.budgetUsed.calls === 2, 'budgetUsed reflects the two observed runs');

await Promise.all([good, clean, vacuous, hit, stale, noContract].map((d) => rm(d, { recursive: true, force: true })));
console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
