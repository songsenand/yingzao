#!/usr/bin/env node
// Q1: the context/token budget for a CAD request.
//
// WHAT IS MEASURED (and what is not). The model's context is huge and mostly
// outside this repository: conversation history, harness instructions, the
// workspace AGENTS.md. Claiming a budget over any of that would be a claim about
// someone else's runtime. This script measures the two components the PLUGIN
// controls and that every CAD session pays up front, before a single word of
// conversation:
//
//   1. the nine surface tool schemas (name + description + parameters) — the
//      model sees these in the tool list on every turn;
//   2. the skill catalog entries (name + description of each skills/*/SKILL.md) —
//      always injected; a skill's BODY is only read when the skill is loaded, so
//      it is not part of the fixed prefix and is counted separately as INFO.
//
// Budgets (the numbers are a contract, not a target):
//   * nine surfaces ≤ 6144 chars — the same budget the freeze ledger carries;
//   * the fixed prefix ≤ the recorded baseline × 1.10 — "do not regress".
//
// `--write` records a new baseline. It prints the delta and refuses to hide a
// regression: growing the prefix is allowed, growing it silently is not.
//
//   node scripts/accept-token-budget.mjs
//   node scripts/accept-token-budget.mjs --write      # re-record the baseline
//   node scripts/accept-token-budget.mjs --json

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER = join(ROOT, 'docs/TOOL-SURFACE-V1.json');
const BASELINE = join(ROOT, 'docs/TOKEN-BASELINE.json');
const SKILLS = join(ROOT, 'skills');
const JSON_OUT = process.argv.includes('--json');
const WRITE = process.argv.includes('--write');
const TOLERANCE = 0.10;
const SURFACE_BUDGET = 6144;

const home = mkdtempSync(join(tmpdir(), 'cad-token-budget-'));
process.env.DSH_HOME = home;
process.env.DSH_CAD_PYTHON = 'off';
const { registerCadToolsWithSurfaces } = await import('../src/host/register-with-surfaces.ts');

const ALL = ['session', 'part', 'assembly', 'check', 'simulate', 'inspect', 'see', 'python', 'deliver'];
const SURFACE_NAMES = ['cad_session', 'cad_part', 'cad_assembly', 'cad_check', 'cad_simulate', 'cad_inspect', 'cad_see', 'cad_python', 'cad_deliver'];

/** Register with a fake ctx and keep whatever the plugin asked the host for. */
function capture(scope) {
  const tools = new Map();
  registerCadToolsWithSurfaces({
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => {}; } },
    connection: { fetch: { register: () => (() => {}) } },
    attachments: { saveImages: async () => [] },
    reflect: { get: () => undefined },
    on: () => () => {},
    effect: (fn) => { try { fn(); } catch { /* registration effects are not under test */ } },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  }, scope);
  return tools;
}

/** Exactly what the model reads for a tool: name, description, parameter schema. */
const schemaChars = (definition) => JSON.stringify({
  name: definition.name,
  description: definition.description,
  parameters: definition.parameters,
}).length;

