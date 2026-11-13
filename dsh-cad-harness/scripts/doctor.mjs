#!/usr/bin/env node
// dsh-cad-doctor — one command that separates "not installed" from "not configured"
// from "project is broken" from "capability missing".
//
//   npx dsh-cad-doctor
//   npx dsh-cad-doctor --json
//   npx dsh-cad-doctor --project /path/to/project
//   npx dsh-cad-doctor --root /path/to/package
//   npx dsh-cad-doctor --tmpdir /tmp
//
// Exit: 0 ok · 1 degraded · 2 fail. `kind` is the only thing to read.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { listSkillFiles } from './preset-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(argValue('--root') ?? join(HERE, '..'));
const DSH_HOME = resolve(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'));
const CAD_HOME = join(DSH_HOME, 'cad');

function argValue(name) {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  const value = process.argv[i + 1];
  if (!value || value.startsWith('--')) {
    console.error(`dsh-cad-doctor: ${name} needs a value`);
    process.exit(2);
  }
  return value;
}

const asJson = process.argv.includes('--json');
const project = argValue('--project') ? resolve(argValue('--project')) : null;
const explicitOpenScad = argValue('--openscad');
const explicitSkillDir = argValue('--skill-dir');
const tmpRoot = resolve(argValue('--tmpdir') ?? tmpdir());

function onPath(command) {
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function versionOf(bin, args = ['--version']) {
  const result = spawnSync(bin, args, { encoding: 'utf8', timeout: 8000 });
  if (result.error) return { ok: false, error: result.error.message, output: '' };
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
  return { ok: result.status === 0, output, status: result.status };
}

const checks = [];
function add(id, status, detail, fix) {
  checks.push({ id, status, detail, ...(fix ? { fix } : {}) });
}

// --- runtime ---------------------------------------------------------------
const nodeMajor = Number(process.versions.node.split('.')[0]);
add('node', nodeMajor >= 20 ? 'pass' : 'fail', `node ${process.versions.node}`, nodeMajor >= 20 ? undefined : 'install Node.js >= 20');

let pluginVersion = 'unknown';
try {
  pluginVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version ?? 'unknown';
} catch { /* the check below reports the missing package */ }

add('plugin-package', existsSync(join(ROOT, 'package.json')) ? 'pass' : 'fail', `dsh-cad-harness ${pluginVersion} at ${ROOT}`,
  existsSync(join(ROOT, 'package.json')) ? undefined : 'reinstall the plugin package');

const dshBin = onPath('dsh');
if (!dshBin) {
  add('dsh', 'warn', 'dsh not found on PATH (plugin may still be running inside dsh)', 'run `dsh --version` from the profile that loads the plugin');
} else {
  const v = versionOf(dshBin);
  add('dsh', v.ok ? 'pass' : 'warn', v.ok ? v.output.split('\n')[0] : `dsh found but --version failed: ${v.error ?? v.output}`,
    v.ok ? undefined : 'check the dsh installation');
}

// A tested range is a claim; print it and check the rough major/minor so a
// future dsh does not silently load an API it does not have.
let testedRange = null;
try { testedRange = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).cad?.dshRuntime ?? null; } catch { /* reported above */ }
const dshVersion = dshBin ? (versionOf(dshBin).output.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/)?.[0] ?? null) : null;
if (!dshVersion) {
  add('dsh-compat', 'warn', `cannot parse dsh version (tested: ${testedRange ?? 'unknown'})`, 'run `dsh --version`');
} else {
  const [major, minor, patch] = dshVersion.split(/[.-]/).map(Number);
  const ok = major === 0 && minor === 2 && patch >= 1;
  const future = major > 0 || minor > 2;
  add('dsh-compat', ok && !future ? 'pass' : future ? 'warn' : 'fail',
    `dsh ${dshVersion} (tested: ${testedRange ?? 'unknown'})`,
    ok && !future ? undefined : 'install dsh 0.2.1-rc.2 or a later 0.2.x; 0.3+ is untested');
}

