// Quiet pass; compact warnings; loud failures with what/why/where.
import { formatContractRound, formatTemplateExecution } from '../src/host/pearls/format.ts';
import { executeContractRound } from '../src/host/pearls/execute.ts';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (ok, label, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };
const pass = { status: 'pass', round: 0, maxRounds: 4, deadlineMs: 1000, timedOut: false, stages: [], contract: null, repair: { action: 'continue', signatures: [], repeated: [], reason: '' }, next: [], failures: [] };
const passText = formatContractRound(pass);
check(passText === 'pearl: pass · round 0/4', 'pass is one quiet line', passText);
const table = await executeContractRound(join(ROOT, '../examples/eight-immortals-table'), { round: 0 });
const tableText = formatContractRound(table);
check(tableText.includes('what:') && tableText.includes('why:') && tableText.includes('where:') && tableText.includes('next:'), 'blocked output is loud');
const windup = await executeContractRound(join(ROOT, '../examples/windup-frog'), { round: 0 });
const windText = formatContractRound(windup);
check(windText.split('\n').length < tableText.split('\n').length && windText.includes('!'), 'warn output is compact', `${windText.split('\n').length} lines`);
const tp = formatTemplateExecution({ status: 'pass', steps: [{ id: 'a', tool: 'x', status: 'pass', durationMs: 1, attempts: 1 }] });
check(tp === 'pearl: pass · 1 step(s)', 'template pass is one quiet line', tp);
const td = formatTemplateExecution({ status: 'pass', steps: [{ id: 'a', tool: 'x', status: 'pass', durationMs: 1, attempts: 1, explanationRequired: true, attention: ['judgement=difficult'] }], explanations: ['a: judgement=difficult'] });
check(td.includes('explanation required'), 'difficult pass asks for an explanation', td);
const tf = formatTemplateExecution({ status: 'repair-needed', next: 'model', steps: [{ id: 'a', tool: 'x', status: 'fail', durationMs: 1, attempts: 1, error: 'boom' }] });
check(tf.includes('✗ a') && tf.includes('boom'), 'template failure names step and error', tf);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