/** The catalog line of a skill: the YAML frontmatter the host injects. */
function skillCatalog() {
  const rows = [];
  for (const entry of readdirSync(SKILLS, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let text = '';
    try { text = readFileSync(join(SKILLS, entry.name, 'SKILL.md'), 'utf8'); } catch { continue; }
    const block = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    const name = block.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? entry.name;
    const description = block.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? '';
    const when = block.match(/^whenToUse:\s*(.+)$/m)?.[1]?.trim() ?? '';
    rows.push({ name, chars: name.length + description.length + when.length, bodyChars: text.length });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

const base = capture(undefined);
const cutover = capture({ toolSurfaces: ALL, hideLegacy: [...base.keys()] });

const missing = SURFACE_NAMES.filter((name) => !cutover.has(name));
if (missing.length) {
  console.error(`token-budget: surfaces missing from the cutover registration: ${missing.join(', ')}`);
  rmSync(home, { recursive: true, force: true });
  process.exit(1);
}

const surfaceRows = SURFACE_NAMES.map((name) => ({ name, chars: schemaChars(cutover.get(name)) }));
const surfaceTotal = surfaceRows.reduce((sum, row) => sum + row.chars, 0);
const legacyTotal = [...base.values()].reduce((sum, definition) => sum + schemaChars(definition), 0);
const skills = skillCatalog();
const skillTotal = skills.reduce((sum, row) => sum + row.chars, 0);
const skillBodyTotal = skills.reduce((sum, row) => sum + row.bodyChars, 0);
const prefix = surfaceTotal + skillTotal;

let baseline = null;
try { baseline = JSON.parse(readFileSync(BASELINE, 'utf8')); } catch { /* reported below */ }
let ledger = null;
try { ledger = JSON.parse(readFileSync(LEDGER, 'utf8')); } catch { /* reported below */ }
const surfaceBudget = ledger?.schemaCharsBudget ?? SURFACE_BUDGET;

let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`);
  else { failed++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const measured = {
  recordedAt: new Date().toISOString().slice(0, 10),
  surfaceSchemaChars: surfaceTotal,
  skillCatalogChars: skillTotal,
  fixedPrefixChars: prefix,
  surfaceBudgetChars: surfaceBudget,
  tolerance: TOLERANCE,
  legacySchemaChars: legacyTotal,
  components: { surfaces: surfaceRows, skills: skills.map(({ name, chars }) => ({ name, chars })) },
};

if (WRITE) {
  const previous = baseline?.fixedPrefixChars;
  writeFileSync(BASELINE, `${JSON.stringify(measured, null, 2)}\n`);
  console.log(`token-budget: wrote docs/TOKEN-BASELINE.json (${prefix} chars`
    + `${previous ? `, ${prefix - previous >= 0 ? '+' : ''}${prefix - previous} vs previous` : ''})`);
} else {
  check('baseline exists (docs/TOKEN-BASELINE.json — run --write once)',
    baseline !== null, 'first run: node scripts/accept-token-budget.mjs --write');
  check(`nine surface schemas within budget (${surfaceBudget} chars)`,
    surfaceTotal <= surfaceBudget, `${surfaceTotal} chars`);
  if (baseline) {
    const ceiling = Math.round(baseline.fixedPrefixChars * (1 + TOLERANCE));
    check(`fixed prefix within baseline +${Math.round(TOLERANCE * 100)}% (${ceiling} chars)`,
      prefix <= ceiling, `${prefix} vs baseline ${baseline.fixedPrefixChars}`);
  }
  check('every component was measured, none assumed',
    surfaceTotal > 0 && skillTotal > 0 && skills.length > 0,
    `surfaces ${surfaceTotal}, skills ${skillTotal} over ${skills.length} entries`);
  check('the nine surfaces are the only tool schemas in the prefix',
    [...cutover.keys()].sort().join(',') === [...SURFACE_NAMES].sort().join(','),
    [...cutover.keys()].join(','));
}

const tokens = (chars) => Math.round(chars / 4);
if (JSON_OUT) {
  console.log(JSON.stringify({ ...measured, approxTokens: tokens(prefix), ok: failed === 0 }, null, 2));
} else {
  console.log('');
  console.log(`  surfaces ${surfaceTotal} chars (~${tokens(surfaceTotal)} tok) over ${SURFACE_NAMES.length} tools`);
  for (const row of surfaceRows) console.log(`    ${row.name.padEnd(14)} ${String(row.chars).padStart(6)} chars`);
  console.log(`  skill catalog ${skillTotal} chars (~${tokens(skillTotal)} tok) over ${skills.length} skills`
    + ` (bodies, loaded on demand only: ${skillBodyTotal} chars — NOT in the prefix)`);
  console.log(`  FIXED PREFIX ${prefix} chars (~${tokens(prefix)} tok); legacy ${base.size} tool schemas for comparison: ${legacyTotal} chars`);
  console.log(`  reduction vs legacy: ${(100 * (1 - prefix / legacyTotal)).toFixed(1)}%`);
  console.log('');
}

rmSync(home, { recursive: true, force: true });
console.log(failed ? `accept-token-budget: ${failed} FAILURE(S)` : 'accept-token-budget: PASS');
process.exit(failed ? 1 : 0);
