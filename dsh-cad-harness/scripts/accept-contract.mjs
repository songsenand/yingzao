// Contract is a thin index over the six pearls, not a second assembly manifest.
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildNecklaceContract, readNecklaceContract, writeNecklaceContract, validateNecklaceContract, CONTRACT_STAGES } from '../src/host/pearls/contract.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (ok, label, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };

check(CONTRACT_STAGES[0].join() === 'brief' && CONTRACT_STAGES.at(-1).join() === 'deliver', 'contract stages start at brief and end at deliver');
for (const e of ['windup-frog', 'roberval-balance', 'eight-immortals-table']) {
  const c = await buildNecklaceContract(join(ROOT, '../examples', e));
  check(Object.keys(c.sections).length === 6, `${e}: six sections`, Object.keys(c.sections).join(','));
  check(c.complete === (e !== 'roberval-balance'), `${e}: completeness matches observed sections`);
  check(c.assembly?.hash?.startsWith('sha256:'), `${e}: assembly hash is pinned`);
  check(c.failures.every((f) => f.location && f.why?.length), `${e}: failures have location/why`);
  check(c.repair.maxRounds === 4 && c.repair.action === 'continue', `${e}: contract carries no-progress/4-round policy`, c.repair.action);
}
const table = await buildNecklaceContract(join(ROOT, '../examples/eight-immortals-table'));
check(table.next[0] === 'model', 'table routes the hard contract failure to model first', table.next.join(','));
const windup = await buildNecklaceContract(join(ROOT, '../examples/windup-frog'));
check(windup.next.includes('make') && windup.next.includes('review'), 'windup routes make/review warnings', windup.next.join(','));

const dir = await mkdtemp(join(tmpdir(), 'contract-'));
await mkdir(join(dir, 'assembly'), { recursive: true });
await writeFile(join(dir, 'assembly/assembly.json'), await readFile(join(ROOT, '../examples/windup-frog/assembly/assembly.json')));
const c = await buildNecklaceContract(join(ROOT, '../examples/windup-frog'));
const w = await writeNecklaceContract(dir, c);
check(w.changed && (await readFile(w.path, 'utf8')).includes('"sections"'), 'contract writes atomically', w.path);
const w2 = await writeNecklaceContract(dir, c);
check(w2.changed === false, 'same contract is idempotent');
const history = JSON.parse(await readFile(join(dir, 'necklace-contract-history.json'), 'utf8'));
check(history.entries.length === 1, 'contract write appends history', String(history.entries.length));
const read = await readNecklaceContract(dir);
check(read.contractHash === w.hash && read.stale === false, 'reading validates hash and freshness', `${read.stale}`);
let mismatch = '';
try { await writeNecklaceContract(dir, c, 'sha256:' + '0'.repeat(64)); } catch (e) { mismatch = String(e); }
check(mismatch.includes('hash mismatch'), 'stale contract hash is refused', mismatch.slice(0, 80));
let overwrite = '';
try { await writeNecklaceContract(dir, { ...c, template: 'changed' }); } catch (e) { overwrite = String(e); }
check(overwrite.includes('expectedHash is required'), 'overwrite without expectedHash is refused', overwrite.slice(0, 80));
let invalid = '';
try { await writeNecklaceContract(dir, { ...c, schemaVersion: 2 }); } catch (e) { invalid = String(e); }
check(invalid.includes('invalid contract'), 'invalid contract is refused', invalid.slice(0, 80));
const staleDir = await mkdtemp(join(tmpdir(), 'contract-stale-'));
await mkdir(join(staleDir, 'assembly'), { recursive: true });
await writeFile(join(staleDir, 'assembly/assembly.json'), await readFile(join(ROOT, '../examples/windup-frog/assembly/assembly.json')));
await writeNecklaceContract(staleDir, c);
await writeFile(join(staleDir, 'assembly/assembly.json'), '{}');
const stale = await readNecklaceContract(staleDir);
check(stale.stale === true, 'read detects assembly hash drift');
await rm(staleDir, { recursive: true, force: true });
await rm(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
