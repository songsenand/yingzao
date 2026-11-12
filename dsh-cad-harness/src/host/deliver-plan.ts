// Delivery plan (read-only, first slice).
//
// WHY: the agent should not have to remember 37 tools and which run is fresh.
// This module DERIVES a plan from the BOM/ICD (`assembly/assembly.json` + parts
// roles), the claims and the run graph, then reports per-target status, witness,
// where to look and which atomic tool to re-run. It calls `verify()` for the
// observation (no CAD, no run writes) and never re-implements a check's verdict.
//
// It is deliberately a PLAN, not a gate: a missing process/profile/run becomes
// `unobserved` with the declaration or tool call that would fill it. Nothing here
// silently passes, and nothing here runs geometry.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CLAIM_EVIDENCE, type DeliveryClaim } from './delivery-audit.ts';
import { flattenParts, type AssemblyManifest, type ManifestInterface, type ManifestNode } from './manifest.ts';
import { listParts, partRoleOf, type PartEntry } from './parts.ts';
import { processCapability } from './process-catalog.ts';
import { listRuns, type RunEntry } from './runs.ts';
import { readVisualReview, reviewCoversRequiredViews, reviewIsFresh } from './visual-review.ts';
import { loadClaims } from './verify/claims.ts';
import { verify } from './verify/index.ts';
import { loadVerifyProject } from './verify/project.ts';
import type { VerifyClaim, VerifyReport } from './verify/types.ts';

export type PlanStatus = 'pass' | 'warn' | 'fail' | 'blocked' | 'unobserved' | 'exempt';

export interface PlanEvidence {
  runId?: string;
  checkId?: string;
  versionIds?: string[];
  profileId?: string;
  processSource?: 'user' | 'policy' | 'agent' | 'argument' | 'claim';
  processConfirmed?: boolean;
  reviewedAt?: string;
}

export interface PlanRow {
  id: string;
  target: string;
  check: string;
  why: string;
  status: PlanStatus;
  evidence?: PlanEvidence;
  where?: { parts?: string[]; point?: number[]; note?: string };
  next?: string;
}

export interface PlanGap {
  code: string;
  what: string;
  why: string;
  next: string;
}

export interface DeliveryPlan {
  project: string;
  process: string | null;
  processSource: 'user' | 'policy' | 'agent' | null;
  /** Process-scoped plan verdict: fail > unobserved > warn > pass. */
  planVerdict: 'excluded' | 'blocked' | 'difficult' | 'not-excluded';
  /** Corpus audit verdict (verify); may differ from the plan when a foreign-profile run is counted. */
  verdict: string;
  rows: PlanRow[];
  gaps: PlanGap[];
  summary: Record<PlanStatus | 'total', number>;
  verification: {
    generatedAt: string;
    verdict: string;
    rows: { id: string; status: string }[];
    findings: { id: string; code: string; severity: string; what: string }[];
    checks: { id: string; status: string; late?: boolean }[];
  };
}

export interface PlanOptions {
  process?: string;
  claimsPath?: string;
  /** Turn custom checks on (same meaning as verify --checks). */
  checks?: boolean;
}

interface RunReport {
  verdict?: string;
  profiles?: { profileId?: string }[];
  results?: { interfaceId: string; verdict: string; measured?: number; detail?: string }[];
  minWallMm?: number;
  minWallAtMm?: number[];
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function setEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((x, i) => x === sb[i]);
}

function statusOfRun(run: RunEntry): PlanStatus {
  if (run.status === 'fail') return 'fail';
  if (run.judgement === 'excluded') return 'fail';
  if (run.judgement === 'difficult') return 'warn';
  return 'pass';
}

function statusOfPrintability(report: RunReport | null, run: RunEntry): PlanStatus {
  const v = report?.verdict;
  if (v === 'excluded') return 'fail';
  if (v === 'difficult') return 'warn';
  if (v === 'not-excluded') return 'pass';
  return statusOfRun(run);
}

function roleOfVersion(parts: readonly PartEntry[], version: string): string {
  const part = parts.find((p) => p.versionIds.includes(version));
  return partRoleOf(part);
}

type ProcessDecl = NonNullable<ManifestNode['process']>;

function processOf(node: ManifestNode): ProcessDecl | null {
  const p = node.process;
  return p && typeof p.id === 'string' && p.id.length > 0 ? p : null;
}

/** A user decision, or a choice covered by a user-approved manufacturing policy. */
function processConfirmed(p: ProcessDecl, policy: AssemblyManifest['manufacturing'] | undefined): boolean {
  if (p.source === 'user' || p.confirmedBy || p.confirmedAt) return true;
  const allowed = policy?.allowed?.map((a) => a.id) ?? [];
  const approved = !!policy?.approvedBy || !!policy?.approvedAt;
  if (!approved) return false;
  if (allowed.length > 0 && !allowed.includes(p.id)) return false;
  if (p.source === 'policy') return true;
  // An agent choice inside the user-approved set is delegated, not a per-part question.
  return p.source === 'agent' && policy?.delegate !== false;
}

