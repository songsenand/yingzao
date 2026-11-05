// Acceptance for checker/v1: sample probe, negative sample, bad reports, timeout.
// Every green here names the observation that would make it red.
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChecker, runFixture, verifyChecker } from '../src/host/checkers/registry.ts';
import { runChecker } from '../src/host/checkers/runner.ts';
import { validateCheckerReport } from '../src/host/checkers/protocol.ts';
import { CHECKER_API_VERSION } from '../src/host/checkers/types.ts';
import { loadPearl } from '../src/host/pearls/registry.ts';
import { mountProbe } from '../src/host/pearls/probes.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'examples/checkers/leg-fit');
let failures = 0;
const check = (ok, label, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };

for (const s of ['checker-manifest.schema.json', 'checker-report.schema.json']) {
  JSON.parse(await readFile(join(ROOT, 'schemas', s), 'utf8'));
  check(true, `schema is valid JSON: ${s}`);
}

const checker = await loadChecker(DIR);
check(checker.manifest.id === 'leg-fit' && checker.hash.length === 64, 'sample checker loads and hashes', checker.hash.slice(0, 12));

const overlap = JSON.parse(await readFile(join(DIR, 'fixtures/overlap.json'), 'utf8'));
const clear = JSON.parse(await readFile(join(DIR, 'fixtures/clear.json'), 'utf8'));
const bad = await runFixture(checker, overlap);
const good = await runFixture(checker, clear);
check(bad.report.status === 'fail', '0.5 mm overlap is rejected', bad.report.status);
check(good.report.status === 'pass' && good.report.coverage.complete === true, 'clear fit passes with full coverage', good.report.status);

const fit = await loadPearl(join(ROOT, 'pearls/fit'));
const probeEnabled = { ...fit.manifest, probe: { ...fit.manifest.probe, allowed: ['leg-fit'] } };
const mounted = await mountProbe(probeEnabled, 'leg-fit', join(ROOT, 'examples/pearls'));
check(mounted.selfTest.ok, 'pearl fit mounts leg-fit only after its negative sample passes');
let unlisted = false;
try { await mountProbe(probeEnabled, 'stock-length', join(ROOT, 'examples/pearls')); } catch { unlisted = true; }
check(unlisted, 'a probe outside the pearl allowlist is rejected');

const self = await verifyChecker(checker);
check(self.ok, 'declared negative sample rejects itself', JSON.stringify(self.samples));
check(self.hash === checker.hash, 'self-test pins the same hash');

const base = {
  apiVersion: CHECKER_API_VERSION,
  checker: { id: 'leg-fit', version: '0.1.0' },
  status: 'fail',
  findings: [],
  coverage: { criteria: ['fit.interference'], complete: true, skipped: [] },
  artifacts: [],
};
const missingWitness = validateCheckerReport({ ...base, findings: [{ criterion: 'fit.interference', verdict: 'fail' }] }, checker.manifest);
check(missingWitness.some((e) => e.includes('witness')), 'fail without witness is rejected', missingWitness.join('; '));

const incomplete = validateCheckerReport({ ...base, status: 'pass', findings: [], coverage: { criteria: [], complete: false, skipped: [] } }, checker.manifest);
check(incomplete.some((e) => e.includes('coverage.complete')), 'pass with incomplete coverage is rejected', incomplete.join('; '));

const unknown = validateCheckerReport({
  ...base,
  findings: [{
    criterion: 'fit.unknown', verdict: 'fail', measured: 1, limit: 0, unit: 'mm3',
    witness: { kind: 'x' }, attention: [{ kind: 'x', note: 'x' }],
  }],
}, checker.manifest);
check(unknown.some((e) => e.includes('not declared')), 'unknown criterion is rejected', unknown.join('; '));

const traversal = validateCheckerReport({
  ...base, status: 'pass', findings: [], artifacts: [{ kind: 'json', path: '../escape.json' }],
}, checker.manifest);
check(traversal.some((e) => e.includes('artifacts/')), 'artifact path escape is rejected', traversal.join('; '));

const timeoutManifest = {
  ...checker.manifest,
  id: 'timeout-probe', version: '0.1.0', timeoutMs: 1000,
  entry: ['python3', '-c', 'import time; time.sleep(2)'],
  negativeSamples: [],
};
const timed = await runChecker(timeoutManifest, { apiVersion: CHECKER_API_VERSION });
check(timed.report.status === 'error' && timed.report.error?.code === 'timeout', 'timeout becomes error, never pass', timed.report.error?.code ?? timed.report.status);

const junkManifest = {
  ...checker.manifest,
  id: 'junk-probe', version: '0.1.0', timeoutMs: 1000,
  entry: ['python3', '-c', 'print("not json")'],
  negativeSamples: [],
};
const junk = await runChecker(junkManifest, { apiVersion: CHECKER_API_VERSION });
check(junk.report.status === 'error' && junk.report.error?.code === 'invalid-json', 'non-JSON stdout becomes error', junk.report.error?.code ?? junk.report.status);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
