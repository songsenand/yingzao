// Generate the CAD agent preset's patch file from the installed `standard` one.
//
// A preset is a whole agent-plane composition (persona, tools, skills, goals,
// planning, compaction, delegation), and presets do not inherit from each other.
// The CAD preset exists to be a DIFFERENT PRESET ID — the CAD tools themselves
// are registered globally by this bundle and merely stop being hidden for
// sessions that name it (see src/host/tool-scope.ts). So its composition is the
// standard one, plus one row of our own: a second skill-discovery provider
// pointed at this repository's `skills/` directory, and a short workflow
// paragraph injected into the persona prefix.
//
// Why the extra row matters: skills are discovered per preset LAYER, so a CAD
// skill registered here is visible to CAD sessions only. That is what lets the
// CAD skill stay rich — the CAD tool descriptions can shrink to "what it is,
// when to use it" and the selection judgement, parameter sweet spots and traps
// move into a skill that no coding session ever pays for (and that a CAD
// session loads only when it actually does CAD work).
//
// MECHANISM (current dsh): a preset is a `@deepseek-ai/dsh-agent-preset`
// declaration row inserted by a bundle patch — exactly what the web bundle's
// `presets/standard.patch.yml` does for `preset-standard`. The old
// `@deepseek-ai/dsh-agent-presets` package with config-side `roots` is gone.
// This script derives `presets/cad/preset.patch.yml` from the installed
// `standard.patch.yml` as a TEXT transform (the standard body is copied
// verbatim so `!!js` expressions and block scalars survive); package.json
// applies the result via `dsh.bundle.patch`, right after cordis.patch.yml.
//
//   node scripts/sync-cad-preset.mjs          # regenerate
//   node scripts/sync-cad-preset.mjs --check   # fail if a regeneration would change it
//
// `presets/cad/preset.yml` (display name/description/order) and
// `presets/cad/workflow.md` (preset-level instruction) are authored by hand
// and never touched; everything else is generated.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = join(ROOT, 'presets', 'cad', 'preset.patch.yml');
const META = join(ROOT, 'presets', 'cad', 'preset.yml');

/** Where the shipped `standard` preset patch can live, most specific first. */
function findStandardPatch() {
  const candidates = [
    join(ROOT, 'node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml'),
    join(homedir(), '.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml'),
  ];
  return candidates.find((p) => existsSync(p));
}

const source = findStandardPatch();
if (!source) {
  console.error('sync-cad-preset: could not find the installed `standard.patch.yml`.');
  process.exit(1);
}

const stdLines = readFileSync(source, 'utf8').split('\n');
const metaText = readFileSync(META, 'utf8');
const meta = {
  name: /^name:[ \t]*(.+)$/m.exec(metaText)?.[1]?.trim() ?? 'CAD',
  description: /^description:[ \t]*(.+)$/m.exec(metaText)?.[1]?.trim() ?? '',
  order: Number(/^order:[ \t]*(\d+)$/m.exec(metaText)?.[1] ?? 20),
};
const skillDir = join(ROOT, 'skills');
const hasSkills = existsSync(skillDir);

// The standard patch inserts exactly one preset row:
//   - id: preset-standard
//     name: '@deepseek-ai/dsh-agent-preset'
//     config:
//       id: standard
//       ...body...
// Copy everything from `config:` onward verbatim, re-identitied to `cad`.
const configIdx = stdLines.findIndex((l) => l === '      config:');
const idIdx = stdLines.findIndex((l) => l === '        id: standard');
if (configIdx < 0 || idIdx < 0 || idIdx !== configIdx + 1) {
  console.error('sync-cad-preset: unexpected standard.patch.yml shape — refusing to guess.');
  process.exit(1);
}
const body = stdLines.slice(configIdx + 1);
if (!body.some((l) => l.startsWith('        plugins:'))) {
  console.error('sync-cad-preset: standard preset has no plugins list — unexpected shape.');
  process.exit(1);
}
// Replace the identity fields; keep everything else byte-for-byte.
body[0] = '        id: cad';
const orderIdx = body.findIndex((l) => /^        order: \d+$/.test(l));
if (orderIdx < 0) {
  console.error('sync-cad-preset: standard preset has no order field — unexpected shape.');
  process.exit(1);
}
body[orderIdx] = `        order: ${meta.order}`;
body.splice(1, 0,
  `        name: ${jsonQuote(meta.name)}`,
  `        description: ${jsonQuote(meta.description)}`,
);

