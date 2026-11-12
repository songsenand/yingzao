// V1 evidence verification: read-only report types.
//
// A report is a DERIVED snapshot, never an input: tools must not read it back.
// Status vocabulary is one set at this boundary: pass | warn | fail | blocked |
// unobserved. Legacy tool words (excluded/difficult/not-excluded) are mapped in
// the adapters, not re-exported.

import type { DeliveryClaim } from '../delivery-audit.ts';
import type { InterfaceLedger } from './interfaces.ts';

export type VerifyStatus = 'pass' | 'warn' | 'fail' | 'blocked' | 'unobserved';
export type VerifyRowId = 'requirements' | 'model' | 'fit' | 'make' | 'review' | 'delivery';
export type VerifySeverity = 'info' | 'warn' | 'blocked';
export type VerifyOutcome = 'info' | 'warn' | 'fail' | 'blocked';
export type VerifyWhereKind = 'pair' | 'interface' | 'part' | 'manifest' | 'unknown';

export interface VerifyWhere {
  kind: VerifyWhereKind;
  parts?: string[];
  point?: number[];
  center?: number[];
  note?: string;
  path?: string;
}

export interface VerifyFinding {
  id: string;
  code: string;
  severity: VerifySeverity;
  what: string;
  why: string[];
  where: VerifyWhere;
  next: string[];
  witness?: Record<string, unknown>;
  exceptionId?: string;
  checkId?: string;
}

export interface VerifyChecked {
  runId?: string;
  kind: string;
}

export interface VerifyMissing {
  evidence: string;
  why: string;
  next: string[];
}

export interface VerifyRow {
  id: VerifyRowId;
  label: string;
  status: VerifyStatus;
  checked: VerifyChecked[];
  missing: VerifyMissing[];
  findingIds: string[];
  note?: string;
}

export interface VerifyClaim {
  kind: DeliveryClaim['kind'];
  statement: string;
  /** Optional explicit witness. When omitted, the audit's kind-level check applies. */
  runId?: string;
  /** Optional custom-check witness. When present, the check owns the witness. */
  checkId?: string;
  /** Optional scope; defaults to the current assembly version set. */
  versionIds?: string[];
}

export type VerifyCheckStatus = 'pass' | 'fail' | 'blocked' | 'error' | 'pending' | 'invalid' | 'mutated' | 'unregistered' | 'modified';

export interface VerifyCheck {
  id: string;
  version: string;
  hash: string;
  row: VerifyRowId;
  status: VerifyCheckStatus;
  findingIds: string[];
  registeredAt?: string;
  /** Registered after the current version: the result is advisory only. */
  late?: boolean;
}

export interface VerifyPolicy {
  schemaVersion: 1;
  id?: string;
  mode?: 'advisory' | 'blocking';
  blockOn?: string[];
  warnOn?: string[];
  requireClaims?: boolean;
  exceptions?: string;
}

export interface VerifyException {
  id: string;
  finding: string;
  project?: string;
  reason: string;
  expiresAt: string;
  approvedBy?: string;
}

export interface VerifyInputs {
  versions: string[];
  claimsHash?: string;
  rulepack?: string | null;
}

export interface VerifyReport {
  schemaVersion: 1;
  generatedAt: string;
  project: string;
  depth: 'read';
  policy: { source: 'file' | 'flags' | 'none'; mode: 'advisory' | 'blocking'; id?: string; hash?: string };
  inputs: VerifyInputs;
  verdict: VerifyStatus;
  rows: VerifyRow[];
  findings: VerifyFinding[];
  checks: VerifyCheck[];
  coverage: { checked: string[]; missing: string[] };
  exceptions: { id: string; finding: string; reason: string; expiresAt: string; approvedBy?: string }[];
  provenance: { toolVersions: Record<string, string | null>; runIds: string[] };
  /** Derived per-interface proof; absent when there is no manifest. */
  interfaces?: InterfaceLedger;
}

export interface VerifyOptions {
  projectRoot: string;
  claimsPath?: string;
  policyPath?: string;
  rulepack?: string;
  block?: boolean;
  advisory?: boolean;
  strict?: boolean;
  requireClaims?: boolean;
  /** Enable custom checks (opt-in). */
  checks?: boolean;
  /** Explicit checks directory; implies `checks`. */
  checksDir?: string;
  /** Validate/mount only: no geometry run. */
  mountChecks?: boolean;
  /** Explicitly disable checks. */
  noChecks?: boolean;
}

/** Internal draft before ids/rows are finalised. */
export interface FindingDraft {
  row: VerifyRowId;
  code: string;
  outcome: VerifyOutcome;
  severity: VerifySeverity;
  what: string;
  why: string[];
  where: VerifyWhere;
  next: string[];
  witness?: Record<string, unknown>;
  exceptionId?: string;
  checkId?: string;
}

export interface RowDraft {
  id: VerifyRowId;
  label: string;
  status: VerifyStatus;
  checked: VerifyChecked[];
  missing: VerifyMissing[];
  note?: string;
  findings: FindingDraft[];
}
