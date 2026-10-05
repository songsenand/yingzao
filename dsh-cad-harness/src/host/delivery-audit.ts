// Delivery audit (DESGIGN §23): one call that answers "is this corpus actually
// deliverable?", instead of relying on the model's memory of what it ran.
//
// WHY: microscope5 shipped with 66/69 runs citing superseded versions, only two
// fully-fresh runs (both FAILING motion), 19/19 assembly validations failed, a
// contract with no mechanism interface at all, and a delivery table whose part
// versions had already been replaced. Every one of those facts was IN the
// corpus — none of them was VISIBLE in one place. This module computes them.
//
// Pure over the three stores plus an optional manifest, so the tool wrapper and
// any acceptance script share one implementation.

import { loadAssemblyManifest, resolveAssemblyManifestPath } from './manifest.ts';
import { listParts } from './parts.ts';
import { listRuns, type RunEntry } from './runs.ts';
import { listVersions, type VersionManifestEntry } from './version.ts';
import type { ProjectStores } from './project.ts';

export type AuditSeverity = 'blocked' | 'warn' | 'info';

export interface AuditFinding {
  severity: AuditSeverity;
  code: string;
  detail: string;
}

export interface DeliveryAudit {
  verdict: 'blocked' | 'attention' | 'ok';
  findings: AuditFinding[];
  versions: { total: number; neverCited: string[]; newest: string | null; newestTimestamp: string | null };
  parts: { total: number; newestNeverValidated: string[] };
  runs: {
    total: number;
    stale: { id: string; kind: string; status: string; superseded: string[] }[];
    failing: { id: string; kind: string; summary: string }[];
    duplicateGroups: { signature: string; count: number }[];
    /** Newest run per kind, with whether ANY newer version exists. */
    latestByKind: Record<string, { id: string; status: string; timestamp: string }>;
  };
  contract: {
    name: string | null;
    interfaces: number;
    byCheck: Record<string, number>;
    /** Manifest part nodes pointing at a version that is no longer the newest. */
    staleNodes: { name: string; version: string; newest: string }[];
    /** True when the newest version is POSTERIOR to the newest contract check. */
    geometryNewerThanCheck: boolean;
  };
}

const newestOf = <T extends { timestamp: string }>(list: T[]): T | undefined =>
  list.slice().sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0))[0];

