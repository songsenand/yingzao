// Custom checks (V1.1): a project brings its own checker/v1 package; V1 mounts
// it, proves it can fail (negative sample), runs it against the current geometry
// and maps the result into the six rows.
//
// The site owns: discovery, manifest/self-test gates, the bounded runner, the
// mapping and the report. The user/agent owns: the check code, the criterion and
// the negative sample. There is no workflow here: a check is evidence, not a step.

import { existsSync, type Dirent } from 'node:fs';
import { cp, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { loadChecker, verifyChecker, type CheckerSelfTest, type LoadedChecker } from '../checkers/registry.ts';
import { runChecker } from '../checkers/runner.ts';
import type { CheckerFinding, CheckerInput, CheckerManifest, CheckerReport, RunCheckerResult } from '../checkers/types.ts';
import { setEqual } from './freshness.ts';
import type { LoadedVerifyProject } from './project.ts';
import { hashCheckDir, loadRegistry } from './registry.ts';
import type {
  FindingDraft, VerifyCheck, VerifyCheckStatus, VerifyClaim, VerifyOutcome,
  VerifyRowId, VerifySeverity, VerifyWhere,
} from './types.ts';

/** Site cap: a custom check may not outlive this, whatever its manifest says. */
export const CHECK_TIMEOUT_CAP_MS = 30_000;
export const MAX_CHECKS = 32;
/** Site cap: a custom check may not flood the report. */
export const MAX_FINDINGS = 50;
/** Best-effort mutation guard: snapshot at most this many files. */
const SNAPSHOT_MAX_FILES = 5_000;

const ROWS: VerifyRowId[] = ['requirements', 'model', 'fit', 'make', 'review', 'delivery'];
const PEARL_TO_ROW: Record<string, VerifyRowId> = {
  brief: 'requirements',
  model: 'model',
  fit: 'fit',
  make: 'make',
  review: 'review',
  deliver: 'delivery',
  delivery: 'delivery',
};

export type CheckRegistration = 'registered' | 'unregistered' | 'modified';

export interface LoadedCheck {
  id: string;
  version: string;
  row: VerifyRowId;
  dir: string;
  hash: string;
  manifest?: CheckerManifest;
  error?: string;
  registration?: CheckRegistration;
  registeredAt?: string;
}

export interface ChecksLoadResult {
  root: string | null;
  checks: LoadedCheck[];
  issues: string[];
  registryIssues: string[];
}

export interface CheckRun {
  check: LoadedCheck;
  status: VerifyCheckStatus;
  report?: CheckerReport;
  durationMs?: number;
  /** Project paths the check changed, if the guard caught a write. */
  mutated?: string[];
  /** Registered after the current version: the result is advisory only. */
  late?: boolean;
  lateReason?: string;
}

export function rowOfManifest(manifest: CheckerManifest | undefined): VerifyRowId {
  if (!manifest) return 'delivery';
  if (manifest.row && ROWS.includes(manifest.row as VerifyRowId)) return manifest.row as VerifyRowId;
  if (manifest.pearl && PEARL_TO_ROW[manifest.pearl]) return PEARL_TO_ROW[manifest.pearl];
  return 'delivery';
}

function messageOf(e: unknown): string {
  return String((e as Error)?.message ?? e);
}

function isInside(rel: string): boolean {
  return !isAbsolute(rel) && !rel.split(/[\\/]/).includes('..');
}

async function unsafeManifestPath(dir: string): Promise<string | null> {
  try {
    const raw = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    const entry = Array.isArray(raw.entry) ? raw.entry.filter((x): x is string => typeof x === 'string') : [];
    const negatives = Array.isArray(raw.negativeSamples)
      ? raw.negativeSamples.filter((x): x is string => typeof x === 'string')
      : [];
    for (const rel of [...entry.slice(1), ...negatives]) {
      if (!isInside(rel)) return rel;
    }
    return null;
  } catch {
    return null; // let loadChecker report the manifest error
  }
}

/**
 * Load and validate one check package. Does not touch the registry; the caller
 * decides whether it is registered and whether to run the negative samples.
 */
export async function loadCheck(
  dir: string,
  options: { selfTest?: boolean } = {},
): Promise<LoadedCheck> {
  const fallback: LoadedCheck = {
    id: basename(dir), version: 'unknown', row: 'delivery', dir, hash: '',
  };
  // Refuse to hash or run paths outside the check dir before loadChecker reads them.
  const unsafe = await unsafeManifestPath(dir);
  if (unsafe) return { ...fallback, error: `path must stay inside the check dir: ${unsafe}` };

  let checker: LoadedChecker;
  try {
    checker = await loadChecker(dir);
  } catch (e) {
    return { ...fallback, error: `manifest is invalid: ${messageOf(e)}` };
  }

  const manifest = checker.manifest;
  const base: LoadedCheck = {
    id: manifest.id,
    version: manifest.version,
    row: rowOfManifest(manifest),
    dir,
    hash: '',
    manifest,
  };

  try {
    base.hash = (await hashCheckDir(dir)).hash;
  } catch (e) {
    return { ...base, error: `check package is not hashable: ${messageOf(e)}` };
  }

  const errors: string[] = [];
  if (!manifest.negativeSamples || manifest.negativeSamples.length === 0) {
    errors.push('negativeSamples must contain at least one fixture');
  }
  for (const rel of manifest.negativeSamples ?? []) {
    if (!isInside(rel)) errors.push(`negative sample must stay inside the check dir: ${rel}`);
  }
  if (manifest.timeoutMs > CHECK_TIMEOUT_CAP_MS) {
    errors.push(`timeoutMs ${manifest.timeoutMs} exceeds the site cap ${CHECK_TIMEOUT_CAP_MS}`);
  }
  if (manifest.permissions.includes('write:artifacts')) {
    errors.push('V1.2 is read-only: write:artifacts is not allowed');
  }
  if (manifest.entry.length !== 2 || manifest.entry[0] !== 'node') {
    errors.push('entry must be exactly ["node", "<file>.mjs"]');
  } else {
    const file = manifest.entry[1]!;
    if (!file.endsWith('.mjs')) errors.push(`entry[1] must be a .mjs file: ${file}`);
    if (!isInside(file)) errors.push(`entry must stay inside the check dir: ${file}`);
    else if (!existsSync(join(dir, file))) errors.push(`entry file not found: ${file}`);
  }
  if (errors.length > 0) return { ...base, error: errors.join('; ') };

  if (options.selfTest !== false) {
    let selfTest: CheckerSelfTest;
    try {
      selfTest = await verifyChecker(checker);
    } catch (e) {
      return { ...base, error: `self-test failed: ${messageOf(e)}` };
    }
    if (!selfTest.ok) {
      const detail = selfTest.samples
        .map((s) => `${s.fixture}: ${s.status} (${s.detail})`)
        .join('; ');
      return { ...base, error: `negative samples must not pass: ${detail}` };
    }
  }
  return base;
}

/**
 * Discover checks under `root` and annotate each with its registry state. An
 * unregistered or modified check is never executed; an invalid package is kept
 * with `error`, never dropped.
 */
export async function loadChecks(
  root: string | null,
  options: { explicit?: boolean } = {},
): Promise<ChecksLoadResult> {
  if (!root) return { root: null, checks: [], issues: [], registryIssues: [] };
  const dir = resolve(root);
  if (!existsSync(dir)) {
    return {
      root: dir,
      checks: [],
      issues: options.explicit ? [`checks directory not found: ${dir}`] : [],
      registryIssues: [],
    };
  }

  const loadedRegistry = await loadRegistry(dir);
  const registryIssues = [...loadedRegistry.issues];
  const entries = (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const issues: string[] = [];
  if (entries.length > MAX_CHECKS) {
    issues.push(`only the first ${MAX_CHECKS} checks are loaded (found ${entries.length})`);
  }

  const checks: LoadedCheck[] = [];
  for (const name of entries.slice(0, MAX_CHECKS)) {
    const check = await loadCheck(join(dir, name), { selfTest: false });
    if (!check.error) {
      const active = loadedRegistry.registry.checks.find((c) => c.id === check.id);
      if (!active) {
        check.registration = 'unregistered';
      } else if (
        active.hash !== check.hash
        || active.version !== check.version
        || active.row !== check.row
        || active.criteria.length !== (check.manifest?.criteria.length ?? 0)
        || !active.criteria.every((c, i) => c === check.manifest?.criteria[i])
      ) {
        check.registration = 'modified';
      } else {
        check.registration = 'registered';
        check.registeredAt = active.registeredAt;
        // The negative-sample gate runs at registration, not here: verify must
        // not execute an unregistered/modified package, and the registry hash
        // pins exactly the package that was tested there.
      }
    }
    checks.push(check);
  }
  const loadedIds = new Set(checks.map((c) => c.id));
  for (const active of loadedRegistry.registry.checks) {
    if (!loadedIds.has(active.id)) {
      registryIssues.push(`registered check "${active.id}" has no loadable directory under ${dir}`);
    }
  }
  return { root: dir, checks, issues, registryIssues };
}

function buildInput(
  project: LoadedVerifyProject,
  claims: readonly VerifyClaim[],
  manifest: CheckerManifest,
): CheckerInput {
  const parts = project.currentVersions.map((p) => {
    const stl = join(project.root, 'cad-data', 'versions', p.version, 'model.stl');
    return existsSync(stl) ? { id: p.id, stl } : { id: p.id };
  });
  return {
    apiVersion: 'checker/v1',
    project: { root: project.root, units: 'mm' },
    geometry: { parts },
    constraints: {
      claims: claims.map((c) => ({ ...c })),
      versionIds: [...project.currentVersionSet],
      checkConfig: manifest.config ?? {},
    },
  };
}


interface FileStamp {
  size: number;
  mtimeMs: number;
}

type ProjectSnapshot = Map<string, FileStamp>;

const SNAPSHOT_SKIP = new Set(['.git', 'node_modules', '.tmp']);

async function walkSnapshot(
  dir: string,
  root: string,
  out: ProjectSnapshot,
  budget: { n: number },
): Promise<void> {
  if (budget.n >= SNAPSHOT_MAX_FILES) return;
  const entries: Dirent[] = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (budget.n >= SNAPSHOT_MAX_FILES) return;
    if (SNAPSHOT_SKIP.has(entry.name)) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkSnapshot(abs, root, out, budget);
    } else if (entry.isFile()) {
      try {
        const st = await stat(abs);
        out.set(relative(root, abs), { size: st.size, mtimeMs: st.mtimeMs });
        budget.n++;
      } catch {
        // disappeared during the walk; the diff reports it if it mattered
      }
    }
  }
}

