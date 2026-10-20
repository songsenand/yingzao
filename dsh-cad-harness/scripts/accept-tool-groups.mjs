// Acceptance for the job-group table (DESIGN §25.7).
// The invariant that matters: no registered CAD tool may be missing from the table —
// otherwise declaring a group silently hides a tool that the skill says exists.
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAD_TOOL_GROUPS, toolsInGroups, ungroupedTools } from '../src/host/tool-groups.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (ok, label, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };

// Registered names, read from the source (same technique as accept-tool-scope: no plugin boot).
const names = [];
for (const f of ['src/host/tools.ts', 'src/host/python-tools.ts']) {
  const src = await readFile(join(ROOT, f), 'utf8');
  for (const m of src.matchAll(/registerTool\(defineTool\(\{\s*\n\s*name: '([a-z_]+)'/g)) names.push(m[1]);
}
check(names.length >= 20, 'the registrations were found', `${names.length} tools`);

const missing = ungroupedTools(names);
check(missing.length === 0, 'every registered tool is in a group (a new tool cannot be silently ungrouped)',
  missing.length ? missing.join(', ') : '');

check(toolsInGroups(['simulate']).length === 5 && toolsInGroups(['simulate']).every((n) => n.startsWith('simulate_')),
  'declaring "simulate" keeps exactly the simulate_* tools', toolsInGroups(['simulate']).join(','));
check(toolsInGroups(undefined) === null && toolsInGroups([]) === null,
  'no declaration = whole catalog (capability stays open, narrowing is opt-in)');
check(CAD_TOOL_GROUPS.deliver.every((n) => typeof n === 'string') && CAD_TOOL_GROUPS.deliver.includes('delivery_audit'),
  'the gate group names the audit');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
