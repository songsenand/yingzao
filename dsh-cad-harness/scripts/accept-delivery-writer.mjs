// delivery_audit must persist the artifact the deliver observer reads.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { projectStores } from '../src/host/project.ts';
import { persistDeliveryAudit } from '../src/host/delivery-audit.ts';
import { observeDeliver } from '../src/host/pearls/ledger.ts';

let failures = 0;
const check = (ok, label, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };
const dir = await mkdtemp(join(tmpdir(), 'deliver-writer-'));
const project = projectStores(dir);
const report = { verdict: 'not-excluded', findings: [], visual: {}, versions: {}, parts: {}, runs: {}, contract: {}, unregistered: {} };
const path = await persistDeliveryAudit(project, { ...report, judgement: 'not-excluded', summary: 'ok' }, [{ kind: 'assembly', statement: 'declared' }]);
const raw = JSON.parse(await readFile(path, 'utf8'));
check(raw.claims.length === 1 && raw.verdict === 'not-excluded', 'artifact carries claims and verdict', path);
const observed = await observeDeliver(dir);
check(observed.status === 'pass', 'written artifact is observed as pass', observed.status);
await rm(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
