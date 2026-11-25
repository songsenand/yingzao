#!/usr/bin/env node
// DSH compatibility matrix: run this plugin against several DSH versions in
// throwaway containers, without touching the host's global npm or ~/.dsh.
//
//   node scripts/accept-dsh-matrix.mjs
//   node scripts/accept-dsh-matrix.mjs --versions 0.2.1-rc.2,0.2.2-rc.5
//   node scripts/accept-dsh-matrix.mjs --engine local --json
//
// Why kern: one rootless binary, no daemon, no global installs. The state
// (images, version volume) lives under --state, and every box is --rm.
//
// IMPORTANT: run this from a normal terminal, not from inside another
// sandbox. kern needs the systemd user bus to create its cgroup scope; a
// bwrap-based shell cannot reach it.
//
// Two boxes are involved:
//   1. install box (--net host): installs missing DSH versions into a named
//      volume, so later runs reuse them.
//   2. test box (--net none): runs the plugin's T0-T2 assertions with a
//      loopback-only mock model. No network leaves the box.
//
// The assertions themselves live in accept-dsh-matrix-box.sh so `--engine
// local` can run the exact same code on the host for debugging.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CONFIG = JSON.parse(readFileSync(join(ROOT, 'dsh-matrix.json'), 'utf8'));
const KNOWN_BLOCKED = CONFIG.knownBlocked ?? {};
const VERSION_VOLUME = process.env.DSH_MATRIX_VOLUME ?? 'yingzao-dsh-versions';
const BOX_SCRIPT = join(ROOT, 'scripts', 'accept-dsh-matrix-box.sh');

function argValue(name) {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  const value = process.argv[i + 1];
  if (!value || value.startsWith('--')) {
    console.error(`accept-dsh-matrix: ${name} needs a value`);
    process.exit(2);
  }
  return value;
}

const engine = argValue('--engine') ?? 'kern';
const versions = (argValue('--versions') ?? CONFIG.versions.join(','))
  .split(',').map((v) => v.trim()).filter(Boolean);
const state = resolve(argValue('--state') ?? process.env.DSH_MATRIX_HOME ?? join(homedir(), '.cache', 'yingzao-dsh-matrix'));
const outRoot = resolve(argValue('--out') ?? join(ROOT, 'verification', 'dsh-matrix'));
const image = argValue('--image') ?? process.env.DSH_MATRIX_IMAGE ?? CONFIG.image;
const memory = argValue('--memory') ?? process.env.DSH_MATRIX_MEMORY ?? '4g';
const asJson = process.argv.includes('--json');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`usage: node scripts/accept-dsh-matrix.mjs [options]

  --engine kern|local   kern (default) or run the same assertions on the host
                        (local uses the host's Node; debug only)
  --versions a,b        DSH versions (default: dsh-matrix.json)
  --state DIR           cache for images/version volume (default: ~/.cache/yingzao-dsh-matrix)
  --out DIR             result directory (default: verification/dsh-matrix)
  --image REF           container image (default: dsh-matrix.json)
  --memory SIZE         box memory cap (default: 4g; npm install needs more than 512m)
  --json                print only the aggregate JSON
`);
  process.exit(0);
}

if (process.platform === 'win32' && engine === 'local') {
  console.error('accept-dsh-matrix: --engine local needs a POSIX shell; use --engine kern on Windows (WSL2).');
  process.exit(2);
}
if (engine !== 'kern' && engine !== 'local') {
  console.error(`accept-dsh-matrix: unknown engine "${engine}" (kern|local)`);
  process.exit(2);
}
if (versions.length === 0) {
  console.error('accept-dsh-matrix: no versions');
  process.exit(2);
}
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
for (const version of versions) {
  if (!VERSION_RE.test(version)) {
    console.error(`accept-dsh-matrix: invalid version "${version}" (expected e.g. 0.2.2-rc.5)`);
    process.exit(2);
  }
}
if (!existsSync(join(ROOT, 'lib', 'index.js'))) {
  console.error('accept-dsh-matrix: lib/index.js is missing; run `npm run build` first');
  process.exit(2);
}

