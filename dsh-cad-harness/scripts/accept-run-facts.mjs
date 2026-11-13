#!/usr/bin/env node
// Full-UI slice: run summary labels/headlines/summaries switch to English.

import { en, setCadTranslator } from '../src/client/i18n.ts';
import { runFacts } from '../src/client/run-facts.ts';

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function fill(key, vars = {}) {
  return String(en[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`));
}
setCadTranslator((key, vars) => fill(key, vars));

const motion = runFacts('motion', {
  durationSec: 1, keyframes: [],
  metrics: { interferenceCount: 0, interferenceChecks: 24, samplingSatisfied: true },
}, 'pass');
check('motion headline is English', motion?.headline === 'Pass', motion?.headline);
check('motion duration label is English', motion?.facts.some((f) => f.label === 'Duration'));
check('motion summary is English', !/[\u4e00-\u9fff]/.test(motion?.summary ?? ''), motion?.summary);
check('motion sampling label is English', motion?.facts.some((f) => f.label === 'Sampling'));

const fluid = runFacts('fluid', {
  metrics: { outletArrivalRatio: 0.95, penetrationCount: 0, particleCount0: 100 },
}, 'pass');
check('fluid headline is English', fluid?.headline === 'Pass', fluid?.headline);
check('fluid arrival label is English', fluid?.facts.some((f) => f.label === 'Arrival'));
check('fluid summary is English', !/[\u4e00-\u9fff]/.test(fluid?.summary ?? ''), fluid?.summary);

const checkRun = runFacts('assembly-check', {
  manifestName: 'demo', manifestPath: 'assembly/assembly.json',
  summary: { interfaces: 3, pass: 3, hardViolations: 0, undeclared: 0 },
}, 'pass');
check('assembly-check headline is English', checkRun?.headline === 'Contract holds', checkRun?.headline);
check('assembly-check scope label is English', checkRun?.facts.some((f) => f.label === 'Scope'));

const assembly = runFacts('assembly', {
  pairs: [{ status: 'ok' }, { status: 'ok' }],
}, 'pass');
check('assembly headline is English', assembly?.headline === 'Pass', assembly?.headline);
check('assembly summary is English', !/[\u4e00-\u9fff]/.test(assembly?.summary ?? ''), assembly?.summary);

console.log(`\naccept-run-facts: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
