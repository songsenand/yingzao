// Acceptance for rulepack/v1: domain rules load, but stay outside the core pearl.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRulePack, validateRulePack } from '../src/host/pearls/rulepack.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (ok, label, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };

const pack = await loadRulePack(join(ROOT, '../examples/rulepacks/wood-furniture'));
check(pack.manifest.id === 'wood-furniture', 'rule pack loads', pack.manifest.id);
check(pack.guide?.includes('腿') && pack.guide?.includes('边框'), 'rule pack guide keeps domain groups', pack.guide ? `${pack.guide.length} bytes` : 'missing');
check(pack.manifest.thresholds?.interferenceEpsilonMm3 === 1, 'thresholds are owned by the rule pack');
check(pack.manifest.requiredGroups?.length === 3, 'required groups are declared in the rule pack');
check(pack.manifest.undeclaredPolicy === 'block', 'rule pack can opt into strict policy');
check(pack.manifest.make?.kind === 'wood' && pack.manifest.make.stockMm?.length === 3, 'wood make policy owns stock dimensions');
check(pack.manifest.probes?.includes('leg-fit'), 'probe allowlist is rule-pack scoped');

check(validateRulePack({ schemaVersion: 1, id: 'bad', version: '1.0.0', undeclaredPolicy: 'hard' }).some((e) => e.includes('warn|block')), 'invalid policy is rejected');
check(validateRulePack({ schemaVersion: 2, id: 'bad', version: '1.0.0' }).some((e) => e.includes('schemaVersion')), 'wrong schema version is rejected');
check(validateRulePack({ schemaVersion: 1, id: 'bad', version: '1.0.0', requiredGroups: [{ id: 'x', min: -1 }] }).some((e) => e.includes('min')), 'negative group minimum is rejected');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