const startedAt = new Date().toISOString();
const stamp = startedAt.replace(/[:.]/g, '-');
const runDir = join(outRoot, stamp);
mkdirSync(runDir, { recursive: true });
mkdirSync(join(state, 'data'), { recursive: true });
mkdirSync(join(state, 'cache'), { recursive: true });
mkdirSync(join(state, 'config'), { recursive: true });
mkdirSync(join(state, 'npm-cache'), { recursive: true });

function kernEnv() {
  return {
    ...process.env,
    XDG_DATA_HOME: join(state, 'data'),
    XDG_CACHE_HOME: join(state, 'cache'),
    XDG_CONFIG_HOME: join(state, 'config'),
  };
}

function resolveKern() {
  if (process.env.KERN_BIN) return process.env.KERN_BIN;
  const onPath = spawnSync('sh', ['-c', 'command -v kern'], { encoding: 'utf8' });
  if (onPath.status === 0 && onPath.stdout.trim()) return onPath.stdout.trim();
  const local = join(state, 'bin', 'kern');
  if (existsSync(local)) return local;
  console.error('accept-dsh-matrix: kern not found. Install it (rootless, no daemon):');
  console.error('  curl -fsSL https://raw.githubusercontent.com/getkern/kern/main/install.sh | sh');
  console.error('or point KERN_BIN at the binary. Use --engine local to run without a container.');
  process.exit(2);
}

function run(command, args, { timeout = 10 * 60_000, env = process.env, label = command } = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout,
    env,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    const reason = result.error.code === 'ETIMEDOUT' ? `timed out after ${Math.round(timeout / 1000)}s` : result.error.message;
    return { ...result, ok: false, reason };
  }
  return { ...result, ok: result.status === 0, reason: result.status === 0 ? undefined : `exit ${result.status}` };
}

function fail(message, result) {
  console.error(`accept-dsh-matrix: ${message}`);
  if (result) {
    if (result.stdout) console.error(result.stdout.slice(-4000));
    if (result.stderr) console.error(result.stderr.slice(-4000));
  }
  process.exit(1);
}

function sanitize(value) {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, '-');
}

// --- version preparation ---------------------------------------------------
function installCommands(missing) {
  // No `set -e`: one failed version must not abort the rest of a sweep.
  const lines = ['set -u', 'export npm_config_cache=/opt/dsh/.npm-cache', 'mkdir -p /opt/dsh/.npm-cache'];
  for (const version of missing) {
    lines.push(`if [ -f "/opt/dsh/${version}/node_modules/@deepseek-ai/dsh/lib/bin.js" ]; then echo "CACHED ${version}"; else`);
    lines.push(`  echo "INSTALL ${version}"`);
    lines.push(`  mkdir -p "/opt/dsh/${version}"`);
    lines.push(`  printf '{"name":"dsh-%s","private":true}\\n' "${version}" > "/opt/dsh/${version}/package.json"`);
    lines.push(`  if npm install --prefix "/opt/dsh/${version}" --no-audit --no-fund --loglevel=error "@deepseek-ai/dsh@${version}"; then`);
    lines.push(`    echo "INSTALLED ${version}"`);
    lines.push('  else');
    lines.push(`    echo "INSTALL-FAILED ${version}"`);
    lines.push('  fi');
    lines.push('fi');
  }
  return lines.join('\n');
}

function prepareKernVersions(kern) {
  // The box checks the volume and installs only what is missing. It always
  // gets --net host because a cached volume still has to be inspected first.
  const script = installCommands(versions);
  const box = `yingzao-matrix-install-${stamp}`;
  const result = run(kern, [
    'box', box, '--image', image, '--privileged', '--net', 'host', '--memory', memory, '--rm',
    '--pull', 'missing',
    '-v', `${VERSION_VOLUME}:/opt/dsh`,
    '--', 'sh', '-c', script,
  ], { timeout: 4 * 60 * 60_000, env: kernEnv(), label: 'kern install box' });
  if (result.error?.code === 'ETIMEDOUT') run(kern, ['kill', box], { timeout: 30_000, env: kernEnv() });
  if (!result.ok) {
    const hint = /user scope bus|systemd/i.test(`${result.stderr ?? ''}${result.stdout ?? ''}`)
      ? '\nHint: kern needs the systemd user bus. Run from a normal terminal, not inside another sandbox.'
      : '';
    fail(`failed to prepare DSH versions in the kern volume${hint}`, result);
  }
  const installed = versions.filter((v) => `${result.stdout ?? ''}`.includes(`INSTALLED ${v}`));
  const cached = versions.filter((v) => `${result.stdout ?? ''}`.includes(`CACHED ${v}`));
  const failed = versions.filter((v) => `${result.stdout ?? ''}`.includes(`INSTALL-FAILED ${v}`));
  return { cached, installed, failed };
}

