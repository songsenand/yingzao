#!/usr/bin/env node
// Acceptance for the sealed assembly contract:
//   - only the contract writer produces a seal + change record;
//   - a direct edit is refused by the seal check and restorable from the log;
//   - reason / expectedRevision / dryRun / diff behave as documented.
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { projectStores } from '../src/host/project.ts';
import { loadAssemblyManifest, saveAssemblyManifest } from '../src/host/manifest.ts';
import { planProjectExport } from '../src/host/project-export.ts';
import {
  rebuildContract,
  verifyContract,
  writeAssemblyContract,
} from '../src/host/assembly-contract.ts';
import { applyCadFsPolicy, isProtectedAssemblyPath, isCadProjectPath } from '../src/host/fs-policy.ts';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const hash = (s) => `sha256:${createHash('sha256').update(s).digest('hex')}`;

async function seedProject(dir) {
  await mkdir(join(dir, 'cad-data/versions/v001'), { recursive: true });
  await writeFile(join(dir, 'cad-data/project.json'), JSON.stringify({ schemaVersion: 1, cwd: dir, key: 'test', title: 'test' }));
  await writeFile(join(dir, 'cad-data/versions/v001/datums.json'), JSON.stringify({
    points: [{ name: 'p', point: [0, 0, 0] }], axes: [], planes: [], cylinders: [],
  }));
}

const dir = await mkdtemp(join(tmpdir(), 'contract-accept-'));
const manifestPath = join(dir, 'assembly/assembly.json');

