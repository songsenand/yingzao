// Flip the preset between the two arms of Q1's A/B, and put it back — safely.
//
// The A/B compares the 9-surface catalogue (B) with the 45 legacy tools (A). Doing
// that by hand means editing `cordis.patch.yml`, remembering `npx dsh-cad-setup`,
// restarting dsh, and — the part people forget — putting the file back afterwards.
// A release that ships with `hideLegacy` commented out is a release whose whole
// token story is the old one, and nothing would fail to tell you.
//
// So this script owns the edit, the regeneration, and the restore:
//
//   node scripts/token-ab-toggle.mjs --status     # which arm is on disk now
//   node scripts/token-ab-toggle.mjs --legacy     # switch to A (45 tools) + regenerate
//   node scripts/token-ab-toggle.mjs --surfaces   # switch back to B + regenerate
//
// It verifies the generated preset actually changed (the file `setup` writes), so a
// silent no-op cannot masquerade as a switch. The original is kept at
// `<repo>/.tmp-ab/cordis.patch.yml.orig` and `--surfaces` restores from it verbatim.

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');            // dsh-cad-harness/
const REPO = resolve(ROOT, '..');
const PATCH = join(ROOT, 'cordis.patch.yml');
const BACKUP_DIR = join(REPO, '.tmp-ab');
const BACKUP = join(BACKUP_DIR, 'cordis.patch.yml.orig');
const PRESET = join(ROOT, 'presets', 'cad', 'preset.patch.yml');

const args = process.argv.slice(2);
const LEGACY_LINE = '        hideLegacy: all';
const COMMENTED = '        # hideLegacy: all   # A/B arm A (legacy 45 tools)';

const readPatch = () => readFileSync(PATCH, 'utf8');
const arm = () => {
  const text = readPatch();
  if (text.includes(COMMENTED)) return 'legacy';
  if (/^\s*hideLegacy:\s*all\s*$/m.test(text)) return 'surfaces';
  return 'unknown';
};

function regenerate() {
  // The preset is a byte copy of the standard patch plus the plugin's rows, so it
  // MUST be regenerated for the arm change to reach a session. `sync-cad-preset` is
  // the narrow tool (it only rewrites the preset, no backend provisioning) — the full
  // `dsh-cad-setup` would also try to install OpenSCAD, which this does not need and
  // which fails on a read-only home directory.
  const run = spawnSync(process.execPath, ['scripts/sync-cad-preset.mjs'], { cwd: ROOT, encoding: 'utf8', timeout: 180_000 });
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();
  return { ok: (run.status ?? 1) === 0, out: out.split('\n').slice(-3).join(' | ') };
}

const mode = args.includes('--legacy') ? 'legacy' : args.includes('--surfaces') ? 'surfaces' : 'status';
const current = arm();

if (mode === 'status') {
  console.log(`arm: ${current}`);
  if (current === 'legacy') console.log('  A 组（45 个 legacy 工具）：新开会话后生效');
  if (current === 'surfaces') console.log('  B 组（9 面，生产配置）：新开会话后生效');
  console.log(`  backup: ${existsSync(BACKUP) ? BACKUP : '(none — will be written on the first switch)'}`);
  process.exit(current === 'unknown' ? 1 : 0);
}

if (mode === 'legacy' && current === 'legacy') {
  console.log('arm: legacy (already). Nothing to do.');
  process.exit(0);
}
if (mode === 'surfaces' && current === 'surfaces') {
  console.log('arm: surfaces (already). Nothing to do.');
  process.exit(0);
}

const presetBefore = existsSync(PRESET) ? statSync(PRESET).mtimeMs : 0;
mkdirSync(BACKUP_DIR, { recursive: true });

if (mode === 'legacy') {
  if (!existsSync(BACKUP)) copyFileSync(PATCH, BACKUP);
  const text = readPatch();
  if (!/^\s*hideLegacy:\s*all\s*$/m.test(text)) {
    console.error('cordis.patch.yml does not contain an active `hideLegacy: all` — refusing to edit blind');
    process.exit(2);
  }
  writeFileSync(PATCH, text.replace(/^(\s*)hideLegacy:\s*all\s*$/m, `${COMMENTED}`));
} else {
  if (!existsSync(BACKUP)) {
    console.error(`no backup at ${BACKUP}; refusing to guess the original (switch to --legacy first)`);
    process.exit(2);
  }
  copyFileSync(BACKUP, PATCH);
}

const result = regenerate();
if (!result.ok) {
  console.error(`dsh-cad-setup failed: ${result.out}`);
  process.exit(1);
}
const presetAfter = existsSync(PRESET) ? statSync(PRESET).mtimeMs : 0;
// The generated preset is the artifact a session actually loads: if it did not change,
// the switch did not reach the user, whatever the patch file says.
const changed = presetAfter !== presetBefore;
console.log(`arm: ${arm()}  · preset regenerated: ${changed ? 'yes' : 'NO (setup wrote nothing new)'}`);
console.log(`  ${result.out}`);
console.log('\nnext: restart dsh, then OPEN A NEW SESSION (toolScope is a session-creation fact).');
console.log(`  when done: node scripts/token-ab-toggle.mjs --surfaces`);
process.exit(changed ? 0 : 1);
