// Checker protocol types (checker/v1).
//
// The runtime depends on these JSON shapes, not on a base class: a checker may be
// Python, JS, WASM or declarative as long as it reads one JSON document on stdin and
// writes one JSON document on stdout.

export const CHECKER_API_VERSION = 'checker/v1' as const;

export type CheckerStatus = 'pass' | 'fail' | 'blocked' | 'error';
export type CheckerRow = 'requirements' | 'model' | 'fit' | 'make' | 'review' | 'delivery';
export type FindingVerdict = 'pass' | 'fail' | 'blocked' | 'error';

export interface CheckerManifest {
  apiVersion: typeof CHECKER_API_VERSION;
  id: string;
  version: string;
  /** Legacy pearl slot. Kept for the deprecated probe path; custom checks use `row`. */
  pearl?: string;
  /** V1 coverage row. Defaults from `pearl`, then `delivery`. */
  row?: CheckerRow;
  criteria: string[];
  entry: string[];
  permissions: CheckerPermission[];
  timeoutMs: number;
  negativeSamples?: string[];
  /** Opaque, check-owned config; V1 passes it as constraints.checkConfig. */
  config?: Record<string, unknown>;
  description?: string;
}

export type CheckerPermission = 'read:geometry' | 'read:constraints' | 'write:artifacts';

export interface CheckerAttention {
  kind: string;
  part?: string;
  a?: string;
  b?: string;
  where?: number[];
  view?: string;
  note: string;
}

export interface CheckerWitness {
  kind: string;
  parts?: string[];
  volumeMm3?: number;
  minDistanceMm?: number;
  measured?: number;
  limit?: number;
  unit?: string;
  [key: string]: unknown;
}

export interface CheckerFinding {
  criterion: string;
  verdict: FindingVerdict;
  measured?: number;
  limit?: number;
  unit?: string;
  witness?: CheckerWitness;
  attention?: CheckerAttention[];
  message?: string;
}

export interface CheckerCoverage {
  criteria: string[];
  complete: boolean;
  skipped: { criterion: string; reason: string }[];
}

export interface CheckerArtifact {
  kind: string;
  path: string;
}

export interface CheckerReport {
  apiVersion: typeof CHECKER_API_VERSION;
  checker: { id: string; version: string };
  status: CheckerStatus;
  findings: CheckerFinding[];
  coverage: CheckerCoverage;
  artifacts: CheckerArtifact[];
  runtime?: { ms: number };
  error?: { code: string; message: string; retryable?: boolean };
}

export interface CheckerPartInput {
  id: string;
  stl?: string;
  aabb?: { min: [number, number, number]; max: [number, number, number] };
  bbox?: [number, number, number];
}

export interface CheckerInput {
  apiVersion: typeof CHECKER_API_VERSION;
  run?: { pearl?: string; template?: string };
  project?: { root?: string; units?: 'mm' };
  geometry?: {
    parts?: CheckerPartInput[];
    assembly?: unknown;
  };
  constraints?: Record<string, unknown>;
  budget?: { timeoutMs?: number; maxFindings?: number };
}

export interface RunCheckerResult {
  report: CheckerReport;
  durationMs: number;
  stderr: string;
}
