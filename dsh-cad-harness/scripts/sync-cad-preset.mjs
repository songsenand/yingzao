// Generate the CAD agent preset's patch file from the installed `standard` one.
//
//   node scripts/sync-cad-preset.mjs              # regenerate the checkout's file
//   node scripts/sync-cad-preset.mjs --check      # fail if a regeneration would change it
//   node scripts/sync-cad-preset.mjs --without-skills  # release/pack mode
//
// The generation lives in scripts/preset-lib.mjs so `dsh-cad-setup` can reuse
// the exact same text transform on the user's install path.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPreset } from './preset-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

function argValue(name) {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  const value = process.argv[i + 1];
  if (!value || value.startsWith('--')) {
    console.error(`sync-cad-preset: ${name} needs a value`);
    process.exit(3);
  }
  return value;
}

const root = resolve(argValue('--root') ?? ROOT);
const by = argValue('--skill-dir');
const withoutSkills = process.argv.includes('--without-skills');
const asJson = process.argv.includes('--json');
const out = resolve(argValue('--out') ?? join(root, 'presets', 'cad', 'preset.patch.yml'));

try {
  const built = buildPreset({
    root,
    skillDir: by ? resolve(by) : undefined,
    standardPatch: argValue('--standard'),
    withoutSkills,
  });

  if (process.argv.includes('--check')) {
    const current = existsSync(out) ? readFileSync(out, 'utf8') : '';
    const strip = (text) => text.replace(/^\s*#.*$/gm, '').trim();
    if (strip(current) !== strip(built.text)) {
      if (asJson) {
        console.log(JSON.stringify({ ok: false, reason: 'out-of-date', file: out, skillDir: built.skillDir }));
      } else {
        console.error('sync-cad-preset --check: presets/cad/preset.patch.yml is out of date.');
        console.error('  run: node scripts/sync-cad-preset.mjs');
      }
      process.exit(1);
    }
    if (asJson) {
      console.log(JSON.stringify({ ok: true, file: out, skillDir: built.skillDir, source: built.source }));
    } else {
      console.log('sync-cad-preset --check: up to date');
    }
  } else {
    writeFileSync(out, built.text);
    if (asJson) {
      console.log(JSON.stringify({
        ok: true,
        file: out,
        source: built.source,
        skillDir: built.skillDir,
        skills: built.hasSkills,
        rows: built.rows,
      }));
    } else {
      console.log(`sync-cad-preset: wrote ${out}`);
      console.log(`  from ${built.source} (${built.rows} plugin rows)`);
      console.log(`  skill root: ${built.hasSkills ? built.skillDir : '(omitted)'}`);
    }
  }
} catch (error) {
  console.error(`sync-cad-preset: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
