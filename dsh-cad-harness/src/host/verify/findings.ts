// Adapters: tool/observer output -> one finding shape. Each adapter is the
// only place that knows that tool's vocabulary; the rows and report never do.

import type { AuditFinding } from '../delivery-audit.ts';
import type { PearlFailure, SpatialLocation } from '../pearls/failure.ts';
import type { FitObservation } from '../pearls/observe.ts';
import type { FindingDraft, VerifyOutcome, VerifyRowId, VerifySeverity, VerifyWhere } from './types.ts';
import { categoryOf } from './policy.ts';

export function severityOf(outcome: VerifyOutcome): VerifySeverity {
  if (outcome === 'blocked' || outcome === 'fail') return 'blocked';
  if (outcome === 'warn') return 'warn';
  return 'info';
}

export interface WhyNext {
  why: string[];
  next: string[];
}

export function whyNext(code: string): WhyNext {
  switch (code) {
    case 'visual-review-missing':
      return {
        why: ['a printed part has no top+iso review record', 'the review was never run, or the record was lost'],
        next: ['review_visual(versionId) with top+iso and a note', 're-run the delivery audit'],
      };
    case 'visual-review-stale':
      return {
        why: ['the review record predates the current version', 'the part was revised after it was reviewed'],
        next: ['review_visual(versionId) again on the current version'],
      };
    case 'unregistered-geometry':
      return {
        why: ['a mesh exists on disk with no version accounting for it', 'it was written directly instead of through generate_part/import_part'],
        next: ['import_part or generate_part to register it', 'or exempt it with a reason'],
      };
    case 'stale-evidence':
      return {
        why: ['a run cites a version that has since been replaced', 'the check was not re-run after the edit'],
        next: ['re-run the affected check on the current version'],
      };
    case 'stale-contract':
      return {
        why: [
          'the contract check and the assembly run cite different version sets',
          'one side is stale, or a flexible part is intentionally omitted from static assembly',
        ],
        next: [
          'reconcile the version sets and re-run check_assembly',
          'or declare the omitted part in assembly/static-scope.json',
        ],
      };
    case 'failing-printability':
    case 'latest-printability-failing':
      return {
        why: ['the printability run failed; the current design has an unresolved blocker'],
        next: ['inspect the min-wall/overhang location', 'fix it and re-run check_printability'],
      };
    case 'duplicate-runs':
      return {
        why: ['the same check ran on the same geometry with the same outcome'],
        next: ['cite one run; spend the time on a different check'],
      };
    case 'overlay-backed-runs':
      return {
        why: ['the run used user-overlay packages; reproducibility depends on the same overlay'],
        next: ['record or pin the overlay for CI'],
      };
    case 'role-exempt-parts':
      return {
        why: ['parts declared stock/research are exempt from printability and newest-version checks'],
        next: ['keep the role current; set it back to printed if it is delivered printed'],
      };
    case 'versions-never-cited':
      return {
        why: ['a version is not used by any run', 'it may be an experiment or a superseded draft'],
        next: ['run the check on it, or remove it from the corpus'],
      };
    case 'merged-stale':
      return {
        why: ['a merged body was built from versions a part has since replaced'],
        next: ['rebuild the merge from the current versions'],
      };
    case 'contract-without-motion':
      return {
        why: ['the assembly declares interfaces but no motion-clearance interface', 'a multi-part mechanism may need motion evidence'],
        next: ['add a motion-clearance interface with a cited motion run, or explain why motion does not apply'],
      };
    case 'evidence-predates-geometry':
      return {
        why: ['the declared interface evidence is older than the geometry it cites'],
        next: ['re-run check_assembly after the geometry change'],
      };
    case 'contract-stale-nodes':
      return {
        why: ['the assembly manifest cites a version that is no longer the newest for its part'],
        next: ['update the contract to the current version and re-run check_assembly'],
      };
    case 'claim-without-evidence':
      return {
        why: ['the claim has no fresh run of the kind it needs', 'the claim may be true but unproven'],
        next: ['run the required check on the current versions', 'then declare the claim with its run id'],
      };
    case 'claim-run-missing':
      return {
        why: ['the claim cites a run id that is not in the run store'],
        next: ['cite an existing run id, or run the check again'],
      };
    case 'claim-run-stale':
      return {
        why: ['the cited run cites a version set that is not current', 'the geometry changed after the run'],
        next: ['re-run the check on the current versions and cite the new run'],
      };
    case 'claim-run-unverifiable':
      return {
        why: ['the run or a cited version has no usable timestamp'],
        next: ['record the version timestamp, or re-run the check'],
      };
    case 'claim-kind-mismatch':
      return {
        why: ['the cited run kind does not produce the evidence the claim needs'],
        next: ['cite a run of the required kind'],
      };
    case 'claim-check-missing':
      return {
        why: ['the claim cites a custom check that is not mounted'],
        next: ['write checks/<id>/ and run verify --checks', 'or remove checkId from the claim'],
      };
    case 'claim-check-unregistered':
      return {
        why: ['the claim cites a check that is not in checks/registry.json'],
        next: ['run node scripts/check-register.mjs <project> --id <id>', 'or remove checkId from the claim'],
      };
    case 'claim-check-modified':
      return {
        why: ['the check changed after it was registered; the hash no longer matches'],
        next: ['review the change, then --unregister and register again'],
      };
    case 'claim-check-late':
      return {
        why: ['the check was registered after the current version, so it is advisory only'],
        next: ['register before the next version if you want it as a witness'],
      };
    case 'claim-check-invalid':
      return {
        why: ['the cited custom check did not pass its own negative sample'],
        next: ['fix the check manifest/entry/negative sample'],
      };
    case 'claim-check-pending':
      return {
        why: ['the check is mounted but has no geometry to run on'],
        next: ['draw the geometry, then run verify without --mount-checks'],
      };
    case 'claim-check-failed':
      return {
        why: ['the custom check declared a criterion and it is not met'],
        next: ['inspect the check witness', 'fix the design or the declared criterion'],
      };
    case 'claim-check-blocked':
      return {
        why: ['the custom check could not evaluate its criterion'],
        next: ['inspect the check output and its inputs'],
      };
    case 'claim-check-error':
      return {
        why: ['the custom check crashed or returned an invalid report'],
        next: ['fix the check code', 're-run verify --checks'],
      };
    case 'claim-check-stale':
      return {
        why: ['the claim cites versions that are not the current set'],
        next: ['re-run the check on the current versions, or update the claim'],
      };
    case 'claim-check-mutated':
      return {
        why: ['the check wrote to the project, so its evidence was discarded'],
        next: ['remove the write (use a temp dir for outputs)', 're-run verify --checks'],
      };
    case 'interference':
      return {
        why: ['two solids overlap at the current placement', 'the pose is wrong, or the clearance is smaller than the mesh residual'],
        next: ['open the pair report and inspect the witness', 'change the pose/geometry and re-run validate_assembly'],
      };
    case 'hard-interface':
      return {
        why: ['a declared interface is outside its tolerance', 'the datum or placement is wrong'],
        next: ['open the failing interface row and inspect the measured value'],
      };
    case 'undeclared-adjacency':
      return {
        why: ['a contact pair is not declared in the assembly contract', 'the adjacency threshold may be broader than the intent'],
        next: ['declare the structural joints, or explain the contact in the rule pack'],
      };
    case 'no-declared-interfaces':
      return {
        why: ['the contract has no interfaces, so "0 hard violations" is vacuous'],
        next: ['declare interfaces in assembly.json and re-run check_assembly'],
      };
    case 'missing-assembly':
      return { why: ['no assembly run exists'], next: ['run validate_assembly'] };
    case 'missing-contract':
      return { why: ['no assembly-check run exists'], next: ['run check_assembly'] };
    case 'model.contract-invalid':
      return {
        why: ['the manifest, a cited version, or a datum endpoint does not resolve'],
        next: ['fix the manifest or the version/datum it cites', 're-run the model check'],
      };
    case 'make.printability':
      return {
        why: ['wall/overhang is below the declared process profile', 'the print orientation is not declared'],
        next: ['inspect the reported min-wall/overhang location', 'change orientation/profile or declare an exemption'],
      };
    case 'make.stock':
      return {
        why: ['the rough part is larger than the declared stock'],
        next: ['shrink the part or declare a larger stock'],
      };
    case 'make.coverage':
      return { why: ['a current part has no printability run'], next: ['run check_printability on the current version'] };
    case 'make.no-cutlist':
      return { why: ['no wood cutlist was produced'], next: ['produce assembly/cutlist.json'] };
    case 'make.no-stock':
      return { why: ['the rule pack declares no stock size'], next: ['declare stockMm in the rule pack'] };
    case 'make.no-evidence':
      return { why: ['no printability run exists for the current printed parts'], next: ['run check_printability'] };
    case 'brief.missing':
      return { why: ['no requirements artifact was written down'], next: ['write PROMPT.md or claims.json'] };
    case 'no-claims-declared':
      return {
        why: ['no delivery claim was declared', 'the corpus is audited, but no delivery assertion is verified'],
        next: ['write claims.json when you intend to deliver'],
      };
    case 'rulepack-unreadable':
      return {
        why: ['the optional rule pack could not be loaded'],
        next: ['fix the rule pack path or remove it'],
      };
    case 'exception-expired':
      return {
        why: ['a recorded exception passed its expiry date'],
        next: ['renew the exception with a new expiry, or fix the finding'],
      };
    default:
      return {
        why: ['the finding evidence did not match a known rule'],
        next: ['inspect the finding evidence', 'fix the cause and re-run the check'],
      };
  }
}

