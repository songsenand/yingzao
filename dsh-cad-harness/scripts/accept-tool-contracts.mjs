// The tools' own text is the ONLY thing a model reads before calling them. This acceptance
// keeps that text from regressing: every tool documented in the generated contract sheet,
// every parameter documented, every tool with an output schema, and every argument error
// naming its field.
//
//   node scripts/accept-tool-contracts.mjs
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (ok, label, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };
const run = (script, ...args) => spawnSync(process.execPath, [join(ROOT, 'scripts', script), ...args], { cwd: ROOT, encoding: 'utf8' });

const audit = run('audit-tool-contracts.mjs');
check(audit.status === 0, 'the tool audit runs', (audit.stderr ?? '').trim().slice(0, 80));
const m = /captured (\d+) tool\(s\)/.exec(audit.stdout ?? '');
const count = Number(m?.[1] ?? 0);
check(count >= 25, 'every registered tool was captured (not a hand-written list)', `${count} tools`);
check(/0 undocumented parameter\(s\)/.test(audit.stdout ?? ''), 'no parameter lacks a description');
check(/0 tool\(s\) need work/.test(audit.stdout ?? ''), 'and no tool lacks an output schema');

const ck = run('audit-tool-contracts.mjs', '--check');
check(ck.status === 0, 'the generated contract sheet documents all of them', (ck.stdout ?? '').trim().split('\n').pop());

const sheet = await readFile(join(ROOT, 'docs', 'TOOL-CONTRACTS.md'), 'utf8');
const headers = [...sheet.matchAll(/^## `([a-z0-9_]+)`$/gm)].map((x) => x[1]);
check(headers.length === count, 'the sheet has one section per tool', `${headers.length} vs ${count}`);
check(/^```js\n[a-z_]+\(\{/m.test(sheet), 'and every section carries a runnable minimal call');

const lint = run('audit-arg-errors.mjs');
check(lint.status === 0, 'every argument error names the offending field', (lint.stdout ?? '').trim().split('\n').pop());
// A lint that scans NOTHING passes vacuously (it did: after the argError() refactor it
// matched `throw new Error(` only, and reported "checked 0"). Requiring a non-zero count
// is what makes the green meaningful.
const checkedCount = Number(/checked (\d+) negative argument guard/.exec(lint.stdout ?? '')?.[1] ?? 0);
check(checkedCount > 0, 'the argument-error lint actually looked at something', `${checkedCount} guard(s)`);

// The output contract: every tool's VALUE must satisfy the schema it declares. This is the
// gap that let four tools ship broken (2026-10-23 audit, FIX-A1/A3).
const out = run('accept-tool-output.mjs');
check(out.status === 0, "every tool's value satisfies its declared output schema", (out.stdout ?? '').trim().split('\n').pop());

// The argument-error shape itself: it must always say what is ACCEPTED, and show a call
// when one is given. (The migration of the remaining throw sites is tracked separately.)
const { argError } = await import('../src/host/arg-error.ts');
const msg = argError('merge_parts', 'parts', 'needs at least 2 parts', 'an array of { name, versionId } with ≥2 entries', {
  example: 'merge_parts({ parts: […] })',
  received: [{ name: 'a' }],
}).message;
check(/^merge_parts: parts /.test(msg), 'an argument error starts with tool + field');
check(/received:/.test(msg) && /\[\{"name":"a"\}\]/.test(msg), 'and echoes what actually arrived');
check(/accepts:\s+an array of/.test(msg), 'and states what is accepted');
check(/example:\s+merge_parts\(/.test(msg), 'and shows a runnable call');
const bare = argError('x', 'f', 'is required', 'a string').message;
check(!/example:/.test(bare), 'no example is invented when none was given');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
