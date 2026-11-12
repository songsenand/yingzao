#!/usr/bin/env node
// N16 acceptance (first slice): stable code + stage + hint + cause for the
// errors that cross the export boundary.

import { classifyError, envelopeText } from '../src/shared/error-envelope.ts';
import { withOutputContract } from '../src/host/tool-contract.ts';

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const cases = [
  ['operation timed out after 30s', 'timeout'],
  ['ENOENT: no such file or directory, open model.stl', 'not-found'],
  ['EACCES: permission denied', 'permission'],
  ['getaddrinfo ENOTFOUND example.invalid', 'network'],
  ['backend_not_available: kernel "cadquery" is planned', 'backend-not-available'],
  ['bad request: v is required', 'invalid-input'],
  ['something exploded', 'tool-failed'],
];
for (const [message, code] of cases) {
  const env = classifyError(new Error(message), 'export');
  check(`${code} is classified`, env.code === code, env.code);
  check(`${code} has a hint`, env.hint.length > 0);
  check(`${code} keeps cause`, env.cause.includes(message.split(':')[0]));
  check(`${code} text has code and hint`, envelopeText(env).includes(`[${code}]`) && envelopeText(env).includes('hint:'));
}
check('stage is carried', classifyError(new Error('x'), 'import').stage === 'import');
check('export-blocked is a code', classifyError(new Error('export-blocked'), 'export').code === 'export-blocked');

const wrapped = withOutputContract({
  name: 'test_tool',
  output: { schema: { type: 'object' } },
  execute: async () => { throw new Error('ENOENT: no such file or directory'); },
});
try {
  await wrapped.execute({}, {});
  check('wrapped tool throws', false);
} catch (error) {
  check('wrapped tool keeps the message', String(error.message).includes('ENOENT'));
  check('wrapped tool gets a code', error.code === 'not-found', error.code);
  check('wrapped tool gets a stage', error.stage === 'test_tool', error.stage);
  check('wrapped tool gets a hint', typeof error.hint === 'string' && error.hint.length > 0);
  check('wrapped tool gets a cause', String(error.cause).includes('ENOENT'));
}
console.log(`\naccept-error-envelope: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
