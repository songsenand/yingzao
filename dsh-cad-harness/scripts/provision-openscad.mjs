#!/usr/bin/env node
// Provision a portable OpenSCAD into $DSH_HOME/cad/tools/openscad/<version>.
//
// Official snapshot first. If it is unreachable or slower than 256 KB/s, the
// same pinned asset is fetched from the public OSS mirror. No admin rights, no
// PATH changes: the resulting executable is written to backend.json.

import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { assetFor, downloadWithFallback, OPENSCAD_VERSION, sourcesFor } from './provision-lib.mjs';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const json = has('--json');
const check = has('--check');
const force = has('--force');
const dryRun = has('--dry-run');
const sourceMode = valueOf('--source') ?? 'auto';
const fromFile = valueOf('--from');
const home = resolve(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'));

function out(text) {
  if (json) return;
  process.stderr.write(`${text}\n`);
}

function versionOf(bin) {
  try {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 8000 });
    const text = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    const line = text.split('\n').find((l) => /OpenSCAD version|20\d\d\.\d\d/.test(l));
    return line?.trim() || null;
  } catch {
    return null;
  }
}

function versionScore(text) {
  const m = /20(\d{2})\.(\d{2})/.exec(text ?? '');
  return m ? Number(`20${m[1]}${m[2]}`) : 0;
}

function systemOpenScad() {
  const candidates = [process.env.CAD_OPENSCAD_BIN, process.platform === 'win32' ? 'openscad.com' : 'openscad', 'openscad'];
  for (const bin of candidates.filter(Boolean)) {
    if (bin !== 'openscad' && bin !== 'openscad.com' && !existsSync(bin)) continue;
    const version = versionOf(bin);
    if (version) return { bin, version, score: versionScore(version) };
  }
  return null;
}

function findExecutable(root) {
  if (!existsSync(root)) return null;
  const direct = process.platform === 'win32'
    ? [join(root, `OpenSCAD-${OPENSCAD_VERSION}-x86-64`, 'openscad.exe'), join(root, 'openscad.exe')]
    : process.platform === 'darwin'
      ? [join(root, 'OpenSCAD.app', 'Contents', 'MacOS', 'OpenSCAD')]
      : [join(root, 'squashfs-root', 'AppRun'), join(root, 'OpenSCAD.AppImage')];
  for (const p of direct) if (existsSync(p)) return p;
  if (process.platform === 'darwin') {
    for (const name of readdirSync(root)) {
      if (!name.endsWith('.app')) continue;
      const p = join(root, name, 'Contents', 'MacOS', 'OpenSCAD');
      if (existsSync(p)) return p;
    }
  }
  if (process.platform === 'win32') {
    const stack = [{ dir: root, depth: 0 }];
    while (stack.length) {
      const { dir, depth } = stack.pop();
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        let st;
        try { st = statSync(p); } catch { continue; }
        if (st.isDirectory() && depth < 3) stack.push({ dir: p, depth: depth + 1 });
        else if (name.toLowerCase() === 'openscad.exe') return p;
      }
    }
  }
  return null;
}

function installed() {
  const configPath = join(home, 'cad', 'backend.json');
  if (existsSync(configPath)) {
    try {
      const bin = JSON.parse(readFileSync(configPath, 'utf8')).binaryPath;
      if (typeof bin === 'string' && existsSync(bin)) {
        const version = versionOf(bin);
        if (version) return { bin, version, source: 'backend.json' };
      }
    } catch { /* fall through */ }
  }
  return null;
}

function writeBackend(bin) {
  const path = join(home, 'cad', 'backend.json');
  mkdirSync(dirname(path), { recursive: true });
  let current = { kernel: 'openscad', compileBackend: 'auto', binaryPath: null };
  if (existsSync(path)) {
    try { current = { ...current, ...JSON.parse(readFileSync(path, 'utf8')) }; } catch { /* replace */ }
  }
  current.kernel = 'openscad';
  current.binaryPath = bin;
  writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
  return path;
}