export function whereFromLocation(location: SpatialLocation | undefined): VerifyWhere {
  if (!location) return { kind: 'unknown' };
  if (location.kind === 'pair' || location.kind === 'interface') {
    return {
      kind: location.kind,
      ...(location.parts ? { parts: location.parts } : {}),
      ...(location.center ? { center: location.center } : {}),
      ...(location.note ? { note: location.note } : {}),
    };
  }
  if (location.kind === 'part') {
    return {
      kind: 'part',
      ...(location.parts ? { parts: location.parts } : {}),
      ...(location.point ? { point: location.point } : {}),
      ...(location.note ? { note: location.note } : {}),
    };
  }
  if (location.kind === 'manifest') return { kind: 'manifest', ...(location.note ? { note: location.note } : {}) };
  return { kind: 'unknown', ...(location.note ? { note: location.note } : {}) };
}

export function auditFindingDraft(f: AuditFinding, row: VerifyRowId): FindingDraft {
  const outcome: VerifyOutcome = f.severity === 'blocked' ? 'blocked' : f.severity === 'warn' ? 'warn' : 'info';
  const meta = whyNext(f.code);
  return {
    row,
    code: f.code,
    outcome,
    severity: severityOf(outcome),
    what: f.detail,
    why: meta.why,
    where: { kind: 'manifest' },
    next: meta.next,
  };
}

