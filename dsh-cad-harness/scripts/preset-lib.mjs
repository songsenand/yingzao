// Build the CAD agent preset patch from the installed `standard` preset.
//
// This is the single implementation behind two entry points:
//   - scripts/sync-cad-preset.mjs  (developer, writes the checkout's file)
//   - scripts/setup.mjs            (installed package, writes the real skill dir)
//
// WHY IT IS A LIBRARY, NOT A SCRIPT: the installed package cannot know the
// absolute path of its own `skills/` until it is on the user's disk. A checked-in
// absolute path is a silent failure: the tools still load, the skills disappear.
// `dsh-cad-setup` regenerates the file from the package root at install time.
//
// MECHANISM (current dsh): a preset is a `@deepseek-ai/dsh-agent-preset`
// declaration row inserted by a bundle patch. The standard body is copied
// verbatim so `!!js` expressions and block scalars survive; only identity fields
// and the CAD-only skill-provider row are changed.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

/** Where the shipped `standard.patch.yml` can live, most specific first. */
export function findStandardPatch(root) {
  const preset = (base) => join(base, '@deepseek-ai', 'dsh-web-app', 'presets', 'standard.patch.yml');
  const nested = (base) => join(base, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets', 'standard.patch.yml');
  const roots = [
    process.env.DSH_STANDARD_PATCH,
    join(root, 'node_modules'),
    join(homedir(), '.local', 'lib', 'node_modules'),
    process.env.npm_config_prefix ? join(process.env.npm_config_prefix, 'lib', 'node_modules') : null,
    '/usr/local/lib/node_modules',
    '/opt/homebrew/lib/node_modules',
  ].filter(Boolean);
  for (const base of roots) {
    if (base.endsWith('.yml') && existsSync(base)) return base;
    for (const candidate of [preset(base), nested(base)]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Build the preset patch text.
 *
 * @param {object} options
 * @param {string} options.root package/checkout root
 * @param {string} [options.skillDir] absolute skill directory (default <root>/skills)
 * @param {string} [options.standardPatch] explicit standard.patch.yml path
 * @param {boolean} [options.withoutSkills] omit the CAD skill-provider row
 * @returns {{ text: string, source: string, skillDir: string, hasSkills: boolean, rows: number }}
 */
export function buildPreset({ root, skillDir, standardPatch, withoutSkills = false }) {
  const source = standardPatch ?? findStandardPatch(root);
  if (!source) {
    throw new Error(
      'could not find the installed `standard.patch.yml`; pass --standard <file> or install dsh first',
    );
  }

  const out = join(root, 'presets', 'cad', 'preset.patch.yml');
  const metaPath = join(root, 'presets', 'cad', 'preset.yml');
  const workflowPath = join(root, 'presets', 'cad', 'workflow.md');
  const skills = skillDir ?? join(root, 'skills');
  const hasSkills = !withoutSkills && existsSync(skills);

  const stdLines = readFileSync(source, 'utf8').split('\n');
  const metaText = readFileSync(metaPath, 'utf8');
  const meta = {
    name: /^name:[ \t]*(.+)$/m.exec(metaText)?.[1]?.trim() ?? 'CAD',
    description: /^description:[ \t]*(.+)$/m.exec(metaText)?.[1]?.trim() ?? '',
    order: Number(/^order:[ \t]*(\d+)$/m.exec(metaText)?.[1] ?? 20),
  };

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
    throw new Error('unexpected standard.patch.yml shape: config/id rows not found');
  }
  const body = stdLines.slice(configIdx + 1);
  if (!body.some((l) => l.startsWith('        plugins:'))) {
    throw new Error('unexpected standard.patch.yml shape: no plugins list');
  }

  // Replace the identity fields; keep everything else byte-for-byte.
  body[0] = '        id: cad';
  const orderIdx = body.findIndex((l) => /^        order: \d+$/.test(l));
  if (orderIdx < 0) throw new Error('unexpected standard.patch.yml shape: no order field');
  body[orderIdx] = `        order: ${meta.order}`;
  body.splice(1, 0,
    `        name: ${jsonQuote(meta.name)}`,
    `        description: ${jsonQuote(meta.description)}`,
  );

  // A short preset-level instruction, injected into the persona prefix. It is
  // paid on every CAD session, so keep it to a few sentences.
  const workflow = existsSync(workflowPath) ? readFileSync(workflowPath, 'utf8').trim() : '';
  if (workflow) {
    const personaIdx = body.findIndex((line) => line.trim() === '- id: persona');
    if (personaIdx < 0) throw new Error('unexpected standard.patch.yml shape: no persona row');
    let prefixIdx = -1;
    for (let i = personaIdx + 1; i < body.length; i++) {
      if (/^\s+- id: /.test(body[i])) break;
      if (/^\s+prefix:\s+/.test(body[i])) { prefixIdx = i; break; }
    }
    const match = prefixIdx >= 0 ? /^(\s*)prefix:\s*(.*)$/.exec(body[prefixIdx]) : null;
    const base = match?.[2]?.trim() ?? '';
    if (!match || !base || base === '|' || base === '>') {
      throw new Error('unexpected standard.patch.yml shape: persona prefix is not a one-line scalar');
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
    '          # NOTE: the directory below is written by `dsh-cad-setup` (or',
    '          # `node scripts/sync-cad-preset.mjs` in a checkout) because an',
    '          # absolute path from another machine is a silent skill loss.',
    '          - id: cad-skill-filesystem',
    "            name: '@deepseek-ai/dsh-skill-filesystem'",
    '            config:',
    '              providerName: cad-filesystem',
    '              includeDefaultRoots: false',
    '              customSkillDirs:',
    `                - ${skills}`,
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
# Regenerate:  npx dsh-cad-setup        (installed package)
#              node scripts/sync-cad-preset.mjs  (checkout)
# Source: ${basename(source)} (installed dsh)
#
`;

  const text = header + [
    '- insert:',
    '    - id: preset-cad',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    ...body,
  ].join('\n') + '\n';

  return { text, source, skillDir: skills, hasSkills, rows: body.filter((l) => l.startsWith('          - id:')).length, out };
}

/** Double-quoted YAML scalar, safe for arbitrary display text. */
function jsonQuote(text) {
  return JSON.stringify(text);
}

/** List the skill bodies the preset is supposed to expose. */
export function listSkillFiles(skillDir) {
  if (!existsSync(skillDir)) return [];
  const out = [];
  for (const name of readdirSync(skillDir)) {
    if (name.startsWith('.')) continue;
    const file = join(skillDir, name, 'SKILL.md');
    if (existsSync(file)) out.push(file);
  }
  return out.sort();
}