/** Best-effort stat snapshot of the project; not a sandbox, but catches writes. */
async function snapshotProject(projectRoot: string): Promise<ProjectSnapshot> {
  const out: ProjectSnapshot = new Map();
  await walkSnapshot(projectRoot, projectRoot, out, { n: 0 });
  return out;
}

function changedPaths(before: ProjectSnapshot, after: ProjectSnapshot): string[] {
  const changed = new Set<string>();
  for (const [rel, stamp] of before) {
    const next = after.get(rel);
    if (!next || next.size !== stamp.size || next.mtimeMs !== stamp.mtimeMs) changed.add(rel);
  }
  for (const rel of after.keys()) if (!before.has(rel)) changed.add(rel);
  return [...changed].sort().slice(0, 10);
}

function lateOf(check: LoadedCheck, project: LoadedVerifyProject): { late: boolean; reason?: string } {
  if (project.currentVersionSet.length === 0) return { late: false };
  const registered = Date.parse(check.registeredAt ?? '');
  if (!Number.isFinite(registered)) return { late: true, reason: 'the registration timestamp is invalid' };
  const times = project.currentVersionSet.map((v) => Date.parse(project.versionTimes.get(v) ?? ''));
  if (times.some((t) => !Number.isFinite(t))) {
    return { late: true, reason: 'a current version has no usable timestamp' };
  }
  const latest = Math.max(...times);
  if (registered > latest) {
    return { late: true, reason: `registered at ${check.registeredAt} after the latest current version` };
  }
  return { late: false };
}

