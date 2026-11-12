#!/usr/bin/env node
// N14 acceptance: the scope route explains the environment, and the client
// turns each state into one actionable sentence.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply } from '../src/host/index.ts';
import { environmentNotice } from '../src/client/project.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const routes = new Map();
const connection = { fetch: { register(route) { routes.set(route.path, route); return async () => {}; } } };
const ctx = {
  connection,
  reflect: { get: (key) => (key === 'connection' ? connection : undefined), set: () => {} },
  tools: { register() { return () => {}; }, restrict() {} },
  attachments: {},
  on() { return () => {}; },
  effect(fn) { try { fn(); } catch { /* startup effects are not under test */ } },
  logger: { debug() {}, info() {}, warn() {}, error() {} },
};
apply(ctx, { toolScope: 'all' });

const route = routes.get('/api/cad/scope');
check('scope route is registered', Boolean(route));
const response = await route.fetch(new Request('http://x/api/cad/scope'));
const body = await response.json();
check('scope returns 200', response.status === 200);
check('scope carries runtime state', typeof body.runtime?.state === 'string', JSON.stringify(body.runtime));
check('scope carries backend', body.backend?.kernel === 'openscad', JSON.stringify(body.backend));

const base = { toolScope: 'global', presets: [] };
check('ready has no notice', environmentNotice({ ...base, runtime: { state: 'ready' }, backend: { kernel: 'openscad', compileBackend: 'auto' } }) === null);
check('absent explains the first-run download', environmentNotice({ ...base, runtime: { state: 'absent' } })?.includes('400 MB'));
check('failed names repair', environmentNotice({ ...base, runtime: { state: 'failed', error: 'boom' } })?.includes('action=repair'));
check('disabled names the env var', environmentNotice({ ...base, runtime: { state: 'disabled' } })?.includes('DSH_CAD_PYTHON'));
check('unsupported is not a modelling failure', environmentNotice({ ...base, runtime: { state: 'unsupported' } })?.includes('不是建模失败'));
check('non-openscad kernel is refused', environmentNotice({ ...base, backend: { kernel: 'cadquery', compileBackend: 'auto' } })?.includes('dsh-cad-backend'));

console.log(`\naccept-scope: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