function extractZip(zip, root) {
  mkdirSync(root, { recursive: true });
  if (process.platform === 'win32') {
    const q = (p) => p.replace(/'/g, "''");
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${q(zip)}' -DestinationPath '${q(root)}' -Force`], { stdio: 'inherit' });
  } else {
    execFileSync('unzip', ['-q', '-o', zip, '-d', root], { stdio: 'inherit' });
  }
}

function extractAppImage(file, root) {
  mkdirSync(root, { recursive: true });
  const bin = join(root, 'OpenSCAD.AppImage');
  copyFileSync(file, bin);
  chmodSync(bin, 0o755);
  if (versionOf(bin)) return bin;
  out('AppImage direct run failed (FUSE?); extracting instead');
  execFileSync(bin, ['--appimage-extract'], { cwd: root, stdio: 'inherit' });
  const apprun = join(root, 'squashfs-root', 'AppRun');
  if (existsSync(apprun)) chmodSync(apprun, 0o755);
  return apprun;
}

function extractDmg(file, root) {
  mkdirSync(root, { recursive: true });
  const mnt = join(root, '.dmg-mount');
  mkdirSync(mnt, { recursive: true });
  try {
    execFileSync('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mnt, file], { stdio: 'inherit' });
    const app = readdirSync(mnt).find((name) => name.endsWith('.app'));
    if (!app) throw new Error('DMG contains no .app bundle');
    cpSync(join(mnt, app), join(root, app), { recursive: true, force: true });
    return join(root, app, 'Contents', 'MacOS', 'OpenSCAD');
  } finally {
    try { execFileSync('hdiutil', ['detach', mnt], { stdio: 'ignore' }); } catch { /* already detached */ }
    try { rmSync(mnt, { recursive: true, force: true }); } catch { /* racing */ }
  }
}

async function main() {
  if (has('--help') || has('-h')) {
    console.log(`usage: dsh-cad-provision [options]

  --check              report whether OpenSCAD is already usable; never download
  --json               machine-readable output
  --source auto|official|mirror  default auto: official first, mirror on slow/failure
  --from <file>        install from a local archive (no network)
  --force              reinstall even when a usable version exists
  --dry-run            print the selected sources without downloading

Exit: 0 ok · 1 missing/failed · 2 usage/unsupported platform`);
    process.exit(0);
  }
  if (!['auto', 'official', 'mirror'].includes(sourceMode)) {
    console.error(`dsh-cad-provision: unknown --source ${sourceMode}`);
    process.exit(2);
  }

  const system = systemOpenScad();
  const existing = installed();
  if (check) {
    const ready = system?.score >= 202506 ? { ...system, source: 'system' } : existing;
    const payload = ready ?? { ok: false, reason: 'no usable OpenSCAD 2025.06+', home };
    if (json) console.log(JSON.stringify({ ok: Boolean(ready), ...payload }, null, 2));
    else if (ready) console.log(`OpenSCAD ready: ${ready.bin} (${ready.version}; ${ready.source})`);
    else console.log('OpenSCAD not ready: install 2025.06+ or run dsh-cad-provision');
    process.exit(ready ? 0 : 1);
  }

  if (!force && !fromFile && system?.score >= 202506) {
    const payload = { ok: true, source: 'system', bin: system.bin, version: system.version };
    if (json) console.log(JSON.stringify(payload, null, 2));
    else console.log(`Using system OpenSCAD: ${system.bin} (${system.version})`);
    process.exit(0);
  }

  if (!force && !fromFile && existing) {
    writeBackend(existing.bin);
    const payload = { ok: true, source: existing.source, bin: existing.bin, version: existing.version };
    if (json) console.log(JSON.stringify(payload, null, 2));
    else console.log(`Using installed OpenSCAD: ${existing.bin} (${existing.version})`);
    process.exit(0);
  }

  const asset = assetFor();
  if (!asset) {
    console.error(`dsh-cad-provision: unsupported platform ${process.platform}`);
    process.exit(2);
  }
  const root = join(home, 'cad', 'tools', 'openscad', OPENSCAD_VERSION);
  const archive = fromFile ? resolve(fromFile) : join(home, 'cad', 'cache', 'openscad', asset.filename);

  if (dryRun) {
    const sources = fromFile ? [{ label: 'local', url: archive }] : sourcesFor(asset, sourceMode);
    console.log(JSON.stringify({ platform: process.platform, version: OPENSCAD_VERSION, root, sources }, null, 2));
    process.exit(0);
  }

  if (fromFile) {
    if (!existsSync(archive)) {
      console.error(`dsh-cad-provision: no such file ${archive}`);
      process.exit(1);
    }
  } else {
    const sources = sourcesFor(asset, sourceMode);
    out(`OpenSCAD ${OPENSCAD_VERSION}: ${sources.map((s) => s.label).join(' → ')}`);
    const result = await downloadWithFallback({
      sources,
      expectedSha: asset.sha256,
      size: asset.size,
      dest: archive,
      log: out,
    });
    out(`downloaded from ${result.source} (${result.bytes} bytes)`);
  }

  if (force) rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  let bin;
  if (asset.archive === 'zip') {
    extractZip(archive, root);
    bin = findExecutable(root);
  } else if (asset.archive === 'appimage') {
    bin = extractAppImage(archive, root);
  } else {
    bin = extractDmg(archive, root);
  }
  if (!bin || !existsSync(bin)) throw new Error('archive did not contain the expected OpenSCAD executable');
  const version = versionOf(bin);
  if (!version) throw new Error(`installed binary does not answer --version: ${bin}`);
  const config = writeBackend(bin);
  const payload = { ok: true, source: fromFile ? 'local' : 'download', bin, version, config, root };
  if (json) console.log(JSON.stringify(payload, null, 2));
  else {
    console.log(`OpenSCAD ${version}`);
    console.log(`binary: ${bin}`);
    console.log(`backend: ${config}`);
  }
}

main().catch((error) => {
  console.error(`dsh-cad-provision: ${String(error?.message ?? error)}`);
  process.exit(1);
});