function prepareLocalVersion(version) {
  const prefix = join(state, 'local', version);
  const bin = join(prefix, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (existsSync(bin)) return prefix;
  if (!asJson) console.log(`   installing dsh@${version} locally (first run only)...`);
  mkdirSync(prefix, { recursive: true });
  writeFileSync(join(prefix, 'package.json'), `${JSON.stringify({ name: `dsh-${version}`, private: true }, null, 2)}\n`);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = run(npm, ['install', '--prefix', prefix, '--no-audit', '--no-fund', '--loglevel=error', `@deepseek-ai/dsh@${version}`], {
    timeout: 2 * 60 * 60_000,
    env: { ...process.env, npm_config_cache: join(state, 'npm-cache') },
    label: `npm install @deepseek-ai/dsh@${version}`,
  });
  if (!result.ok) fail(`could not install dsh@${version} locally`, result);
  return prefix;
}

// --- one version -----------------------------------------------------------
function parseChecks(text) {
  const checks = {};
  for (const line of text.split('\n')) {
    const match = /^CHECK (\S+)=(pass|fail)(?:\s+(.*))?$/.exec(line.trim());
    if (match) checks[match[1]] = { status: match[2], detail: match[3] ?? '' };
  }
  return checks;
}

function runVersionInBox(kern, version) {
  const box = sanitize(`yingzao-matrix-${version}-${stamp}`);
  const resultFile = join(runDir, `${version}.result`);
  const logFile = join(runDir, `${version}.box.log`);
  const started = Date.now();
  const result = run(kern, [
    'box', box, '--image', image, '--privileged', '--net', 'none', '--memory', memory, '--rm',
    '-v', `${ROOT}:/work:ro`,
    '-v', `${VERSION_VOLUME}:/opt/dsh:ro`,
    '-v', `${runDir}:/out`,
    '--', 'sh', '/work/scripts/accept-dsh-matrix-box.sh',
    version, `/out/${version}.result`, `/opt/dsh/${version}`, '/work', '/out',
  ], { timeout: 10 * 60_000, env: kernEnv(), label: `kern box ${version}` });
  if (result.error?.code === 'ETIMEDOUT') run(kern, ['kill', box], { timeout: 30_000, env: kernEnv() });
  writeFileSync(logFile, `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  const checks = existsSync(resultFile) ? parseChecks(readFileSync(resultFile, 'utf8')) : {};
  const ok = result.ok && Object.values(checks).every((c) => c.status === 'pass') && Object.keys(checks).length > 0;
  return {
    version,
    engine: 'kern',
    ok,
    blocked: !ok && Boolean(KNOWN_BLOCKED[version]) && checks.binary?.status === 'fail',
    blockedReason: KNOWN_BLOCKED[version],
    elapsedMs: Date.now() - started,
    checks,
    error: result.ok ? undefined : result.reason,
    log: logFile,
  };
}

function runVersionLocal(version) {
  const prefix = prepareLocalVersion(version);
  const resultFile = join(runDir, `${version}.result`);
  const logFile = join(runDir, `${version}.local.log`);
  const started = Date.now();
  const result = run('sh', [
    BOX_SCRIPT, version, resultFile, prefix, ROOT, runDir,
  ], { timeout: 10 * 60_000, label: `local ${version}` });
  writeFileSync(logFile, `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  const checks = existsSync(resultFile) ? parseChecks(readFileSync(resultFile, 'utf8')) : {};
  const ok = result.ok && Object.values(checks).every((c) => c.status === 'pass') && Object.keys(checks).length > 0;
  return {
    version,
    engine: 'local',
    ok,
    blocked: !ok && Boolean(KNOWN_BLOCKED[version]) && checks.binary?.status === 'fail',
    blockedReason: KNOWN_BLOCKED[version],
    elapsedMs: Date.now() - started,
    checks,
    error: result.ok ? undefined : result.reason,
    log: logFile,
  };
}

// --- main ------------------------------------------------------------------
let kern;
let prepared = { cached: [], installed: [], failed: [] };
if (engine === 'kern') {
  kern = resolveKern();
  const version = run(kern, ['--version'], { timeout: 30_000, env: kernEnv() });
  if (!version.ok) fail('kern --version failed', version);
  if (!asJson) console.log('== preparing DSH versions (install box; first run downloads about 1.2 GB per version)');
  prepared = prepareKernVersions(kern);
  if (!asJson) {
    if (prepared.installed.length) console.log(`   installed: ${prepared.installed.join(', ')}`);
    if (prepared.cached.length) console.log(`   reused: ${prepared.cached.join(', ')}`);
    if (prepared.failed.length) console.log(`   install failed: ${prepared.failed.join(', ')}`);
  }
}

const rows = [];
for (const version of versions) {
  if (!asJson) console.log(`\n== dsh ${version} (${engine})`);
  const row = engine === 'kern' ? runVersionInBox(kern, version) : runVersionLocal(version);
  rows.push(row);
  if (!asJson) {
    console.log(`   ${row.ok ? 'PASS' : row.blocked ? 'BLOCKED' : 'FAIL'}  ${(row.elapsedMs / 1000).toFixed(1)}s`);
    for (const [name, check] of Object.entries(row.checks)) {
      console.log(`   ${check.status === 'pass' ? '  ' : '!!'} ${name.padEnd(12)} ${check.status} ${check.detail}`);
    }
    if (row.error) console.log(`   error: ${row.error}`);
  }
}

const ok = rows.every((row) => row.ok || row.blocked);
const blockedRows = rows.filter((row) => row.blocked);
const aggregate = {
  schemaVersion: 1,
  engine,
  image: engine === 'kern' ? image : undefined,
  startedAt,
  state,
  output: runDir,
  prepared,
  ok,
  versions: rows,
};
const jsonFile = join(outRoot, `${stamp}.json`);
const mdFile = join(outRoot, `${stamp}.md`);
writeFileSync(jsonFile, `${JSON.stringify(aggregate, null, 2)}\n`);

const defaultChecks = ['binary', 'engines', 'setup', 'compose', 'boot', 'tools', 'tool-call', 'tool-result', 'tool-final'];
const checkNames = [...new Set([...defaultChecks, ...rows.flatMap((row) => Object.keys(row.checks))])];
const md = [
  '# DSH compatibility matrix',
  '',
  `- engine: ${engine}`,
  ...(engine === 'kern' ? [`- image: ${image}`] : []),
  `- started: ${aggregate.startedAt}`,
  `- result: ${ok ? 'PASS' : 'FAIL'}`,
  ...(prepared.installed.length ? [`- installed this run: ${prepared.installed.join(', ')}`] : []),
  ...(prepared.cached.length ? [`- reused: ${prepared.cached.join(', ')}`] : []),
  ...(prepared.failed?.length ? [`- install failed: ${prepared.failed.join(', ')}`] : []),
  ...(blockedRows.length ? [`- blocked (known upstream): ${blockedRows.map((row) => row.version).join(', ')}`] : []),
  '',
  `| version | ${checkNames.join(' | ')} | result |`,
  `|---|${checkNames.map(() => '---').join('|')}|---|`,
  ...rows.map((row) => `| ${row.version} | ${checkNames.map((name) => row.checks[name]?.status ?? '-').join(' | ')} | ${row.ok ? 'PASS' : row.blocked ? 'BLOCKED' : 'FAIL'} |`),
  '',
  ...(blockedRows.length ? ['## Blocked (known upstream)', '', ...blockedRows.map((row) => `- ${row.version}: ${row.blockedReason}`), ''] : []),
  ...(ok ? [] : ['## Failures', '', ...rows.filter((row) => !row.ok && !row.blocked).map((row) => `- ${row.version}: ${row.error ?? 'check failed'} (${row.log})`), '']),
  `Full JSON: ${jsonFile}`,
].join('\n');
writeFileSync(mdFile, md);

if (asJson) {
  console.log(JSON.stringify(aggregate, null, 2));
} else {
  console.log(`\n${ok ? 'PASS' : 'FAIL'}  ${rows.length} version(s)${blockedRows.length ? ` · ${blockedRows.length} blocked` : ''} · ${mdFile}`);
}

process.exit(ok ? 0 : 1);
