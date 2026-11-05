// Explained undeclared pairs are accepted evidence, not silently deleted.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { observeFit } from '../src/host/pearls/observe.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (ok, label, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };
const dir = await mkdtemp(join(tmpdir(), 'explained-'));
const cad = join(dir, 'cad-data');
await mkdir(join(cad, 'runs/r1'), { recursive: true });
await mkdir(join(cad, 'runs/r2'), { recursive: true });
await writeFile(join(cad, 'runs/manifest.json'), JSON.stringify({ schemaVersion: 1, runs: [
  { id: 'r1', kind: 'assembly', timestamp: '2026-01-01T00:00:00Z', status: 'pass', sourceVersionIds: ['v1'] },
  { id: 'r2', kind: 'assembly-check', timestamp: '2026-01-01T00:00:01Z', status: 'pass', sourceVersionIds: ['v1'] },
]}));
await writeFile(join(cad, 'runs/r1/report.json'), JSON.stringify({ overallStatus: 'pass', pairs: [], interferenceEpsilonMm3: 0 }));
await writeFile(join(cad, 'runs/r2/report.json'), JSON.stringify({
  summary: { interfaces: 1, hardViolations: 0, undeclared: 2 },
  undeclared: [{ partA: 'a', partB: 'b' }, { partA: 'c', partB: 'd' }],
}));
const bare = await observeFit(cad);
check(bare.counts.undeclared === 2, 'both undeclared pairs count when unexplained', String(bare.counts.undeclared));
const explained = await observeFit(cad, { explainedUndeclared: [{ a: 'a', b: 'b', reason: 'intentional contact' }] });
check(explained.counts.undeclared === 1, 'explained pair is removed from the unexplained count', String(explained.counts.undeclared));
check(explained.findings.some((f) => f.code === 'explained-undeclared' && f.severity === 'info'), 'explanation is visible as info');
await rm(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
