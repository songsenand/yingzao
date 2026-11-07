// Validation for checker/v1 manifests and reports.
//
// Strict on purpose: a checker that returns a green-looking blob without coverage,
// witness or attention is a rubber stamp, not evidence.

import {
  CHECKER_API_VERSION,
  type CheckerManifest,
  type CheckerReport,
} from './types.ts';

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const PERMISSIONS = new Set(['read:geometry', 'read:constraints', 'write:artifacts']);
const ROWS = new Set(['requirements', 'model', 'fit', 'make', 'review', 'delivery']);
const STATUSES = new Set(['pass', 'fail', 'blocked', 'error']);
const VERDICTS = new Set(['pass', 'fail', 'blocked', 'error']);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function asNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Validate a checker manifest. Returns [] when valid. */
export function validateCheckerManifest(value: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(value)) return ['manifest must be an object'];
  if (value.apiVersion !== CHECKER_API_VERSION) errors.push(`apiVersion must be "${CHECKER_API_VERSION}"`);
  if (!asString(value.id) || !ID_RE.test(value.id)) errors.push('id must match ^[a-z0-9][a-z0-9._-]*$');
  if (!asString(value.version) || !VERSION_RE.test(value.version)) errors.push('version must be semver (e.g. 1.0.0)');
  if (value.pearl !== undefined && !asString(value.pearl)) errors.push('pearl must be a non-empty string when present');
  if (value.row !== undefined && !ROWS.has(value.row as string)) {
    errors.push(`row must be one of: ${[...ROWS].join(', ')}`);
  }
  if (value.config !== undefined && (!isObject(value.config) || Array.isArray(value.config))) {
    errors.push('config must be an object when present');
  }
  if (!Array.isArray(value.criteria) || value.criteria.length === 0 || !value.criteria.every(asString)) {
    errors.push('criteria must be a non-empty array of strings');
  }
  if (!Array.isArray(value.entry) || value.entry.length === 0 || !value.entry.every(asString)) {
    errors.push('entry must be a non-empty array of strings');
  } else if (value.entry.some((x) => x.includes('\u0000'))) {
    errors.push('entry must not contain NUL');
  }
  if (!Array.isArray(value.permissions) || !value.permissions.every((p) => typeof p === 'string' && PERMISSIONS.has(p))) {
    errors.push(`permissions must be an array of: ${[...PERMISSIONS].join(', ')}`);
  }
  if (!asNumber(value.timeoutMs) || value.timeoutMs < 1_000 || value.timeoutMs > 600_000) {
    errors.push('timeoutMs must be between 1000 and 600000');
  }
  if (value.negativeSamples !== undefined && (!Array.isArray(value.negativeSamples) || !value.negativeSamples.every(asString))) {
    errors.push('negativeSamples must be an array of strings when present');
  }
  return errors;
}

export interface ValidateReportOptions {
  /** Custom checks must not write artifacts. */
  artifacts?: 'allow' | 'forbid';
  /** Reject a report with more findings than this. */
  maxFindings?: number;
}

