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
  if (!asString(value.pearl)) errors.push('pearl must be a non-empty string');
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

/** Validate a checker report against the protocol (and optionally its manifest). */
export function validateCheckerReport(value: unknown, manifest?: CheckerManifest): string[] {
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
  if (!isObject(coverage)) {
    errors.push('coverage must be an object');
  } else {
    if (!Array.isArray(coverage.criteria) || !coverage.criteria.every(asString)) {
      errors.push('coverage.criteria must be an array of strings');
    }
    if (typeof coverage.complete !== 'boolean') errors.push('coverage.complete must be boolean');
    if (!Array.isArray(coverage.skipped)) {
      errors.push('coverage.skipped must be an array');
    } else if (coverage.skipped.length > 0 && coverage.complete === true) {
      errors.push('coverage.complete cannot be true when skipped is non-empty');
    }
  }

  const artifacts = value.artifacts;
  if (!Array.isArray(artifacts)) {
    errors.push('artifacts must be an array');
  } else {
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

  if (value.status === 'pass') {
    if (isObject(coverage) && coverage.complete !== true) errors.push('status=pass requires coverage.complete=true');
    if (Array.isArray(findings) && findings.some((f) => isObject(f) && f.verdict !== 'pass')) {
      errors.push('status=pass cannot coexist with a non-pass finding');
    }
  }
  if (value.status === 'fail' && Array.isArray(findings) && !findings.some((f) => isObject(f) && f.verdict === 'fail')) {
    errors.push('status=fail requires at least one fail finding');
  }
  if (value.status === 'error' && !isObject(value.error)) {
    errors.push('status=error requires an error object');
  }

  if (manifest && Array.isArray(findings)) {
    const allowed = new Set(manifest.criteria);
    for (const f of findings) {
      if (isObject(f) && asString(f.criterion) && !allowed.has(f.criterion)) {
        errors.push(`finding criterion "${f.criterion}" is not declared by manifest (allowed: ${manifest.criteria.join(', ')})`);
      }
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
