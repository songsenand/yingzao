// Observe the model pearl: does the project have a schema-valid assembly
// contract whose versions and datum endpoints resolve? This is deliberately
// narrower than fit: an empty contract is still a valid model artifact; fit is
// the pearl that judges whether it covers the joints.

import { projectStores } from '../project.ts';
import { inspectAssemblyContract } from '../write-assembly.ts';
import { manifestLocation, type PearlFailure } from './failure.ts';

export interface ModelObservation {
  pearl: 'model';
  status: 'pass' | 'blocked';
  manifestPath: string;
  counts: { children: number; interfaces: number } | null;
  issues: string[];
  /** Reader-facing drift; never blocks. The version store is authoritative. */
  warnings: string[];
  failures: PearlFailure[];
}

export async function observeModel(projectRoot: string): Promise<ModelObservation> {
  const project = projectStores(projectRoot);
  const inspection = await inspectAssemblyContract(project);
  const failures: PearlFailure[] = inspection.issues.map((issue) => ({
    code: 'model.contract-invalid',
    severity: 'hard',
    what: issue,
    why: ['manifest schema, child version, or datum endpoint does not resolve', 'contract may predate the current geometry'],
    location: manifestLocation(inspection.manifestPath, 'contract/invalid endpoint; no single geometric point'),
    evidence: { manifestPath: inspection.manifestPath, issue },
    next: ['fix the assembly manifest or the version/datum it cites', 're-run model/assembly'],
  }));
  return {
    pearl: 'model',
    status: inspection.issues.length ? 'blocked' : 'pass',
    manifestPath: inspection.manifestPath,
    counts: inspection.counts,
    issues: inspection.issues,
    warnings: inspection.warnings ?? [],
    failures,
  };
}
