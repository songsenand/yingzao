// Delivery audit (DESIGN §23): one call that answers "is this corpus actually
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

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadAssemblyManifest, resolveAssemblyManifestPath } from './manifest.ts';
import { listParts, partRoleOf } from './parts.ts';
import { listRuns, type RunEntry } from './runs.ts';
import { listVersions, type VersionManifestEntry } from './version.ts';
import { mergedInputVersionIds, newestVersionPerPart, supersededVersionIds } from './latest.ts';
// The unregistered-geometry scan lives in its own module because the panel's
// 未登记 category consumes the SAME list: two implementations would drift and
// the human would see a different list than the machine flags.
import { SCAN_BUDGET, scanUnregistered, type UnregisteredFile, type UnregisteredScan } from './unregistered.ts';
import type { ProjectStores } from './project.ts';
import { readVisualReview, reviewCoversRequiredViews, reviewIsFresh } from './visual-review.ts';

export type AuditSeverity = 'blocked' | 'warn' | 'info';

export interface AuditFinding {
  severity: AuditSeverity;
  code: string;
  detail: string;
}

/**
 * A delivery CLAIM, declared by the caller (DESIGN §25.7: an undecidable judgement may
 * only be DECLARED, never certified). The audit does not judge whether the claim is true;
 * it checks that the corpus carries the kind of evidence the claim needs, and reports the
 * gap by name. That is the machine-enforceable half of "we looked at it / we checked it".
 */
export interface DeliveryClaim {
  kind: 'strength' | 'motion' | 'assembly' | 'manufacturability' | 'appearance' | 'review';
  statement: string;
}

/** What each claim kind needs, and how to say it in a finding. */
const CLAIM_EVIDENCE: Record<DeliveryClaim['kind'], { kinds: string[]; label: string }> = {
  strength: { kinds: ['stress'], label: 'a fresh stress run citing the newest version' },
  motion: { kinds: ['motion', 'physics'], label: 'a fresh motion/physics run' },
  assembly: { kinds: ['assembly-check'], label: 'a fresh assembly check' },
  manufacturability: { kinds: ['printability'], label: 'a fresh printability run for EVERY printed part (stock/research roles are exempt by declaration)' },
  appearance: { kinds: ['appearance', 'assembly'], label: 'a fresh appearance run (check_appearance), or an assembly run carrying the renders' },
  review: { kinds: ['assembly'], label: 'a fresh assembly render to look at' },
};

export interface DeliveryAudit {
  /** Canonical since 2026-10-20 (was blocked/attention/ok). */
  verdict: 'excluded' | 'difficult' | 'not-excluded';
  findings: AuditFinding[];
  /** Per-version LLM visual review gate (top+iso, fresh for the exact version). */
  visual: {
    required: boolean;
    checked: number;
    missing: { name: string; version: string }[];
    stale: { name: string; version: string; reviewedAt?: string }[];
  };
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
  /** Mesh files under the scan roots that no version accounts for. */
  unregistered: UnregisteredScan;
}

const newestOf = <T extends { timestamp: string }>(list: T[]): T | undefined =>
  list.slice().sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0))[0];

