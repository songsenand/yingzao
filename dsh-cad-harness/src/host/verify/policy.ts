// Policy loading, category overrides, exception records, verdict/exit mapping.
//
// There is no owner role: a policy is the user's declaration. Without one, V1
// runs advisory (exit 0) and still produces the report. Exceptions are user
// records with an expiry; the site only applies them and reports expiry.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { FindingDraft, VerifyException, VerifyOutcome, VerifyPolicy, VerifyReport, VerifyRow, VerifyStatus } from './types.ts';

export type FindingCategory =
  | 'evidence-missing'
  | 'evidence-stale'
  | 'claim-without-witness'
  | 'design-threshold'
  | 'difficult'
  | 'no-claims-declared'
  | 'exception-expired'
  | 'custom-check'
  | 'other';

export function categoryOf(code: string): FindingCategory {
  if (code === 'no-claims-declared') return 'no-claims-declared';
  if (code === 'exception-expired') return 'exception-expired';
  if (code === 'check-root' || code.startsWith('check-') || code.startsWith('claim-check-')) return 'custom-check';
  if (
    code === 'claim-without-evidence' ||
    code === 'claim-run-missing' ||
    code === 'claim-run-stale' ||
    code === 'claim-run-unverifiable' ||
    code === 'claim-kind-mismatch' ||
    code === 'claims-required' ||
    code === 'claims-invalid'
  ) {
    return 'claim-without-witness';
  }
  if (
    code === 'stale-evidence' ||
    code === 'visual-review-stale' ||
    code === 'merged-stale' ||
    code === 'evidence-predates-geometry' ||
    code === 'contract-stale-nodes'
  ) {
    return 'evidence-stale';
  }
  if (
    code === 'visual-review-missing' ||
    code === 'unregistered-geometry' ||
    code === 'make.no-cutlist' ||
    code === 'make.no-stock' ||
    code === 'make.no-evidence' ||
    code === 'make.no-parts' ||
    code === 'brief.missing' ||
    code === 'model.contract-invalid' ||
    code === 'missing-assembly' ||
    code === 'missing-contract' ||
    code === 'no-declared-interfaces' ||
    code === 'stale-contract' ||
    code === 'deliver.no-evidence' ||
    code === 'review.missing' ||
    code === 'verify.project-missing' ||
    code === 'verify.audit-failed' ||
    code === 'rulepack-unreadable'
  ) {
    return 'evidence-missing';
  }
  if (code === 'interference' || code === 'hard-interface' || code === 'make.printability' || code === 'make.stock') {
    return 'design-threshold';
  }
  if (code === 'make.coverage' || code === 'deliver.warn' || code === 'undeclared-adjacency') return 'difficult';
  return 'other';
}

export interface PolicyLoadResult {
  policy: VerifyPolicy | null;
  source: 'file' | 'flags' | 'none';
  hash?: string;
  path?: string;
  issues: string[];
}

export function validatePolicy(value: unknown): string[] {
  const issues: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ['policy must be an object'];
  const p = value as Record<string, unknown>;
  if (p.schemaVersion !== 1) issues.push('policy.schemaVersion must be 1');
  if (p.id !== undefined && (typeof p.id !== 'string' || p.id.length === 0)) issues.push('policy.id must be a non-empty string');
  if (p.mode !== undefined && p.mode !== 'advisory' && p.mode !== 'blocking') issues.push('policy.mode must be advisory|blocking');
  for (const key of ['blockOn', 'warnOn'] as const) {
    if (p[key] !== undefined && (!Array.isArray(p[key]) || (p[key] as unknown[]).some((x) => typeof x !== 'string'))) {
      issues.push(`policy.${key} must be an array of category strings`);
    }
  }
  if (p.requireClaims !== undefined && typeof p.requireClaims !== 'boolean') issues.push('policy.requireClaims must be boolean');
  if (p.exceptions !== undefined && typeof p.exceptions !== 'string') issues.push('policy.exceptions must be a path string');
  return issues;
}

export async function loadPolicy(projectRoot: string, policyPath?: string): Promise<PolicyLoadResult> {
  const root = resolve(projectRoot);
  const explicit = typeof policyPath === 'string' && policyPath.length > 0;
  const path = explicit
    ? (isAbsolute(policyPath!) ? policyPath! : resolve(policyPath!))
    : join(root, 'evidence-policy.json');
  if (!existsSync(path)) {
    return {
      policy: null,
      source: explicit ? 'none' : 'none',
      issues: explicit ? [`policy file not found: ${path}`] : [],
    };
  }
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    return { policy: null, source: 'file', path, issues: [`policy is not readable: ${String((e as Error)?.message ?? e)}`] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { policy: null, source: 'file', path, issues: [`policy is not readable JSON: ${String((e as Error)?.message ?? e)}`] };
  }
  const issues = validatePolicy(raw);
  if (issues.length > 0) return { policy: null, source: 'file', path, issues };
  return {
    policy: raw as VerifyPolicy,
    source: 'file',
    hash: `sha256:${createHash('sha256').update(text).digest('hex')}`,
    path,
    issues: [],
  };
}

export function resolveMode(options: { block?: boolean; advisory?: boolean }, policy: VerifyPolicy | null): 'advisory' | 'blocking' {
  if (options.advisory) return 'advisory';
  if (options.block) return 'blocking';
  return policy?.mode === 'blocking' ? 'blocking' : 'advisory';
}

