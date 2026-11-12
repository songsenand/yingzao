// Per-interface evidence ledger (read-only).
//
// The manifest says which relations must hold; the run store says which of them
// were actually evaluated. This joins the two, so "which interfaces are proven"
// is a lookup instead of an inference. It never writes and never decides design:
// a `fail` is a witness, `unproven` is "nobody looked at this version".
//
// Evidence is DERIVED, not declared: the assembly-check run already carries one
// result per interface. A declared pointer (`params.runId`, motion/spring) is
// reported alongside, not required here.

import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { listRuns, type RunEntry } from '../runs.ts';
import { isFresh } from './freshness.ts';
import type { AssemblyManifest } from '../manifest.ts';
import type { LoadedVerifyProject } from './project.ts';

export type InterfaceProofStatus = 'pass' | 'fail' | 'flagged' | 'skipped' | 'unproven';

export interface InterfaceProof {
  id: string;
  ownerPath: string[];
  severity: 'hard' | 'intent';
  check?: string;
  /** Declared external evidence (motion/spring); not required for a static check. */
  declaredRunId?: string;
  status: InterfaceProofStatus;
  runId?: string;
  verdict?: string;
  reason?: string;
}

export interface InterfaceLedger {
  total: number;
  /** Counted from the manifest; a reader should not have to re-enumerate. */
  parts: number;
  counts: Record<InterfaceProofStatus, number>;
  /** The assembly-check run the ledger was read from, if any. */
  runId: string | null;
  fresh: boolean;
  reason?: string;
  orphans: number;
  items: InterfaceProof[];
}

export interface LedgerInput {
  assembly: AssemblyManifest | null;
  currentVersionSet: readonly string[];
  versionTimes: Map<string, string>;
  runs: readonly RunEntry[];
  readReport: (runId: string) => Promise<unknown>;
}

function proofStatus(verdict: unknown): InterfaceProofStatus | null {
  switch (verdict) {
    case 'pass': return 'pass';
    case 'hard-violation': return 'fail';
    case 'intent-flag': return 'flagged';
    case 'skipped': return 'skipped';
    default: return null;
  }
}

interface ManifestInterface {
  key: string;
  id: string;
  ownerPath: string[];
  severity: 'hard' | 'intent';
  check?: string;
  declaredRunId?: string;
}

function collectInterfaces(assembly: AssemblyManifest): { items: ManifestInterface[]; parts: number } {
  const out: ManifestInterface[] = [];
  let parts = 0;
  const walk = (node: AssemblyManifest['root'], path: string[]) => {
    if (node.kind !== 'assembly') parts++;
    for (const iface of node.interfaces ?? []) {
      out.push({
        key: [...path, iface.id].join('/'),
        id: iface.id,
        ownerPath: path,
        severity: iface.severity,
        ...(iface.check ? { check: iface.check } : {}),
        ...((iface as any).evidence?.runId
          ? { declaredRunId: String((iface as any).evidence.runId) }
          : (iface as any).params?.runId ? { declaredRunId: String((iface as any).params.runId) } : {}),
      });
    }
    for (const child of node.children ?? []) walk(child, [...path, child.id]);
  };
  walk(assembly.root, [assembly.root.id]);
  return { items: out, parts };
}

function resultsOf(report: unknown): any[] {
  const results = (report as any)?.results;
  return Array.isArray(results) ? results : [];
}

export async function buildInterfaceLedger(input: LedgerInput): Promise<InterfaceLedger | null> {
  if (!input.assembly) return null;
  const { items: interfaces, parts } = collectInterfaces(input.assembly);
  const counts: Record<InterfaceProofStatus, number> = { pass: 0, fail: 0, flagged: 0, skipped: 0, unproven: 0 };

  const contractRuns = input.runs
    .filter((r) => r.kind === 'assembly-check')
    .sort((a, b) => (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0));

  let chosen: RunEntry | null = null;
  let fresh = false;
  let reason: string | undefined;
  for (const run of contractRuns) {
    const verdict = isFresh(run, input.currentVersionSet, input.versionTimes, 'assembly');
    if (verdict.fresh) { chosen = run; fresh = true; break; }
    if (!chosen) { chosen = run; reason = verdict.reason; }
  }

  const items: InterfaceProof[] = interfaces.map((iface) => ({
    id: iface.id,
    ownerPath: iface.ownerPath,
    severity: iface.severity,
    ...(iface.check ? { check: iface.check } : {}),
    ...(iface.declaredRunId ? { declaredRunId: iface.declaredRunId } : {}),
    status: 'unproven' as InterfaceProofStatus,
  }));
  const byKey = new Map<string, InterfaceProof>();
  for (const item of items) byKey.set([...item.ownerPath, item.id].join('/'), item);
  const byId = new Map<string, InterfaceProof>();
  for (const item of items) if (!byId.has(item.id)) byId.set(item.id, item);

  let orphans = 0;
  // A stale run is not evidence: its verdicts were computed on a different
  // version set. Keep the run id so the reader can see what was attempted.
  if (chosen && fresh) {
    const report = await input.readReport(chosen.id).catch(() => null);
    for (const result of resultsOf(report)) {
      const id = String(result?.interfaceId ?? '');
      if (!id) continue;
      const ownerPath = Array.isArray(result.ownerPath) ? result.ownerPath.map(String) : null;
      const hit = (ownerPath ? byKey.get([...ownerPath, id].join('/')) : undefined) ?? byId.get(id);
      const status = proofStatus(result?.verdict);
      if (!hit) { orphans++; continue; }
      if (!status) continue;
      hit.status = status;
      hit.runId = chosen.id;
      hit.verdict = String(result.verdict);
      if (status === 'unproven') hit.reason = 'the run produced no verdict';
    }
  }

  for (const item of items) {
    counts[item.status]++;
    if (item.status === 'unproven' && !item.reason) {
      item.reason = chosen
        ? (fresh ? 'the fresh assembly-check run has no result for this interface' : `the newest assembly-check run is stale: ${reason ?? 'version set changed'}`)
        : 'no assembly-check run';
    }
  }

  return {
    total: items.length,
    parts,
    counts,
    runId: chosen?.id ?? null,
    fresh,
    ...(reason && !fresh ? { reason } : {}),
    orphans,
    items,
  };
}

/** Convenience wrapper for the V1 entry point. */
export async function ledgerForProject(project: LoadedVerifyProject): Promise<InterfaceLedger | null> {
  if (!project.assembly) return null;
  const runs = project.stores ? await listRuns(project.stores.runStore) : [];
  return buildInterfaceLedger({
    assembly: project.assembly,
    currentVersionSet: project.currentVersionSet,
    versionTimes: project.versionTimes,
    runs,
    readReport: async (runId) => JSON.parse(await readFile(
      join(project.stores!.runStore.root, runId, 'report.json'), 'utf8')),
  });
}
