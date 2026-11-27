// designException — a signed design decision for a load-bearing thin wall.
//
// WHY THIS EXISTS (2026-11-27): the handwheel's 0.8 mm hub wall is on the crank
// torque path. The first review note called it "decorative/non-load-bearing" and
// closed it; it was neither. A numeric stress run cannot decide it either (isotropic
// model, no layer adhesion/fatigue). The decision is a DESIGN decision, so the agent
// must stop and write it down: load case, why this dimension, why not larger,
// residual risk, inspection. The agent may sign it itself — the point is attention,
// not approval — but a blank or boilerplate signature is invalid, and the summary
// must be reported to the user.
//
// The hard edge is `whyNotLarger`: if the agent cannot name a concrete conflict that
// a larger wall would cause, the design must change. "none"/"没有"/"不影响" is invalid.

export interface DesignException {
  featureId: string;
  versionId: string;
  measuredMm: number;
  requiredMm: number;
  loadCase: string;
  whyThisDimension: string;
  whyNotLarger: string;
  residualRisk: string;
  inspection: string;
  userSummary: string;
  reportedToUser: boolean;
  signedBy: 'agent' | 'user';
}

const NONE_WORDS = new Set(['none', 'no', 'n/a', 'na', '-', '没有', '无', '不影响', '没影响', '不冲突', 'nothing']);

function text(v: unknown, min = 12): boolean {
  return typeof v === 'string' && v.trim().length >= min;
}

/** Issues that make the signature invalid. Empty = valid. */
export function validateDesignException(value: unknown, currentVersionId?: string): string[] {
  const issues: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['designException must be an object'];
  const e = value as Partial<DesignException>;
  if (!text(e.featureId, 3)) issues.push('featureId is required');
  if (!text(e.versionId, 2)) issues.push('versionId is required');
  if (currentVersionId && e.versionId !== currentVersionId) {
    issues.push(`versionId ${String(e.versionId)} is not the scanned version ${currentVersionId}`);
  }
  if (typeof e.measuredMm !== 'number' || !Number.isFinite(e.measuredMm) || e.measuredMm <= 0) {
    issues.push('measuredMm must be a positive number');
  }
  if (typeof e.requiredMm !== 'number' || !Number.isFinite(e.requiredMm) || e.requiredMm <= 0) {
    issues.push('requiredMm must be a positive number');
  }
  if (typeof e.measuredMm === 'number' && typeof e.requiredMm === 'number' && e.measuredMm >= e.requiredMm) {
    issues.push(`measuredMm ${e.measuredMm} is not below requiredMm ${e.requiredMm} — no exception is needed`);
  }
  if (!text(e.loadCase, 3)) issues.push('loadCase is required (a force/torque, not a word)');
  if (!text(e.whyThisDimension)) issues.push('whyThisDimension is required (the constraint that sets this dimension)');
  if (!text(e.whyNotLarger)) {
    issues.push('whyNotLarger is required (the concrete conflict a larger wall would cause)');
  } else if (NONE_WORDS.has(e.whyNotLarger!.trim().toLowerCase())) {
    issues.push('whyNotLarger is "none" — if nothing blocks a larger wall, enlarge it; the exception is invalid');
  }
  if (!text(e.residualRisk)) issues.push('residualRisk is required (failure mode + consequence)');
  if (!text(e.inspection)) issues.push('inspection is required (how the delivery check catches it)');
  if (!text(e.userSummary)) issues.push('userSummary is required (one sentence the user will see)');
  if (e.reportedToUser !== true) issues.push('reportedToUser must be true — a reason buried in JSON is not a report');
  if (e.signedBy !== 'agent' && e.signedBy !== 'user') issues.push('signedBy must be "agent" or "user"');
  return issues;
}

/** The hard message the scan returns when no valid exception is supplied. */
export function thinWallBlockMessage(input: {
  featureId: string;
  atMm: number[];
  measuredMm: number;
  requiredMm: number;
  policy: string;
}): string {
  return [
    'BLOCKED — load-bearing thin wall. This is a DESIGN decision, not a meshing problem.',
    `  feature: ${input.featureId} @ [${input.atMm.map((v) => v.toFixed(2)).join(', ')}]`,
    `  measured: ${input.measuredMm.toFixed(2)} mm; required: ${input.requiredMm.toFixed(2)} mm (${input.policy})`,
    'You may sign this yourself, but a signature must answer all five:',
    '  loadCase, whyThisDimension, whyNotLarger (a concrete conflict; "none" is invalid),',
    '  residualRisk, inspection — plus a userSummary that MUST appear in your reply.',
    'A finer mesh or a submodel does NOT replace this decision.',
    'Pass the fields as `designException` to record the decision, or change the design.',
  ].join('\n');
}
