// The sealed contract store: change records, the writer, and the reader guard.
//
// `assembly/assembly.json` is a MATERIALIZED VIEW. The authoritative history is
// `assembly/changes/*.json`, an append-only hash chain; `assembly/assembly.seal`
// is a binary seal over the exact JSON bytes. A direct edit to the JSON changes
// its hash, so the seal no longer matches and every reader refuses the file
// until `rebuild` re-materializes it from the change log.
//
// This is deliberately not a security boundary: an actor with write access can
// forge the seal. It is a process barrier: the only path that produces a seal
// and a change record is `writeAssemblyContract`, and a direct edit is visible
// and ineffective instead of silently becoming the contract.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { withFileLock } from './file-lock.ts';
import type { AssemblyManifest, ManifestNode } from './manifest.ts';
import type { ProjectStores } from './project.ts';
import {
  changesDirFor,
  readSeal,
  sealPathFor,
  sha256Text,
  writeSeal,
  type AssemblySeal,
} from './assembly-seal.ts';
import {
  prepareAssemblyWrite,
  type WriteAssemblyInput,
  type WriteAssemblyMode,
  type WriteAssemblyResult,
} from './write-assembly.ts';

export interface ContractActor {
  sessionId?: string;
  source?: string;
}

export interface ContractWriteInput extends WriteAssemblyInput {
  /** Required for every mutation; recorded in the change log. */
  reason: string;
  /** Current revision from the seal (0 for a legacy/create contract). */
  expectedRevision?: number;
  /** Preview only: validate + diff, write nothing. */
  dryRun?: boolean;
  actor?: ContractActor;
}

export interface FieldChange {
  path: string;
  before: unknown;
  after: unknown;
}

export interface ManifestDiff {
  root: FieldChange[];
  children: {
    added: { id: string; name?: string; version?: string }[];
    removed: { id: string; name?: string; version?: string }[];
    changed: { id: string; path: string; fields: FieldChange[] }[];
  };
  interfaces: {
    added: { id: string; a?: string; b?: string }[];
    removed: { id: string; a?: string; b?: string }[];
    changed: { id: string; fields: FieldChange[] }[];
  };
}

export interface ContractChangeRecord {
  schema: 'assembly-change/v1';
  changeId: string;
  seq: number;
  /** Hash of the previous record's JSON text, or "genesis". */
  parent: string;
  /** Hash of the manifest JSON this record materialized. */
  resulting: string;
  reason: string;
  actor: ContractActor;
  at: string;
  diff: ManifestDiff;
  manifest: AssemblyManifest;
}

export interface ContractState {
  manifestPath: string;
  sealPath: string;
  changesDir: string;
  status: 'sealed' | 'unlocked' | 'missing';
  seal: AssemblySeal | null;
  text: string | null;
  manifest: AssemblyManifest | null;
}

export interface ContractWriteResult extends WriteAssemblyResult {
  contractRevision: number;
  contractHash: string;
  changeId: string | null;
  diff: ManifestDiff | null;
  dryRun: boolean;
}

export interface ContractVerification {
  ok: boolean;
  status: 'sealed' | 'unlocked' | 'missing' | 'tampered';
  revision: number;
  head: string | null;
  issues: string[];
}

const CHANGES_SCHEMA = 'assembly-change/v1';

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function manifestText(manifest: AssemblyManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function recordText(record: ContractChangeRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Resolve the manifest path with the same workspace guard as the writer. */
export function resolveContractPath(projectCwd: string, requested?: string): string {
  const raw = requested?.trim() || 'assembly/assembly.json';
  const target = isAbsolute(raw) ? raw : join(projectCwd, raw);
  const rel = relative(projectCwd, target);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`manifestPath escapes the project workspace: ${raw} -> ${target}`);
  }
  return target;
}