/**
 * Run every mountable check. Unregistered/modified packages are not executed.
 * Mount-only, or a project without geometry, yields `pending` — never `pass`.
 */
export async function runChecks(
  checks: readonly LoadedCheck[],
  project: LoadedVerifyProject,
  claims: readonly VerifyClaim[],
  options: { mountOnly?: boolean } = {},
): Promise<CheckRun[]> {
  const runs: CheckRun[] = [];
  for (const check of checks) {
    if (check.error) {
      runs.push({ check, status: 'invalid' });
      continue;
    }
    if (check.registration === 'unregistered') {
      runs.push({ check, status: 'unregistered' });
      continue;
    }
    if (check.registration === 'modified') {
      runs.push({ check, status: 'modified' });
      continue;
    }
    if (options.mountOnly) {
      runs.push({ check, status: 'pending' });
      continue;
    }
    if (project.currentVersionSet.length === 0) {
      runs.push({ check, status: 'pending' });
      continue;
    }
    try {
      const input = buildInput(project, claims, check.manifest!);
      const before = await snapshotProject(project.root);
      const work = await mkdtemp(join(tmpdir(), 'dsh-check-'));
      let result: RunCheckerResult;
      try {
        await cp(check.dir, work, {
          recursive: true,
          filter: (src) => !/[\\/](node_modules|\.tmp)([\\/]|$)/.test(src),
        });
        result = await runChecker(check.manifest!, input, {
          cwd: work,
          artifacts: 'forbid',
          maxFindings: MAX_FINDINGS,
        });
      } finally {
        await rm(work, { recursive: true, force: true }).catch(() => {});
      }
      const mutated = changedPaths(before, await snapshotProject(project.root));
      const late = lateOf(check, project);
      runs.push({
        check,
        status: mutated.length > 0 ? 'mutated' : result.report.status,
        report: result.report,
        durationMs: result.durationMs,
        ...(mutated.length > 0 ? { mutated } : {}),
        ...(late.late ? { late: true, lateReason: late.reason } : {}),
      });
    } catch {
      runs.push({ check, status: 'error' });
    }
  }
  return runs;
}

