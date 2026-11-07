// V1 entry point: read-only evidence verification.
//
// Everything here is a read: no CAD tool is called, no run is written, no
// contract is written. The report is returned to the caller; the CLI decides
// whether to print it / write it with --out.

import { join, resolve } from 'node:path';
import { auditDelivery, type DeliveryAudit } from '../delivery-audit.ts';
import { loadVerifyProject } from './project.ts';
import { loadClaims, toDeliveryClaims } from './claims.ts';
import { applyExceptions, applyPolicy, exitCodeFor, loadExceptions, loadPolicy, resolveMode, statusOfOutcomes } from './policy.ts';
import { evaluateRows } from './rows.ts';
import { assembleReport } from './report.ts';
import { checkClaimByCheck, checkFindingDrafts, checkSummary, loadChecks, runChecks } from './checks.ts';
import { claimFindingDraft } from './findings.ts';
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

  // Custom checks are opt-in: no directory is read unless asked for. A check
  // that cannot pass its own negative sample is `invalid`, never silently green.
  const checksEnabled = (options.checks === true || !!options.checksDir || options.mountChecks === true)
    && options.noChecks !== true;
  const checksRoot = checksEnabled
    ? (options.checksDir ? resolve(options.checksDir) : join(project.root, 'checks'))
    : null;
  const loadedChecks = checksEnabled
    ? await loadChecks(checksRoot, { explicit: !!options.checksDir })
    : { root: null, checks: [], issues: [] };
  const runs = checksEnabled
    ? await runChecks(loadedChecks.checks, project, claims.claims, { mountOnly: options.mountChecks === true })
    : [];
  const blockCustom = (policy.policy?.blockOn ?? []).includes('custom-check');

  for (const run of runs) {
    const row = rows.find((r) => r.id === run.check.row);
    if (!row) continue;
    row.findings.push(...checkFindingDrafts(run, { block: blockCustom }));
    if (run.status === 'pending') {
      row.missing.push({
        evidence: `check:${run.check.id}`,
        why: options.mountChecks ? 'mounted; run verify after drawing' : 'awaiting geometry',
        next: ['draw the geometry, then run verify'],
      });
    } else if (run.status === 'invalid') {
      row.missing.push({
        evidence: `check:${run.check.id}`,
        why: run.check.error ?? 'not mountable',
        next: ['fix the check manifest/entry/negative sample'],
      });
    } else {
      row.checked.push({ kind: `check:${run.check.id}@${run.check.version}` });
    }
  }
  for (const issue of loadedChecks.issues) {
    const delivery = rows.find((r) => r.id === 'delivery');
    if (!delivery) continue;
    delivery.findings.push({
      row: 'delivery',
      code: 'check-root',
      outcome: 'warn',
      severity: 'warn',
      what: issue,
      why: ['the checks directory could not be fully loaded'],
      where: { kind: 'manifest', note: checksRoot ?? 'checks' },
      next: ['fix the checks path or the check manifests'],
    });
  }

  // A claim with `checkId` is witnessed by that check, not by a run kind.
  const deliveryRow = rows.find((r) => r.id === 'delivery');
  for (const claim of claims.claims) {
    if (!claim.checkId) continue;
    const res = checkClaimByCheck(claim, runs, project.currentVersionSet);
    if (res.ok) {
      deliveryRow?.checked.push({ kind: `check:${claim.checkId}` });
    } else {
      deliveryRow?.findings.push(
        claimFindingDraft(res.code ?? 'claim-check-missing', res.detail ?? 'check claim is not witnessed', claim),
      );
      deliveryRow?.missing.push({
        evidence: `check:${claim.checkId}`,
        why: res.detail ?? 'no check witness',
        next: ['fix or run the check, then re-run verify --checks'],
      });
    }
  }

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
    checks: runs.map(checkSummary),
  });

  return { report, exitCode: exitCodeFor(report, mode, options.strict === true), mode };
}