/** The audit itself: reads the stores, never writes. */
export async function auditDelivery(
  project: ProjectStores,
  opts: { manifestPath?: string; workspace?: string } = {},
): Promise<DeliveryAudit> {
  const [versions, parts, runs] = await Promise.all([
    listVersions(project.store), listParts(project.partStore), listRuns(project.runStore),
  ]);
  const versionById = new Map(versions.map((v) => [v.id, v]));
  const versionList = versions.map((v) => ({ ...v })) as VersionManifestEntry[];

  // Newest version per part — the yardstick for "is this evidence current".
  const newestOfPart = new Map<string, string>();
  for (const v of versionList) {
    if (!v.partId) continue;
    const current = newestOfPart.get(v.partId);
    if (!current || (versionById.get(current)?.timestamp ?? '') < v.timestamp) newestOfPart.set(v.partId, v.id);
  }
  const superseded = (ids: readonly string[]): string[] =>
    ids.filter((id) => {
      const v = versionById.get(id);
      if (!v?.partId) return false;
      return newestOfPart.get(v.partId) !== id;
    });

  const cited = new Set<string>();
  for (const r of runs) for (const id of r.sourceVersionIds ?? []) cited.add(id);
  const neverCited = versionList.filter((v) => !cited.has(v.id)).map((v) => v.id);

  // Parts whose NEWEST version nobody validated: the sharpest form of "you
  // changed it and never re-checked".
  const newestNeverValidated: string[] = [];
  for (const [partId, newestId] of newestOfPart) {
    if (cited.has(newestId)) continue;
    const part = parts.find((p) => p.id === partId);
    newestNeverValidated.push(part?.name ?? partId);
  }

  const staleRuns = runs
    .map((r) => ({ id: r.id, kind: r.kind, status: r.status, superseded: superseded(r.sourceVersionIds ?? []) }))
    .filter((r) => r.superseded.length > 0);
  const failing = runs
    .filter((r) => r.status === 'fail')
    .map((r) => ({ id: r.id, kind: r.kind, summary: r.summary }));

  // Duplicate work: same kind, same cited geometry, same outcome.
  const groups = new Map<string, RunEntry[]>();
  for (const r of runs) {
    const sig = `${r.kind}|${[...(r.sourceVersionIds ?? [])].sort().join('+')}|${r.status}`;
    const list = groups.get(sig) ?? [];
    list.push(r);
    groups.set(sig, list);
  }
  const duplicateGroups = [...groups.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([signature, list]) => ({ signature, count: list.length }))
    .sort((a, b) => b.count - a.count);

  const latestByKind: DeliveryAudit['runs']['latestByKind'] = {};
  for (const r of runs) {
    const cur = latestByKind[r.kind];
    if (!cur || cur.timestamp < r.timestamp) latestByKind[r.kind] = { id: r.id, status: r.status, timestamp: r.timestamp };
  }

  // ── the contract, when there is one ────────────────────────────────────────
  const contract: DeliveryAudit['contract'] = {
    name: null, interfaces: 0, byCheck: {}, staleNodes: [], geometryNewerThanCheck: false,
  };
  try {
    const resolved = await resolveAssemblyManifestPath(opts.manifestPath, {
      workspace: opts.workspace ?? project.cwd,
      dataRoot: project.root,
    });
    const manifest = await loadAssemblyManifest(resolved.path);
    contract.name = manifest.name ?? null;
    const root: any = (manifest as any).root ?? manifest;
    const walk = (node: any): void => {
      for (const iface of node?.interfaces ?? []) {
        contract.interfaces += 1;
        const check = String(iface?.check ?? '(none)');
        contract.byCheck[check] = (contract.byCheck[check] ?? 0) + 1;
      }
      if (node?.kind === 'part' && typeof node.version === 'string') {
        const v = versionById.get(node.version);
        const cur = v?.partId ? newestOfPart.get(v.partId) : undefined;
        if (cur && cur !== node.version) {
          contract.staleNodes.push({ name: String(node.name ?? node.id), version: node.version, newest: cur });
        }
      }
      for (const child of node?.children ?? []) walk(child);
    };
    walk(root);

    const newestCheck = newestOf(runs.filter((r) => r.kind === 'assembly-check'));
    const newestVersion = newestOf(versionList);
    contract.geometryNewerThanCheck = Boolean(
      newestCheck && newestVersion && newestVersion.timestamp > newestCheck.timestamp,
    );
  } catch { /* no readable manifest: the other findings still stand */ }

  // ── findings, worst first ─────────────────────────────────────────────────
  const findings: AuditFinding[] = [];
  const push = (severity: AuditSeverity, code: string, detail: string) => findings.push({ severity, code, detail });

  for (const [kind, latest] of Object.entries(latestByKind)) {
    if (latest.status === 'fail') {
      push('blocked', `latest-${kind}-failing`,
        `the newest ${kind} run (${latest.id}) is RED — the current design has an unresolved blocking result`);
    }
  }
  for (const r of failing) {
    const isLatest = latestByKind[r.kind]?.id === r.id;
    if (!isLatest) continue;
    push('blocked', `failing-${r.kind}`, `${r.id} (${r.kind}) failed: ${r.summary}`);
  }
  if (newestNeverValidated.length > 0) {
    push('blocked', 'newest-version-unvalidated',
      `${newestNeverValidated.length} part(s) have a newest version NO run ever checked: ${newestNeverValidated.join(', ')}`);
  }
  if (neverCited.length > 0) {
    push('warn', 'versions-never-cited',
      `${neverCited.length}/${versionList.length} versions were never used by any run: ${neverCited.slice(0, 12).join(', ')}${neverCited.length > 12 ? ' …' : ''}`);
  }
  if (staleRuns.length > 0) {
    const sample = staleRuns.slice(-5).map((r) => `${r.id}(${r.kind}, superseded ${r.superseded.join('/')})`);
    push('warn', 'stale-evidence',
      `${staleRuns.length}/${runs.length} runs cite geometry that has since been replaced — e.g. ${sample.join(', ')}`);
  }
  if (contract.interfaces > 0 && !contract.byCheck['motion-clearance'] && parts.length > 1) {
    push('warn', 'contract-without-motion',
      'the contract declares interfaces but NO motion-clearance one: the mechanism is not part of the contract, ' +
      'so a green contract says nothing about whether it moves without collision');
  }
  if (contract.geometryNewerThanCheck) {
    push('warn', 'evidence-predates-geometry',
      'the newest version is POSTERIOR to the newest contract check — re-run the check before citing it');
  }
  if (contract.staleNodes.length > 0) {
    push('warn', 'contract-stale-nodes',
      `${contract.staleNodes.length} manifest node(s) point at a replaced version: ` +
      contract.staleNodes.map((n) => `${n.name} ${n.version}→${n.newest}`).join(', '));
  }
  if (duplicateGroups.length > 0) {
    const wasted = duplicateGroups.reduce((a, g) => a + g.count - 1, 0);
    push('info', 'duplicate-runs',
      `${duplicateGroups.length} group(s) repeat the same kind+geometry+outcome — ${wasted} run(s) spent without new information`);
  }

  const verdict: DeliveryAudit['verdict'] = findings.some((f) => f.severity === 'blocked') ? 'blocked'
    : findings.length > 0 ? 'attention' : 'ok';

  return {
    verdict,
    findings,
    versions: {
      total: versionList.length,
      neverCited,
      newest: newestOf(versionList)?.id ?? null,
      newestTimestamp: newestOf(versionList)?.timestamp ?? null,
    },
    parts: { total: parts.length, newestNeverValidated },
    runs: { total: runs.length, stale: staleRuns, failing, duplicateGroups, latestByKind },
    contract,
  };
}