// The bundle entry point is what dsh loads; a missing lib/ is a broken install.
add('bundle-lib', existsSync(join(ROOT, 'lib/index.js')) ? 'pass' : 'fail',
  existsSync(join(ROOT, 'lib/index.js')) ? 'lib/index.js present' : 'lib/index.js missing (package was not built)',
  existsSync(join(ROOT, 'lib/index.js')) ? undefined : 'reinstall the built tarball, or run `npm run build` in a checkout');

// --- OpenSCAD --------------------------------------------------------------
const backendFile = join(CAD_HOME, 'backend.json');
let backendConfig = { kernel: 'openscad', compileBackend: 'auto', binaryPath: null };
try { backendConfig = { ...backendConfig, ...JSON.parse(readFileSync(backendFile, 'utf8')) }; } catch { /* defaults */ }
const repoSandbox = join(ROOT, '..', 'bin', 'squashfs-root', 'usr', 'bin', 'openscad');
const candidates = explicitOpenScad
  ? [explicitOpenScad]
  : [
      process.env.CAD_OPENSCAD_BIN,
      backendConfig.binaryPath,
      onPath('openscad'),
      existsSync(repoSandbox) ? repoSandbox : null,
    ].filter(Boolean);
let openscad = null;
let openscadVersion = null;
for (const candidate of candidates) {
  const v = versionOf(candidate);
  if (v.ok || v.output) {
    openscad = candidate;
    openscadVersion = v.output.split('\n')[0] || 'unknown';
    break;
  }
}
if (!openscad) {
  add('openscad', 'fail', 'OpenSCAD not found', 'run `npx dsh-cad-provision`, or install OpenSCAD 2025.06+ on PATH / set CAD_OPENSCAD_BIN');
} else {
  const year = Number(/20(\d{2})/.exec(openscadVersion ?? '')?.[1] ?? 0);
  add('openscad', 'pass', `${openscad} — ${openscadVersion}`, undefined);
  if (year > 0 && year < 25) {
    add('openscad-backend', 'warn', 'OpenSCAD is older than 2025.06; the Manifold backend is off', 'install 2025.06+ for the fast/robust backend');
  } else {
    add('openscad-backend', 'pass', year >= 25 ? 'Manifold-capable (2025.06+)' : 'version not parsed; backend left to OpenSCAD');
  }
}

// BOSL2 is optional; missing it must be visible, not silently produce empty geometry.
const bosl2 = [
  process.env.OPENSCADPATH?.split(delimiter).map((p) => join(p, 'BOSL2', 'std.scad')).find(existsSync),
  join(ROOT, '..', 'lib', 'BOSL2', 'std.scad'),
  join(ROOT, 'lib', 'BOSL2', 'std.scad'),
].find((p) => p && existsSync(p));
add('bosl2', bosl2 ? 'pass' : 'warn', bosl2 ? `BOSL2 at ${bosl2}` : 'BOSL2 not found (optional; standard parts need it)',
  bosl2 ? undefined : 'download BOSL2 into lib/BOSL2 and set OPENSCADPATH to the directory that CONTAINS BOSL2');

// --- backend selection -----------------------------------------------------
add('backend', backendConfig.kernel === 'openscad' ? 'pass' : 'fail',
  `kernel=${backendConfig.kernel} compileBackend=${backendConfig.compileBackend}`,
  backendConfig.kernel === 'openscad' ? undefined : 'run `npx dsh-cad-backend --kernel openscad` (only OpenSCAD ships in this preview)');

