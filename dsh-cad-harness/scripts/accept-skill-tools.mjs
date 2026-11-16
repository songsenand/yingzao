// Acceptance for "the skills say what the tools actually do" (2026-10-23).
//
// The skills are the model's map of the toolset; the tool registrations are the territory.
// They drift in ways that are invisible until a session follows the map into a wall:
// a retired tool name, a verdict vocabulary two generations old (`ok/check/unprintable`),
// a field that moved from `metrics.notes` to top-level `notes`, or a tool that never
// reached any skill at all.
//
// Mechanical, so it fails on its own next time:
//   * every tool the skills name is registered;
//   * the tool count in the skill matches the registry;
//   * every registered tool is mentioned somewhere (a new tool cannot stay undocumented);
//   * legacy verdict words only survive inside the sentence that explains they are history;
//   * the params/fields the skills assert exist in the generated contract sheet;
//   * the sheet does not mark an OBJECT endpoint "required" because it carries a nested
//     required array (aSphere.required = ['center','radius'] — the bug this run found).
//
//   node scripts/accept-skill-tools.mjs
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

// ── the territory: the generated sheet ─────────────────────────────────────
const sheet = await readFile(join(ROOT, 'docs', 'TOOL-CONTRACTS.md'), 'utf8');
const contract = new Map();
{
  let cur = null;
  for (const line of sheet.split('\n')) {
    const h = /^## `([a-z0-9_]+)`/.exec(line);
    if (h) { cur = { params: new Set(), returns: new Set() }; contract.set(h[1], cur); continue; }
    if (!cur) continue;
    const p = /^\| `([a-zA-Z_]+)` \|/.exec(line);
    if (p) { cur.params.add(p[1]); continue; }
    const r = /^returns: (.+)$/.exec(line);
    // Identifiers may end in digits (`thinAreaMm2`, `surfaceAreaMm2`): excluding them
    // made this parser silently drop three real return fields (caught by its own
    // `surfaceAreaMm2` assertion on the first run).
    if (r) for (const m of r[1].matchAll(/`([a-zA-Z_][a-zA-Z0-9_]*)`/g)) cur.returns.add(m[1]);
  }
}
const toolNames = new Set(contract.keys());

// The territory is the LIVE registry, not a literal. After the measure merge and the
// 9-surface cutover a hard-coded 43 kept passing while testing the old world; importing
// the registry also proves every op declares the surface production exposes — a tool
// without one is unreachable to the model no matter what the sheet says.
const defs = new Map();
{
  const { registerCadTools } = await import('../src/host/tools.ts');
  registerCadTools({
    tools: { register: (definition) => { defs.set(definition.name, definition); return () => {}; } },
    attachments: { saveImages: async () => [] },
    reflect: { get: () => undefined },
    on: () => {},
  });
}
const registry = new Set(defs.keys());
check(registry.size === 39, 'the registry exposes 39 ops', String(registry.size));
check(toolNames.size === registry.size && [...registry].every((n) => toolNames.has(n)),
  'the contract sheet lists exactly the registered ops',
  `${toolNames.size} sheet vs ${registry.size} registered`);
const surfaceOf = (name) => defs.get(name)?.surface;
const missingSurface = [...registry].filter((n) => !surfaceOf(n)?.id || !surfaceOf(n)?.action);
check(missingSurface.length === 0, 'every op declares the surface that exposes it',
  missingSurface.join(', ') || `(${registry.size} ops)`);
const opsBySurface = new Map();
for (const name of registry) {
  const id = surfaceOf(name)?.id;
  if (id) opsBySurface.set(id, (opsBySurface.get(id) ?? 0) + 1);
}
check(opsBySurface.size === 9, 'nine surfaces cover every op',
  [...opsBySurface].map(([id, n]) => `${id}:${n}`).join(', '));

// ── the map: the five skills ───────────────────────────────────────────────
const skills = [];
for (const dir of await readdir(join(ROOT, 'skills'))) {
  try {
    skills.push({ name: dir, text: await readFile(join(ROOT, 'skills', dir, 'SKILL.md'), 'utf8') });
  } catch { /* not a skill dir */ }
}
check(skills.length === 5, 'five skills are present', String(skills.length));
const all = skills.map((s) => s.text).join('\n');

