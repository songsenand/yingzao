// The run cited as external evidence for an interface.
//
// `evidence.runId` is the documented field; `params.runId` is the legacy alias
// that older manifests and the motion-clearance operator used. One reader, so
// the precedence cannot drift between the checker and the ledger.

export interface EvidenceCarrier {
  evidence?: { runId?: unknown };
  params?: Record<string, unknown>;
}

export function citedRunId(iface: EvidenceCarrier): string | null {
  const first = iface.evidence?.runId;
  if (typeof first === 'string' && first.length > 0) return first;
  const legacy = iface.params?.runId;
  if (typeof legacy === 'string' && legacy.length > 0) return legacy;
  return null;
}
