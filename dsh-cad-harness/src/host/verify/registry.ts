// Custom-check registry: the pre-registration desk.
//
// A check is evidence only after it is registered. The registry pins the hash of
// the whole check package (manifest + code + fixtures + measurements), records
// when it was registered, and keeps a revocation/supersede history. `verify` is
// read-only: it reads this file, never writes it. The `check-register` CLI writes.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { writeJsonAtomic } from '../file-lock.ts';
import type { LoadedCheck } from './checks.ts';
import type { VerifyRowId } from './types.ts';

export const REGISTRY_FILE = 'registry.json';
export const REGISTRY_SCHEMA_VERSION = 1;
export const MAX_CHECK_FILES = 500;
export const MAX_CHECK_BYTES = 10 * 1024 * 1024;

const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const ROWS = new Set<VerifyRowId>(['requirements', 'model', 'fit', 'make', 'review', 'delivery']);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'artifacts', '.tmp']);

export interface RegistryEntry {
  id: string;
  version: string;
  hash: string;
  row: VerifyRowId;
  criteria: string[];
  registeredAt: string;
}

export interface RegistryHistoryEntry {
  id: string;
  version: string;
  hash: string;
  registeredAt: string;
  revokedAt: string;
  reason?: string;
}

export interface CheckRegistry {
  schemaVersion: 1;
  checks: RegistryEntry[];
  history: RegistryHistoryEntry[];
}

export interface RegistryLoadResult {
  registry: CheckRegistry;
  path: string;
  issues: string[];
}

export type RegisterStatus = 'registered' | 'unchanged' | 'superseded' | 'restored' | 'unregistered';

export interface RegisterResult {
  ok: boolean;
  status: RegisterStatus | 'error';
  id?: string;
  version?: string;
  hash?: string;
  registeredAt?: string;
  errors: string[];
}

function emptyRegistry(): CheckRegistry {
  return { schemaVersion: REGISTRY_SCHEMA_VERSION, checks: [], history: [] };
}

function isIso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export function validateRegistry(value: unknown): string[] {
  const issues: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ['registry must be an object'];
  const v = value as { schemaVersion?: unknown; checks?: unknown; history?: unknown };
  if (v.schemaVersion !== REGISTRY_SCHEMA_VERSION) issues.push('registry.schemaVersion must be 1');
  if (!Array.isArray(v.checks)) {
    issues.push('registry.checks must be an array');
    return issues;
  }
  const seen = new Set<string>();
  for (const [i, raw] of v.checks.entries()) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      issues.push(`checks[${i}] must be an object`);
      continue;
    }
    const c = raw as Record<string, unknown>;
    if (typeof c.id !== 'string' || c.id.length === 0) issues.push(`checks[${i}].id is required`);
    else if (seen.has(c.id)) issues.push(`checks[${i}].id "${c.id}" is duplicated`);
    else seen.add(c.id);
    if (typeof c.version !== 'string' || c.version.length === 0) issues.push(`checks[${i}].version is required`);
    if (typeof c.hash !== 'string' || !HASH_RE.test(c.hash)) issues.push(`checks[${i}].hash must be sha256:<64 hex>`);
    if (typeof c.row !== 'string' || !ROWS.has(c.row as VerifyRowId)) issues.push(`checks[${i}].row must be one of the six rows`);
    if (!Array.isArray(c.criteria) || c.criteria.length === 0 || !c.criteria.every((x) => typeof x === 'string' && x.length > 0)) {
      issues.push(`checks[${i}].criteria must be a non-empty array of strings`);
    }
    if (!isIso(c.registeredAt)) issues.push(`checks[${i}].registeredAt must be an ISO date`);
  }
  if (v.history !== undefined) {
    if (!Array.isArray(v.history)) {
      issues.push('registry.history must be an array when present');
    } else {
      for (const [i, raw] of v.history.entries()) {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          issues.push(`history[${i}] must be an object`);
          continue;
        }
        const h = raw as Record<string, unknown>;
        if (typeof h.id !== 'string' || h.id.length === 0) issues.push(`history[${i}].id is required`);
        if (typeof h.version !== 'string' || h.version.length === 0) issues.push(`history[${i}].version is required`);
        if (typeof h.hash !== 'string' || !HASH_RE.test(h.hash)) issues.push(`history[${i}].hash must be sha256:<64 hex>`);
        if (!isIso(h.registeredAt)) issues.push(`history[${i}].registeredAt must be an ISO date`);
        if (!isIso(h.revokedAt)) issues.push(`history[${i}].revokedAt must be an ISO date`);
      }
    }
  }
  return issues;
}

export async function loadRegistry(checksRoot: string): Promise<RegistryLoadResult> {
  const path = join(resolve(checksRoot), REGISTRY_FILE);
  if (!existsSync(path)) return { registry: emptyRegistry(), path, issues: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    return { registry: emptyRegistry(), path, issues: [`registry.json is not readable JSON: ${String((e as Error)?.message ?? e)}`] };
  }
  const issues = validateRegistry(raw);
  if (issues.length > 0) return { registry: emptyRegistry(), path, issues };
  const registry = raw as CheckRegistry;
  return { registry: { ...registry, history: registry.history ?? [] }, path, issues: [] };
}

export async function writeRegistry(checksRoot: string, registry: CheckRegistry): Promise<void> {
  await writeJsonAtomic(join(resolve(checksRoot), REGISTRY_FILE), registry);
}

