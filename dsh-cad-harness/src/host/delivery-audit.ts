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
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { writeJsonAtomic } from './file-lock.ts';
import { loadAssemblyManifest, resolveAssemblyManifestPath } from './manifest.ts';
import { listParts, partRoleOf } from './parts.ts';
import { listRuns, type RunEntry } from './runs.ts';
import { datumNames, listVersions, readVersionDatums, type VersionManifestEntry } from './version.ts';
import { mergedInputVersionIds, newestVersionPerPart, supersededVersionIds } from './latest.ts';
// The unregistered-geometry scan lives in its own module because the panel's
// 未登记 category consumes the SAME list: two implementations would drift and
// the human would see a different list than the machine flags.
import { SCAN_BUDGET, scanUnregistered, type UnregisteredFile, type UnregisteredScan } from './unregistered.ts';
import type { ProjectStores } from './project.ts';
import { readVisualReview, reviewCoversRequiredViews, reviewIsFresh } from './visual-review.ts';
import { validateDesignException, type DesignException } from './design-exceptions.ts';

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
  kind: 'strength' | 'motion' | 'assembly' | 'manufacturability' | 'appearance' | 'review' | 'flow';
  statement: string;
}

/** Interfaces that make the deliverable a MECHANISM (see ManifestInterface.type). */
const KINEMATIC_INTERFACE_TYPES = new Set(['转动副', '滑动副', '弹簧']);

/**
 * The run kinds that count as MANUFACTURING evidence. The claim used to accept only
 * `printability`, so a turned brass shaft or a laser-cut plate had to be screened for
 * FDM overhangs it will never see (and the sewing machine's audit demanded exactly
 * that for 10 machined parts). The process is declared on the manifest node; the audit
 * does not need to re-derive it to know that "a fresh manufacturing run of SOME kind
 * cites this version" is the enforceable half. The process-aware plan (deliver-plan)
 * still names the exact evaluator per process — this set is the claim's floor.
 */
export const MANUFACTURING_RUN_KINDS: ReadonlySet<string> = new Set([
  'printability', 'machinability', 'turning', 'sheet2d',
]);