function messageOfFinding(f: CheckerFinding): string {
  if (f.message) return f.message;
  const bits = [f.criterion];
  if (f.measured !== undefined) bits.push(`measured ${f.measured}${f.unit ?? ''}`);
  if (f.limit !== undefined) bits.push(`limit ${f.limit}${f.unit ?? ''}`);
  return bits.join(': ');
}

function whereOf(f: CheckerFinding): VerifyWhere {
  const a = f.attention?.[0];
  if (!a) return { kind: 'unknown', note: f.criterion };
  if (a.kind === 'pair') {
    return {
      kind: 'pair',
      ...(a.a && a.b ? { parts: [a.a, a.b] } : a.part ? { parts: [a.part] } : {}),
      ...(a.where ? { center: [...a.where] } : {}),
      ...(a.note ? { note: a.note } : {}),
    };
  }
  if (a.kind === 'part') {
    return {
      kind: 'part',
      ...(a.part ? { parts: [a.part] } : {}),
      ...(a.where ? { point: [...a.where] } : {}),
      ...(a.note ? { note: a.note } : {}),
    };
  }
  return { kind: 'unknown', ...(a.note ? { note: a.note } : {}) };
}

/**
 * Map a check run to V1 findings. Custom evidence is `warn` by default; only an
 * explicit policy `blockOn: ["custom-check"]` promotes it to `blocked`.
 */