/** Validate a checker report against the protocol (and optionally its manifest). */
export function validateCheckerReport(
  value: unknown,
  manifest?: CheckerManifest,
  options: ValidateReportOptions = {},
): string[] {
  const errors: string[] = [];
  if (!isObject(value)) return ['report must be an object'];
  if (value.apiVersion !== CHECKER_API_VERSION) errors.push(`apiVersion must be "${CHECKER_API_VERSION}"`);

  const checker = value.checker;
  if (!isObject(checker) || !asString(checker.id) || !asString(checker.version)) {
    errors.push('checker must be { id, version }');
  } else if (manifest && (checker.id !== manifest.id || checker.version !== manifest.version)) {
    errors.push(`checker identity ${checker.id}@${checker.version} does not match manifest ${manifest.id}@${manifest.version}`);
  }

  if (typeof value.status !== 'string' || !STATUSES.has(value.status)) {
    errors.push('status must be pass|fail|blocked|error');
  }

  const findings = value.findings;
  if (!Array.isArray(findings)) {
    errors.push('findings must be an array');
  } else {
    if (options.maxFindings !== undefined && findings.length > options.maxFindings) {
      errors.push(`findings must be at most ${options.maxFindings} (got ${findings.length})`);
    }
    findings.forEach((f, i) => {
      if (!isObject(f)) { errors.push(`findings[${i}] must be an object`); return; }
      if (!asString(f.criterion)) errors.push(`findings[${i}].criterion must be a non-empty string`);
      if (typeof f.verdict !== 'string' || !VERDICTS.has(f.verdict)) {
        errors.push(`findings[${i}].verdict must be pass|fail|blocked|error`);
      }
      if (f.verdict !== 'pass') {
        if (!asNumber(f.measured)) errors.push(`findings[${i}].measured is required for ${String(f.verdict)}`);
        if (!asNumber(f.limit)) errors.push(`findings[${i}].limit is required for ${String(f.verdict)}`);
        if (!asString(f.unit)) errors.push(`findings[${i}].unit is required for ${String(f.verdict)}`);
        if (!isObject(f.witness) || !asString((f.witness as Record<string, unknown>).kind)) {
          errors.push(`findings[${i}].witness.kind is required for ${String(f.verdict)}`);
        }
        if (!Array.isArray(f.attention) || f.attention.length === 0) {
          errors.push(`findings[${i}].attention is required for ${String(f.verdict)}`);
        }
      }
    });
  }

  const coverage = value.coverage;
  const skippedCriteria: string[] = [];
  if (!isObject(coverage)) {
    errors.push('coverage must be an object');
  } else {
    if (!Array.isArray(coverage.criteria) || !coverage.criteria.every(asString)) {
      errors.push('coverage.criteria must be an array of strings');
    }
    if (typeof coverage.complete !== 'boolean') errors.push('coverage.complete must be boolean');
    if (!Array.isArray(coverage.skipped)) {
      errors.push('coverage.skipped must be an array');
    } else {
      if (coverage.skipped.length > 0 && coverage.complete === true) {
        errors.push('coverage.complete cannot be true when skipped is non-empty');
      }
      const declared = new Set(manifest?.criteria ?? []);
      coverage.skipped.forEach((s, i) => {
        if (!isObject(s)) { errors.push(`coverage.skipped[${i}] must be an object`); return; }
        if (!asString(s.criterion)) errors.push(`coverage.skipped[${i}].criterion must be a non-empty string`);
        else if (manifest && !declared.has(s.criterion)) {
          errors.push(`coverage.skipped[${i}].criterion "${s.criterion}" is not declared by manifest`);
        } else {
          skippedCriteria.push(s.criterion);
        }
        if (!asString(s.reason)) errors.push(`coverage.skipped[${i}].reason must be a non-empty string`);
      });
    }
  }

  const artifacts = value.artifacts;
  if (!Array.isArray(artifacts)) {
    errors.push('artifacts must be an array');
  } else {
    if (options.artifacts === 'forbid' && artifacts.length > 0) {
      errors.push('artifacts must be empty for custom checks (read-only)');
    }
    artifacts.forEach((a, i) => {
      if (!isObject(a) || !asString(a.kind) || !asString(a.path)) {
        errors.push(`artifacts[${i}] must be { kind, path }`);
        return;
      }
      if (!a.path.startsWith('artifacts/') || a.path.includes('../') || a.path.startsWith('/')) {
        errors.push(`artifacts[${i}].path must stay under artifacts/`);
      }
    });
  }

  const declaredCriteria = manifest?.criteria ?? [];
  const findingCriteria = new Set<string>(
    Array.isArray(findings)
      ? findings
        .filter(isObject)
        .map((f) => (asString(f.criterion) ? f.criterion : ''))
        .filter((c) => c.length > 0)
      : [],
  );
  const coverageCriteria = isObject(coverage) && Array.isArray(coverage.criteria)
    ? coverage.criteria.filter(asString)
    : [];

  if (manifest && Array.isArray(findings)) {
    const allowed = new Set(manifest.criteria);
    for (const f of findings) {
      if (isObject(f) && asString(f.criterion) && !allowed.has(f.criterion)) {
        errors.push(`finding criterion "${f.criterion}" is not declared by manifest (allowed: ${manifest.criteria.join(', ')})`);
      }
    }
    for (const c of coverageCriteria) {
      if (!allowed.has(c)) errors.push(`coverage criterion "${c}" is not declared by manifest`);
    }
    for (const c of findingCriteria) {
      if (!coverageCriteria.includes(c) && !skippedCriteria.includes(c)) {
        errors.push(`finding criterion "${c}" is missing from coverage.criteria`);
      }
    }
  }

  // A check that did not crash must account for every declared criterion, either
  // with a finding or with an explicit skipped reason. Error reports are exempt:
  // the check never got far enough to evaluate anything.
  const status = value.status;
  if (manifest && status !== 'error' && Array.isArray(findings)) {
    const accounted = new Set([...findingCriteria, ...skippedCriteria]);
    for (const c of declaredCriteria) {
      if (!accounted.has(c)) {
        errors.push(`manifest criterion "${c}" is not accounted for by a finding or skipped reason`);
      }
    }
  }

  if (status === 'pass') {
    if (!isObject(coverage) || coverage.complete !== true) {
      errors.push('status=pass requires coverage.complete=true');
    }
    if (isObject(coverage) && Array.isArray(coverage.skipped) && coverage.skipped.length > 0) {
      errors.push('status=pass cannot coexist with skipped criteria');
    }
    if (Array.isArray(findings) && findings.some((f) => isObject(f) && f.verdict !== 'pass')) {
      errors.push('status=pass cannot coexist with a non-pass finding');
    }
    for (const c of declaredCriteria) {
      if (!Array.isArray(findings) || !findings.some((f) => isObject(f) && f.criterion === c && f.verdict === 'pass')) {
        errors.push(`status=pass requires a pass finding for every declared criterion (missing "${c}")`);
      }
    }
  }
  if (status === 'fail' && Array.isArray(findings) && !findings.some((f) => isObject(f) && f.verdict === 'fail')) {
    errors.push('status=fail requires at least one fail finding');
  }
  if (status === 'blocked') {
    const hasBlocked = Array.isArray(findings) && findings.some((f) => isObject(f) && f.verdict === 'blocked');
    if (!hasBlocked && skippedCriteria.length === 0) {
      errors.push('status=blocked requires a blocked finding or a skipped criterion');
    }
  }
  if (status === 'error') {
    if (!isObject(value.error)) {
      errors.push('status=error requires an error object');
    } else {
      if (!asString(value.error.code)) errors.push('status=error requires error.code');
      if (!asString(value.error.message)) errors.push('status=error requires error.message');
    }
  }

  return errors;
}

export function assertCheckerReport(value: unknown, manifest?: CheckerManifest): asserts value is CheckerReport {
  const errors = validateCheckerReport(value, manifest);
  if (errors.length > 0) throw new Error(`checker report invalid:\n- ${errors.join('\n- ')}`);
}

export function assertCheckerManifest(value: unknown): asserts value is CheckerManifest {
  const errors = validateCheckerManifest(value);
  if (errors.length > 0) throw new Error(`checker manifest invalid:\n- ${errors.join('\n- ')}`);
}

/** Turn an invalid report into a protocol error report (never a pass). */
export function protocolError(manifest: CheckerManifest, code: string, message: string): CheckerReport {
  return {
    apiVersion: CHECKER_API_VERSION,
    checker: { id: manifest.id, version: manifest.version },
    status: 'error',
    findings: [],
    coverage: { criteria: [], complete: false, skipped: [] },
    artifacts: [],
    error: { code, message, retryable: false },
  };
}