// --- Python runtime --------------------------------------------------------
const pythonMode = (process.env.DSH_CAD_PYTHON ?? '').toLowerCase();
const runtimeRoot = resolve(process.env.DSH_CAD_PYTHON_ROOT?.trim() || join(CAD_HOME, 'runtime'));
if (pythonMode === 'off') {
  add('python-runtime', 'warn', 'DSH_CAD_PYTHON=off — geometry analysis, physics and fluid are unavailable', 'unset DSH_CAD_PYTHON to use the bundled runtime');
} else if (pythonMode === 'system') {
  const py = onPath(process.platform === 'win32' ? 'python' : 'python3') ?? onPath('python');
  add('python-runtime', py ? 'pass' : 'fail', py ? `system Python at ${py}` : 'DSH_CAD_PYTHON=system but no python3 on PATH',
    py ? undefined : 'install CPython 3.13 or unset DSH_CAD_PYTHON');
} else {
  const statePath = join(runtimeRoot, 'state.json');
  let state = null;
  try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch { /* absent */ }
  if (!state) {
    add('python-runtime', 'warn', `runtime absent at ${runtimeRoot}; provisioned on first use (about 400 MB)`, 'set DSH_CAD_PYTHON=eager, or call python_runtime action=provision');
  } else if (state.error) {
    add('python-runtime', 'fail', `runtime failed: ${state.error}`, 'run python_runtime action=repair');
  } else if (state.venvPython && existsSync(state.venvPython)) {
    add('python-runtime', 'pass', `ready at ${runtimeRoot}`);
  } else {
    add('python-runtime', 'warn', `runtime at ${runtimeRoot} is not ready (phase=${state.phase ?? 'unknown'})`, 'run python_runtime action=provision');
  }
}

// --- Skills + preset -------------------------------------------------------
const skillDir = resolve(explicitSkillDir ?? join(ROOT, 'skills'));
const skills = listSkillFiles(skillDir);
add('skills', skills.length === 0 ? 'fail' : skills.length < 5 ? 'warn' : 'pass',
  skills.length ? `${skills.length} skill(s) under ${skillDir}` : `no SKILL.md under ${skillDir}`,
  skills.length >= 5 ? undefined : 'reinstall the package; expected the 5 CAD skills');
const presetFile = join(ROOT, 'presets', 'cad', 'preset.patch.yml');
let preset = '';
try { preset = readFileSync(presetFile, 'utf8'); } catch { /* missing */ }
const presetHasSkill = preset.includes(`- ${skillDir}`);
add('preset-skill-path', presetHasSkill ? 'pass' : 'fail',
  presetHasSkill ? 'preset points at this machine\'s skill directory' : 'preset does not point at this skill directory (stale or missing)',
  presetHasSkill ? undefined : 'run `npx dsh-cad-setup`, then restart dsh');

// --- temp hygiene ----------------------------------------------------------
const TEMP_PREFIXES = ['cad-harness-', 'cad-doctor-', 'cad-setup-', 'cad-export-', 'cad-add-', 'cad-bundle-', 'cad-backend-', 'cad-pyfail-', 'cad-rehearse-', 'cad-http-'];
const MAX_TEMP_MB = Number(process.env.DSH_CAD_TEMP_MAX_MB ?? '512');
function dirBytes(dir) {
  let total = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) total += dirBytes(path);
      else if (entry.isFile()) { try { total += statSync(path).size; } catch { /* racing delete */ } }
    }
  } catch { /* racing delete */ }
  return total;
}
let staleTemps = 0;
let staleBytes = 0;
if (existsSync(tmpRoot)) {
  const cutoff = Date.now() - 60 * 60_000;
  for (const entry of readdirSync(tmpRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !TEMP_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) continue;
    try {
      const stat = statSync(join(tmpRoot, entry.name));
      if (stat.mtimeMs < cutoff) { staleTemps++; staleBytes += dirBytes(join(tmpRoot, entry.name)); }
    } catch { /* racing delete */ }
  }
}
const tempOver = Number.isFinite(MAX_TEMP_MB) && staleBytes > MAX_TEMP_MB * 1024 * 1024;
add('temp-dirs', staleTemps === 0 && !tempOver ? 'pass' : 'warn',
  staleTemps === 0 && !tempOver
    ? `no stale CAD temp dirs under ${tmpRoot}`
    : `${staleTemps} stale CAD temp dir(s), ${(staleBytes / 1024 / 1024).toFixed(1)} MiB / ${MAX_TEMP_MB} MiB limit under ${tmpRoot}`,
  staleTemps === 0 && !tempOver ? undefined : 'run `npx dsh-cad-clean --apply --max-mb ' + MAX_TEMP_MB + '` (dry-run without --apply)');

