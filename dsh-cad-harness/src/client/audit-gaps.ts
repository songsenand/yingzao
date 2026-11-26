// "What has not been run yet", derived from the delivery audit — pure.
//
// The audit's verdict answers "is this excluded"; it does NOT answer "which step
// did nobody run". That second answer is the one a person needs before shipping,
// and it is arithmetic over the audit's own fields: a failing CURRENT run, a
// newest version no run cites, runs superseded by newer ones, manifest nodes
// pinning older versions, a contract check older than the geometry, missing or
// stale visual reviews, mesh files nobody registered.
//
// WHY A MODULE: U19's exit is "点行跳对应 run". A row is useful only if it carries
// a target, and a target is a string a UI maps to a navigation. Both halves are
// testable here (`scripts/accept-audit-gaps.mjs`) without a browser: a synthetic
// audit with one of each gap proves the row COUNT, the TONE and the JUMP, and
// proves a jump only resolves when the target really exists.

/** The slice of the host audit this module reads (see src/host/delivery-audit.ts). */
export interface AuditValue {
  verdict: 'excluded' | 'difficult' | 'not-excluded';
  judgement?: string;
  summary: string;
  findings: { severity: 'blocked' | 'warn' | 'info'; code: string; detail: string }[];
  versions: { total: number; currentUncited: string[] };
  parts: { total: number };
  runs: {
    total: number;
    stale: { id: string; kind: string; status: string; superseded: string[] }[];
    failing: { id: string; kind: string; summary: string; current: boolean }[];
  };
  contract: {
    staleNodes: { name: string; version: string; newest: string }[];
    geometryNewerThanCheck: boolean;
    changedSinceCheck: boolean;
  };
  visual: { missing: { name: string; version: string }[]; stale: { name: string; version: string }[] };
  unregistered: { files: string[] };
}

export type GapTone = 'blocked' | 'warn' | 'info';

export interface AuditGap {
  tone: GapTone;
  /** Already-translated sentence. */
  text: string;
  /** `run:r012` or `version:v003` — absent when there is nothing to open. */
  jump?: string;
}

/** Translator shape (i18n's `tr`), injected so this module stays pure. */
export type Translate = (key: string, vars?: Record<string, string | number>) => string;

/**
 * The pending-work rows, worst first.
 *
 * Order is deliberate: a CURRENT failure outranks an uncited version, which
 * outranks superseded history. A list that leads with history reads as noise.
 */
export function auditGaps(value: AuditValue | null, t: Translate): AuditGap[] {
  if (!value) return [];
  const rows: AuditGap[] = [];
  for (const run of value.runs.failing.filter((entry) => entry.current)) {
    rows.push({ tone: 'blocked', text: t('ui.audit.failing', { id: run.id, kind: run.kind, summary: run.summary }), jump: `run:${run.id}` });
  }
  for (const version of value.versions.currentUncited) {
    rows.push({ tone: 'blocked', text: t('ui.audit.uncited', { version }), jump: `version:${version}` });
  }
  for (const stale of value.runs.stale) {
    rows.push({
      tone: 'warn',
      text: t('ui.audit.stale', { id: stale.id, kind: stale.kind, superseded: stale.superseded.join(', ') || '—' }),
      jump: `run:${stale.id}`,
    });
  }
  for (const node of value.contract.staleNodes ?? []) {
    rows.push({ tone: 'warn', text: t('ui.audit.staleNode', { name: node.name, version: node.version, newest: node.newest }), jump: `version:${node.newest}` });
  }
  if (value.contract.geometryNewerThanCheck) rows.push({ tone: 'warn', text: t('ui.audit.contractNewer') });
  if (value.contract.changedSinceCheck) rows.push({ tone: 'warn', text: t('ui.audit.contractChanged') });
  for (const missing of value.visual.missing) {
    rows.push({ tone: 'warn', text: t('ui.audit.visualMissing', { name: missing.name, version: missing.version }), jump: `version:${missing.version}` });
  }
  for (const stale of value.visual.stale) {
    rows.push({ tone: 'warn', text: t('ui.audit.visualStale', { name: stale.name, version: stale.version }), jump: `version:${stale.version}` });
  }
  if (value.unregistered.files.length > 0) {
    rows.push({ tone: 'info', text: t('ui.audit.unregistered', { count: value.unregistered.files.length }) });
  }
  return rows;
}

/** What a jump target resolves to, or null when nothing in the corpus owns it. */
export type AuditTarget =
  | { kind: 'run'; runId: string }
  | { kind: 'version'; partId: string; versionId: string };

/**
 * Resolve `run:r012` / `version:v003` against the live corpus.
 *
 * A row whose target no longer exists must NOT navigate somewhere arbitrary: the
 * audit can be a few seconds older than the corpus (a run retired, a version
 * pruned), and clicking into the wrong product is worse than doing nothing —
 * the reader would quote the wrong artifact's evidence.
 */
export function resolveAuditJump(
  jump: string,
  runs: readonly { id: string }[],
  parts: readonly { id: string; versions: readonly { id: string }[] }[],
): AuditTarget | null {
  const [kind, id] = jump.split(':');
  if (!id) return null;
  if (kind === 'run') return runs.some((run) => run.id === id) ? { kind: 'run', runId: id } : null;
  if (kind === 'version') {
    const owner = parts.find((part) => part.versions.some((version) => version.id === id));
    return owner ? { kind: 'version', partId: owner.id, versionId: id } : null;
  }
  return null;
}