export function checkFindingDrafts(run: CheckRun, options: { block?: boolean } = {}): FindingDraft[] {
  const { check, status, report } = run;
  const outcome: VerifyOutcome = options.block ? 'blocked' : 'warn';
  const severity: VerifySeverity = options.block ? 'blocked' : 'warn';
  const baseWitness = { checkId: check.id, checkVersion: check.version, checkHash: check.hash };
  const drafts: FindingDraft[] = [];

  if (status === 'invalid') {
    drafts.push({
      row: check.row,
      code: 'check-invalid',
      outcome,
      severity,
      what: check.error ?? 'check is not mountable',
      why: ['a check that cannot reject its own negative sample is not evidence'],
      where: { kind: 'manifest', note: `checks/${check.id}` },
      next: ['fix the manifest, entry or negative sample', 're-run verify --checks'],
      checkId: check.id,
      witness: baseWitness,
    });
    return drafts;
  }
  if (status === 'unregistered') {
    drafts.push({
      row: check.row,
      code: 'check-unregistered',
      outcome,
      severity,
      what: `${check.id} is not in checks/registry.json`,
      why: ['a check must be pre-registered before it can be evidence'],
      where: { kind: 'manifest', note: `checks/${check.id}` },
      next: ['run node scripts/check-register.mjs <project> --id ' + check.id, 'or remove the check'],
      checkId: check.id,
      witness: baseWitness,
    });
    return drafts;
  }
  if (status === 'modified') {
    drafts.push({
      row: check.row,
      code: 'check-modified',
      outcome,
      severity,
      what: `${check.id} changed after it was registered (hash mismatch)`,
      why: ['the registered hash pins the package; an edit voids the old evidence'],
      where: { kind: 'manifest', note: `checks/${check.id}` },
      next: ['review the change, then --unregister and register again'],
      checkId: check.id,
      witness: { ...baseWitness, registeredAt: check.registeredAt ?? null },
    });
    return drafts;
  }
  if (status === 'pending') return drafts;

  if (status === 'mutated') {
    drafts.push({
      row: check.row,
      code: 'check-mutated',
      outcome,
      severity,
      what: `${check.id} wrote to the project: ${(run.mutated ?? []).join(', ') || 'unknown path'}`,
      why: ['a check may read the project but must not write it'],
      where: { kind: 'manifest', note: `checks/${check.id}` },
      next: ['write outputs to a temp dir instead', 're-run verify --checks'],
      checkId: check.id,
      witness: { ...baseWitness, mutated: run.mutated ?? [] },
    });
    return drafts;
  }

  const findings = report?.findings ?? [];
  const nonPass = findings.filter((f) => f.verdict !== 'pass');

  if (nonPass.length > 0) {
    for (const f of nonPass) {
      drafts.push({
        row: check.row,
        code: f.verdict === 'error' ? 'check-error' : f.verdict === 'blocked' ? 'check-blocked' : 'check-failed',
        outcome,
        severity,
        what: messageOfFinding(f),
        why: ['the check declared this criterion and it is not met'],
        where: whereOf(f),
        next: ['inspect the check witness', 'fix the design or the declared criterion'],
        checkId: check.id,
        witness: {
          ...baseWitness,
          criterion: f.criterion,
          ...(f.measured !== undefined ? { measured: f.measured } : {}),
          ...(f.limit !== undefined ? { limit: f.limit } : {}),
          ...(f.unit ? { unit: f.unit } : {}),
          ...(f.witness ?? {}),
        },
      });
    }
  } else if (status === 'pass') {
    drafts.push({
      row: check.row,
      code: 'check-passed',
      outcome: 'info',
      severity: 'info',
      what: `${check.id}: ${(check.manifest?.criteria ?? []).join('; ') || 'passed'}`,
      why: ['the check declared this criterion and every finding is a witness'],
      where: { kind: 'manifest', note: `checks/${check.id}` },
      next: [],
      checkId: check.id,
      witness: baseWitness,
    });
  } else {
    drafts.push({
      row: check.row,
      code: status === 'error' ? 'check-error' : status === 'blocked' ? 'check-blocked' : 'check-failed',
      outcome,
      severity,
      what: report?.error?.message ?? `${check.id} returned ${status}`,
      why: ['the check did not pass and produced no finding to explain it'],
      where: { kind: 'manifest', note: `checks/${check.id}` },
      next: ['inspect the check output and its inputs'],
      checkId: check.id,
      witness: baseWitness,
    });
  }

  const incomplete = status !== 'error'
    && (report?.coverage?.complete === false || (report?.coverage?.skipped?.length ?? 0) > 0);
  if (incomplete) {
    const skipped = (report?.coverage?.skipped ?? [])
      .map((s) => `${s.criterion}: ${s.reason}`)
      .join('; ');
    drafts.push({
      row: check.row,
      code: 'check-incomplete',
      outcome,
      severity,
      what: `${check.id} did not cover all criteria${skipped ? `: ${skipped}` : ''}`,
      why: ['an incomplete check cannot certify a claim'],
      where: { kind: 'manifest', note: `checks/${check.id}` },
      next: ['extend the check to cover every declared criterion, or narrow the claim'],
      checkId: check.id,
      witness: baseWitness,
    });
  }

  if (run.late) {
    drafts.push({
      row: check.row,
      code: 'check-late',
      outcome: 'info',
      severity: 'info',
      what: `${check.id} is late (${run.lateReason ?? 'registered after the current version'}); result is advisory`,
      why: ['a check registered after the geometry is not a pre-registered witness'],
      where: { kind: 'manifest', note: `checks/${check.id}` },
      next: ['register before the next version if you want it as a claim witness'],
      checkId: check.id,
      witness: { ...baseWitness, registeredAt: check.registeredAt ?? null },
    });
  }

  return drafts;
}

