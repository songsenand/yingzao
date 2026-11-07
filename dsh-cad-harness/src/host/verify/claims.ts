// Claims are the user's declaration of what they intend to deliver. V1 does not
// generate them and does not judge the statement; it checks that a claimed kind
// has a fresh witness (the explicit run/version form is checked here; the
// kind-level per-part form is delegated to delivery_audit).

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { CLAIM_EVIDENCE, type DeliveryClaim } from '../delivery-audit.ts';
import type { VerifyClaim } from './types.ts';

export interface ClaimsLoadResult {
  claims: VerifyClaim[];
  source: string | null;
  hash?: string;
  issues: string[];
}

const KINDS = new Set(Object.keys(CLAIM_EVIDENCE) as DeliveryClaim['kind'][]);

export function validateClaims(value: unknown): string[] {
  const issues: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ['claims must be an object'];
  const v = value as { schemaVersion?: unknown; claims?: unknown };
  if (v.schemaVersion !== 1) issues.push('claims.schemaVersion must be 1');
  if (!Array.isArray(v.claims)) {
    issues.push('claims.claims must be an array');
    return issues;
  }
  for (const [i, raw] of v.claims.entries()) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      issues.push(`claims[${i}] must be an object`);
      continue;
    }
    const c = raw as Record<string, unknown>;
    if (typeof c.kind !== 'string' || !KINDS.has(c.kind as DeliveryClaim['kind'])) {
      issues.push(`claims[${i}].kind must be one of: ${[...KINDS].join(', ')}`);
    }
    if (typeof c.statement !== 'string' || c.statement.trim().length === 0) {
      issues.push(`claims[${i}].statement must be a non-empty string`);
    }
    if (c.runId !== undefined && (typeof c.runId !== 'string' || c.runId.length === 0)) {
      issues.push(`claims[${i}].runId must be a non-empty string when present`);
    }
    if (c.checkId !== undefined && (typeof c.checkId !== 'string' || c.checkId.length === 0)) {
      issues.push(`claims[${i}].checkId must be a non-empty string when present`);
    }
    if (c.versionIds !== undefined) {
      if (!Array.isArray(c.versionIds) || c.versionIds.some((x) => typeof x !== 'string' || x.length === 0)) {
        issues.push(`claims[${i}].versionIds must be an array of version ids when present`);
      }
    }
  }
  return issues;
}

function hashClaims(claims: VerifyClaim[]): string {
  const text = JSON.stringify(claims);
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

export async function loadClaims(projectRoot: string, claimsPath?: string): Promise<ClaimsLoadResult> {
  const root = resolve(projectRoot);
  const explicit = typeof claimsPath === 'string' && claimsPath.length > 0;
  const path = explicit
    ? (isAbsolute(claimsPath!) ? claimsPath! : resolve(claimsPath!))
    : join(root, 'claims.json');

  if (!existsSync(path)) {
    return {
      claims: [],
      source: null,
      issues: explicit ? [`claims file not found: ${path}`] : [],
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    return { claims: [], source: path, issues: [`claims file is not readable JSON: ${String((e as Error)?.message ?? e)}`] };
  }
  const issues = validateClaims(raw);
  if (issues.length > 0) return { claims: [], source: path, issues };

  const claims = ((raw as { claims: Record<string, unknown>[] }).claims).map((c) => ({
    kind: c.kind as VerifyClaim['kind'],
    statement: String(c.statement),
    ...(typeof c.runId === 'string' ? { runId: c.runId } : {}),
    ...(typeof c.checkId === 'string' ? { checkId: c.checkId } : {}),
    ...(Array.isArray(c.versionIds) ? { versionIds: [...c.versionIds] as string[] } : {}),
  })) as VerifyClaim[];

  return { claims, source: path, hash: hashClaims(claims), issues: [] };
}

export function toDeliveryClaims(claims: readonly VerifyClaim[]): DeliveryClaim[] {
  // A check-backed claim is owned by the custom-check run; the delivery audit
  // must not also judge it by run-kind. Otherwise a check claim could pass or
  // fail for the wrong reason.
  return claims.filter((c) => !c.checkId).map((c) => ({ kind: c.kind, statement: c.statement }));
}