// --- project (optional) ----------------------------------------------------
if (project) {
  const readJson = (file) => {
    if (!existsSync(file)) return { ok: true, absent: true };
    try { return { ok: true, value: JSON.parse(readFileSync(file, 'utf8')) }; }
    catch (error) { return { ok: false, error: String(error?.message ?? error) }; }
  };
  const schemaCheck = (id, file, supported) => {
    const parsed = readJson(file);
    if (parsed.absent) return;
    if (!parsed.ok) { add(id, 'fail', `${file}: unreadable (${parsed.error})`, 'restore the file from a backup; do not let a torn write look like an empty project'); return; }
    const version = parsed.value?.schemaVersion;
    if (version === undefined || version === null) { add(id, 'pass', `${file}: legacy (no schemaVersion)`); return; }
    if (!Number.isInteger(version)) { add(id, 'fail', `${file}: schemaVersion is not an integer (${JSON.stringify(version)})`, 'fix the file by hand or restore a backup'); return; }
    if (version > supported) {
      add(id, 'fail', `${file}: schemaVersion ${version} is newer than this plugin (${supported})`,
        'upgrade dsh-cad-harness; do not run a newer project on an older plugin, and back up before migrating');
      return;
    }
    if (version < supported) {
      add(id, 'warn', `${file}: schemaVersion ${version} is older than this plugin (${supported})`,
        'back up the project, then run the migration named in docs/dev/SCHEMA.md (none is automatic yet)');
      return;
    }
    add(id, 'pass', `${file}: schemaVersion ${version}`);
  };

  const marker = join(project, 'cad-data', 'project.json');
  add('project-marker', existsSync(marker) ? 'pass' : 'warn',
    existsSync(marker) ? `project marker at ${marker}` : `no cad-data/project.json under ${project}`,
    existsSync(marker) ? undefined : 'run init_project or bind_project in a CAD session');
  try {
    const probe = mkdtempSync(join(project, '.cad-doctor-'));
    writeFileSync(join(probe, 'probe'), 'ok');
    rmSync(probe, { recursive: true, force: true });
    add('project-write', 'pass', `writable: ${project}`);
  } catch (error) {
    add('project-write', 'fail', `cannot write ${project}: ${String(error?.message ?? error)}`, 'fix permissions or choose another project');
  }
  schemaCheck('project-schema', marker, 1);
  schemaCheck('assembly-schema', join(project, 'assembly', 'assembly.json'), 1);
  schemaCheck('claims-schema', join(project, 'claims.json'), 1);
  schemaCheck('policy-schema', join(project, 'evidence-policy.json'), 1);
}

const hasFail = checks.some((c) => c.status === 'fail');
const hasWarn = checks.some((c) => c.status === 'warn');
const kind = hasFail ? 'fail' : hasWarn ? 'degraded' : 'ok';
const report = {
  kind,
  version: {
    plugin: pluginVersion,
    node: process.versions.node,
    dsh: dshBin ? (versionOf(dshBin).output.split('\n')[0] || 'unknown') : 'unknown',
    platform: `${process.platform}/${process.arch}`,
  },
  root: ROOT,
  dshHome: DSH_HOME,
  project,
  checks,
  skills: skills.map((p) => dirname(p).split(/[\\/]/).pop()),
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`dsh-cad-doctor: ${kind}`);
  for (const c of checks) {
    const icon = c.status === 'pass' ? '✓' : c.status === 'warn' ? '!' : '✗';
    console.log(`  ${icon} ${c.id}: ${c.detail}`);
    if (c.fix) console.log(`      fix: ${c.fix}`);
  }
  if (kind !== 'ok') console.log('\nread `fix` lines above; do not treat degraded as ok');
}

process.exit(kind === 'fail' ? 2 : kind === 'degraded' ? 1 : 0);