// A short preset-level instruction, injected into the persona prefix. It is
// paid on every CAD session, so keep it to a few sentences. Authored in
// presets/cad/workflow.md, not here.
const WORKFLOW = join(ROOT, 'presets', 'cad', 'workflow.md');
const workflow = existsSync(WORKFLOW) ? readFileSync(WORKFLOW, 'utf8').trim() : '';
if (workflow) {
  const personaIdx = body.findIndex((line) => line.trim() === '- id: persona');
  if (personaIdx < 0) {
    console.error('sync-cad-preset: standard preset has no persona row — cannot inject workflow.');
    process.exit(1);
  }
  let prefixIdx = -1;
  for (let i = personaIdx + 1; i < body.length; i++) {
    if (/^\s+- id: /.test(body[i])) break;
    if (/^\s+prefix:\s+/.test(body[i])) { prefixIdx = i; break; }
  }
  const match = prefixIdx >= 0 ? /^(\s*)prefix:\s*(.*)$/.exec(body[prefixIdx]) : null;
  const base = match?.[2]?.trim() ?? '';
  if (!match || !base || base === '|' || base === '>') {
    console.error('sync-cad-preset: persona prefix is not a one-line scalar — refusing to guess.');
    process.exit(1);
  }
  const indent = match[1];
  body.splice(prefixIdx, 1,
    `${indent}prefix: |`,
    `${indent}  ${base}`,
    '',
    ...workflow.split('\n').map((line) => line ? `${indent}  ${line}` : ''),
  );
}

// Append the CAD-only skill root as one more entry of the trailing plugins
// list (the plugins list is the last thing in the standard patch body).
const cadSkill = hasSkills ? [
  '          # ── CAD-only skill root (dsh-cad-harness) ─────────────────────────',
  '          #',
  '          # A SECOND discovery provider, not an edit of any row above: skill',
  '          # discovery is layered per preset, so the CAD skill is invisible to',
  '          # every session that does not name this preset — which is what lets',
  '          # NOTE: the directory below is the path on the machine that RAN this',
  '          # it be as detailed as the work needs. Re-run this script after',
  '          # cloning/moving the plugin, or the skills silently stop being found',
  '          - id: cad-skill-filesystem',
  "            name: '@deepseek-ai/dsh-skill-filesystem'",
  '            config:',
  '              providerName: cad-filesystem',
  '              includeDefaultRoots: false',
  '              customSkillDirs:',
  `                - ${skillDir}`,
  '              watch: true',
  '',
] : [];
while (body.length && body[body.length - 1].trim() === '') body.pop();
body.push(...cadSkill);

const header = `# GENERATED — do not edit by hand.
#
# The CAD agent preset as a bundle patch: the shipped \`standard\` composition,
# plus one row of our own. The CAD tool catalog is registered globally by the
# dsh-cad-harness bundle; a session naming THIS preset is the one that keeps it
# (src/host/tool-scope.ts decides; package.json applies this file after
# cordis.patch.yml).
#
# Regenerate after a dsh upgrade:  node scripts/sync-cad-preset.mjs
# Source: ${source}
#
`;

const next = header + [
  '- insert:',
  "    - id: preset-cad",
  "      name: '@deepseek-ai/dsh-agent-preset'",
  '      config:',
  ...body,
].join('\n') + '\n';

/** Double-quoted YAML scalar, safe for arbitrary display text. */
function jsonQuote(text) {
  return JSON.stringify(text);
}

if (process.argv.includes('--check')) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  const strip = (text) => text.replace(/^#.*$/gm, '').trim();
  if (strip(current) !== strip(next)) {
    console.error('sync-cad-preset --check: presets/cad/preset.patch.yml is out of date.');
    console.error('  run: node scripts/sync-cad-preset.mjs');
    process.exit(1);
  }
  console.log('sync-cad-preset --check: up to date');
} else {
  writeFileSync(OUT, next);
  console.log(`sync-cad-preset: wrote ${OUT}`);
  console.log(`  from ${source} (${body.filter((l) => l.startsWith('          - id:')).length} plugin rows)`);
  console.log(`  skill root: ${hasSkills ? skillDir : '(skills/ not present — no row appended)'}`);
}
