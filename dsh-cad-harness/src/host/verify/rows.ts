// The six coverage rows. Each row reads evidence; it never writes and never
// decides whether the design is good.

import { join } from 'node:path';
import type { DeliveryAudit } from '../delivery-audit.ts';
import { observeBrief, observeMake } from '../pearls/ledger.ts';
import { observeModel } from '../pearls/model.ts';
import { observeFit } from '../pearls/observe.ts';
import { checkClaim } from './freshness.ts';
import { listRuns } from '../runs.ts';
import {
  auditFindingDraft, briefFailureDraft, claimFindingDraft, evidenceMissingDraft,
  fitFindingDraft, makeFailureDraft, modelFailureDraft,
} from './findings.ts';
import { statusOfOutcomes } from './policy.ts';
import type { ClaimsLoadResult } from './claims.ts';
import type { LoadedVerifyProject } from './project.ts';
import type { FindingDraft, RowDraft, VerifyChecked, VerifyMissing, VerifyRowId, VerifyStatus } from './types.ts';

const LABELS: Record<VerifyRowId, string> = {
  requirements: 'requirements',
  model: 'model',
  fit: 'fit',
  make: 'make',
  review: 'review',
  delivery: 'delivery',
};

export const ROW_ORDER: VerifyRowId[] = ['requirements', 'model', 'fit', 'make', 'review', 'delivery'];

function statusFromDrafts(drafts: readonly FindingDraft[]): VerifyStatus {
  return statusOfOutcomes(drafts.map((d) => d.outcome));
}

function makeRow(
  id: VerifyRowId,
  status: VerifyStatus,
  findings: FindingDraft[],
  checked: VerifyChecked[] = [],
  missing: VerifyMissing[] = [],
  note?: string,
): RowDraft {
  return {
    id,
    label: LABELS[id],
    status,
    checked,
    missing,
    findings,
    ...(note ? { note } : {}),
  };
}

function checkedOf(runIds: readonly (string | undefined)[], kind: string): VerifyChecked[] {
  return runIds.filter((x): x is string => typeof x === 'string' && x.length > 0).map((runId) => ({ runId, kind }));
}

export interface EvaluateOptions {
  requireClaims: boolean;
  policyIssues?: string[];
  exceptionIssues?: string[];
}

