// The delivery audit's VALUE — the one place `cad_deliver audit`, the panel route
// and the sandbox route build it from.
//
// WHY A MODULE: U19 requires the panel's audit view to be the SAME judgement the
// tool returns. A view that recomputed it from the index would be a second
// implementation and the two would disagree the first time one learned a new
// finding. Everything that decides what the audit SAYS (verdict → canonical
// judgement, the summary line, the counts) lives here.

import { asJudgement } from '../shared/judgement.ts';
import { auditDelivery, type DeliveryClaim } from './delivery-audit.ts';

export interface AuditRequest {
  manifestPath?: string;
  claims?: DeliveryClaim[];
  scanPaths?: string[];
  exempt?: { path: string; reason: string }[];
  visualReview?: 'required' | 'off';
}

/** Compute the audit and the values every caller displays. */
export async function deliveryAuditValue(project: Parameters<typeof auditDelivery>[0], args: AuditRequest) {
  const report = await auditDelivery(project, {
    manifestPath: args.manifestPath,
    claims: args.claims,
    scanPaths: args.scanPaths,
    exempt: args.exempt,
    visualReview: args.visualReview,
  });
  const blocked = report.findings.filter((f) => f.severity === 'blocked').length;
  const warn = report.findings.filter((f) => f.severity === 'warn').length;
  const info = report.findings.filter((f) => f.severity === 'info').length;
  const currentFailing = report.runs.failing.filter((r) => r.current).length;
  return {
    ...report,
    // The single key management and the delivery audit read (DESIGN §25.7).
    judgement: asJudgement(report.verdict),
    // Lead with the verdict, not with "0 blocked": the latter is true but reads as
    // green while `difficult` is the actual answer.
    summary: `${report.verdict.toUpperCase()} · ${blocked} blocked · ${warn} warn · ${info} info · ` +
      `${currentFailing} current failing · ${report.versions.currentUncited.length} current uncited · ` +
      `${report.versions.total} versions / ${report.parts.total} parts / ${report.runs.total} runs · ` +
      `stale runs ${report.runs.stale.length}` +
      (report.unregistered.files.length ? ` · unregistered files ${report.unregistered.files.length}` : ''),
  };
}