export function applyPolicy(drafts: FindingDraft[], policy: VerifyPolicy | null): void {
  if (!policy) return;
  const block = new Set(policy.blockOn ?? []);
  const warn = new Set(policy.warnOn ?? []);
  for (const d of drafts) {
    // A policy override must not turn a passing witness into a failure.
    if (d.outcome === 'info') continue;
    const category = categoryOf(d.code);
    if (block.has(category)) {
      d.outcome = 'blocked';
      d.severity = 'blocked';
    } else if (warn.has(category)) {
      d.outcome = 'warn';
      d.severity = 'warn';
    }
  }
}

export interface ExceptionsLoadResult {
  exceptions: VerifyException[];
  source: string | null;
  issues: string[];
}

export async function loadExceptions(
  projectRoot: string,
  policy: VerifyPolicy | null,
  policyPath?: string,
): Promise<ExceptionsLoadResult> {
  const root = resolve(projectRoot);
  const rel = policy?.exceptions ?? 'evidence-exceptions.json';
  const base = policyPath ? dirname(resolve(policyPath)) : root;
  const path = isAbsolute(rel) ? rel : resolve(base, rel);
  if (!existsSync(path)) return { exceptions: [], source: null, issues: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    return { exceptions: [], source: path, issues: [`exceptions file is not readable JSON: ${String((e as Error)?.message ?? e)}`] };
  }
  const container = raw as { schemaVersion?: unknown; exceptions?: unknown };
  if (container?.schemaVersion !== 1 || !Array.isArray(container.exceptions)) {
    return { exceptions: [], source: path, issues: ['exceptions file must be { schemaVersion: 1, exceptions: [...] }'] };
  }
  const exceptions: VerifyException[] = [];
  const issues: string[] = [];
  for (const [i, item] of container.exceptions.entries()) {
    if (typeof item !== 'object' || item === null) { issues.push(`exceptions[${i}] must be an object`); continue; }
    const e = item as Record<string, unknown>;
    if (typeof e.id !== 'string' || !e.id) { issues.push(`exceptions[${i}].id is required`); continue; }
    if (typeof e.finding !== 'string' || !e.finding) { issues.push(`exceptions[${i}].finding is required`); continue; }
    if (typeof e.reason !== 'string' || !e.reason) { issues.push(`exceptions[${i}].reason is required`); continue; }
    if (typeof e.expiresAt !== 'string' || Number.isNaN(Date.parse(e.expiresAt))) { issues.push(`exceptions[${i}].expiresAt must be an ISO date`); continue; }
    exceptions.push({
      id: e.id,
      finding: e.finding,
      reason: e.reason,
      expiresAt: e.expiresAt,
      ...(typeof e.project === 'string' ? { project: e.project } : {}),
      ...(typeof e.approvedBy === 'string' ? { approvedBy: e.approvedBy } : {}),
    });
  }
  return { exceptions, source: path, issues };
}

export interface AppliedException {
  id: string;
  finding: string;
  reason: string;
  expiresAt: string;
  approvedBy?: string;
}

export interface ExceptionApplyResult {
  applied: AppliedException[];
  expired: string[];
}

function exceptionMatches(e: VerifyException, draft: FindingDraft, root: string): boolean {
  if (e.finding !== draft.code) return false;
  if (e.project) {
    const p = isAbsolute(e.project) ? e.project : resolve(root, e.project);
    if (p !== root) return false;
  }
  return true;
}

export function applyExceptions(
  drafts: FindingDraft[],
  exceptions: readonly VerifyException[],
  projectRoot: string,
): ExceptionApplyResult {
  const root = resolve(projectRoot);
  const applied: AppliedException[] = [];
  const expired: string[] = [];
  const expiredSeen = new Set<string>();
  for (const d of drafts) {
    for (const e of exceptions) {
      if (!exceptionMatches(e, d, root)) continue;
      const ts = Date.parse(e.expiresAt);
      if (Number.isNaN(ts) || ts < Date.now()) {
        if (!expiredSeen.has(e.id)) {
          expiredSeen.add(e.id);
          expired.push(e.id);
        }
        continue;
      }
      d.outcome = 'warn';
      d.severity = 'warn';
      d.exceptionId = e.id;
      if (!applied.some((a) => a.id === e.id && a.finding === d.code)) {
        applied.push({ id: e.id, finding: d.code, reason: e.reason, expiresAt: e.expiresAt, ...(e.approvedBy ? { approvedBy: e.approvedBy } : {}) });
      }
      break;
    }
  }
  return { applied, expired };
}

export function statusOfOutcomes(outcomes: readonly VerifyOutcome[]): VerifyStatus {
  if (outcomes.includes('blocked')) return 'blocked';
  if (outcomes.includes('fail')) return 'fail';
  if (outcomes.includes('warn')) return 'warn';
  return 'pass';
}

export function verdictOf(rows: readonly VerifyRow[]): VerifyStatus {
  const statuses = rows.map((r) => r.status);
  for (const s of ['blocked', 'fail', 'warn', 'unobserved', 'pass'] as VerifyStatus[]) {
    if (statuses.includes(s)) return s;
  }
  return 'pass';
}

export function exitCodeFor(report: VerifyReport, mode: 'advisory' | 'blocking', strict: boolean): number {
  if (mode === 'advisory') return 0;
  if (report.verdict === 'pass') return 0;
  if (report.verdict === 'warn') return strict ? 2 : 1;
  return 2;
}
