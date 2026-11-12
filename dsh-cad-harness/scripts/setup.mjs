#!/usr/bin/env node
// dsh-cad-setup — write the CAD preset's real skill path on this machine.
//
// WHY THIS EXISTS: `presets/cad/preset.patch.yml` is loaded by dsh from the
// installed package. An absolute path baked in at pack time is wrong on every
// other machine, and the failure is silent: the tools still load, the skills
// disappear. This command regenerates the file from the package root at install
// time, and `--check` makes the failure visible.
//
//   npx dsh-cad-setup              # write the file, then restart dsh
//   npx dsh-cad-setup --check      # exit 1 if the file is stale or skills are missing
//   npx dsh-cad-setup --json       # machine-readable status for doctor
//
// Exit: 0 ok · 1 stale/missing skills (check mode) · 2 cannot write / no dsh.

import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPreset, listSkillFiles } from './preset-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

function argValue(name) {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  const value = process.argv[i + 1];
  if (!value || value.startsWith('--')) {
    console.error(`dsh-cad-setup: ${name} needs a value`);
    process.exit(2);
  }
  return value;
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`usage: dsh-cad-setup [options]

  --check              report whether the preset is current; do not write
  --json               print machine-readable status
  --root <dir>         package root (default: the directory above this script)
  --skill-dir <dir>    skill directory (default: <root>/skills)
  --standard <file>    explicit standard.patch.yml (default: find installed dsh)
  --out <file>         write here instead of <root>/presets/cad/preset.patch.yml

Exit: 0 ok · 1 stale/missing skills · 2 cannot write / no dsh`);
  process.exit(0);
}

const check = process.argv.includes('--check');
const asJson = process.argv.includes('--json');
const root = resolve(argValue('--root') ?? ROOT);
const skillDir = resolve(argValue('--skill-dir') ?? join(root, 'skills'));
const file = resolve(argValue('--out') ?? join(root, 'presets', 'cad', 'preset.patch.yml'));
const standard = argValue('--standard');

function status(ok, extra = {}) {
  const payload = {
    ok,
    root,
    skillDir,
    file,
    skills: listSkillFiles(skillDir).map((p) => basename(dirname(p))),
    ...extra,
  };
  if (asJson) console.log(JSON.stringify(payload, null, 2));
  return payload;
}

let built;
try {
  built = buildPreset({ root, skillDir, standardPatch: standard });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  status(false, { error: message });
  console.error(`dsh-cad-setup: ${message}`);
  process.exit(2);
}

const skills = listSkillFiles(skillDir);
const skillDirs = existsSync(skillDir)
  ? readdirSync(skillDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
  : [];
const missingSkills = skillDirs.filter((name) => !existsSync(join(skillDir, name, 'SKILL.md')));
if (skills.length === 0 || missingSkills.length > 0) {
  status(false, { error: 'skill directory is incomplete', missingSkills });
  console.error(`dsh-cad-setup: skill directory is incomplete at ${skillDir}`);
  if (missingSkills.length > 0) console.error(`  missing SKILL.md: ${missingSkills.join(', ')}`);
  else console.error('  no SKILL.md files found');
  console.error('  the package is incomplete; reinstall it or pass --skill-dir');
  process.exit(1);
}

const strip = (text) => text.replace(/^\s*#.*$/gm, '').trim();
const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
const changed = strip(current) !== strip(built.text);

if (check) {
  if (changed) {
    status(false, { changed: true, reason: 'preset-out-of-date' });
    console.error(`dsh-cad-setup --check: ${file} is stale or missing.`);
    console.error('  run: npx dsh-cad-setup');
    process.exit(1);
  }
  status(true, { changed: false });
  if (!asJson) {
    console.log(`dsh-cad-setup --check: ok (${skills.length} skills at ${skillDir})`);
  }
  process.exit(0);
}

if (!changed) {
  status(true, { changed: false });
  if (!asJson) console.log(`dsh-cad-setup: already current (${skills.length} skills at ${skillDir})`);
  process.exit(0);
}

try {
  const dir = dirname(file);
  const tmp = mkdtempSync(join(dir, '.cad-setup-'));
  const tmpFile = join(tmp, 'preset.patch.yml');
  writeFileSync(tmpFile, built.text, 'utf8');
  renameSync(tmpFile, file);
  rmSync(tmp, { recursive: true, force: true });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const readOnly = /EACCES|EPERM|EROFS/.test(message);
  status(false, { error: message, readOnly });
  console.error(`dsh-cad-setup: cannot write ${file}`);
  console.error(`  ${message}`);
  if (readOnly) {
    console.error('  the install directory is read-only; install into a writable profile, or pass --out');
  }
  process.exit(2);
}

status(true, { changed: true });
if (!asJson) {
  console.log(`dsh-cad-setup: wrote ${file}`);
  console.log(`  ${skills.length} skills at ${skillDir}`);
  console.log('  restart dsh so the new preset layers load');
}