const FIT_DESIGN_CODES = new Set(['interference', 'hard-interface']);

export function fitFindingDraft(
  f: FitObservation['findings'][number],
  failure: PearlFailure | undefined,
): FindingDraft {
  const outcome: VerifyOutcome = f.severity === 'hard'
    ? (FIT_DESIGN_CODES.has(f.code) ? 'fail' : 'blocked')
    : f.severity === 'warn' ? 'warn' : 'info';
  const meta = whyNext(f.code);
  return {
    row: 'fit',
    code: f.code,
    outcome,
    severity: severityOf(outcome),
    what: f.message,
    why: meta.why,
    where: whereFromLocation(failure?.location),
    next: meta.next,
    ...(f.witness ? { witness: f.witness } : {}),
  };
}

export function makeFailureDraft(f: PearlFailure): FindingDraft {
  const isMissing = f.code.startsWith('make.no-');
  const outcome: VerifyOutcome = isMissing ? 'blocked' : f.severity === 'warn' ? 'warn' : 'fail';
  return {
    row: 'make',
    code: f.code,
    outcome,
    severity: severityOf(outcome),
    what: f.what,
    why: f.why,
    where: whereFromLocation(f.location),
    next: f.next,
    ...(Object.keys(f.evidence ?? {}).length ? { witness: f.evidence } : {}),
  };
}

export function modelFailureDraft(f: PearlFailure): FindingDraft {
  return {
    row: 'model',
    code: f.code,
    outcome: 'blocked',
    severity: 'blocked',
    what: f.what,
    why: f.why,
    where: whereFromLocation(f.location),
    next: f.next,
    ...(Object.keys(f.evidence ?? {}).length ? { witness: f.evidence } : {}),
  };
}

export function briefFailureDraft(f: PearlFailure): FindingDraft {
  return {
    row: 'requirements',
    code: f.code,
    outcome: 'warn',
    severity: 'warn',
    what: f.what,
    why: f.why,
    where: whereFromLocation(f.location),
    next: f.next,
  };
}

export function claimFindingDraft(
  code: string,
  detail: string,
  claim: { statement: string; runId?: string; checkId?: string; versionIds?: string[] },
): FindingDraft {
  const meta = whyNext(code);
  return {
    row: 'delivery',
    code,
    outcome: 'blocked',
    severity: 'blocked',
    what: `${claim.statement}: ${detail}`,
    why: meta.why,
    where: { kind: 'unknown' },
    next: meta.next,
    witness: {
      ...(claim.runId ? { runId: claim.runId } : {}),
      ...(claim.checkId ? { checkId: claim.checkId } : {}),
      ...(claim.versionIds ? { versionIds: claim.versionIds } : {}),
    },
  };
}

export function evidenceMissingDraft(
  row: VerifyRowId,
  code: string,
  what: string,
  witness?: Record<string, unknown>,
): FindingDraft {
  const meta = whyNext(code);
  return {
    row,
    code,
    outcome: 'blocked',
    severity: 'blocked',
    what,
    why: meta.why,
    where: { kind: 'manifest' },
    next: meta.next,
    ...(witness ? { witness } : {}),
  };
}

/** Re-export for rows that want the same category table. */
export { categoryOf };
