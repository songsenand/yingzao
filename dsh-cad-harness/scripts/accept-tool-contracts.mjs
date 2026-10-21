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
const headers = [...sheet.matchAll(/^## `([a-z_]+)`$/gm)].map((x) => x[1]);
check(headers.length === count, 'the sheet has one section per tool', `${headers.length} vs ${count}`);
check(/^```js\n[a-z_]+\(\{/m.test(sheet), 'and every section carries a runnable minimal call');

const lint = run('audit-arg-errors.mjs');
check(lint.status === 0, 'every argument error names the offending field', (lint.stdout ?? '').trim().split('\n').pop());

console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