export function checkSummary(run: CheckRun): VerifyCheck {
  return {
    id: run.check.id,
    version: run.check.version,
    hash: run.check.hash,
    row: run.check.row,
    status: run.status,
    findingIds: [],
    ...(run.check.registeredAt ? { registeredAt: run.check.registeredAt } : {}),
    ...(run.late ? { late: true } : {}),
  };
}

export interface CheckClaimResult {
  ok: boolean;
  code?: string;
  detail?: string;
}

/** A claim with `checkId` is witnessed by that check, not by a run kind. */
export function checkClaimByCheck(
  claim: VerifyClaim,
  runs: readonly CheckRun[],
  currentSet: readonly string[],
): CheckClaimResult {
  if (!claim.checkId) return { ok: false, code: 'claim-check-missing', detail: 'claim has no checkId' };
  const run = runs.find((r) => r.check.id === claim.checkId);
  if (!run) {
    return { ok: false, code: 'claim-check-missing', detail: `check ${claim.checkId} is not mounted (run verify --checks)` };
  }
  if (run.status === 'invalid') {
    return { ok: false, code: 'claim-check-invalid', detail: `check ${claim.checkId} is not mountable: ${run.check.error ?? 'invalid'}` };
  }
  if (run.status === 'unregistered') {
    return { ok: false, code: 'claim-check-unregistered', detail: `check ${claim.checkId} is not registered (run check-register)` };
  }
  if (run.status === 'modified') {
    return { ok: false, code: 'claim-check-modified', detail: `check ${claim.checkId} changed after registration; re-register it` };
  }
  if (run.status === 'pending') {
    return { ok: false, code: 'claim-check-pending', detail: `check ${claim.checkId} is mounted but has not run (awaiting geometry)` };
  }
  if (run.status === 'mutated') {
    return { ok: false, code: 'claim-check-mutated', detail: `check ${claim.checkId} wrote to the project; evidence discarded` };
  }
  if (run.status === 'pass') {
    if (run.late) {
      return { ok: false, code: 'claim-check-late', detail: `check ${claim.checkId} was registered after the current version; it is advisory only` };
    }
    // checker/v1 requires coverage.complete=true for status=pass; an incomplete
    // check reports blocked/fail and is handled below.
    if (claim.versionIds?.length) {
      const scope = run.check.row === 'make' || run.check.row === 'review' ? 'part' : 'assembly';
      if (scope === 'assembly') {
        if (!setEqual(claim.versionIds, currentSet)) {
          return {
            ok: false,
            code: 'claim-check-stale',
            detail: `claim cites ${claim.versionIds.join(',')} but the current set is ${currentSet.join(',')}`,
          };
        }
      } else {
        const missing = claim.versionIds.filter((v) => !currentSet.includes(v));
        if (missing.length > 0) {
          return { ok: false, code: 'claim-check-stale', detail: `claim cites versions not in the current set: ${missing.join(',')}` };
        }
      }
    }
    return { ok: true };
  }
  const code = run.status === 'error'
    ? 'claim-check-error'
    : run.status === 'blocked'
      ? 'claim-check-blocked'
      : 'claim-check-failed';
  return { ok: false, code, detail: `check ${claim.checkId} returned ${run.status}` };
}
