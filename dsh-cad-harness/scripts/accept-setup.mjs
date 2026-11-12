#!/usr/bin/env node
// Acceptance for A2: the preset's skill path must be generated on THIS machine,
// never baked in from another one.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildPreset, findStandardPatch, listSkillFiles } from './preset-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SETUP = join(HERE, 'setup.mjs');
let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function run(args, cwd = ROOT) {
  return spawnSync(process.execPath, [SETUP, ...args], { cwd, encoding: 'utf8' });
}

const standard = findStandardPatch(ROOT);
if (!standard) {
  console.error('accept-setup: cannot find installed standard.patch.yml; install dsh first');
  process.exit(2);
}

const tmp = mkdtempSync(join(tmpdir(), 'cad-setup-'));
try {
  mkdirSync(join(tmp, 'presets', 'cad'), { recursive: true });
  mkdirSync(join(tmp, 'skills', 'cad-toolbox'), { recursive: true });
  mkdirSync(join(tmp, 'skills', 'cad-assembly'), { recursive: true });
  cpSync(join(ROOT, 'presets', 'cad', 'preset.yml'), join(tmp, 'presets', 'cad', 'preset.yml'));
  cpSync(join(ROOT, 'presets', 'cad', 'workflow.md'), join(tmp, 'presets', 'cad', 'workflow.md'));
  writeFileSync(join(tmp, 'skills', 'cad-toolbox', 'SKILL.md'), '---\nname: cad-toolbox\n---\n');
  writeFileSync(join(tmp, 'skills', 'cad-assembly', 'SKILL.md'), '---\nname: cad-assembly\n---\n');

  const skillDir = join(tmp, 'skills');
  const built = buildPreset({ root: tmp, skillDir, standardPatch: standard });
  check('generated text points at the temp skill dir', built.text.includes(`- ${skillDir}`));
  check('generated text does not contain the checkout skill dir', !built.text.includes(join(ROOT, 'skills')));
  check('generated text has the CAD skill row', built.text.includes('cad-skill-filesystem'));
  check('skill files are discoverable', listSkillFiles(skillDir).length === 2);

  const presetFile = join(tmp, 'presets', 'cad', 'preset.patch.yml');
  const first = run(['--root', tmp, '--standard', standard]);
  check('setup writes the preset', first.status === 0, first.stderr);
  const text1 = existsSync(presetFile) ? readFileSync(presetFile, 'utf8') : '';
  check('written preset points at the temp skill dir', text1.includes(`- ${skillDir}`));

  const checkOk = run(['--root', tmp, '--standard', standard, '--check']);
  check('setup --check passes after write', checkOk.status === 0, checkOk.stderr);

  const second = run(['--root', tmp, '--standard', standard]);
  const text2 = readFileSync(presetFile, 'utf8');
  check('setup is idempotent', second.status === 0 && text1 === text2);

  rmSync(join(tmp, 'skills', 'cad-assembly', 'SKILL.md'));
  const missing = run(['--root', tmp, '--standard', standard, '--check']);
  check('setup --check fails when a skill disappears', missing.status === 1, `status=${missing.status}`);

  const noSkills = buildPreset({ root: tmp, skillDir, standardPatch: standard, withoutSkills: true });
  check('--without-skills omits the CAD skill row', !noSkills.text.includes('cad-skill-filesystem'));

  writeFileSync(join(tmp, 'skills', 'cad-assembly', 'SKILL.md'), '---\nname: cad-assembly\n---\n');
  const json = run(['--root', tmp, '--standard', standard, '--json']);
  const parsed = (() => {
    try { return JSON.parse(json.stdout); } catch { return null; }
  })();
  check('setup --json is parseable', parsed && parsed.ok === true && Array.isArray(parsed.skills));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\naccept-setup: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
