// Repair is not "retry twice": stop on no progress, cap globally at 4 rounds.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideRepair, repairSignature, MAX_REPAIR_ROUNDS, MAX_TRANSIENT_RETRIES } from '../src/host/pearls/repair.ts';
import { loadPearl } from '../src/host/pearls/registry.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (ok, label, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };
const f = (code, parts) => ({
  code, severity: 'hard', what: code, why: ['test'], location: { kind: 'pair', parts, approximate: true }, evidence: {}, next: [],
});

const first = f('interference', ['a', 'b']);
const sig = repairSignature(first, { assemblyHash: 'sha256:a' });
const newRound = decideRepair(0, [first], [], { assemblyHash: 'sha256:a' });
check(newRound.action === 'continue' && newRound.round === 0, 'new failure allows repair round 1', newRound.action);
check(MAX_REPAIR_ROUNDS === 4, 'global repair cap is 4');

const repeated = decideRepair(1, [first], [sig], { assemblyHash: 'sha256:a' });
check(repeated.action === 'no-progress' && repeated.repeated.length === 1, 'same signature stops immediately', repeated.action);

const changed = decideRepair(1, [f('interference', ['a', 'c'])], [sig], { assemblyHash: 'sha256:a' });
check(changed.action === 'continue', 'different location is progress', changed.action);

const changedHash = decideRepair(1, [first], [sig], { assemblyHash: 'sha256:b' });
check(changedHash.action === 'continue', 'changed assembly hash is progress', changedHash.action);

const exhausted = decideRepair(4, [f('make.printability', ['x'])], [], { assemblyHash: 'sha256:a' });
check(exhausted.action === 'exhausted', 'global cap 4 blocks a fifth round', exhausted.action);

check(MAX_TRANSIENT_RETRIES === 2, 'transient retry stays separate and capped at 2');
const model = await loadPearl(join(ROOT, 'pearls/model'));
const assembly = model.templates.find((t) => t.manifest.id === 'assembly');
check(assembly?.manifest.retry === 4, 'model/assembly self-return allowance matches global cap');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