export async function evaluateRows(
  project: LoadedVerifyProject,
  claims: ClaimsLoadResult,
  audit: DeliveryAudit | null,
  options: EvaluateOptions,
): Promise<RowDraft[]> {
  const rows: RowDraft[] = [];

  // requirements -----------------------------------------------------------
  {
    const findings: FindingDraft[] = [];
    let status: VerifyStatus = 'pass';
    const missing: VerifyMissing[] = [];
    if (claims.issues.length > 0) {
      status = 'blocked';
      for (const issue of claims.issues) {
        findings.push({
          row: 'requirements', code: 'claims-invalid', outcome: 'blocked', severity: 'blocked',
          what: issue, why: ['the claims file is not usable'], where: { kind: 'manifest', note: 'claims.json' },
          next: ['fix claims.json to {schemaVersion:1, claims:[...]}'],
        });
      }
    }
    if (claims.claims.length === 0 && claims.issues.length === 0) {
      if (options.requireClaims) {
        status = 'blocked';
        findings.push({
          row: 'requirements', code: 'claims-required', outcome: 'blocked', severity: 'blocked',
          what: 'no claims declared, but claims are required', why: ['a delivery needs a declared claim'],
          where: { kind: 'manifest', note: 'claims.json' }, next: ['write claims.json with what you intend to deliver'],
        });
        missing.push({ evidence: 'claims.json', why: 'claims are required', next: ['write claims.json'] });
      } else {
        status = 'warn';
        findings.push({
          row: 'requirements', code: 'no-claims-declared', outcome: 'warn', severity: 'info',
          what: 'no delivery claim declared; the corpus is audited only',
          why: ['without a claim, V1 cannot verify a delivery assertion'],
          where: { kind: 'manifest', note: 'claims.json' }, next: ['write claims.json when you intend to deliver'],
        });
        missing.push({ evidence: 'claims.json', why: 'no delivery claim declared', next: ['write claims.json'] });
        try {
          const brief = await observeBrief(project.root);
          for (const f of brief.failures) findings.push(briefFailureDraft(f));
        } catch { /* requirements is already warn */ }
      }
    }
    rows.push(makeRow('requirements', status, findings, [], missing, claims.claims.length === 0 ? 'corpus audit only' : `${claims.claims.length} claim(s)`));
  }

  // model ------------------------------------------------------------------
  {
    const findings: FindingDraft[] = [];
    if (!project.assembly) {
      const what = project.issues.length ? project.issues.join('; ') : 'assembly/assembly.json is missing or invalid';
      findings.push(evidenceMissingDraft('model', 'model.contract-invalid', what));
    } else {
      try {
        const obs = await observeModel(project.root);
        findings.push(...obs.failures.map(modelFailureDraft));
        if (obs.issues.length > 0 && obs.failures.length === 0) {
          findings.push(evidenceMissingDraft('model', 'model.contract-invalid', obs.issues.join('; ')));
        }
      } catch (e) {
        findings.push(evidenceMissingDraft('model', 'model.contract-invalid', `model check failed: ${String((e as Error)?.message ?? e)}`));
      }
    }
    if (project.issues.length > 0 && project.assembly) {
      findings.push({
        row: 'model', code: 'project-issue', outcome: 'warn', severity: 'warn',
        what: project.issues.join('; '), why: ['a read-only project dependency failed'],
        where: { kind: 'manifest', note: 'project' }, next: ['inspect the project/corpus paths'],
      });
    }
    rows.push(makeRow('model', findings.length ? statusFromDrafts(findings) : 'pass', findings));
  }

  // fit --------------------------------------------------------------------
  {
    const findings: FindingDraft[] = [];
    const checked: VerifyChecked[] = [];
    const missing: VerifyMissing[] = [];
    if (!project.hasRuns) {
      missing.push({ evidence: 'fresh assembly/assembly-check runs', why: 'no run store or no runs', next: ['run validate_assembly and check_assembly'] });
      rows.push(makeRow('fit', 'unobserved', findings, checked, missing, 'no runs'));
    } else {
      try {
        const obs = await observeFit(join(project.root, 'cad-data'), {
          template: 'static',
          requireUndeclaredZero: project.undeclaredPolicy === 'block',
          explainedUndeclared: project.undeclaredExplanations,
        });
        for (const f of obs.findings) findings.push(fitFindingDraft(f, obs.failures.find((x) => x.code === f.code)));
        checked.push(...checkedOf([obs.sourceRuns.assembly], 'assembly'));
        checked.push(...checkedOf([obs.sourceRuns.contract], 'assembly-check'));
        if (!obs.coverage.interference) missing.push({ evidence: 'fresh validate_assembly run', why: 'interference evidence is missing', next: ['run validate_assembly'] });
        if (!obs.coverage.interfaces) missing.push({ evidence: 'fresh check_assembly run with declared interfaces', why: 'interface evidence is missing', next: ['declare interfaces and run check_assembly'] });
        let status = findings.length ? statusFromDrafts(findings) : 'pass';
        if (obs.status === 'blocked' && !findings.some((d) => d.outcome === 'blocked')) status = 'blocked';
        if (obs.status === 'fail' && !findings.some((d) => d.outcome === 'fail')) status = 'fail';
        rows.push(makeRow('fit', status, findings, checked, missing));
      } catch (e) {
        findings.push(evidenceMissingDraft('fit', 'missing-assembly', `fit check failed: ${String((e as Error)?.message ?? e)}`));
        rows.push(makeRow('fit', 'blocked', findings, checked, missing));
      }
    }
  }

  // make -------------------------------------------------------------------
  {
    const findings: FindingDraft[] = [];
    const checked: VerifyChecked[] = [];
    const missing: VerifyMissing[] = [];
    if (!project.hasCorpus) {
      missing.push({ evidence: 'a version/run corpus', why: 'cad-data/ is missing', next: ['create evidence with the CAD tools'] });
      rows.push(makeRow('make', 'unobserved', findings, checked, missing, 'no corpus'));
    } else {
      try {
        const entry = await observeMake(project.root, project.make ?? undefined);
        const noParts = entry.failures.some((f) => f.code === 'make.no-parts');
        if (noParts) {
          rows.push(makeRow('make', 'unobserved', findings, checked, missing, 'no printed parts'));
        } else {
          findings.push(...entry.failures.map(makeFailureDraft));
          const reports = entry.evidence?.reports as Record<string, { run?: string }> | undefined;
          if (reports) for (const r of Object.values(reports)) checked.push(...checkedOf([r?.run], 'printability'));
          let status = findings.length ? statusFromDrafts(findings) : 'pass';
          if (entry.status === 'unobserved' && findings.length === 0) {
            status = 'unobserved';
            missing.push({ evidence: 'fresh printability run for the current printed parts', why: 'no evidence found', next: ['run check_printability'] });
          }
          rows.push(makeRow('make', status, findings, checked, missing, entry.note));
        }
      } catch (e) {
        findings.push(evidenceMissingDraft('make', 'make.no-evidence', `make check failed: ${String((e as Error)?.message ?? e)}`));
        rows.push(makeRow('make', 'blocked', findings, checked, missing));
      }
    }
  }

  // review -----------------------------------------------------------------
  {
    const findings: FindingDraft[] = [];
    const missing: VerifyMissing[] = [];
    if (!audit) {
      findings.push(evidenceMissingDraft('review', 'verify.audit-failed', 'the delivery audit could not run'));
      rows.push(makeRow('review', 'blocked', findings));
    } else if (!audit.visual.required) {
      rows.push(makeRow('review', 'unobserved', findings, [], [], 'visual review disabled by policy'));
    } else {
      for (const f of audit.findings.filter((x) => x.code.startsWith('visual-review-'))) {
        findings.push(auditFindingDraft(f, 'review'));
      }
      for (const m of audit.visual.missing) {
        missing.push({ evidence: `top+iso review for ${m.name} ${m.version}`, why: 'no visual-review record', next: [`review_visual(${m.version})`] });
      }
      for (const s of audit.visual.stale) {
        missing.push({ evidence: `fresh review for ${s.name} ${s.version}`, why: `review predates the version (${s.reviewedAt ?? 'unknown'})`, next: [`review_visual(${s.version})`] });
      }
      const status: VerifyStatus = audit.visual.missing.length > 0 || audit.visual.stale.length > 0
        ? 'blocked'
        : audit.visual.checked > 0 ? 'pass' : 'unobserved';
      rows.push(makeRow('review', status, findings, [], missing, audit.visual.checked > 0 ? `${audit.visual.checked} reviewed` : undefined));
    }
  }

  // delivery ---------------------------------------------------------------
  {
    const findings: FindingDraft[] = [];
    const checked: VerifyChecked[] = [];
    const missing: VerifyMissing[] = [];
    if (!audit) {
      findings.push(evidenceMissingDraft('delivery', 'verify.audit-failed', 'the delivery audit could not run'));
    } else {
      findings.push(...audit.findings.filter((x) => !x.code.startsWith('visual-review-') && x.code !== 'no-claims-declared').map((f) => auditFindingDraft(f, 'delivery')));
      for (const [kind, run] of Object.entries(audit.runs.latestByKind ?? {})) {
        checked.push(...checkedOf([run?.id], kind));
      }
      if (project.rulepackWarning) {
        findings.push({
          row: 'delivery', code: 'rulepack-unreadable', outcome: 'warn', severity: 'warn',
          what: project.rulepackWarning, why: ['the optional rule pack could not be loaded'],
          where: { kind: 'manifest', note: 'pearl-profile.json / rulepack' }, next: ['fix the rule pack path or remove it'],
        });
      }
      if (options.policyIssues?.length) {
        findings.push({
          row: 'delivery', code: 'policy-invalid', outcome: 'warn', severity: 'warn',
          what: options.policyIssues.join('; '), why: ['the policy file could not be used; V1 is advisory'],
          where: { kind: 'manifest', note: 'evidence-policy.json' }, next: ['fix the policy file or use CLI flags'],
        });
      }
      if (options.exceptionIssues?.length) {
        findings.push({
          row: 'delivery', code: 'exceptions-invalid', outcome: 'warn', severity: 'warn',
          what: options.exceptionIssues.join('; '), why: ['the exception file could not be fully read'],
          where: { kind: 'manifest', note: 'evidence-exceptions.json' }, next: ['fix the exception file'],
        });
      }
    }

    // Explicit claim witnesses (kind-level per-part manufacturability stays with the audit).
    if (audit) {
      const runList = project.stores ? await listRuns(project.stores.runStore) : [];
      for (const claim of claims.claims) {
        // A check-backed claim is owned by the custom-check run; do not also
        // judge it by run-kind.
        if (claim.checkId) continue;
        const res = checkClaim(claim, runList, project.currentVersionSet, project.versionTimes);
        if (!res.checked) continue;
        if (res.ok) {
          if (res.run) checked.push({ runId: res.run.id, kind: res.run.kind });
        } else {
          findings.push(claimFindingDraft(res.code ?? 'claim-without-witness', res.detail ?? 'claim is not evidenced', claim));
          missing.push({
            evidence: `${claim.kind} witness for "${claim.statement}"`,
            why: res.detail ?? 'no fresh witness',
            next: ['run the required check and cite its run id'],
          });
        }
      }
    }

    const status = findings.length ? statusFromDrafts(findings) : 'pass';
    rows.push(makeRow('delivery', status, findings, checked, missing, claims.claims.length === 0 ? 'corpus audit only' : undefined));
  }

  if (rows.length !== ROW_ORDER.length) throw new Error(`verify: expected ${ROW_ORDER.length} rows, got ${rows.length}`);
  return rows;
}