/** The audit itself: reads the stores, never writes. */
export async function auditDelivery(
  project: ProjectStores,
  opts: {
    manifestPath?: string;
    workspace?: string;
    claims?: DeliveryClaim[];
    /** Workspace-relative roots for the unregistered-geometry scan. Default ['.']; [] disables it. */
    scanPaths?: string[];
    /** Files intentionally left as files (reference geometry), with a reason. */
    exempt?: { path: string; reason: string }[];
    /**
     * The per-version visual-review gate. `required` (default): a delivery is
     * blocked until every printed part in the assembly has a fresh top+iso
     * review. `off` exists for legacy/bench corpora and is reported as info —
     * it is a declared opt-out, never a silent pass.
     */
    visualReview?: 'required' | 'off';
  } = {},
): Promise<DeliveryAudit> {
  const [versions, parts, runs] = await Promise.all([
    listVersions(project.store), listParts(project.partStore), listRuns(project.runStore),
  ]);
  const versionById = new Map(versions.map((v) => [v.id, v]));
  const versionList = versions.map((v) => ({ ...v })) as VersionManifestEntry[];

  // Newest version per part — the shared rule (src/host/latest.ts).
  const newestOfPart = newestVersionPerPart(versionList);
  const superseded = (ids: readonly string[]): string[] => supersededVersionIds(versionList, ids);

  const cited = new Set<string>();
  for (const r of runs) for (const id of r.sourceVersionIds ?? []) cited.add(id);
  const neverCited = versionList.filter((v) => !cited.has(v.id)).map((v) => v.id);

  // G4 (2026-10-29): a part DECLARED stock/research is not a printed part, so the
  // printability and newest-validated expectations do not apply to it. The
  // exemption stays visible as an info finding below — a declared exemption,
  // never a silent shrink of what the audit demands (roberval r025–r036 was 12
  // ceremony printability runs on merged bodies and M3 models because role did
  // not exist).
  const roleExempt = parts.filter((p) => partRoleOf(p) !== 'printed');
  const roleExemptIds = new Set(roleExempt.map((p) => p.id));

  // Parts whose NEWEST version nobody validated: the sharpest form of "you
  // changed it and never re-checked".
  const newestNeverValidated: string[] = [];
  for (const [partId, newestId] of newestOfPart) {
    if (cited.has(newestId)) continue;
    if (roleExemptIds.has(partId)) continue;
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
  let contractPath: string | null = null;
  let contractError: string | null = null;
  /** Delivered versions named by the manifest: the visual gate's subject. */
  const manifestVersions = new Map<string, string>();
  try {
    const resolved = await resolveAssemblyManifestPath(opts.manifestPath, {
      workspace: opts.workspace ?? project.cwd,
      dataRoot: project.root,
    });
    contractPath = resolved.path;
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
        manifestVersions.set(node.version, String(node.name ?? node.id ?? node.version));
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
  } catch (e) {
    // Distinguish "there is no manifest" (normal for a single part) from "a manifest is
    // there and cannot be read" (which silently erased three contract findings — the
    // 2026-10-23 audit's FIX-B4). Only the second one is a finding.
    contractError = String((e as Error)?.message ?? e);
  }

  // ── geometry on disk that no version accounts for ─────────────────────────
  //
  // A deliverable that never became a version is invisible to the panel AND to
  // every tool (they all take a versionId). The corpus cannot vouch for it, so
  // this is blocked unless the caller DECLARES the file exempt.
  const workspace = resolve(opts.workspace ?? project.cwd);
  const scanPaths = opts.scanPaths ?? ['.'];
  const scan: UnregisteredScan = scanPaths.length > 0
    ? await scanUnregistered({ project, workspace, scanPaths, exempt: opts.exempt ?? [], versions: versionList })
    : { scanned: 0, files: [], exempt: [], missingExempt: [], truncated: false };

  const findings: AuditFinding[] = [];
  const push = (severity: AuditSeverity, code: string, detail: string) => findings.push({ severity, code, detail });

  // ── per-version visual review ─────────────────────────────────────────────
  //
  // The wind-up-frog key shipped a cut-through D hole that was visible in
  // `versions/v029/render_top.png`; the model had passed `views: []` at generation
  // and never opened that image. A delivery gate therefore has to require a
  // POSITIVE per-version record, not infer "reviewed" from the presence of renders.
  // The record is fresh only for the exact version; a shape change needs another
  // look. `visualReview: 'off'` is a declared opt-out for legacy corpora.
  const visualRequired = (opts.visualReview ?? 'required') !== 'off';
  const visualTargets = new Map<string, string>();
  if (manifestVersions.size > 0) {
    for (const [versionId, name] of manifestVersions) {
      const v = versionById.get(versionId);
      if (v?.partId && roleExemptIds.has(v.partId)) continue; // stock/research: not a printed delivery
      visualTargets.set(versionId, name);
    }
  } else {
    // No contract: the newest printed version of every part is the delivery set.
    for (const [partId, versionId] of newestOfPart) {
      if (roleExemptIds.has(partId)) continue;
      const part = parts.find((p) => p.id === partId);
      visualTargets.set(versionId, part?.name ?? partId);
    }
  }
  const visualMissing: { name: string; version: string }[] = [];
  const visualStale: { name: string; version: string; reviewedAt?: string }[] = [];
  for (const [versionId, name] of visualTargets) {
    const version = versionById.get(versionId);
    if (!version) continue;
    const review = await readVisualReview(project.store, versionId);
    if (!review) {
      visualMissing.push({ name, version: versionId });
    } else if (!reviewIsFresh(review, version.timestamp) || !reviewCoversRequiredViews(review)) {
      visualStale.push({ name, version: versionId, reviewedAt: review.reviewedAt });
    }
  }
  if (visualRequired && visualMissing.length > 0) {
    push('blocked', 'visual-review-missing',
      `${visualMissing.length} delivered printed part(s) have NO visual review: ` +
      `${visualMissing.slice(0, 8).map((x) => `${x.name} ${x.version}`).join(', ')}` +
      `${visualMissing.length > 8 ? ` … (+${visualMissing.length - 8})` : ''} — ` +
      'call review_visual (top+iso, with a note) on the exact version before claiming delivery');
  }
  if (visualRequired && visualStale.length > 0) {
    push('blocked', 'visual-review-stale',
      `${visualStale.length} delivered printed part(s) have a STALE/INCOMPLETE visual review: ` +
      `${visualStale.slice(0, 8).map((x) => `${x.name} ${x.version}${x.reviewedAt ? ` @ ${x.reviewedAt}` : ''}`).join(', ')}` +
      `${visualStale.length > 8 ? ` … (+${visualStale.length - 8})` : ''} — ` +
      'the review predates the version or lacks top/iso; look again at the current geometry');
  }
  if (!visualRequired) {
    push('info', 'visual-review-disabled',
      'visualReview: "off" — the per-version top+iso gate was NOT applied; this audit cannot say whether a human/model ever looked at the delivered geometry');
  }
  if (visualRequired && visualTargets.size === 0) {
    push('warn', 'visual-review-no-targets',
      'no delivered printed version was found for the visual gate (no manifest, or every part is stock/research) — nothing was required, which is not the same as reviewed');
  }
  const visual = {
    required: visualRequired,
    checked: visualTargets.size,
    missing: visualMissing,
    stale: visualStale,
  };

  // A corpus with nothing in it is not a clean corpus (2026-10-23 audit, FIX-B4): the
  // audit used to answer `not-excluded` for an empty project, which reads as "nothing
  // wrong found" when the truth is "there was nothing to look at".
  if (versionList.length === 0 && parts.length === 0 && runs.length === 0) {
    push('warn', 'empty-corpus',
      'this project has no version, no part and no run — the audit found nothing to check, which is NOT a clean bill');
  }
  if (contractPath && contractError && existsSync(contractPath)) {
    push('warn', 'manifest-unreadable',
      `an assembly manifest exists at ${contractPath} but could not be read (${contractError}) — its interfaces, ` +
      'stale nodes and motion coverage are UNKNOWN, so the contract findings below are not evidence of anything');
  }
  if (scanPaths.length === 0) {
    push('info', 'scan-disabled',
      'scanPaths was [] — the unregistered-geometry scan (the check that can BLOCK a delivery) did not run; ' +
      'pass explicit roots, or [] only when you are auditing a corpus with no files on disk');
  }

  // ── claims → evidence (declared, not inferred) ────────────────────────────
  //
  // "必须看过渲染图" cannot be verified by content (DESIGN §25.7 gate rule): a machine can
  // only witness existence + currency. So a judgement is REGISTERED here as a claim, and
  // the audit answers the question it can answer — is there fresh evidence of the right
  // kind behind it? — instead of pretending to have checked the looking.
  const staleIds = new Set(staleRuns.map((r) => r.id));
  const newestVersions = new Set([...newestOfPart.values()]);
  const freshRuns = runs.filter((r) => !staleIds.has(r.id));
  // A run that FAILED is not evidence that a claim holds: it is evidence that something
  // is wrong (2026-10-23 audit, FIX-B4). `check` still counts — an inconclusive run is
  // better than no run, and the verdict already carries the doubt.
  const freshOfKind = (kinds: string[]) =>
    freshRuns.filter(
      (r) => kinds.includes(r.kind) && r.status !== 'fail' &&
        (r.sourceVersionIds ?? []).some((id) => newestVersions.has(id)),
    );
  const partsMissingPrintability = [...newestOfPart.entries()]
    .filter(([pid, vid]) => {
      if (roleExemptIds.has(pid)) return false;
      return !freshRuns.some((r) => r.kind === 'printability' && r.status !== 'fail' &&
        (r.sourceVersionIds ?? []).includes(vid));
    })
    .map(([pid]) => parts.find((x) => x.id === pid)?.name ?? pid);
  const claims = opts.claims ?? [];
  for (const claim of claims) {
    const spec = CLAIM_EVIDENCE[claim.kind];
    if (!spec) {
      push('warn', 'unknown-claim-kind', `claim "${claim.statement}" has an unknown kind "${claim.kind}" — it cannot be backed or checked`);
      continue;
    }
    if (claim.kind === 'manufacturability') {
      if (partsMissingPrintability.length > 0) {
        push('blocked', 'claim-without-evidence',
          `claim "${claim.statement}" needs ${spec.label}; missing for: ${partsMissingPrintability.join(', ')}`);
      }
      continue;
    }
    if (freshOfKind(spec.kinds).length === 0) {
      push('blocked', 'claim-without-evidence',
        `claim "${claim.statement}" needs ${spec.label}, and no such run cites the newest version of any part`);
    }
  }
  if (claims.length === 0) {
    push('info', 'no-claims-declared',
      'audited the CORPUS only: with no claims declared this audit cannot say whether a delivery claim is backed — ' +
      'declare `claims` to make it answer that question (a green corpus is not a delivered design)');
  }

  // ── findings, worst first ─────────────────────────────────────────────────

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
  // A merged body is DERIVED: if a part it was built from moved on, the merged geometry
  // describes an older design and nothing used to say so (2026-10-23 audit, FIX-C5).
  const staleMerged = versionList
    .map((v) => ({ id: v.id, stale: supersededVersionIds(versionList, mergedInputVersionIds(v)) }))
    .filter((x) => x.stale.length > 0);
  if (staleMerged.length > 0) {
    push('warn', 'merged-stale',
      `${staleMerged.length} merged version(s) were built from versions a part has since replaced — ` +
      `the merged body describes an older design: ${staleMerged.slice(0, 5).map((x) => `${x.id} <- ${x.stale.join(',')}`).join('; ')}` +
      ' — merge again from the current versions, or cite the stale inputs explicitly');
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
  const nameList = (list: UnregisteredFile[]): string =>
    `${list.slice(0, 5).map((f) => f.path).join(', ')}${list.length > 5 ? ` … (+${list.length - 5})` : ''}`;
  const blockedFiles = scan.files.filter((f) => f.severity === 'blocked');
  const oldFiles = scan.files.filter((f) => f.severity === 'warn');
  if (blockedFiles.length > 0) {
    push('blocked', 'unregistered-geometry',
      `${blockedFiles.length} mesh file(s) on disk have no version and are NEWER than the newest version: ${nameList(blockedFiles)} — ` +
      'register them (import_part) so the panel can show them, or declare them exempt with a reason');
  }
  if (oldFiles.length > 0) {
    push('warn', 'unregistered-geometry',
      `${oldFiles.length} unregistered mesh file(s) predate the newest version: ${nameList(oldFiles)} — ` +
      'if one is part of the delivery, import it or declare it exempt');
  }
  if (scan.exempt.length > 0) {
    push('info', 'unregistered-exempt',
      `${scan.exempt.length} file(s) declared exempt: ${scan.exempt.slice(0, 5).map((e) => `${e.path} (${e.reason})`).join(', ')}`);
  }
  if (roleExempt.length > 0) {
    push('info', 'role-exempt-parts',
      `${roleExempt.length} part(s) declared stock/research and exempt from the printability and ` +
      `newest-version-validated checks: ${roleExempt.slice(0, 8).map((p) => `${p.name} (${partRoleOf(p)})`).join(', ')}` +
      `${roleExempt.length > 8 ? ` … (+${roleExempt.length - 8})` : ''} — if one of these IS delivered as a printed part, set its role back to printed`);
  }
  if (scan.missingExempt.length > 0) {
    push('warn', 'exemption-missing',
      `${scan.missingExempt.length} exemption(s) name a path that does not exist: ${scan.missingExempt.map((e) => e.path).join(', ')}`);
  }
  if (scan.truncated) {
    push('info', 'scan-truncated',
      `the unregistered-geometry scan stopped after ${SCAN_BUDGET.maxVisitedEntries} entries / ${SCAN_BUDGET.maxMeshFiles} mesh files — narrow \`scanPaths\` to be sure it saw everything`);
  }
  if (duplicateGroups.length > 0) {
    const wasted = duplicateGroups.reduce((a, g) => a + g.count - 1, 0);
    push('info', 'duplicate-runs',
      `${duplicateGroups.length} group(s) repeat the same kind+geometry+outcome — ${wasted} run(s) spent without new information`);
  }
  // The user's own packages are part of what a number came out of. This is INFO,
  // not a fault: installing is the user's right (DECISION-LOG 2026-10-22). But a
  // corpus that never says "this run used an overlay" would make "the same
  // version, the same tool" unanswerable — so the machine names it.
  const withOverlay = runs.filter((r) => (r.pythonOverlay?.packages?.length ?? 0) > 0);
  if (withOverlay.length > 0) {
    const packages = [...new Set(withOverlay.flatMap((r) => r.pythonOverlay?.packages ?? []))];
    const forced = [...new Set(withOverlay.flatMap((r) => r.pythonOverlay?.overrides ?? []))];
    push('info', 'overlay-backed-runs',
      `${withOverlay.length} run(s) were computed with packages from the user overlay: ${packages.slice(0, 6).join(', ')}` +
      `${packages.length > 6 ? ` … (+${packages.length - 6})` : ''}` +
      `${forced.length ? ` — including EXPLICIT OVERRIDES of locked packages (${forced.slice(0, 4).join(', ')}), which replace what the lock pins` : ''}` +
      ' — reproducible only where the same overlay is installed');
  }

  // The canonical three (src/shared/judgement.ts). The severity words stay as they are —
  // 'blocked'/'warn'/'info' describe a FINDING, not the judgement — but the verdict says
  // what a manager needs to query, and 'ok' no longer exists.
  // 'difficult' means a WARNING makes the margin unclear. An `info` finding (duplicate runs,
  // no-claims-declared) is information, not a downgrade — otherwise every real corpus reads
  // 'difficult' and the signal dies.
  const verdict: DeliveryAudit['verdict'] = findings.some((f) => f.severity === 'blocked')
    ? 'excluded'
    : findings.some((f) => f.severity === 'warn')
      ? 'difficult'
      : 'not-excluded';

  return {
    verdict,
    findings,
    visual,
    versions: {
      total: versionList.length,
      neverCited,
      newest: newestOf(versionList)?.id ?? null,
      newestTimestamp: newestOf(versionList)?.timestamp ?? null,
    },
    parts: { total: parts.length, newestNeverValidated },
    runs: { total: runs.length, stale: staleRuns, failing, duplicateGroups, latestByKind },
    contract,
    unregistered: scan,
  };
}
