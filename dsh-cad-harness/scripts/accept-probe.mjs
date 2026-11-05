// Probe catalog: implemented template, opt-in, negative-tested, and selectable.
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadPearl } from '../src/host/pearls/registry.ts';
import { mountProbe } from '../src/host/pearls/probes.ts';
import { runPearl } from '../src/host/pearls/run.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (ok, label, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };
const fit = await loadPearl(join(ROOT, 'pearls/fit'));
const mounted = await mountProbe(fit.manifest, 'fit-clearance', join(ROOT, 'pearls'));
check(mounted.selfTest.ok && mounted.selfTest.samples.length === 1, 'probe template mounts and rejects its negative sample', JSON.stringify(mounted.selfTest.samples));

const base = await mkdtemp(join(tmpdir(), 'probe-'));
await cp(join(ROOT, '../examples/roberval-balance'), join(base, 'roberval-balance'), { recursive: true });
await cp(join(ROOT, '../examples/rulepacks'), join(base, 'rulepacks'), { recursive: true });
const profilePath = join(base, 'roberval-balance/pearl-profile.json');
const profile = JSON.parse(await readFile(profilePath, 'utf8'));
profile.rulePack = '../rulepacks/mechanism';
profile.probe = 'fit-clearance';
profile.probeConfig = { minClearanceMm: 1, measuredMm: 0.2 };
await writeFile(profilePath, JSON.stringify(profile, null, 2));
const result = await runPearl(join(base, 'roberval-balance'));
check(result.probe.id === 'fit-clearance' && result.probe.report?.status === 'fail', 'selected probe runs and reports fail', JSON.stringify(result.probe.report?.status));
check(result.status === 'blocked', 'probe fail blocks the gate', result.status);
await rm(base, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
