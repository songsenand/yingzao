// Freshness rules for V1. One definition, used by the delivery row and by the
// explicit claim checker.
//
// Assembly-level run: sourceVersionIds must EQUAL the current version set.
// Part-level run:     sourceVersionIds must CONTAIN the claimed version(s).
// In both cases the run must be at or after the latest cited version's timestamp.
// A run without sourceVersionIds cannot prove freshness (blocked, never pass).

import type { RunEntry } from '../runs.ts';
import { CLAIM_EVIDENCE } from '../delivery-audit.ts';
import type { VerifyClaim } from './types.ts';

export type RunScope = 'assembly' | 'part';

export interface FreshnessResult {
  fresh: boolean;
  reason?: string;
  unverifiable?: boolean;
}

export function scopeOfKind(kind: string): RunScope {
  return kind === 'printability' || kind === 'sheet2d' || kind === 'turning' || kind === 'machinability' || kind === 'edm' ? 'part' : 'assembly';
}

export function setEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((v, i) => v === right[i]);
}

function versionTimeOf(id: string, versionTimes: Map<string, string>): number | undefined {
  const raw = versionTimes.get(id);
  if (typeof raw !== 'string') return undefined;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : undefined;
}

export function isFresh(
  run: RunEntry,
  versions: readonly string[],
  versionTimes: Map<string, string>,
  scope: RunScope,
): FreshnessResult {
  const source = Array.isArray(run.sourceVersionIds) ? [...run.sourceVersionIds] : [];
  if (source.length === 0) return { fresh: false, reason: 'run has no sourceVersionIds' };
  if (versions.length === 0) return { fresh: false, reason: 'no current versions to compare' };

  for (const v of source) {
    if (versionTimeOf(v, versionTimes) === undefined) {
      return { fresh: false, unverifiable: true, reason: `version ${v} has no usable timestamp` };
    }
  }
  const runTs = Date.parse(run.timestamp);
  if (!Number.isFinite(runTs)) return { fresh: false, unverifiable: true, reason: 'run timestamp is invalid' };

  if (scope === 'assembly') {
    if (!setEqual(source, versions)) {
      return { fresh: false, reason: `run cites ${source.join(',')} but the current set is ${versions.join(',')}` };
    }
  } else {
    const missing = versions.filter((v) => !source.includes(v));
    if (missing.length > 0) return { fresh: false, reason: `run does not cite ${missing.join(',')}` };
  }

  const times = versions.map((v) => versionTimeOf(v, versionTimes));
  if (times.some((t) => t === undefined)) {
    return { fresh: false, unverifiable: true, reason: `a claimed version has no usable timestamp` };
  }
  const latestVersionTs = Math.max(...(times as number[]));
  if (runTs < latestVersionTs) {
    return { fresh: false, reason: `run ${run.timestamp} predates the latest cited version` };
  }
  return { fresh: true };
}

export function latestFreshRun(
  runs: readonly RunEntry[],
  kinds: readonly string[],
  versions: readonly string[],
  versionTimes: Map<string, string>,
  scope: RunScope,
): RunEntry | undefined {
  const candidates = runs
    .filter((r) => kinds.includes(r.kind))
    .slice()
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  return candidates.find((r) => isFresh(r, versions, versionTimes, scope).fresh);
}

export interface ClaimCheck {
  /** false = V1 did not check this claim (the audit's kind-level check owns it). */
  checked: boolean;
  ok: boolean;
  code?: string;
  detail?: string;
  run?: RunEntry;
  scope?: RunScope;
}

/**
 * Explicit claim check. The audit already checks claims by kind (e.g. "a fresh
 * printability run for every printed part"); this adds the exact run/version
 * witness when the claim names one.
 */
export function checkClaim(
  claim: VerifyClaim,
  runs: readonly RunEntry[],
  currentSet: readonly string[],
  versionTimes: Map<string, string>,
): ClaimCheck {
  const kinds = CLAIM_EVIDENCE[claim.kind].kinds;

  if (claim.runId) {
    const run = runs.find((r) => r.id === claim.runId);
    if (!run) return { checked: true, ok: false, code: 'claim-run-missing', detail: `run ${claim.runId} is not in the run store` };
    if (!kinds.includes(run.kind)) {
      return { checked: true, ok: false, code: 'claim-kind-mismatch', detail: `run ${run.id} is ${run.kind}; claim "${claim.kind}" needs ${kinds.join('/')}` };
    }
    const scope = scopeOfKind(run.kind);
    const versions = claim.versionIds?.length
      ? claim.versionIds
      : scope === 'part'
        ? (Array.isArray(run.sourceVersionIds) ? run.sourceVersionIds.filter((v) => currentSet.includes(v)) : [])
        : currentSet;
    if (versions.length === 0) {
      return { checked: true, ok: false, code: 'claim-run-stale', detail: `run ${run.id} does not cite a current version`, run, scope };
    }
    const fresh = isFresh(run, versions, versionTimes, scope);
    if (!fresh.fresh) {
      return {
        checked: true, ok: false,
        code: fresh.unverifiable ? 'claim-run-unverifiable' : 'claim-run-stale',
        detail: fresh.reason ?? 'run is not fresh', run, scope,
      };
    }
    return { checked: true, ok: true, run, scope };
  }

  // Manufacturability is per printed part; the audit owns that check. Do not
  // turn a single fresh printability run into a pass for all parts.
  if (claim.kind === 'manufacturability') return { checked: false, ok: true };

  const scope: RunScope = kinds.includes('printability') ? 'part' : 'assembly';
  const versions = claim.versionIds?.length ? claim.versionIds : currentSet;
  if (versions.length === 0) {
    return { checked: true, ok: false, code: 'claim-without-witness', detail: 'no current versions to compare' };
  }
  const run = latestFreshRun(runs, kinds, versions, versionTimes, scope);
  if (!run) {
    return {
      checked: true, ok: false, code: 'claim-without-witness',
      detail: `no fresh ${kinds.join('/')} run for ${versions.join(',')}`,
    };
  }
  return { checked: true, ok: true, run, scope };
}