try {
  await seedProject(dir);
  const project = projectStores(dir);
  const root = {
    id: 'asm', name: 'test assembly', kind: 'assembly',
    children: [
      { id: 'partA', name: 'A', kind: 'part', version: 'v001' },
      { id: 'partB', name: 'B', kind: 'part', version: 'v001' },
    ],
    interfaces: [
      { id: 'I1', a: 'partA.p', b: 'partB.p', type: '贴合', severity: 'hard', check: 'distance', expected: 0, tolerance: { min: -1, max: 1 } },
    ],
  };

  let missingReason = '';
  try { await writeAssemblyContract(project, { mode: 'create', expectedRevision: 0, reason: '   ', root }); } catch (e) { missingReason = String(e); }
  check(missingReason.includes('reason is required'), 'create refuses an empty reason', missingReason.slice(0, 80));

  let missingRevision = '';
  try { await writeAssemblyContract(project, { mode: 'create', reason: 'initial', root }); } catch (e) { missingRevision = String(e); }
  check(missingRevision.includes('expectedRevision'), 'create requires expectedRevision 0', missingRevision.slice(0, 80));

  const created = await writeAssemblyContract(project, { mode: 'create', expectedRevision: 0, reason: 'initial contract', root });
  check(created.changed && created.contractRevision === 1, 'create writes revision 1', JSON.stringify({ changed: created.changed, rev: created.contractRevision }));
  check(!!created.changeId, 'create returns a changeId', created.changeId ?? '');
  const verified = await verifyContract(manifestPath);
  check(verified.ok && verified.status === 'sealed' && verified.revision === 1, 'seal + change chain verify', JSON.stringify(verified));
  const loaded = await loadAssemblyManifest(manifestPath);
  check(loaded.contractRevision === 1 && loaded.contractStatus === 'sealed', 'loader exposes sealed revision', String(loaded.contractRevision));

  const plan = await planProjectExport(project);
  check(plan.contractFiles.some((f) => f.name === 'assembly/assembly.seal'), 'export plan carries assembly.seal');
  check(plan.contractFiles.some((f) => f.name.startsWith('assembly/changes/')), 'export plan carries the change log');

  const beforeDry = await readFile(manifestPath, 'utf8');
  const dry = await writeAssemblyContract(project, {
    mode: 'merge', expectedRevision: 1, reason: 'dry run', dryRun: true,
    root: { id: 'asm', name: 'dry-name' },
  });
  check(dry.dryRun && dry.changed && dry.contractRevision === 1, 'dryRun returns a diff without advancing revision', JSON.stringify({ rev: dry.contractRevision, changed: dry.changed }));
  check(await readFile(manifestPath, 'utf8') === beforeDry, 'dryRun leaves the manifest bytes untouched');

  let stale = '';
  try { await writeAssemblyContract(project, { mode: 'merge', expectedRevision: 99, reason: 'stale', root: { id: 'asm' } }); } catch (e) { stale = String(e); }
  check(stale.includes('expectedRevision mismatch'), 'stale expectedRevision is refused', stale.slice(0, 100));

  const merged = await writeAssemblyContract(project, {
    mode: 'merge', expectedRevision: 1, reason: 'rename root',
    root: { id: 'asm', name: 'renamed root' },
  });
  check(merged.changed && merged.contractRevision === 2, 'merge advances revision', JSON.stringify({ rev: merged.contractRevision }));
  const rootChange = merged.diff?.root?.find((c) => c.path === 'root.name');
  check(rootChange?.before === 'test assembly' && rootChange?.after === 'renamed root', 'diff names the root field change', JSON.stringify(rootChange));

  const tamperedText = (await readFile(manifestPath, 'utf8')).replace('renamed root', 'tampered root');
  await chmod(manifestPath, 0o644);
  await writeFile(manifestPath, tamperedText, 'utf8');
  let tampered = '';
  try { await loadAssemblyManifest(manifestPath); } catch (e) { tampered = String(e); }
  check(tampered.includes('contract-tampered'), 'direct edit is refused by the seal', tampered.slice(0, 100));

  const rebuilt = await rebuildContract(manifestPath);
  check(rebuilt.revision === 2, 'rebuild restores the last recorded revision', String(rebuilt.revision));
  const restored = await loadAssemblyManifest(manifestPath);
  check(restored.root.name === 'renamed root', 'rebuild restores the recorded manifest', restored.root.name);

  const changesDir = join(dir, 'assembly/changes');
  const changeFiles = (await import('node:fs/promises')).readdir(changesDir);
  const files = await changeFiles;
  check(files.length === 2, 'two change records exist', files.join(', '));
  const first = join(changesDir, files[0]);
  const firstText = await readFile(first, 'utf8');
  await writeFile(first, firstText.replace('initial contract', 'edited record'), 'utf8');
  const broken = await verifyContract(manifestPath);
  check(!broken.ok && broken.issues.some((i) => i.includes('parent') || i.includes('resulting')), 'editing a historical record breaks the chain', broken.issues.join('; ').slice(0, 140));
  let rebuildRefused = '';
  try { await rebuildContract(manifestPath); } catch (e) { rebuildRefused = String(e); }
  check(rebuildRefused.includes('refusing rebuild'), 'rebuild refuses to bless a rewritten change history', rebuildRefused.slice(0, 100));

  check(isProtectedAssemblyPath(join(dir, 'assembly/assembly.json')), 'path guard protects assembly.json');
  check(isProtectedAssemblyPath('./assembly/assembly.json'), 'path guard normalizes a leading ./');
  check(isProtectedAssemblyPath(join(dir, 'assembly/assembly.seal')), 'path guard protects assembly.seal');
  check(isProtectedAssemblyPath(join(dir, 'assembly/changes/0001-x.json')), 'path guard protects changes/');
  check(isCadProjectPath(join(dir, 'assembly/assembly.json')), 'path guard recognizes a CAD project');
  check(isCadProjectPath('assembly/assembly.json', dir), 'path guard resolves a workspace-relative path');

  const listeners = {};
  applyCadFsPolicy({ on: (name, fn) => { listeners[name] = fn; } });
  let guarded = '';
  let guardedCode = '';
  try {
    await listeners['fs/write-intent']({ displayPath: join(dir, 'assembly/assembly.json') });
  } catch (e) {
    guarded = String(e);
    guardedCode = String(e.code ?? '');
  }
  check(guarded.includes('refusing to write the assembly contract') && guardedCode === 'FS_PERMISSION_DENIED',
    'fs policy refuses a generic write to the contract', `${guardedCode}: ${guarded.slice(0, 80)}`);
  const passThrough = await listeners['fs/write-intent']({ displayPath: join(dir, 'src/notes.txt') });
  check(passThrough === undefined, 'fs policy leaves non-contract paths to other policies', String(passThrough));

  // Legacy: a JSON without a seal stays readable, and the first sealed write
  // creates the genesis record.
  const legacyDir = await mkdtemp(join(tmpdir(), 'contract-legacy-'));
  try {
    await seedProject(legacyDir);
    const legacyProject = projectStores(legacyDir);
    const legacyPath = join(legacyDir, 'assembly/assembly.json');
    await saveAssemblyManifest(legacyPath, { schemaVersion: 1, name: 'legacy', unit: 'mm', up: 'z', root });
    const unlocked = await loadAssemblyManifest(legacyPath);
    check(unlocked.contractStatus === 'unlocked', 'legacy JSON is readable as unlocked', String(unlocked.contractStatus));
    const legacyWrite = await writeAssemblyContract(legacyProject, {
      mode: 'merge', expectedRevision: 0, reason: 'adopt sealed writer', root: { id: 'asm', name: 'legacy renamed' },
    });
    check(legacyWrite.contractRevision === 1, 'first sealed write creates revision 1', String(legacyWrite.contractRevision));
    const legacyVerified = await verifyContract(legacyPath);
    check(legacyVerified.ok, 'legacy contract becomes sealed', JSON.stringify(legacyVerified.issues));
  } finally {
    await rm(legacyDir, { recursive: true, force: true });
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