// 1) every tool-like identifier the skills name is registered
const TOOLISH = /^(analyze|attach_[a-z_]+|check_[a-z_]+|create_part|delivery_audit|generate_part|import_part|list_features|measure_[a-z_]+|merge_parts|preflight|python_runtime|recall_reference_image|render_part|run_python|scan_attention|set_datums|simulate_[a-z]+|validate_assembly)$/;
const named = new Set();
for (const s of skills) for (const m of s.text.matchAll(/`([a-z][a-z0-9_]+)`/g)) if (TOOLISH.test(m[1])) named.add(m[1]);
const unknown = [...named].filter((n) => !toolNames.has(n));
check(unknown.length === 0, 'every tool the skills name is registered', unknown.join(', ') || '(all known)');

// 2) the stated count matches the registry
const toolbox = skills.find((s) => s.name === 'cad-toolbox').text;
check(/(?:Nine job surfaces|9 个 surface)/.test(toolbox),
  'cad-toolbox states the 9-surface model (not the retired 43-tool count)',
  toolbox.match(/^.*surface.*$/m)?.[0]?.slice(0, 90) ?? '');
check(/\b39\b/.test(toolbox) && registry.size === 39,
  'cad-toolbox states the 39-op count', `${registry.size}`);

// 3) every registered op reaches a skill through its SURFACE. Under the cutover the
// model never sees a legacy name, so naming the surface (whose catalog() lists every
// op) is the equivalent of the old "every tool is mentioned" rule — and it keeps a
// new op from being reachable in production but invisible in the map.
const undocumentedSurfaces = [...opsBySurface.keys()].filter((id) => !all.includes(`\`${id}\``));
check(undocumentedSurfaces.length === 0, 'every surface is named in a skill',
  undocumentedSurfaces.join(', ') || `(all ${opsBySurface.size})`);

// 4) retired verdict vocabulary only inside its own history sentence
{
  const lines = all.split('\n');
  const bad = lines.filter((l) => /unprintable/.test(l) && !/until 2026-10-20|was `ok`|history/i.test(l));
  check(bad.length === 0, 'legacy verdict words survive only in the "it was …" sentence',
    bad.map((l) => l.trim().slice(0, 60)).join(' | ') || '(none)');
}

// 5) the params and fields the skills assert are really there
const PARAM_CLAIMS = [
  ['check_printability', 'mode'], ['check_printability', 'profileIds'],
  ['simulate_stress', 'mode'], ['import_part', 'tolLinear'], ['import_part', 'tolAngular'],
  ['generate_part', 'views'], ['delivery_audit', 'claims'], ['delivery_audit', 'exempt'],
  ['measure', 'axis'], ['measure', 'axisVector'], ['render_part', 'view'],
  ['attach_appearance', 'file'], ['measure', 'aDatum'],
  ['measure', 'bOn'], ['simulate_motion', 'cycles'], ['analyze', 'profileIds'],
];
for (const [tool, param] of PARAM_CLAIMS) {
  check(contract.get(tool)?.params.has(param) === true, `${tool}.${param} exists`, tool);
}
const FIELD_CLAIMS = [
  ['check_printability', 'verdict'], ['check_printability', 'surfaceAreaMm2'],
  ['check_printability', 'nextLook'], ['check_printability', 'attention'],
  ['simulate_physics', 'notes'], ['simulate_physics', 'settledPenetrationMm'],
  ['simulate_physics', 'jointViolations'], ['simulate_motion', 'initialJointGaps'],
  ['simulate_motion', 'jointToleranceMm'], ['simulate_fluid', 'metrics'],
  ['simulate_lbm', 'metrics'], ['measure', 'kind'], ['measure', 'versionId'],
  ['render_part', 'label'],
  ['attach_appearance', 'materials'], ['delivery_audit', 'judgement'],
];
for (const [tool, field] of FIELD_CLAIMS) {
  check(contract.get(tool)?.returns.has(field) === true, `${tool} returns \`${field}\``, tool);
}

// 6) a field the skill used to attribute to the wrong object must not come back
check(!/metrics\.notes/.test(all), 'no skill claims `metrics.notes` on the simulate_physics REPLY');
check(/run report|REPLY/i.test(toolbox), 'the skill distinguishes the reply from the run report');

// 7) new capabilities are documented, not just implemented
check(/\bmode\b/.test(toolbox) && /`judge`/.test(toolbox), 'the skill documents judge/scan/both');
check(/nextLook/.test(toolbox), 'the skill documents nextLook');

// 8) the contract sheet's required column is not fooled by nested required arrays
check(!/^\| `aSphere` \| object \| \*\*required\*\*/m.test(sheet), 'aSphere is NOT marked required (nested array bug)');
check(!/^\| `bSphere` \| object \| \*\*required\*\*/m.test(sheet), 'bSphere is NOT marked required (nested array bug)');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