/** Read the JSON + seal without schema validation; tamper is an error. */
export async function readContractState(
  manifestPath: string,
  opts: { verifySeal?: boolean } = {},
): Promise<ContractState> {
  const sealPath = sealPathFor(manifestPath);
  const changesDir = changesDirFor(manifestPath);
  const seal = await readSeal(sealPath);
  let text: string | null = null;
  try {
    text = await readFile(manifestPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (seal && text !== null && opts.verifySeal !== false) {
    const actual = sha256Text(text);
    if (actual !== seal.payloadSha256) {
      throw new Error(
        `contract-tampered: ${manifestPath} does not match assembly.seal ` +
        `(seal ${seal.payloadSha256.slice(0, 19)}…, file ${actual.slice(0, 19)}…). ` +
        'Direct edits are not a contract change. Run `dsh-cad-contract rebuild` to restore the last recorded revision, ' +
        'or use cad_assembly write with the current revision.',
      );
    }
  }
  let manifest: AssemblyManifest | null = null;
  if (text !== null) {
    try {
      manifest = JSON.parse(text) as AssemblyManifest;
    } catch (error) {
      throw new Error(`assembly manifest is not readable JSON: ${(error as Error).message}`);
    }
  }
  return {
    manifestPath,
    sealPath,
    changesDir,
    status: seal ? (text === null ? 'missing' : 'sealed') : text === null ? 'missing' : 'unlocked',
    seal,
    text,
    manifest,
  };
}

/** A change record's file name sorts by seq (zero-padded). */
function changeFileName(record: ContractChangeRecord): string {
  return `${String(record.seq).padStart(4, '0')}-${record.changeId}.json`;
}

async function readChangeRecords(changesDir: string): Promise<{ file: string; text: string; record: ContractChangeRecord }[]> {
  if (!existsSync(changesDir)) return [];
  const names = (await readdir(changesDir)).filter((name) => /^\d{4}-.*\.json$/.test(name)).sort();
  const out: { file: string; text: string; record: ContractChangeRecord }[] = [];
  for (const name of names) {
    const file = join(changesDir, name);
    const text = await readFile(file, 'utf8');
    out.push({ file, text, record: JSON.parse(text) as ContractChangeRecord });
  }
  return out;
}

/**
 * Verify the append-only chain and its seal WITHOUT comparing assembly.json.
 * `rebuild` uses this to refuse a broken history while still allowing a
 * payload-only tamper (the case rebuild exists to repair).
 */
async function verifyChain(state: ContractState): Promise<{
  issues: string[];
  records: { file: string; text: string; record: ContractChangeRecord }[];
}> {
  const issues: string[] = [];
  if (!state.seal) return { issues: ['no assembly.seal'], records: [] };
  const records = await readChangeRecords(state.changesDir);
  if (records.length === 0) issues.push('seal exists but assembly/changes/ is empty');
  if (records.length !== state.seal.logCount) {
    issues.push(`seal says ${state.seal.logCount} change(s), found ${records.length}`);
  }
  let parent = 'genesis';
  for (const [index, entry] of records.entries()) {
    const { record } = entry;
    if (record.schema !== CHANGES_SCHEMA) issues.push(`change ${record.changeId}: schema ${String(record.schema)}`);
    if (record.seq !== index + 1) issues.push(`change ${record.changeId}: seq ${record.seq}, expected ${index + 1}`);
    if (record.parent !== parent) issues.push(`change ${record.changeId}: parent ${record.parent}, expected ${parent}`);
    const expectedResulting = sha256(manifestText(record.manifest));
    if (record.resulting !== expectedResulting) issues.push(`change ${record.changeId}: resulting hash does not match its manifest`);
    parent = sha256(entry.text);
  }
  const last = records.at(-1);
  if (last) {
    if (state.seal.logHeadSha256 !== parent) issues.push('seal log head does not match the last change record');
    if (state.seal.payloadSha256 !== last.record.resulting) issues.push('seal payload hash does not match the last change record');
  }
  return { issues, records };
}

/** Verify the seal, the chain, and the materialized JSON. */
export async function verifyContract(manifestPath: string): Promise<ContractVerification> {
  const issues: string[] = [];
  let state: ContractState;
  try {
    state = await readContractState(manifestPath);
  } catch (error) {
    return { ok: false, status: 'tampered', revision: 0, head: null, issues: [String((error as Error)?.message ?? error)] };
  }
  if (state.status === 'missing') {
    return { ok: false, status: 'missing', revision: 0, head: null, issues: ['contract file and seal are both absent'] };
  }
  if (!state.seal) {
    return {
      ok: false,
      status: 'unlocked',
      revision: 0,
      head: state.text ? sha256(state.text) : null,
      issues: ['no assembly.seal: this contract predates the sealed writer (legacy/unlocked)'],
    };
  }
  const { issues: chainIssues } = await verifyChain(state);
  issues.push(...chainIssues);
  return {
    ok: issues.length === 0,
    status: issues.length === 0 ? 'sealed' : 'tampered',
    revision: state.seal.revision,
    head: state.seal.payloadSha256,
    issues,
  };
}

/** Re-materialize assembly.json + seal from the latest change record. */
export async function rebuildContract(manifestPath: string): Promise<{ revision: number; head: string; changeId: string }> {
  const state = await readContractState(manifestPath, { verifySeal: false });
  if (!state.seal) throw new Error('rebuild needs assembly.seal; this is a legacy/unlocked contract');
  const chain = await verifyChain(state);
  if (chain.issues.length > 0) {
    throw new Error(
      `refusing rebuild: the change chain is invalid (${chain.issues.slice(0, 3).join('; ')}). ` +
      'Restore assembly/changes/ from a trusted copy; rebuild must not bless a rewritten history.',
    );
  }
  const last = chain.records.at(-1);
  if (!last) throw new Error('rebuild needs at least one change record under assembly/changes/');
  const text = manifestText(last.record.manifest);
  await chmod(manifestPath, 0o644).catch(() => {});
  await writeFileAtomic(manifestPath, text);
  await writeSeal(state.sealPath, {
    revision: last.record.seq,
    logCount: last.record.seq,
    payloadSha256: sha256(text),
    logHeadSha256: sha256(last.text),
  });
  await chmod(manifestPath, 0o444).catch(() => {});
  return { revision: last.record.seq, head: sha256(text), changeId: last.record.changeId };
}

async function writeFileAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

function compareValue(before: unknown, after: unknown): boolean {
  return JSON.stringify(before) === JSON.stringify(after);
}

function diffFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  skip: Set<string>,
  basePath: string,
): FieldChange[] {
  const changes: FieldChange[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of [...keys].sort()) {
    if (skip.has(key)) continue;
    const b = before[key];
    const a = after[key];
    if (compareValue(b, a)) continue;
    const path = basePath ? `${basePath}.${key}` : key;
    if (isObject(b) && isObject(a)) {
      changes.push(...diffFields(b, a, new Set(), path));
    } else {
      changes.push({ path, before: b, after: a });
    }
  }
  return changes;
}

function nodeRef(node: ManifestNode): { id: string; name?: string; version?: string } {
  return { id: node.id, name: node.name, version: node.version };
}

function diffNode(before: ManifestNode, after: ManifestNode, basePath: string): {
  fields: FieldChange[];
  children: ManifestDiff['children'];
  interfaces: ManifestDiff['interfaces'];
} {
  const fields = diffFields(
    before as unknown as Record<string, unknown>,
    after as unknown as Record<string, unknown>,
    new Set(['id', 'children', 'interfaces']),
    basePath,
  );
  const children: ManifestDiff['children'] = { added: [], removed: [], changed: [] };
  const beforeChildren = new Map((before.children ?? []).map((child) => [child.id, child]));
  const afterChildren = new Map((after.children ?? []).map((child) => [child.id, child]));
  for (const [id, child] of afterChildren) {
    const old = beforeChildren.get(id);
    if (!old) children.added.push(nodeRef(child));
    else {
      const childDiff = diffNode(old, child, basePath ? `${basePath}/${id}` : id);
      if (childDiff.fields.length > 0) children.changed.push({ id, path: basePath ? `${basePath}/${id}` : id, fields: childDiff.fields });
      children.added.push(...childDiff.children.added);
      children.removed.push(...childDiff.children.removed);
      children.changed.push(...childDiff.children.changed);
      // Interfaces are reported at the root only; nested interfaces are rare and
      // still appear through the parent's `fields` when their array changes.
    }
  }
  for (const [id, child] of beforeChildren) if (!afterChildren.has(id)) children.removed.push(nodeRef(child));

  const interfaces: ManifestDiff['interfaces'] = { added: [], removed: [], changed: [] };
  const beforeInterfaces = new Map((before.interfaces ?? []).map((iface) => [iface.id, iface]));
  const afterInterfaces = new Map((after.interfaces ?? []).map((iface) => [iface.id, iface]));
  for (const [id, iface] of afterInterfaces) {
    const old = beforeInterfaces.get(id);
    if (!old) interfaces.added.push({ id, a: iface.a, b: iface.b });
    else {
      const changed = diffFields(
        old as unknown as Record<string, unknown>,
        iface as unknown as Record<string, unknown>,
        new Set(['id']),
        basePath ? `${basePath}.interfaces.${id}` : `interfaces.${id}`,
      );
      if (changed.length > 0) interfaces.changed.push({ id, fields: changed });
    }
  }
  for (const [id, iface] of beforeInterfaces) if (!afterInterfaces.has(id)) interfaces.removed.push({ id, a: iface.a, b: iface.b });
  return { fields, children, interfaces };
}

/** Structured diff used by the writer response and the change record. */
export function diffManifests(before: AssemblyManifest | null, after: AssemblyManifest): ManifestDiff {
  const rootFields = before
    ? diffFields(
      before as unknown as Record<string, unknown>,
      after as unknown as Record<string, unknown>,
      new Set(['root', 'manifestHash', 'contractRevision', 'contractHash', 'contractStatus']),
      '',
    )
    : [];
  if (!before) {
    return {
      root: rootFields,
      children: { added: (after.root.children ?? []).map(nodeRef), removed: [], changed: [] },
      interfaces: {
        added: (after.root.interfaces ?? []).map((iface) => ({ id: iface.id, a: iface.a, b: iface.b })),
        removed: [],
        changed: [],
      },
    };
  }
  const node = diffNode(before.root, after.root, 'root');
  return { root: [...rootFields, ...node.fields], children: node.children, interfaces: node.interfaces };
}

function assertReason(reason: string): string {
  const trimmed = String(reason ?? '').trim();
  if (!trimmed) throw new Error('reason is required: every contract change needs a recorded reason');
  if (trimmed.length > 1000) throw new Error('reason is too long (max 1000 characters)');
  return trimmed;
}

/**
 * The only mutation path: validate, append a change record, materialize JSON,
 * write the seal. `dryRun` returns the same diff without writing.
 */
export async function writeAssemblyContract(
  project: ProjectStores,
  input: ContractWriteInput,
): Promise<ContractWriteResult> {
  const reason = assertReason(input.reason);
  const target = resolveContractPath(project.cwd, input.manifestPath);
  const state = await readContractState(target);
  const currentRevision = state.seal?.revision ?? 0;
  const currentHash = state.text ? sha256(state.text) : null;
  const mode: WriteAssemblyMode = input.mode ?? 'merge';

  if (state.seal && state.text === null) {
    throw new Error(`sealed contract is missing: ${target}; run dsh-cad-contract rebuild before writing`);
  }

  if (mode === 'create') {
    if (state.text !== null) throw new Error(`manifest already exists: ${target}; use merge/replace with expectedRevision`);
    if (input.expectedRevision === undefined && input.expectedHash !== 'genesis') {
      throw new Error('create requires expectedRevision: 0 (or expectedHash: "genesis")');
    }
    if (input.expectedRevision !== undefined && input.expectedRevision !== 0) {
      throw new Error(`create expects revision 0, got ${input.expectedRevision}`);
    }
  } else {
    if (state.text === null) throw new Error(`${mode} requires an existing manifest: ${target}`);
    if (input.expectedRevision === undefined && !input.expectedHash) {
      throw new Error(`${mode} requires expectedRevision (from the last write/check) or expectedHash`);
    }
    if (input.expectedRevision !== undefined && input.expectedRevision !== currentRevision) {
      throw new Error(
        `expectedRevision mismatch: wanted ${input.expectedRevision}, current ${currentRevision}. ` +
        'Re-read with cad_assembly check and retry; do not write against a stale contract.',
      );
    }
    if (input.expectedHash && currentHash && normalizeHash(input.expectedHash) !== currentHash) {
      throw new Error(`expectedHash mismatch: wanted ${normalizeHash(input.expectedHash)}, actual ${currentHash}`);
    }
  }

  const chain = await verifyContract(target);
  if (chain.status === 'tampered') {
    throw new Error(
      `contract chain is invalid: ${chain.issues.slice(0, 3).join('; ')}. ` +
      'Run dsh-cad-contract verify for the full list; do not add a change on top of a broken chain.',
    );
  }

  const prepared = await prepareAssemblyWrite(project, {
    ...input,
    expectedHash: mode === 'create' ? undefined : input.expectedHash ?? currentHash ?? undefined,
  });
  if (!prepared.changed) {
    return {
      ...{
        manifestPath: prepared.manifestPath,
        manifestHash: sha256(prepared.text),
        mode,
        changed: false,
        counts: prepared.counts,
        warnings: prepared.warnings,
      },
      contractRevision: currentRevision,
      contractHash: state.seal?.payloadSha256 ?? currentHash ?? sha256(prepared.text),
      changeId: null,
      diff: null,
      dryRun: Boolean(input.dryRun),
    };
  }

  const diff = diffManifests(state.manifest, prepared.next);
  if (input.dryRun) {
    return {
      manifestPath: prepared.manifestPath,
      manifestHash: sha256(prepared.text),
      mode,
      changed: true,
      counts: prepared.counts,
      warnings: prepared.warnings,
      contractRevision: currentRevision,
      contractHash: state.seal?.payloadSha256 ?? currentHash ?? sha256(prepared.text),
      changeId: null,
      diff,
      dryRun: true,
    };
  }

  return await withFileLock(target, async () => {
    // Re-read under the lock: a concurrent writer may have advanced the head.
    const locked = await readContractState(target);
    const lockedRevision = locked.seal?.revision ?? 0;
    if (lockedRevision !== currentRevision) {
      throw new Error(
        `expectedRevision changed while writing: was ${currentRevision}, now ${lockedRevision}. ` +
        'Re-read and retry; the contract was not modified by this call.',
      );
    }
    const seq = currentRevision + 1;
    const changeId = `chg_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
    const record: ContractChangeRecord = {
      schema: CHANGES_SCHEMA,
      changeId,
      seq,
      parent: locked.seal?.logHeadSha256 ?? 'genesis',
      resulting: sha256(prepared.text),
      reason,
      actor: input.actor ?? { source: 'cad_assembly.write' },
      at: new Date().toISOString(),
      diff,
      manifest: prepared.next,
    };
    const changesDir = changesDirFor(target);
    await mkdir(changesDir, { recursive: true });
    const recordFile = join(changesDir, changeFileName(record));
    const text = recordText(record);
    await writeFileAtomic(recordFile, text);
    await chmod(target, 0o644).catch(() => {});
    await writeFileAtomic(target, prepared.text);
    await writeSeal(sealPathFor(target), {
      revision: seq,
      logCount: seq,
      payloadSha256: sha256(prepared.text),
      logHeadSha256: sha256(text),
    });
    await chmod(target, 0o444).catch(() => {});
    return {
      manifestPath: target,
      manifestHash: sha256(prepared.text),
      mode,
      changed: true,
      counts: prepared.counts,
      warnings: prepared.warnings,
      contractRevision: seq,
      contractHash: sha256(prepared.text),
      changeId,
      diff,
      dryRun: false,
    };
  });
}

function normalizeHash(value: string): string {
  const trimmed = String(value ?? '').trim();
  return trimmed.startsWith('sha256:') ? trimmed : `sha256:${trimmed}`;
}
