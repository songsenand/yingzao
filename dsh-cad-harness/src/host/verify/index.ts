// V1 entry point: read-only evidence verification.
//
// Everything here is a read: no CAD tool is called, no run is written, no
// contract is written. The report is returned to the caller; the CLI decides
// whether to print it / write it with --out.

import { auditDelivery, type DeliveryAudit } from '../delivery-audit.ts';
import { loadVerifyProject } from './project.ts';
import { loadClaims, toDeliveryClaims } from './claims.ts';
import { applyExceptions, applyPolicy, exitCodeFor, loadExceptions, loadPolicy, resolveMode, statusOfOutcomes } from './policy.ts';
import { evaluateRows } from './rows.ts';
import { assembleReport } from './report.ts';
import type { FindingDraft, VerifyOptions, VerifyReport } from './types.ts';

export interface VerifyResult {
  report: VerifyReport;
  exitCode: number;
  mode: 'advisory' | 'blocking';
}

export async function verify(options: VerifyOptions): Promise<VerifyResult> {
  const project = await loadVerifyProject(options.projectRoot, { rulepack: options.rulepack });
  const claims = await loadClaims(project.root, options.claimsPath);
  const policy = await loadPolicy(project.root, options.policyPath);
  const exceptions = await loadExceptions(project.root, policy.policy, policy.path);

  const mode = resolveMode(options, policy.policy);
  const requireClaims = options.requireClaims === true || policy.policy?.requireClaims === true;

  let audit: DeliveryAudit | null = null;
  if (project.stores) {
    try {
      audit = await auditDelivery(project.stores, {
        claims: toDeliveryClaims(claims.claims),
        visualReview: 'required',
      });
    } catch {
      audit = null;
    }
  }

  const rows = await evaluateRows(project, claims, audit, {
    requireClaims,
    policyIssues: policy.issues,
    exceptionIssues: exceptions.issues,
  });

  const drafts: FindingDraft[] = rows.flatMap((r) => r.findings);
  if (!project.hasCorpus) {
    const delivery = rows.find((r) => r.id === 'delivery');
    if (delivery) {
      const draft: FindingDraft = {
        row: 'delivery',
        code: 'verify.project-missing',
        outcome: 'blocked',
        severity: 'blocked',
        what: `no cad-data/ corpus under ${project.root}`,
        why: ['V1 needs a version/run corpus; there is nothing to verify'],
        where: { kind: 'manifest', note: project.root },
        next: ['select the project root that contains cad-data/ and assembly/assembly.json'],
      };
      delivery.findings.push(draft);
      drafts.push(draft);
    }
  }

  applyPolicy(drafts, policy.policy);
  const exceptionResult = applyExceptions(drafts, exceptions.exceptions, project.root);

  for (const id of exceptionResult.expired) {
    const e = exceptions.exceptions.find((x) => x.id === id);
    if (!e) continue;
    const target = rows.find((r) => r.findings.some((f) => f.code === e.finding))
      ?? rows.find((r) => r.id === 'delivery');
    if (!target) continue;
    const draft: FindingDraft = {
      row: target.id,
      code: 'exception-expired',
      outcome: 'info',
      severity: 'info',
      what: `exception ${e.id} expired at ${e.expiresAt}`,
      why: ['an exception is not permanent; the finding returns to blocked'],
      where: { kind: 'manifest', note: 'evidence-exceptions.json' },
      next: ['renew the exception with a new expiry, or fix the finding'],
    };
    target.findings.push(draft);
    drafts.push(draft);
  }

  // Recompute only rows whose findings changed meaning; a row that was
  // `unobserved` because nothing ran must not become `pass` just because it has
  // no findings.
  for (const row of rows) {
    const outcomes = row.findings.map((f) => f.outcome);
    if (outcomes.some((o) => o === 'blocked' || o === 'fail' || o === 'warn')) {
      row.status = statusOfOutcomes(outcomes);
    }
  }

  const report = assembleReport({
    project,
    rows,
    claimsHash: claims.hash,
    policySource: policy.source === 'file' ? 'file' : (options.block || options.advisory || options.requireClaims) ? 'flags' : 'none',
    policyMode: mode,
    policy: policy.policy,
    ...(policy.hash ? { policyHash: policy.hash } : {}),
    exceptions: exceptionResult.applied,
  });

  return { report, exitCode: exitCodeFor(report, mode, options.strict === true), mode };
}