async function walkHash(
  dir: string,
  root: string,
  h: ReturnType<typeof createHash>,
  budget: { files: number; bytes: number },
): Promise<void> {
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const abs = join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`check package must not contain symlinks: ${relative(root, abs)}`);
    if (entry.isDirectory()) {
      await walkHash(abs, root, h, budget);
      continue;
    }
    if (!entry.isFile()) continue;
    budget.files += 1;
    if (budget.files > MAX_CHECK_FILES) throw new Error(`check package has more than ${MAX_CHECK_FILES} files`);
    const info = await stat(abs);
    budget.bytes += info.size;
    if (budget.bytes > MAX_CHECK_BYTES) throw new Error(`check package exceeds ${MAX_CHECK_BYTES} bytes`);
    h.update(relative(root, abs));
    h.update('\0');
    h.update(await readFile(abs));
    h.update('\0');
  }
}

/** Hash the whole check package (manifest, code, fixtures, measurements). */
export async function hashCheckDir(dir: string): Promise<{ hash: string; files: number; bytes: number }> {
  const root = resolve(dir);
  const h = createHash('sha256');
  const budget = { files: 0, bytes: 0 };
  await walkHash(root, root, h, budget);
  return { hash: `sha256:${h.digest('hex')}`, files: budget.files, bytes: budget.bytes };
}

function entryOf(check: LoadedCheck, registeredAt: string): RegistryEntry {
  return {
    id: check.id,
    version: check.version,
    hash: check.hash,
    row: check.row,
    criteria: check.manifest?.criteria ?? [],
    registeredAt,
  };
}

function sameEntry(a: RegistryEntry, check: LoadedCheck): boolean {
  return a.hash === check.hash
    && a.version === check.version
    && a.row === check.row
    && a.criteria.length === (check.manifest?.criteria.length ?? 0)
    && a.criteria.every((c, i) => c === check.manifest?.criteria[i]);
}

/**
 * Register (or supersede) one check. The package is self-tested first; a check
 * that cannot reject its own negative sample is never written.
 */
export async function registerCheck(
  checksRoot: string,
  checkDir: string,
  options: { supersede?: boolean; reason?: string } = {},
): Promise<RegisterResult> {
  const loaded = await loadRegistry(checksRoot);
  if (loaded.issues.length > 0) {
    return { ok: false, status: 'error', errors: [`registry is invalid: ${loaded.issues.join('; ')}`] };
  }
  const { loadCheck } = await import('./checks.ts');
  const check = await loadCheck(checkDir, { selfTest: true });
  if (check.error || !check.manifest) {
    return { ok: false, status: 'error', id: check.id, errors: [check.error ?? 'check is invalid'] };
  }

  const registry = loaded.registry;
  const active = registry.checks.find((c) => c.id === check.id);
  const now = new Date().toISOString();
  const resultBase = { id: check.id, version: check.version, hash: check.hash, registeredAt: now };

  if (active) {
    if (sameEntry(active, check)) {
      return { ok: true, status: 'unchanged', ...resultBase, registeredAt: active.registeredAt, errors: [] };
    }
    if (!options.supersede) {
      return {
        ok: false,
        status: 'error',
        ...resultBase,
        errors: [
          `${check.id} is already registered as ${active.version} ${active.hash}; `
          + 'run check-register --unregister first, or pass --supersede',
        ],
      };
    }
    registry.history.push({
      id: active.id,
      version: active.version,
      hash: active.hash,
      registeredAt: active.registeredAt,
      revokedAt: now,
      ...(options.reason ? { reason: options.reason } : {}),
    });
    registry.checks = registry.checks.filter((c) => c.id !== check.id);
    registry.checks.push(entryOf(check, now));
    await writeRegistry(checksRoot, registry);
    return { ok: true, status: 'superseded', ...resultBase, errors: [] };
  }

  // Re-registering the same package after an unregister keeps its first
  // registration time; a new package starts now.
  const prior = registry.history
    .filter((h) => h.id === check.id && h.hash === check.hash)
    .sort((a, b) => a.registeredAt.localeCompare(b.registeredAt))[0];
  const registeredAt = prior?.registeredAt ?? now;
  registry.checks.push(entryOf(check, registeredAt));
  await writeRegistry(checksRoot, registry);
  return { ok: true, status: prior ? 'restored' : 'registered', ...resultBase, registeredAt, errors: [] };
}

/** Revoke the active registration; the history keeps the record. */
export async function unregisterCheck(
  checksRoot: string,
  id: string,
  reason?: string,
): Promise<RegisterResult> {
  const loaded = await loadRegistry(checksRoot);
  if (loaded.issues.length > 0) {
    return { ok: false, status: 'error', id, errors: [`registry is invalid: ${loaded.issues.join('; ')}`] };
  }
  const registry = loaded.registry;
  const active = registry.checks.find((c) => c.id === id);
  if (!active) return { ok: false, status: 'error', id, errors: [`${id} is not registered`] };
  const now = new Date().toISOString();
  registry.history.push({
    id: active.id,
    version: active.version,
    hash: active.hash,
    registeredAt: active.registeredAt,
    revokedAt: now,
    ...(reason ? { reason } : {}),
  });
  registry.checks = registry.checks.filter((c) => c.id !== id);
  await writeRegistry(checksRoot, registry);
  return { ok: true, status: 'unregistered', id, version: active.version, hash: active.hash, registeredAt: active.registeredAt, errors: [] };
}

/** Read a manifest id without executing the check. */
export async function readCheckId(dir: string): Promise<string | null> {
  try {
    const raw = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as { id?: unknown };
    return typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : null;
  } catch {
    return null;
  }
}

/** Discover check directories under a checks root. */
export async function listCheckDirs(checksRoot: string): Promise<string[]> {
  const root = resolve(checksRoot);
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => join(root, e.name))
    .filter((dir) => existsSync(join(dir, 'manifest.json')))
    .sort();
}