function latestForPart(runs: readonly RunEntry[], kind: string, version: string): RunEntry | null {
  return runs.find((r) => r.kind === kind && r.sourceVersionIds.includes(version)) ?? null;
}

function latestForSet(runs: readonly RunEntry[], kind: string, versionSet: readonly string[]): RunEntry | null {
  return runs.find((r) => r.kind === kind && setEqual(r.sourceVersionIds, versionSet)) ?? null;
}

function nextOf(check: string, args: Record<string, unknown>): string {
  const parts = Object.entries(args).map(([k, v]) => `${k}:${JSON.stringify(v)}`).join(', ');
  return `${check}(${parts})`;
}

export async function buildDeliveryPlan(projectRoot: string, options: PlanOptions = {}): Promise<DeliveryPlan> {
  const project = await loadVerifyProject(projectRoot);
  const claims = await loadClaims(project.root, options.claimsPath);
  const checksEnabled = options.checks !== false;
  const verification = await verify({
    projectRoot: project.root,
    ...(options.claimsPath ? { claimsPath: options.claimsPath } : {}),
    checks: checksEnabled,
  });

  const stores = project.stores;
  const runs = stores ? await listRuns(stores.runStore) : [];
  const parts = stores ? await listParts(stores.partStore) : [];
  const assembly = project.assembly;
  const manufacturing = assembly?.manufacturing;
  const policyApproved = !!manufacturing?.approvedBy || !!manufacturing?.approvedAt;
  const allowedIds = manufacturing?.allowed?.map((a) => a.id) ?? [];
  const policyAllows = (id: string) => allowedIds.length === 0 || allowedIds.includes(id);
  const versionSet = project.currentVersionSet;
  const rows: PlanRow[] = [];
  const gaps: PlanGap[] = [];

  const process = options.process ?? null;
  const processFromClaim = claims.claims
    .map((c) => (c as VerifyClaim & { process?: string }).process)
    .find((p): p is string => typeof p === 'string' && p.length > 0) ?? null;
  const rootProcess = assembly ? processOf(assembly.root) : null;
  const argProcess: ProcessDecl | null = process
    ? { id: process, source: 'user', confirmedBy: 'argument' }
    : null;
  const claimProcessDecl: ProcessDecl | null = processFromClaim
    ? { id: processFromClaim, source: 'user', confirmedBy: 'claim' }
    : null;
  const defaultProcess: ProcessDecl | null = argProcess ?? rootProcess ?? claimProcessDecl;
  const effectiveProcess = defaultProcess?.id ?? null;
  const unconfirmedProcesses: string[] = [];

  const asmCheck = latestForSet(runs, 'assembly-check', versionSet);
  const asmCheckReport = asmCheck && stores
    ? await readJson<RunReport>(join(stores.runStore.root, asmCheck.id, 'report.json'))
    : null;
  const checkPointer = stores
    ? await readJson<{ manifestHash?: string }>(join(project.root, 'assembly', 'assembly-check-report.json'))
    : null;
  const contractFresh = !!asmCheck
    && (!checkPointer?.manifestHash || !assembly?.manifestHash || checkPointer.manifestHash === assembly.manifestHash);
  const asmRun = latestForSet(runs, 'assembly', versionSet);
  const printedParts = assembly
    ? flattenParts(assembly.root).filter((p) => p.node.kind === 'part' && typeof p.node.version === 'string')
    : [];

  // ── the one policy decision, not N part questions ─────────────────────────
  if (manufacturing) {
    rows.push({
      id: 'M:policy',
      target: `manufacturing policy (${allowedIds.join(', ') || 'no allowed set'})`,
      check: 'manufacturing-policy',
      why: policyApproved
        ? `approved by ${manufacturing.approvedBy ?? manufacturing.approvedAt}; allowed ` +
          allowedIds.map((id) => `${id}[${processCapability(id)?.support ?? 'unknown'}]`).join(', ')
        : 'a policy exists but has no approvedBy/approvedAt: it is still a proposal',
      status: policyApproved ? 'pass' : 'unobserved',
      ...(policyApproved ? {} : { next: 'ask the user once: which processes are available/acceptable? then record approvedBy + allowed' }),
    });
  } else {
    rows.push({
      id: 'M:policy',
      target: 'manufacturing policy',
      check: 'manufacturing-policy',
      why: defaultProcess?.source === 'user'
        ? `no option set; the user-stated process is ${defaultProcess.id}`
        : 'no manufacturing policy: the allowed process set is undeclared',
      status: defaultProcess?.source === 'user' ? 'pass' : 'unobserved',
      ...(defaultProcess?.source === 'user'
        ? {}
        : { next: 'ask the user once: which processes are available/acceptable? then record manufacturing.allowed + approvedBy' }),
    });
  }

  // ── one mix decision (printed parts only) ────────────────────────────────
  {
    const printed = printedParts.filter((p) => roleOfVersion(parts, p.node.version as string) === 'printed');
    if (printed.length > 0) {
      const counts = new Map<string, number>();
      let outside = 0;
      for (const p of printed) {
        const d = processOf(p.node) ?? defaultProcess;
        const id = d?.id ?? 'unassigned';
        counts.set(id, (counts.get(id) ?? 0) + 1);
        if (d && manufacturing && policyApproved && !policyAllows(d.id)) outside += 1;
      }
      const mix = [...counts.entries()].map(([id, n]) => `${n}×${id}`).join(', ');
      const unassigned = counts.get('unassigned') ?? 0;
      const mixApproved = !!(manufacturing?.mixApprovedBy || manufacturing?.mixApprovedAt) || allowedIds.length === 1;
      rows.push({
        id: 'M:mix',
        target: 'process mix (printed parts)',
        check: 'manufacturing-mix',
        why: mix + (unassigned === 0 && outside === 0 && !mixApproved ? ' (within the approved set, not yet confirmed)' : ''),
        status: unassigned > 0 || outside > 0 || !mixApproved ? 'unobserved' : 'pass',
        ...(unassigned > 0
          ? { next: 'assign the unassigned parts from the approved set (agent), then confirm the mix once' }
          : outside > 0
            ? { next: 'ask the user once for the parts outside the approved set, or switch them to an allowed process' }
            : mixApproved
              ? {}
              : { next: 'confirm the mix once (request_review), then record mixApprovedBy' }),
      });
    }
  }

  {
    const unknown = allowedIds.filter((id) => !processCapability(id));
    const planned = allowedIds.filter((id) => processCapability(id)?.support === 'planned');
    if (unknown.length > 0) {
      gaps.push({
        code: 'process-unknown',
        what: `allowed process ids not in the catalog: ${unknown.join(', ')}`,
        why: 'an id without a catalog entry cannot be mapped to an evaluator or a support statement',
        next: 'use a catalog id, or add the process (with its evaluator status) to the catalog',
      });
    }
    if (planned.length > 0) {
      gaps.push({
        code: 'process-planned',
        what: `allowed, method defined, evaluator not built yet: ${planned.join(', ')}`,
        why: 'the decision is recordable; a pass would be a rubber stamp until the evaluator exists',
        next: 'build/attach the named evaluator, or record a manual check; do not reuse the printability profile',
      });
    }
  }

  // ── parts: printability + visual review ───────────────────────────────────
  for (const part of printedParts) {
    const node = part.node;
    const version = node.version as string;
    const role = roleOfVersion(parts, version);
    if (role !== 'printed') {
      rows.push({
        id: `P:${part.id}`,
        target: `${node.name} ${version}`,
        check: 'none',
        why: `role=${role}: exempt from printability and newest-version checks`,
        status: 'exempt',
        evidence: { versionIds: [version] },
      });
      continue;
    }

    const decl = processOf(node) ?? defaultProcess;
    if (!decl) {
      // No process at all: the M:policy row is the ONE question. Do not repeat
      // it per part; the agent assigns from the approved set once it exists.
      if (manufacturing && policyApproved && allowedIds.length > 0) {
        rows.push({
          id: `P:${part.id}`,
          target: `${node.name} ${version}`,
          check: 'check_printability',
          why: `no process assigned; the approved policy allows ${allowedIds.join(', ')}`,
          status: 'unobserved',
          evidence: { versionIds: [version] },
          next: 'assign a process from the approved set (agent), then run check_printability',
        });
      }
    } else if (!processConfirmed(decl, manufacturing)) {
      if (manufacturing && policyApproved && !policyAllows(decl.id)) {
        if (!unconfirmedProcesses.includes(decl.id)) unconfirmedProcesses.push(decl.id);
        rows.push({
          id: `P:${part.id}`,
          target: `${node.name} ${version}`,
          check: 'check_printability',
          why: `process ${decl.id} is outside the approved set (${allowedIds.join(', ')})`,
          status: 'unobserved',
          evidence: { versionIds: [version], profileId: decl.id, processSource: decl.source, processConfirmed: false },
          next: 'ask the user once for an exception, or switch this part to an allowed process',
        });
      } else {
        if (!unconfirmedProcesses.includes(decl.id)) unconfirmedProcesses.push(decl.id);
        rows.push({
          id: `P:${part.id}`,
          target: `${node.name} ${version}`,
          check: 'check_printability',
          why: `process ${decl.id} is not confirmed (${decl.source})`,
          status: 'unobserved',
          evidence: { versionIds: [version], profileId: decl.id, processSource: decl.source, processConfirmed: false },
          next: 'approve the manufacturing policy, or confirm this process explicitly',
        });
      }
    } else {
      const partProcess = decl.id;
      const cap = processCapability(partProcess);
      if (!cap || !cap.verification.built) {
        rows.push({
          id: `P:${part.id}`,
          target: `${node.name} ${version}`,
          check: cap?.verification.evaluator ?? 'none',
          why: cap
            ? `${partProcess} [${cap.support}]: ${cap.verification.method}` +
              (cap.verification.built ? '' : ' — evaluator not built yet; inputs: ' + cap.verification.inputs.join(', '))
            : `unknown process id ${partProcess} (not in the process catalog)`,
          status: 'unobserved',
          evidence: { versionIds: [version], profileId: partProcess, processSource: decl.source, processConfirmed: true },
          next: cap
            ? 'implement/attach the named evaluator, or record a manual check; do not reuse the printability profile'
            : 'use a process id from the process catalog',
        });
      } else if (cap.verification.evaluator === 'check_printability') {
        const candidates = runs.filter((r) => r.kind === 'printability' && r.sourceVersionIds.includes(version));
        let picked: { run: RunEntry; report: RunReport | null } | null = null;
        for (const r of candidates) {
          const report = stores ? await readJson<RunReport>(join(stores.runStore.root, r.id, 'report.json')) : null;
          const profiles = (report?.profiles ?? []).map((p) => p.profileId).filter((x): x is string => !!x);
          if (profiles.includes(partProcess)) {
            picked = { run: r, report };
            break;
          }
        }
        if (!picked) {
          rows.push({
            id: `P:${part.id}`,
            target: `${node.name} ${version}`,
            check: 'check_printability',
            why: `no printability run under ${partProcess}`,
            status: 'unobserved',
            evidence: { versionIds: [version], profileId: partProcess, processSource: decl.source, processConfirmed: true },
            next: nextOf('check_printability', { versionId: version, profileIds: [partProcess] }),
          });
        } else {
          rows.push({
            id: `P:${part.id}`,
            target: `${node.name} ${version}`,
            check: 'check_printability',
            why: `measured under ${partProcess} (${decl.source === 'user' ? 'user-confirmed' : decl.source === 'policy' ? 'policy-delegated' : 'agent, confirmed'})`,
            status: statusOfPrintability(picked.report, picked.run),
            evidence: { runId: picked.run.id, versionIds: [version], profileId: partProcess, processSource: decl.source, processConfirmed: true },
            where: picked.report?.minWallAtMm
              ? { parts: [part.id], point: picked.report.minWallAtMm, note: `minWall ${picked.report.minWallMm ?? '?'} mm` }
              : { parts: [part.id] },
          });
        }
      } else if (cap.verification.evaluator === 'check_sheet2d') {
        const picked = runs
          .filter((r) => r.kind === 'sheet2d' && r.sourceVersionIds.includes(version))
          .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0] ?? null;
        if (!picked) {
          rows.push({
            id: `P:${part.id}`,
            target: `${node.name} ${version}`,
            check: 'check_sheet2d',
            why: `no 2D cut run under ${partProcess}`,
            status: 'unobserved',
            evidence: { versionIds: [version], profileId: partProcess, processSource: decl.source, processConfirmed: true },
            next: partProcess === 'sheet-metal-bend'
              ? `check_sheet2d(versionId:"${version}", kerfMm:..., minHoleMm:..., minFeatureMm:..., minSpacingMm:..., bendLines:[...], minHoleToBendMm:..., minFlangeMm:..., minBendReliefMm:...) — bendLines in section u/v`
              : `check_sheet2d(versionId:"${version}", kerfMm:..., minHoleMm:..., minFeatureMm:..., minSpacingMm:...) — declare the cut limits`,
          });
        } else {
          const report = stores
            ? await readJson<{ verdict?: string; unevaluable?: string[] }>(join(stores.runStore.root, picked.id, 'report.json'))
            : null;
          const verdict = report?.verdict ?? picked.judgement ?? 'not-excluded';
          const status = verdict === 'excluded' ? 'fail' : (report?.unevaluable?.length ? 'warn' : 'pass');
          rows.push({
            id: `P:${part.id}`,
            target: `${node.name} ${version}`,
            check: 'check_sheet2d',
            why: `2D cut screen under ${partProcess} (${decl.source === 'user' ? 'user-confirmed' : decl.source === 'policy' ? 'policy-delegated' : 'agent, confirmed'})`,
            status,
            evidence: { runId: picked.id, versionIds: [version], profileId: partProcess, processSource: decl.source, processConfirmed: true },
          });
        }
      } else if (cap.verification.evaluator === 'check_turning') {
        const picked = runs
          .filter((r) => r.kind === 'turning' && r.sourceVersionIds.includes(version))
          .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0] ?? null;
        if (!picked) {
          rows.push({
            id: `P:${part.id}`,
            target: `${node.name} ${version}`,
            check: 'check_turning',
            why: `no turning run under ${partProcess}`,
            status: 'unobserved',
            evidence: { versionIds: [version], profileId: partProcess, processSource: decl.source, processConfirmed: true },
            next: `check_turning(versionId:"${version}", barDiameterMm:..., maxLdRatio:..., symmetryToleranceMm:...) — declare the bar and limits`,
          });
        } else {
          const report = stores
            ? await readJson<{ verdict?: string }>(join(stores.runStore.root, picked.id, 'report.json'))
            : null;
          const verdict = report?.verdict ?? picked.judgement ?? 'not-excluded';
          const status = verdict === 'excluded' ? 'fail' : picked.status === 'check' ? 'warn' : 'pass';
          rows.push({
            id: `P:${part.id}`,
            target: `${node.name} ${version}`,
            check: 'check_turning',
            why: `turning screen under ${partProcess} (${decl.source === 'user' ? 'user-confirmed' : decl.source === 'policy' ? 'policy-delegated' : 'agent, confirmed'})`,
            status,
            evidence: { runId: picked.id, versionIds: [version], profileId: partProcess, processSource: decl.source, processConfirmed: true },
          });
        }
      } else {
        rows.push({
          id: `P:${part.id}`,
          target: `${node.name} ${version}`,
          check: cap.verification.evaluator ?? 'none',
          why: `${partProcess} [${cap.support}]: ${cap.verification.method} — evaluator is not wired into the plan yet`,
          status: 'unobserved',
          evidence: { versionIds: [version], profileId: partProcess, processSource: decl.source, processConfirmed: true },
          next: 'wire the named evaluator into deliver, or record a manual check',
        });
      }

      for (const add of cap?.verification.additional ?? []) {
        if (!add.built) {
          rows.push({
            id: `P:${part.id}:access`,
            target: `${node.name} ${version}`,
            check: add.evaluator,
            why: `${partProcess}: additional check ${add.evaluator} is not built`,
            status: 'unobserved',
            evidence: { versionIds: [version], profileId: partProcess, processSource: decl.source, processConfirmed: true },
            next: 'implement/attach the additional evaluator, or record a manual check',
          });
          continue;
        }
        if (add.evaluator === 'check_cnc_access') {
          const picked = runs
            .filter((r) => r.kind === 'machinability' && r.sourceVersionIds.includes(version))
            .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0] ?? null;
          if (!picked) {
            rows.push({
              id: `P:${part.id}:access`,
              target: `${node.name} ${version}`,
              check: 'check_cnc_access',
              why: `no CNC access run under ${partProcess}`,
              status: 'unobserved',
              evidence: { versionIds: [version], profileId: partProcess, processSource: decl.source, processConfirmed: true },
              next: `check_cnc_access(versionId:"${version}", maxSetups:...) — declare the setup budget`,
            });
          } else {
            const report = stores
              ? await readJson<{ verdict?: string }>(join(stores.runStore.root, picked.id, 'report.json'))
              : null;
            const verdict = report?.verdict ?? picked.judgement ?? 'not-excluded';
            const status = verdict === 'excluded' ? 'fail' : picked.status === 'check' ? 'warn' : 'pass';
            rows.push({
              id: `P:${part.id}:access`,
              target: `${node.name} ${version}`,
              check: 'check_cnc_access',
              why: `CNC six-direction access/setup screen under ${partProcess} (${decl.source === 'user' ? 'user-confirmed' : decl.source === 'policy' ? 'policy-delegated' : 'agent, confirmed'})`,
              status,
              evidence: { runId: picked.id, versionIds: [version], profileId: partProcess, processSource: decl.source, processConfirmed: true },
            });
          }
        } else if (add.evaluator === 'check_sheet2d') {
          const picked = runs
            .filter((r) => r.kind === 'sheet2d' && r.sourceVersionIds.includes(version))
            .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0] ?? null;
          if (!picked) {
            rows.push({
              id: `P:${part.id}:wire`,
              target: `${node.name} ${version}`,
              check: 'check_sheet2d',
              why: `no wire-EDM 2D cut run under ${partProcess}`,
              status: 'unobserved',
              evidence: { versionIds: [version], profileId: partProcess, processSource: decl.source, processConfirmed: true },
              next: `check_sheet2d(versionId:"${version}", kerfMm:..., minHoleMm:..., minFeatureMm:..., minSpacingMm:...) — wire kerf + limits`,
            });
          } else {
            const report = stores
              ? await readJson<{ verdict?: string; unevaluable?: string[] }>(join(stores.runStore.root, picked.id, 'report.json'))
              : null;
            const verdict = report?.verdict ?? picked.judgement ?? 'not-excluded';
            const status = verdict === 'excluded' ? 'fail' : (report?.unevaluable?.length ? 'warn' : 'pass');
            rows.push({
              id: `P:${part.id}:wire`,
              target: `${node.name} ${version}`,
              check: 'check_sheet2d',
              why: `wire-EDM 2D cut screen under ${partProcess} (${decl.source === 'user' ? 'user-confirmed' : decl.source === 'policy' ? 'policy-delegated' : 'agent, confirmed'})`,
              status,
              evidence: { runId: picked.id, versionIds: [version], profileId: partProcess, processSource: decl.source, processConfirmed: true },
            });
          }
        } else if (add.evaluator === 'check_edm_access') {
          const picked = runs
            .filter((r) => r.kind === 'edm' && r.sourceVersionIds.includes(version))
            .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0] ?? null;
          if (!picked) {
            rows.push({
              id: `P:${part.id}:sinker`,
              target: `${node.name} ${version}`,
              check: 'check_edm_access',
              why: `no EDM sinker access run under ${partProcess}`,
              status: 'unobserved',
              evidence: { versionIds: [version], profileId: partProcess, processSource: decl.source, processConfirmed: true },
              next: `check_edm_access(versionId:"${version}", burnAxis:...) — declare the burn axis`,
            });
          } else {
            const report = stores
              ? await readJson<{ verdict?: string }>(join(stores.runStore.root, picked.id, 'report.json'))
              : null;
            const verdict = report?.verdict ?? picked.judgement ?? 'not-excluded';
            const status = verdict === 'excluded' ? 'fail' : picked.status === 'check' ? 'warn' : 'pass';
            rows.push({
              id: `P:${part.id}:sinker`,
              target: `${node.name} ${version}`,
              check: 'check_edm_access',
              why: `EDM single-axis electrode access under ${partProcess} (${decl.source === 'user' ? 'user-confirmed' : decl.source === 'policy' ? 'policy-delegated' : 'agent, confirmed'})`,
              status,
              evidence: { runId: picked.id, versionIds: [version], profileId: partProcess, processSource: decl.source, processConfirmed: true },
            });
          }
        }
      }
    }

    const review = stores ? await readVisualReview(stores.store, version) : undefined;
    const versionTime = project.versionTimes.get(version) ?? '';
    const fresh = reviewIsFresh(review, versionTime) && reviewCoversRequiredViews(review);
    const next = fresh ? undefined : nextOf('review_visual', { versionId: version, views: ['top', 'iso'] });
    rows.push({
      id: `V:${part.id}`,
      target: `${node.name} ${version}`,
      check: 'review_visual',
      why: !review
        ? 'no per-version visual review record'
        : fresh
          ? 'fresh top+iso review record'
          : 'review exists but is stale or missing a required view',
      status: fresh ? 'pass' : review ? 'warn' : 'unobserved',
      evidence: { versionIds: [version], ...(review?.reviewedAt ? { reviewedAt: review.reviewedAt } : {}) },
      ...(next ? { next } : {}),
    });
  }

  // ── interfaces: the executable ICD ────────────────────────────────────────
  const interfaces: { owner: string; iface: ManifestInterface }[] = [];
  if (assembly) {
    const walk = (n: ManifestNode) => {
      for (const i of n.interfaces ?? []) interfaces.push({ owner: n.id, iface: i });
      for (const c of n.children ?? []) walk(c);
    };
    walk(assembly.root);
  }
  const resultByInterface = new Map<string, { verdict: string; measured?: number; detail?: string }>();
  for (const r of asmCheckReport?.results ?? []) resultByInterface.set(r.interfaceId, r);

  for (const { owner, iface } of interfaces) {
    const result = resultByInterface.get(iface.id);
    const motionRunId = typeof (iface.params as unknown as { runId?: unknown })?.runId === 'string'
      ? ((iface.params as unknown as { runId: string }).runId)
      : null;
    const motionRun = motionRunId ? runs.find((r) => r.id === motionRunId) ?? null : null;
    const motionStale = motionRun
      ? !motionRun.sourceVersionIds.every((v) => versionSet.includes(v))
      : false;

    let status: PlanStatus = 'unobserved';
    let why = '';
    let next: string | undefined;
    let evidence: PlanEvidence | undefined;

    if (!asmCheck) {
      why = 'no check_assembly run for the current version set';
      next = nextOf('check_assembly', {});
    } else if (!contractFresh) {
      why = `check_assembly ${asmCheck.id} predates the current manifest (hash changed); re-run it`;
      next = nextOf('check_assembly', {});
    } else if (!result) {
      why = `check_assembly ${asmCheck.id} has no result for ${iface.id}`;
      next = nextOf('check_assembly', {});
    } else if (result.verdict === 'hard-violation') {
      status = 'fail';
      why = result.detail ?? 'hard violation';
    } else if (result.verdict === 'intent-flag') {
      status = 'warn';
      why = result.detail ?? 'intent flag';
    } else if (result.verdict === 'skipped') {
      why = result.detail ?? 'skipped: no implementable operator or missing tolerance';
    } else {
      status = 'pass';
      why = result.detail ?? 'pass';
      evidence = { runId: asmCheck.id };
    }

    if (iface.check === 'motion-clearance') {
      if (!motionRunId) {
        status = 'unobserved';
        why = 'motion-clearance has no params.runId';
      } else if (!motionRun) {
        status = 'unobserved';
        why = `cited motion run ${motionRunId} does not exist`;
      } else if (motionStale) {
        status = 'warn';
        why = `motion run ${motionRunId} cites a version that is no longer current`;
      } else if (status === 'pass') {
        status = statusOfRun(motionRun);
        why = `motion evidenced by ${motionRun.id} (${motionRun.summary ?? ''})`;
        evidence = { runId: motionRun.id };
      }
    }

    // Interface ids are stable inside a manifest; the row id uses them.
    rows.push({
      id: `I:${iface.id}`,
      target: `${owner}.${iface.a} ↔ ${owner}.${iface.b}`,
      check: iface.check ?? iface.type,
      why,
      status,
      ...(evidence ? { evidence } : {}),
      ...(next ? { next } : {}),
    });
  }

  // ── assembly interference ────────────────────────────────────────────────
  rows.push({
    id: 'A:assembly',
    target: 'assembly (validate_assembly)',
    check: 'validate_assembly',
    why: asmRun ? `interference run ${asmRun.id} (${asmRun.summary ?? ''})` : 'no validate_assembly run for the current version set',
    status: asmRun ? statusOfRun(asmRun) : 'unobserved',
    ...(asmRun ? { evidence: { runId: asmRun.id } } : {}),
    ...(asmRun ? {} : { next: nextOf('validate_assembly', {}) }),
  });

  // ── claims ───────────────────────────────────────────────────────────────
  if (claims.claims.length === 0) {
    gaps.push({
      code: 'no-claims',
      what: 'no delivery claim declared',
      why: 'the corpus can be audited, but no delivery assertion is on record',
      next: 'write claims.json when you intend to deliver (kind + statement)',
    });
  }
  for (const [i, claim] of claims.claims.entries()) {
    const check = claim.checkId
      ? verification.report.checks.find((c) => c.id === claim.checkId) ?? null
      : null;
    let status: PlanStatus = 'unobserved';
    let why = '';
    let evidence: PlanEvidence | undefined;
    let next: string | undefined;
    if (claim.checkId) {
      if (!check) {
        why = `custom check ${claim.checkId} is not mounted`;
        next = 'run verify --checks, or register the check';
      } else if (check.status === 'pass') {
        status = check.late ? 'warn' : 'pass';
        why = check.late ? `${claim.checkId} passed but was registered after the geometry (advisory)` : `${claim.checkId} passed`;
        evidence = { checkId: check.id };
        next = check.late ? 'register the check before the next version if it must witness' : undefined;
      } else {
        status = check.status === 'fail' || check.status === 'blocked' ? 'fail' : 'warn';
        why = `${claim.checkId} returned ${check.status}`;
        next = 'inspect the check findings, then re-run it';
      }
    } else {
      const spec = CLAIM_EVIDENCE[claim.kind as DeliveryClaim['kind']];
      const kinds = spec?.kinds ?? [];
      const run = runs.find((r) => kinds.includes(r.kind) && setEqual(r.sourceVersionIds, versionSet));
      if (run) {
        status = statusOfRun(run);
        why = `${spec?.label ?? claim.kind} witnessed by ${run.id}`;
        evidence = { runId: run.id };
      } else {
        why = `no fresh ${kinds.join('/')} run for ${claim.kind}`;
        next = `run ${kinds[0] ?? 'the matching check'} for the current versions`;
      }
    }
    rows.push({
      id: `C:${i + 1}`,
      target: claim.statement,
      check: claim.checkId ?? `claim:${claim.kind}`,
      why,
      status,
      ...(evidence ? { evidence } : {}),
      ...(next ? { next } : {}),
    });
  }

  // ── declared gaps (what this plan cannot establish) ──────────────────────
  if (printedParts.some((p) => roleOfVersion(parts, p.node.version as string) === 'printed') && !manufacturing && !effectiveProcess) {
    gaps.push({
      code: 'process-undeclared',
      what: 'printed parts have no declared process',
      why: 'a printability verdict is only meaningful against a process; the latest run may be a diagnostic of a different one',
      next: 'ask the user once for the allowed process set, record manufacturing.allowed + approvedBy, then assign parts within it',
    });
  }
  if (unconfirmedProcesses.length > 0) {
    gaps.push({
      code: 'process-unconfirmed',
      what: `process not covered by a user-approved set: ${unconfirmedProcesses.join(', ')}`,
      why: 'the process is a design intent plus the user\'s equipment; one approved policy delegates the per-part choice, an outside choice needs one exception decision',
      next: 'ask the user via request_review, then set process.source="user" or add confirmedBy',
    });
  }
  if (effectiveProcess && /inject/i.test(effectiveProcess)) {
    gaps.push({
      code: 'injection-screen',
      what: 'injection screen covers wall/feature/gap; draft is unevaluable and sink/warp/gate are not modelled',
      why: 'not-excluded means "not excluded by this screen", not "moldable"',
      next: 'do not read not-excluded as a moldability certificate',
    });
  }
  if (assembly && interfaces.length > 0 && !interfaces.some((x) => x.iface.check === 'motion-clearance')) {
    gaps.push({
      code: 'no-motion-in-contract',
      what: 'the contract has no motion-clearance interface',
      why: 'a green contract cannot speak about a moving mechanism',
      next: 'add motion-clearance with a cited run, or explain why motion does not apply',
    });
  }
  if (asmCheck && !contractFresh) {
    gaps.push({
      code: 'contract-stale',
      what: `the assembly manifest changed after ${asmCheck.id}; the interface check is stale`,
      why: 'a BOM/ICD edit invalidates the check that audited the old manifest',
      next: 're-run check_assembly on the current manifest',
    });
  }
  if (asmRun) {
    const asmRuns = runs.filter((r) => r.kind === 'assembly' && r.sourceVersionIds.every((v) => versionSet.includes(v)));
    if (asmRuns.length > 1) {
      gaps.push({
        code: 'assembly-states',
        what: `${asmRuns.length} assembly runs exist for current versions; the plan cites ${asmRun.id}`,
        why: 'validate_assembly checks the poses in one run; a mechanism can have several states',
        next: 'cite each state explicitly, or declare the state set in the claim/BOM',
      });
    }
  }
  if (verification.report.checks.some((c) => c.late)) {
    gaps.push({
      code: 'late-check',
      what: 'a custom check was registered after the geometry',
      why: 'pre-registration is what makes a check a witness; late results are advisory',
      next: 'register before the next version',
    });
  }

  const planVerdict: DeliveryPlan['planVerdict'] = rows.some((r) => r.status === 'fail' || r.status === 'blocked')
    ? 'excluded'
    : rows.some((r) => r.status === 'unobserved')
      ? 'blocked'
      : rows.some((r) => r.status === 'warn')
        ? 'difficult'
        : 'not-excluded';

  const summary: Record<PlanStatus | 'total', number> = {
    total: rows.length, pass: 0, warn: 0, fail: 0, blocked: 0, unobserved: 0, exempt: 0,
  };
  for (const r of rows) summary[r.status] += 1;

  const report = verification.report;
  if (planVerdict !== report.verdict) {
    gaps.push({
      code: 'corpus-vs-plan',
      what: `plan says ${planVerdict}, the corpus audit says ${report.verdict}`,
      why: 'the audit may be counting a printability run under a process this plan does not claim',
      next: 'check the blocking run\'s profile, or declare the process in the claim',
    });
  }
  return {
    project: project.root,
    process: effectiveProcess,
    processSource: defaultProcess?.source ?? null,
    planVerdict,
    verdict: report.verdict,
    rows,
    gaps,
    summary,
    verification: {
      generatedAt: report.generatedAt,
      verdict: report.verdict,
      rows: report.rows.map((r) => ({ id: r.id, status: r.status })),
      findings: report.findings.map((f) => ({ id: f.id, code: f.code, severity: f.severity, what: f.what })),
      checks: report.checks.map((c) => ({ id: c.id, status: c.status, ...(c.late ? { late: true } : {}) })),
    },
  };
}