/** What each claim kind needs, and how to say it in a finding. */
export const CLAIM_EVIDENCE: Record<DeliveryClaim['kind'], { kinds: string[]; label: string }> = {
  strength: { kinds: ['stress'], label: 'a fresh stress run citing the newest version' },
  motion: { kinds: ['motion', 'physics'], label: 'a fresh motion/physics run' },
  assembly: { kinds: ['assembly-check'], label: 'a fresh assembly check' },
  manufacturability: { kinds: ['printability', 'machinability', 'turning', 'sheet2d'], label: 'a fresh manufacturing run (printability / CNC access / turning / sheet2d) for EVERY fabricated part (stock/research roles are exempt by declaration)' },
  appearance: { kinds: ['appearance', 'assembly'], label: 'a fresh appearance run (check_appearance), or an assembly run carrying the renders' },
  review: { kinds: ['assembly'], label: 'a fresh assembly render to look at' },
  flow: { kinds: ['fluid'], label: 'a fresh fluid run citing the newest flow-domain version' },
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
  versions: {
    total: number;
    /** Every uncited version (kept for history/back-compat; the warning uses currentUncited). */
    neverCited: string[];
    /** Newest version per part that no run cites: a real delivery gap. */
    currentUncited: string[];
    /** Older/derived versions with no run: history, not a delivery gap. */
    supersededUncited: string[];
    newest: string | null;
    newestTimestamp: string | null;
  };
  parts: { total: number; newestNeverValidated: string[] };
  runs: {
    total: number;
    /** Retired runs are kept as history and deliberately excluded from every verdict. */
    retired: { id: string; kind: string; reason: string; retiredAt: string }[];
    stale: { id: string; kind: string; status: string; superseded: string[] }[];
    /** Every failed run, with `current` = no newer run for the same scope. */
    failing: { id: string; kind: string; summary: string; sourceVersionIds: string[]; current: boolean }[];
    duplicateGroups: { signature: string; count: number; runIds: string[] }[];
    /** Newest run per kind, with whether ANY newer version exists. */
    latestByKind: Record<string, { id: string; status: string; timestamp: string }>;
  };
  /**
   * Kickoff alignment recorded in the manifest's `brief`: what was settled with the
   * user and what the agent assumed. `null` means no manifest (normal for a single
   * part); `present: false` means a manifest with no brief at all.
   */
  brief: {
    /** An assembly manifest exists (a single part normally has none). */
    manifest: boolean;
    /** The manifest carries a `brief` (kickoff alignment). */
    present: boolean;
    processes: string[];
    verify: string[];
    assumed: { item: string; kind: string }[];
  };
  contract: {
    name: string | null;
    interfaces: number;
    /**
     * Interfaces that make this a MECHANISM (转动副 / 滑动副 / 弹簧). Their presence
     * is what makes a fresh motion/physics run a delivery requirement rather than a
     * nicety — the wind-up-frog shipped with "未测 simulate_physics" and passed.
     */
    kinematicInterfaces: number;
    byCheck: Record<string, number>;
    /** Manifest part nodes pointing at a version that is no longer the newest. */
    staleNodes: { name: string; version: string; newest: string; newestDatums?: number }[];
    /** True when the newest version is POSTERIOR to the newest contract check. */
    geometryNewerThanCheck: boolean;
    /** Current sealed contract identity (0/null for a legacy contract). */
    revision: number;
    hash: string | null;
    /** The newest assembly-check's recorded contract identity, when it has one. */
    checkRevision?: number;
    checkHash?: string | null;
    /** True when the current contract differs from the checked one. */
    changedSinceCheck: boolean;
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
    /** Self-signed design decisions for load-bearing thin walls. */
    designExceptions?: DesignException[];
  } = {},
): Promise<DeliveryAudit> {
  const [versions, parts, allRuns] = await Promise.all([
    listVersions(project.store), listParts(project.partStore), listRuns(project.runStore),
  ]);
  // A retired run is history: keep it in the corpus (with its reason) but never
  // let it decide the current design. Before this filter the ONLY way to clear a
  // stale failure was to move its directory by hand, outside every tool.
  const retiredRuns = allRuns.filter((r) => r.retiredAt);
  const runs = allRuns.filter((r) => !r.retiredAt);
  const versionById = new Map(versions.map((v) => [v.id, v]));
  const versionList = versions.map((v) => ({ ...v })) as VersionManifestEntry[];

  // Newest version per part — the shared rule (src/host/latest.ts).
  const newestOfPart = newestVersionPerPart(versionList);
  const superseded = (ids: readonly string[]): string[] => supersededVersionIds(versionList, ids);

  const cited = new Set<string>();
  for (const r of runs) for (const id of r.sourceVersionIds ?? []) cited.add(id);
  const neverCited = versionList.filter((v) => !cited.has(v.id)).map((v) => v.id);
  // The warning pool is the CURRENT version per part, not the whole store. A
  // superseded draft or a derived parent is history: it is not in the BOM/ICD,
  // and listing it beside the current version made v021 (the newest 90° flow
  // domain) read as "old" and the whole warning readable as historical noise.
  const currentVersionIds = new Set(newestOfPart.values());
  const currentUncited = neverCited.filter((id) => currentVersionIds.has(id));
  const supersededUncited = neverCited.filter((id) => !currentVersionIds.has(id));

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

  // A part-scope failure is only actionable with its subject. The run entry
  // carries the version ids; the version index carries the part id; the parts
  // index carries the human name. Join them once, here.
  const partScope = new Set(['printability', 'machinability', 'sheet2d', 'turning']);
  const subjectOf = (run: { kind: string; sourceVersionIds?: string[] }): string => {
    if (!partScope.has(run.kind)) return '';
    const names = (run.sourceVersionIds ?? []).map((vid) => {
      const pid = versionById.get(vid)?.partId;
      const name = pid ? parts.find((x) => x.id === pid)?.name : undefined;
      return name ? `${name} ${vid}` : vid;
    });
    return names.length ? `on ${names.slice(0, 3).join(', ')}` : '';
  };

  const latestByKind: DeliveryAudit['runs']['latestByKind'] = {};
  for (const r of runs) {
    const cur = latestByKind[r.kind];
    if (!cur || cur.timestamp < r.timestamp) latestByKind[r.kind] = { id: r.id, status: r.status, timestamp: r.timestamp };
  }

  // A failure is CURRENT when nothing newer asks the same question about the
  // same scope. comparing against the newest run OF THE KIND was wrong: r022
  // (ball v003) is current even though r026 (gasket v012) is the newest
  // printability run, and r027 (seat v019, wrong spindle) is history after
  // r029 (seat v019, x axis) passed.
  const scopeKey = (r: RunEntry): string =>
    r.subject ? `subject:${r.subject}` : `versions:${[...(r.sourceVersionIds ?? [])].sort().join('+')}`;
  const failingAll = runs
    .filter((r) => r.status === 'fail')
    .map((r) => ({ id: r.id, kind: r.kind, summary: r.summary, sourceVersionIds: r.sourceVersionIds ?? [] }));
  const failing = failingAll.map((r) => {
    const run = runs.find((x) => x.id === r.id)!;
    const newer = runs.some((o) =>
      o.id !== run.id && o.kind === run.kind && o.timestamp > run.timestamp && scopeKey(o) === scopeKey(run));
    // A failure about geometry that has since been replaced is history even when
    // its subject string never gets a successor (the r006 washer case: the subject
    // encoded a version set, so no later run could ever share it). If EVERY cited
    // version is superseded, the run cannot be current evidence.
    const cited = run.sourceVersionIds ?? [];
    const allCitedStale = cited.length > 0 && superseded(cited).length === cited.length;
    return { ...r, current: !run.supersededBy && !run.retiredAt && !allCitedStale && !newer };
  });

  // Duplicate work: same kind, same geometry/parameters, same outcome. The
  // signature must include what the run actually asked, not just version ids:
  // the six fluid runs r003/r005/r006/r007/r008/r009 are different dx/angles
  // (not duplicates), while r003/r017 are the same numerical run. Runs that a
  // newer run already superseded are history, not duplicate work.
  const signatureOf = async (r: RunEntry): Promise<string> => {
    const root = project.runStore.root;
    if (r.kind === 'fluid') {
      try {
        const fm = JSON.parse(await readFile(join(root, r.id, 'fluid-manifest.json'), 'utf8')) as {
          dxMm?: number; boundsMm?: unknown; particleCount0?: number;
        };
        let steps = '?';
        try {
          const report = JSON.parse(await readFile(join(root, r.id, 'report.json'), 'utf8')) as { metrics?: { stepsRun?: number } };
          steps = String(report.metrics?.stepsRun ?? '?');
        } catch { /* report missing: keep '?' */ }
        return `fluid|dx${fm.dxMm ?? '?'}|bounds${JSON.stringify(fm.boundsMm ?? null)}|` +
          `particles${fm.particleCount0 ?? '?'}|steps${steps}|${r.status}`;
      } catch { /* no manifest: fall through */ }
    }
    if (r.kind === 'motion') {
      try {
        const spec = await readFile(join(root, r.id, 'motion-spec.json'), 'utf8');
        return `motion|${createHash('sha256').update(spec).digest('hex').slice(0, 12)}|${r.status}`;
      } catch { /* no spec: fall through */ }
    }
    if (r.subject) return `${r.kind}|subject:${r.subject}|${r.status}`;
    return `${r.kind}|versions:${[...(r.sourceVersionIds ?? [])].sort().join('+')}|${r.status}`;
  };
  const signatureEntries = await Promise.all(
    runs.filter((r) => !r.supersededBy).map(async (r) => [r.id, await signatureOf(r)] as const),
  );
  const signatureById = new Map(signatureEntries);
  const groups = new Map<string, RunEntry[]>();
  for (const r of runs) {
    if (r.supersededBy) continue;
    const sig = signatureById.get(r.id) ?? `${r.kind}|${r.status}`;
    const list = groups.get(sig) ?? [];
    list.push(r);
    groups.set(sig, list);
  }
  const duplicateGroups = [...groups.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([signature, list]) => ({ signature, count: list.length, runIds: list.map((r) => r.id).sort() }))
    .sort((a, b) => b.count - a.count);

  // ── the contract, when there is one ────────────────────────────────────────
  const contract: DeliveryAudit['contract'] = {
    name: null, interfaces: 0, kinematicInterfaces: 0, byCheck: {}, staleNodes: [], geometryNewerThanCheck: false,
    revision: 0, hash: null, changedSinceCheck: false,
  };
  let contractPath: string | null = null;
  let contractError: string | null = null;
  /** Delivered versions named by the manifest: the visual gate's subject. */
  const manifestVersions = new Map<string, string>();
  let brief: DeliveryAudit['brief'] = { manifest: false, present: false, processes: [], verify: [], assumed: [] };
  let manifestClaims: NonNullable<import('./manifest.ts').AssemblyManifest['claims']> = [];
  try {
    const resolved = await resolveAssemblyManifestPath(opts.manifestPath, {
      workspace: opts.workspace ?? project.cwd,
      dataRoot: project.root,
    });
    contractPath = resolved.path;
    const manifest = await loadAssemblyManifest(resolved.path);
    manifestClaims = manifest.claims ?? [];
    contract.name = manifest.name ?? null;
    contract.revision = manifest.contractRevision ?? 0;
    contract.hash = manifest.contractHash ?? manifest.manifestHash ?? null;
    const root: any = (manifest as any).root ?? manifest;
    const walk = (node: any): void => {
      for (const iface of node?.interfaces ?? []) {
        contract.interfaces += 1;
        if (KINEMATIC_INTERFACE_TYPES.has(String(iface?.type ?? ''))) contract.kinematicInterfaces += 1;
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

    // Kickoff alignment (2026-11-14). The 减速器 session chose "FDM → worm drive"
    // without asking buy-vs-make or which processes were allowed, and the frog
    // delivered with "未测: simulate_physics" and still passed. Both are silent
    // decisions; this section makes them visible, not blocking.
    const raw = (root as any).brief;
    if (raw && typeof raw === 'object') {
      const assumed: { item: string; kind: string }[] = [];
      for (const entry of (Array.isArray(raw.buyVsMake) ? raw.buyVsMake : [])) {
        if (entry?.by === 'assumed') assumed.push({ item: `buyVsMake: ${entry.item} → ${entry.decision}`, kind: 'buyVsMake' });
      }
      for (const entry of (Array.isArray(raw.assumptions) ? raw.assumptions : [])) {
        if (entry?.by !== 'user') assumed.push({ item: `assumption: ${entry.text}`, kind: 'assumption' });
      }
      brief = {
        manifest: true,
        present: true,
        processes: Array.isArray(raw.processes) ? raw.processes.map(String) : [],
        verify: Array.isArray(raw.verify) ? raw.verify.map(String) : [],
        assumed,
      };
    } else {
      brief = { manifest: true, present: false, processes: [], verify: [], assumed: [] };
    }

    // "Update to the newest version" is only safe when the newest version can
    // still be an endpoint. A regeneration that dropped its datum() calls cannot
    // (rotor v088), and saying so here is the difference between a contract fix
    // and a dead end.
    for (const node of contract.staleNodes) {
      try {
        node.newestDatums = datumNames(await readVersionDatums(project.store, node.newest)).length;
      } catch {
        node.newestDatums = undefined;
      }
    }

    const newestCheck = newestOf(runs.filter((r) => r.kind === 'assembly-check'));
    const newestVersion = newestOf(versionList);
    contract.geometryNewerThanCheck = Boolean(
      newestCheck && newestVersion && newestVersion.timestamp > newestCheck.timestamp,
    );
    if (newestCheck) {
      try {
        const report = JSON.parse(await readFile(join(project.root, 'runs', newestCheck.id, 'report.json'), 'utf8')) as {
          contractRevision?: unknown;
          contractHash?: unknown;
          manifestHash?: unknown;
        };
        if (typeof report.contractRevision === 'number') contract.checkRevision = report.contractRevision;
        if (typeof report.contractHash === 'string') contract.checkHash = report.contractHash;
        else if (typeof report.manifestHash === 'string') contract.checkHash = report.manifestHash;
        if (contract.checkRevision !== undefined) {
          contract.changedSinceCheck = contract.revision !== contract.checkRevision;
        } else if (contract.checkHash && contract.hash) {
          // Older reports carry the 8-char manifestHash; a sealed contract carries
          // the full hash. A prefix match is the same revision, not a change.
          const a = contract.checkHash.replace(/^manifest@/, '');
          const b = contract.hash;
          contract.changedSinceCheck = !(a === b || (a.length === 8 && b.startsWith(a)) || (b.length === 8 && a.startsWith(b)));
        }
      } catch { /* an unreadable old report is reported as unversioned below */ }
    }
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
  // A designException is a signed decision, not a pass: it is echoed as info when
  // complete and blocked when empty/boilerplate ("whyNotLarger: none"). It does not
  // clear a thin-wall printability finding; it records who decided to keep it.
  for (const ex of opts.designExceptions ?? []) {
    const issues = validateDesignException(ex);
    if (issues.length > 0) {
      push('blocked', 'design-exception-invalid',
        `${ex?.featureId ?? '?'} (${ex?.versionId ?? '?'}): ${issues.join('; ')}`);
    } else {
      push('info', 'design-exception',
        `${ex.featureId} ${ex.measuredMm}mm < ${ex.requiredMm}mm, signed by ${ex.signedBy}: ${ex.userSummary}`);
    }
  }

  // Kickoff alignment findings: visible, never blocking (the user asked for a
  // record, not a gate — the gate is the human reading the list).
  if (brief.present) {
    if (brief.assumed.length > 0) {
      push('info', 'brief-assumed',
        `${brief.assumed.length} item(s) were decided by the agent, not the user: `
        + brief.assumed.map((a) => a.item).join('; '));
    }
    if (brief.processes.length === 0) {
      push('info', 'brief-no-processes', 'the brief records no allowed process set — per-part process provenance is then the only record of who chose it');
    }
    if (brief.verify.length === 0) {
      push('info', 'brief-no-verify', 'the brief does not say what "working" means (assembly / motion / strength), so the delivery cannot be checked against a declared scope');
    }
  } else if (brief.manifest) {
    push('info', 'brief-missing',
      'the manifest has no `brief`: buy-vs-make, allowed processes and verification scope were never settled (or never recorded). '
      + 'Record them before the first part, not after the model is built.');
  }


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
      `${visualMissing.length} delivered fabricated part(s) have NO visual review: ` +
      `${visualMissing.slice(0, 8).map((x) => `${x.name} ${x.version}`).join(', ')}` +
      `${visualMissing.length > 8 ? ` … (+${visualMissing.length - 8})` : ''} — ` +
      'call review_visual (top+iso, with a note) on the exact version before claiming delivery');
  }
  if (visualRequired && visualStale.length > 0) {
    push('blocked', 'visual-review-stale',
      `${visualStale.length} delivered fabricated part(s) have a STALE/INCOMPLETE visual review: ` +
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
      'no delivered fabricated version was found for the visual gate (no manifest, or every part is stock/research) — nothing was required, which is not the same as reviewed');
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
  // Motion COVERAGE, not just "a run exists". A motion run can pass while it
  // never put its revolute pairs in the timeline (or while an in-envelope
  // overlap has no declared fit). Such a run is not motion evidence: the sewing
  // rotary-hook's r092 passed with 0 events and hid upper_shaft↔rod (76.9mm³).
  const motionCoverage = new Map<string, { covered: boolean; known: boolean; excluded: number; unresolved: number }>();
  for (const r of freshRuns.filter((r) => r.kind === 'motion')) {
    try {
      const report = JSON.parse(await readFile(join(project.runStore.root, r.id, 'report.json'), 'utf8')) as {
        metrics?: { excludedJointPairs?: unknown; jointFitsUnresolved?: unknown };
      };
      const excluded = Array.isArray(report.metrics?.excludedJointPairs) ? report.metrics!.excludedJointPairs!.length : -1;
      const unresolved = typeof report.metrics?.jointFitsUnresolved === 'number' ? report.metrics!.jointFitsUnresolved! : 0;
      motionCoverage.set(r.id, {
        known: excluded >= 0,
        excluded: Math.max(0, excluded),
        unresolved,
        covered: excluded === 0 && unresolved === 0,
      });
    } catch {
      motionCoverage.set(r.id, { covered: false, known: false, excluded: 0, unresolved: 0 });
    }
  }
  // A run that FAILED is not evidence that a claim holds: it is evidence that something
  // is wrong (2026-10-23 audit, FIX-B4). `check` still counts — an inconclusive run is
  // better than no run, and the verdict already carries the doubt.
  const freshOfKind = (kinds: string[]) =>
    freshRuns.filter(
      (r) => kinds.includes(r.kind) && r.status !== 'fail' &&
        (r.sourceVersionIds ?? []).some((id) => newestVersions.has(id)),
    );
  // Delivery evidence must be a PASS with complete motion coverage. `check` is
  // not evidence for a required scope: it says "inconclusive", and an
  // inconclusive mechanism is exactly what this audit must not deliver.
  const freshPassCovered = (kinds: string[]) =>
    freshOfKind(kinds).filter((r) => r.status === 'pass'
      && (r.kind !== 'motion' || motionCoverage.get(r.id)?.covered === true));
  // ── declared/derived verification scope → evidence ───────────────────────
  //
  // The wind-up-frog delivery carried "未测: simulate_physics" in its README and
  // still passed, because a claim nobody declared requires no evidence. A
  // mechanism is not a claim the model may drop: when the ICD declares a
  // kinematic interface, a fresh motion/physics run is REQUIRED, and only the
  // user's explicit `brief.verify` can narrow that scope.
  {
    const declared = brief.present && brief.verify.length > 0 ? brief.verify : null;
    const derivedMotion = contract.kinematicInterfaces > 0;
    const required = new Set<string>(declared ?? (derivedMotion ? ['motion'] : []));
    // Only the kinds that have no other gate are enforced here: an assembly check
    // already has currency findings, and manufacturability/appearance have their own.
    // `flow` belongs here: the user declaring it in `brief.verify` is the scope,
    // and no other finding checks whether a fresh fluid run exists.
    const ENFORCED = new Set(['motion', 'strength', 'flow']);
    for (const kind of [...required].filter((k) => ENFORCED.has(k))) {
      const spec = CLAIM_EVIDENCE[kind as keyof typeof CLAIM_EVIDENCE];
      if (!spec) continue; // unknown kinds are surfaced by the claims loop
      if (freshPassCovered(spec.kinds).length > 0) continue;
      const why = declared
        ? `brief.verify declares "${kind}"`
        : `the ICD declares ${contract.kinematicInterfaces} kinematic interface(s)`;
      const tail = kind === 'flow'
        ? 'a flow scope with no fresh fluid run is not a flow check.'
        : 'a mechanism that was never run is not a delivered mechanism.';
      const any = freshOfKind(spec.kinds);
      const coverageNote = any.length > 0 && kind === 'motion'
        ? ` ${any.length} fresh motion run(s) exist but none is a PASS with complete joint-pair coverage ` +
          '(excludedJointPairs empty, jointFitsUnresolved 0); re-run with scanJointPairs and declared envelopes/fits.'
        : '';
      push('blocked', `verify-required-${kind}`,
        `${why}, but no FRESH PASS run of the right kind exists (${spec.label}).${coverageNote} ` +
        `Run it, or narrow the scope explicitly in assembly.json \`brief.verify\` — ${tail}`);
    }
    if (!declared && derivedMotion) {
      push('info', 'verify-derived',
        `motion coverage is required because the ICD declares ${contract.kinematicInterfaces} kinematic interface(s); ` +
        'declare `brief.verify` to state the scope yourself');
    }
    if (declared && derivedMotion && !declared.includes('motion')) {
      push('info', 'verify-waived',
        'the ICD declares kinematic interfaces but `brief.verify` does not include "motion": motion is treated as OUT of scope by the user\'s declaration — that is a decision, not a pass');
    }
  }

  const partsMissingManufacturability = [...newestOfPart.entries()]
    .filter(([pid, vid]) => {
      if (roleExemptIds.has(pid)) return false;
      return !freshRuns.some((r) => MANUFACTURING_RUN_KINDS.has(r.kind) && r.status !== 'fail' &&
        (r.sourceVersionIds ?? []).includes(vid));
    })
    .map(([pid]) => parts.find((x) => x.id === pid)?.name ?? pid);
  // An explicit per-call claim list wins; otherwise read the claims persisted with
  // the contract. Before this, no-claims-declared was unfixable: the writer had no
  // claims field, so the next audit always forgot the previous call's list.
  const claims = opts.claims ?? manifestClaims;
  // `brief.verify` is the user's scope; a claim is the caller's promise to back
  // that scope. If verify says flow but no flow claim was declared, the audit
  // would otherwise never look at the fluid evidence. Make the mismatch visible
  // (warn, not blocked: a claim is a declaration, not a design fact).
  if (claims.length > 0 && brief.present && brief.verify.length > 0) {
    const claimed = new Set(claims.map((c) => c.kind));
    for (const kind of brief.verify) {
      if (!(kind in CLAIM_EVIDENCE)) {
        push('warn', 'verify-unknown-kind',
          `brief.verify declares "${kind}", which is not a known claim kind (${Object.keys(CLAIM_EVIDENCE).join(', ')}) — it cannot be audited`);
        continue;
      }
      if (!claimed.has(kind as keyof typeof CLAIM_EVIDENCE)) {
        push('warn', 'verify-no-claim',
          `brief.verify declares "${kind}" but no "${kind}" claim was declared — the evidence for that scope is not being judged`);
      }
    }
  }
  for (const claim of claims) {
    const spec = CLAIM_EVIDENCE[claim.kind];
    if (!spec) {
      push('warn', 'unknown-claim-kind', `claim "${claim.statement}" has an unknown kind "${claim.kind}" — it cannot be backed or checked`);
      continue;
    }
    if (claim.kind === 'manufacturability') {
      if (partsMissingManufacturability.length > 0) {
        push('blocked', 'claim-without-evidence',
          `claim "${claim.statement}" needs ${spec.label}; missing for: ${partsMissingManufacturability.join(', ')}`);
      }
      continue;
    }
    const evidence = claim.kind === 'motion' ? freshPassCovered(spec.kinds) : freshOfKind(spec.kinds);
    if (evidence.length === 0) {
      const coverageNote = claim.kind === 'motion'
        ? ' (a motion claim needs a PASS with complete joint-pair coverage, not a check or a legacy run)'
        : '';
      push('blocked', 'claim-without-evidence',
        `claim "${claim.statement}" needs ${spec.label}, and no such run cites the newest version of any part${coverageNote}`);
    }
  }
  if (claims.length === 0) {
    push('info', 'no-claims-declared',
      'audited the CORPUS only: with no claims declared this audit cannot say whether a delivery claim is backed — ' +
      'declare `claims` to make it answer that question (a green corpus is not a delivered design)');
  }

  // ── findings, worst first ─────────────────────────────────────────────────

  for (const [kind, latest] of Object.entries(latestByKind)) {
    const latestRun = runs.find((x) => x.id === latest.id);
    const latestCited = latestRun?.sourceVersionIds ?? [];
    const latestStale = latestCited.length > 0 && superseded(latestCited).length === latestCited.length;
    if (latest.status === 'fail' && !latestStale) {
      const subject = subjectOf(latestRun ?? { kind, sourceVersionIds: [] });
      push('blocked', `latest-${kind}-failing`,
        `the newest ${kind} run (${latest.id})${subject ? ` ${subject}` : ''} is RED` +
        ' — the current design has an unresolved blocking result');
    }
  }
  for (const r of failing) {
    // The latest run of a kind is already covered by `latest-<kind>-failing`;
    // current failures for an older version/subject (r022 on the ball, while
    // r026 is the newest printability run overall) still need their own line.
    if (!r.current || latestByKind[r.kind]?.id === r.id) continue;
    const subject = subjectOf(r);
    push('blocked', `failing-${r.kind}`, `${r.id} (${r.kind}) failed: ${r.summary}${subject ? ` — ${subject}` : ''}`);
  }
  if (newestNeverValidated.length > 0) {
    push('blocked', 'newest-version-unvalidated',
      `${newestNeverValidated.length} part(s) have a newest version NO run ever checked: ${newestNeverValidated.join(', ')}`);
  }
  const versionLabel = (id: string): string => {
    const v = versionById.get(id);
    const p = v?.partId ? parts.find((x) => x.id === v.partId) : undefined;
    const role = p ? partRoleOf(p) : undefined;
    return `${id}${p ? ` (${p.name}${role && role !== 'printed' ? `, ${role}` : ''})` : ''}`;
  };
  if (currentUncited.length > 0) {
    push('warn', 'versions-never-cited',
      `${currentUncited.length} CURRENT version(s) were never used by any run: ` +
      `${currentUncited.slice(0, 10).map(versionLabel).join(', ')}${currentUncited.length > 10 ? ' …' : ''}` +
      ' — a current version without evidence is a delivery gap, not history');
  }
  if (supersededUncited.length > 0) {
    push('info', 'versions-uncited-history',
      `${supersededUncited.length} superseded/unreferenced version(s) have no run: ` +
      `${supersededUncited.slice(0, 10).join(', ')}${supersededUncited.length > 10 ? ' …' : ''}` +
      ' — history, not a delivery gap');
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
  // A motion run without its input is result-only: you can read what happened,
  // but you cannot re-run it on a new version without rebuilding the mechanism.
  const motionRuns = runs.filter((r) => r.kind === 'motion');
  const nonReplayable = motionRuns.filter((r) => !existsSync(join(project.runStore.root, r.id, 'motion-spec.json')));
  const uncoveredMotion = freshRuns.filter((r) => r.kind === 'motion' && r.status === 'pass'
    && motionCoverage.get(r.id)?.covered !== true);
  if (uncoveredMotion.length > 0) {
    const sample = uncoveredMotion.slice(0, 5).map((r) => {
      const c = motionCoverage.get(r.id);
      const why = c?.known ? `${c.excluded} excluded pair(s), ${c.unresolved} unresolved fit(s)` : 'coverage UNKNOWN (run predates joint-pair coverage)';
      return `${r.id} (${why})`;
    });
    push('warn', 'motion-coverage-incomplete',
      `${uncoveredMotion.length} motion run(s) report pass but do not cover revolute pairs: ${sample.join(', ')}` +
      (uncoveredMotion.length > 5 ? ' …' : '') +
      ' — their "0 interference" is scoped to the pairs they looked at; only a covered PASS counts as motion evidence');
  }
  if (nonReplayable.length > 0) {
    push('info', 'motion-not-replayable',
      `${nonReplayable.length}/${motionRuns.length} motion run(s) predate motion-spec.json and cannot be replayed: ` +
      nonReplayable.slice(0, 5).map((r) => r.id).join(', ') + (nonReplayable.length > 5 ? ' …' : '') +
      ' — re-running them means rebuilding the joints/drive by hand');
  }
  if (contract.interfaces > 0 && !contract.byCheck['motion-clearance'] && parts.length > 1) {
    // A mechanism whose contract has no motion-clearance interface has no place
    // where a motion claim is judged: the 2026-11-23 sewing contract was 36/36
    // while the rod passed through the upper shaft. A warning was not enough.
    push('blocked', 'contract-without-motion',
      'the contract declares interfaces but NO motion-clearance one: the mechanism is not part of the contract, ' +
      'so a green contract says nothing about whether it moves without collision — declare the kinematic interfaces ' +
      'with check:"motion-clearance" and cite a covered motion run');
  }
  if (contract.geometryNewerThanCheck) {
    push('warn', 'evidence-predates-geometry',
      'the newest version is POSTERIOR to the newest contract check — re-run the check before citing it');
  }
  if (contract.changedSinceCheck) {
    push('warn', 'contract-changed-since-check',
      `the contract is at revision ${contract.revision} but the newest assembly check audited ` +
      `${contract.checkRevision ?? '(unversioned)'} — re-run cad_assembly check before citing its verdict; ` +
      'a contract change is not covered by the old check.');
  }
  if (contract.staleNodes.length > 0) {
    push('warn', 'contract-stale-nodes',
      `${contract.staleNodes.length} manifest node(s) point at a replaced version: ` +
      contract.staleNodes.map((n) => `${n.name} ${n.version}→${n.newest}` +
        (n.newestDatums === 0 ? ' (newest declares no datums — declare anchors before moving the contract)' : '')).join(', '));
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
      `${duplicateGroups.length} group(s) repeat the same kind+geometry/parameters+outcome — ${wasted} run(s) spent without new information; superseded runs are excluded`);
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
      currentUncited,
      supersededUncited,
      newest: newestOf(versionList)?.id ?? null,
      newestTimestamp: newestOf(versionList)?.timestamp ?? null,
    },
    parts: { total: parts.length, newestNeverValidated },
    runs: {
      total: runs.length,
      retired: retiredRuns.map((r) => ({
        id: r.id, kind: r.kind, reason: r.retiredReason ?? '', retiredAt: r.retiredAt ?? '',
      })),
      stale: staleRuns, failing, duplicateGroups, latestByKind,
    },
    brief,
    contract,
    unregistered: scan,
  };
}

/** Persist the audit as the deliver pearl's evidence; returns the artifact path. */
export async function persistDeliveryAudit(
  project: ProjectStores,
  value: DeliveryAudit & { judgement?: string; summary?: string },
  claims: DeliveryClaim[] = [],
): Promise<string> {
  const path = join(project.cwd, 'assembly/delivery-audit.json');
  await writeJsonAtomic(path, {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    project: project.cwd,
    claims,
    ...value,
  });
  return path;
}

/** One version whose evidence needs refreshing after a change. */
export interface AffectedCheck {
  partId: string;
  partName: string;
  versionId: string;
  /** Kinds that already cite this exact version (fresh evidence). */
  freshKinds: string[];
  /** Kinds that only cite an older version of this part (stale evidence). */
  staleKinds: string[];
  /** Atomic tool calls that would refresh the part-level checks. */
  next: { tool: string; args: Record<string, unknown>; why: string }[];
}

/**
 * "What must be re-run now?" — the missing half of the audit.
 *
 * The audit says a corpus is incoherent; it does not say which checks the change
 * actually invalidated. Agents therefore re-ran the whole suite after every
 * chamfer (104 runs, 15 audits in the Bicycle session). This reads the version
 * and run indexes and returns, per changed/newest version, the checks already
 * fresh on it and the part-level checks that only cite an older version.
 *
 * It is a PLAN, not a verdict: manifest-level checks (assembly/motion) are left
 * to `deliver plan`, because their freshness depends on the contract, not one
 * version.
 */
export async function affectedChecks(
  project: ProjectStores,
  opts: { changed?: string[] } = {},
): Promise<{ changedVersionIds: string[]; parts: AffectedCheck[]; summary: string }> {
  const [versions, parts, allRuns] = await Promise.all([
    listVersions(project.store), listParts(project.partStore), listRuns(project.runStore),
  ]);
  const runs = allRuns.filter((r) => !r.retiredAt);
  const newest = newestVersionPerPart(versions);
  const versionById = new Map(versions.map((v) => [v.id, v]));
  const partById = new Map(parts.map((p) => [p.id, p]));
  const changed = opts.changed?.length ? new Set(opts.changed) : new Set(newest.values());
  const rows: AffectedCheck[] = [];
  for (const [partId, versionId] of newest) {
    if (!changed.has(versionId)) continue;
    const part = partById.get(partId);
    const fresh = new Set<string>();
    const stale = new Set<string>();
    for (const run of runs) {
      const ids = run.sourceVersionIds ?? [];
      if (ids.includes(versionId)) fresh.add(run.kind);
      else if (ids.some((id) => versionById.get(id)?.partId === partId)) stale.add(run.kind);
    }
    const next: AffectedCheck['next'] = [];
    const role = part ? partRoleOf(part) : 'printed';
    // "printed" is the default role, not a process claim. Any fresh manufacturing
    // run (printability / CNC access / turning / sheet2d) is enough to answer
    // "was this newest version screened?" — the process-specific evaluator is the
    // deliver plan's job, and demanding printability here re-imposed FDM on
    // turned brass.
    const hasManufacturing = ['printability', 'machinability', 'turning', 'sheet2d']
      .some((kind) => fresh.has(kind));
    if (role === 'printed' && !hasManufacturing) {
      next.push({
        tool: 'check_printability',
        args: { versionId },
        why: 'no fresh manufacturing evidence (printability / CNC access / turning / sheet2d) cites this newest version',
      });
    }
    if (stale.has('turning') && !fresh.has('turning')) {
      next.push({ tool: 'check_turning', args: { versionId }, why: 'turning only cites an older version of this part' });
    }
    if ((stale.has('machinability') || stale.has('cnc')) && !fresh.has('machinability')) {
      next.push({ tool: 'check_cnc_access', args: { versionId }, why: 'CNC access only cites an older version of this part' });
    }
    rows.push({
      partId,
      partName: part?.name ?? partId,
      versionId,
      freshKinds: [...fresh].sort(),
      staleKinds: [...stale].filter((k) => !fresh.has(k)).sort(),
      next,
    });
  }
  const missing = rows.filter((r) => r.next.length > 0).length;
  return {
    changedVersionIds: [...changed].sort(),
    parts: rows,
    summary: `${rows.length} changed part(s) · ${missing} need a part-level re-run · ` +
      `${rows.reduce((n, r) => n + r.next.length, 0)} suggested call(s)`,
  };
}
