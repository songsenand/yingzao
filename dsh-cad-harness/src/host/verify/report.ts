// Report assembly and rendering. The report is a derived snapshot: it is written
// only by `--out` / the CLI, and no reader feeds it back into the tools.

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeJsonAtomic } from '../file-lock.ts';
import { verdictOf, type AppliedException } from './policy.ts';
import type { LoadedVerifyProject } from './project.ts';
import type {
  FindingDraft, RowDraft, VerifyCheck, VerifyFinding, VerifyPolicy, VerifyReport, VerifyRow,
} from './types.ts';

type LoadedProject = LoadedVerifyProject;

const ROW_RANK: Record<string, number> = { requirements: 0, model: 1, fit: 2, make: 3, review: 4, delivery: 5 };
const OUTCOME_RANK: Record<FindingDraft['outcome'], number> = { blocked: 0, fail: 1, warn: 2, info: 3 };

export interface AssembleInput {
  project: LoadedProject;
  rows: RowDraft[];
  claimsHash?: string;
  policySource: 'file' | 'flags' | 'none';
  policyMode: 'advisory' | 'blocking';
  policy: VerifyPolicy | null;
  policyHash?: string;
  exceptions: AppliedException[];
  checks: VerifyCheck[];
}

export function toolVersions(): Record<string, string | null> {
  return {
    node: process.version,
    openscad: process.env.CAD_OPENSCAD_BIN ?? null,
    python: process.env.DSH_CAD_PYTHON ?? null,
  };
}

function findingOf(draft: FindingDraft, id: string): VerifyFinding {
  return {
    id,
    code: draft.code,
    severity: draft.severity,
    what: draft.what,
    why: draft.why,
    where: draft.where,
    next: draft.next,
    ...(draft.witness ? { witness: draft.witness } : {}),
    ...(draft.exceptionId ? { exceptionId: draft.exceptionId } : {}),
    ...(draft.checkId ? { checkId: draft.checkId } : {}),
  };
}

export function assembleReport(input: AssembleInput): VerifyReport {
  const byId = new Map(input.rows.map((r) => [r.id, r]));
  const rowsInOrder = (['requirements', 'model', 'fit', 'make', 'review', 'delivery'] as const)
    .map((id) => byId.get(id))
    .filter((r): r is RowDraft => !!r);

  const findings: VerifyFinding[] = [];
  const findingIdsByCheck = new Map<string, string[]>();
  const rows: VerifyRow[] = [];
  for (const row of rowsInOrder) {
    const drafts = [...row.findings].sort((a, b) => {
      const o = OUTCOME_RANK[a.outcome] - OUTCOME_RANK[b.outcome];
      return o !== 0 ? o : a.code.localeCompare(b.code);
    });
    const ids: string[] = [];
    for (const d of drafts) {
      const id = `F${findings.length + 1}`;
      findings.push(findingOf(d, id));
      ids.push(id);
      if (d.checkId) {
        const arr = findingIdsByCheck.get(d.checkId) ?? [];
        arr.push(id);
        findingIdsByCheck.set(d.checkId, arr);
      }
    }
    rows.push({
      id: row.id,
      label: row.label,
      status: row.status,
      checked: row.checked,
      missing: row.missing,
      findingIds: ids,
      ...(row.note ? { note: row.note } : {}),
    });
  }

  const checks = input.checks
    .map((c) => ({ ...c, findingIds: findingIdsByCheck.get(c.id) ?? [] }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const checked = [...new Set(rows.flatMap((r) => r.checked.map((c) => c.runId ?? c.kind)))].sort();
  const missing = [...new Set(rows.flatMap((r) => r.missing.map((m) => m.evidence)))].sort();
  const runIds = [...new Set(rows.flatMap((r) => r.checked.flatMap((c) => (c.runId ? [c.runId] : []))))].sort();

  const policy: VerifyReport['policy'] = {
    source: input.policySource,
    mode: input.policyMode,
    ...(input.policy?.id ? { id: input.policy.id } : {}),
    ...(input.policyHash ? { hash: input.policyHash } : {}),
  };

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    project: input.project.root,
    depth: 'read',
    policy,
    inputs: {
      versions: [...input.project.currentVersionSet].sort(),
      ...(input.claimsHash ? { claimsHash: input.claimsHash } : {}),
      rulepack: input.project.rulepack?.manifest.id ?? null,
    },
    verdict: verdictOf(rows),
    rows,
    findings,
    checks,
    coverage: { checked, missing },
    exceptions: [...input.exceptions].sort((a, b) => a.id.localeCompare(b.id)),
    provenance: { toolVersions: toolVersions(), runIds },
  };
}

function whereText(where: VerifyFinding['where']): string {
  if (where.kind === 'pair' || where.kind === 'interface') {
    const parts = where.parts?.join('↔') ?? '?';
    const at = where.center ? ` @ [${where.center.map((n) => Math.round(n)).join(', ')}]` : '';
    return `${where.kind} ${parts}${at}`;
  }
  if (where.kind === 'part') {
    const parts = where.parts?.join(', ') ?? '?';
    const at = where.point ? ` @ [${where.point.map((n) => Math.round(n)).join(', ')}]` : '';
    return `part ${parts}${at}`;
  }
  if (where.kind === 'manifest') return `manifest${where.note ? ` (${where.note})` : ''}`;
  return `unknown${where.note ? ` (${where.note})` : ''}`;
}

function rowLine(row: VerifyRow): string {
  const bits: string[] = [];
  if (row.note) bits.push(row.note);
  if (row.checked.length) bits.push(`${row.checked.length} run(s)`);
  if (row.missing.length) bits.push(`${row.missing.length} missing`);
  return `${row.id.padEnd(13)}${row.status.padEnd(12)} ${bits.join(' · ')}`;
}

export function renderText(report: VerifyReport): string {
  const mode = report.policy.mode;
  const policy = report.policy.id ?? (report.policy.source === 'none' ? 'none' : report.policy.source);
  const lines = [`verify: ${report.verdict} (${mode}) · policy ${policy}`];
  for (const row of report.rows) lines.push(rowLine(row));
  if (report.interfaces) {
    const i = report.interfaces;
    const bits = (['pass', 'fail', 'flagged', 'skipped', 'unproven'] as const)
      .filter((k) => i.counts[k] > 0 || k === 'unproven')
      .map((k) => `${k} ${i.counts[k]}`);
    const source = i.runId ? `${i.runId}${i.fresh ? ' fresh (manifest versions)' : ' STALE'}` : 'no run';
    lines.push(`interfaces  ${i.total} · parts ${i.parts} · ${bits.join(' · ')} · ${source}${i.orphans ? ` · ${i.orphans} orphan` : ''}`);
    const attention = i.items
      .filter((x) => x.status === 'fail' || x.status === 'flagged' || x.status === 'unproven')
      .slice(0, 6)
      .map((x) => `${x.id} ${x.status}`);
    if (attention.length) {
      const more = i.counts.fail + i.counts.flagged + i.counts.unproven - attention.length;
      lines.push(`  interface issues: ${attention.join(', ')}${more > 0 ? ` (+${more})` : ''}`);
    }
  }
  if (report.checks.length > 0) {
    const shown = report.checks.slice(0, 6).map((c) => `${c.id} ${c.status}${c.late ? ' late' : ''} (${c.row})`);
    lines.push(`checks: ${shown.join(' · ')}${report.checks.length > 6 ? ` · +${report.checks.length - 6}` : ''}`);
  }

  const visible = report.findings
    .filter((f) => f.severity !== 'info')
    .sort((a, b) => (a.severity === 'blocked' ? 0 : 1) - (b.severity === 'blocked' ? 0 : 1) || a.code.localeCompare(b.code));
  const infoCount = report.findings.filter((f) => f.severity === 'info').length;
  for (const f of visible.slice(0, 8)) {
    lines.push(`! ${f.code} @ ${whereText(f.where)} — ${f.what}${f.exceptionId ? ` [exception ${f.exceptionId}]` : ''}`);
  }
  if (visible.length > 8) {
    // A count alone tells the reader something is hidden but not what. Codes
    // keep the line cheap and let a new session ask the right next question.
    const hidden = [...new Set(visible.slice(8).map((f) => f.code))];
    lines.push(`  … ${visible.length - 8} more: ${hidden.slice(0, 8).join(', ')}${hidden.length > 8 ? ', …' : ''} (full list: --json)`);
  }
  if (infoCount) lines.push(`  ${infoCount} info finding(s)`);

  const next = [...new Set(visible.flatMap((f) => f.next))].slice(0, 5);
  if (next.length) lines.push(`next: ${next.join(' · ')}`);
  return lines.join('\n');
}

/** Canonical JSON for --out and deterministic diffing. `generatedAt` is the only
 *  field that changes between runs; tests strip it before comparing. */
export function canonicalJson(report: VerifyReport): string {
  const sorted: VerifyReport = {
    ...report,
    inputs: { ...report.inputs, versions: [...report.inputs.versions].sort() },
    rows: [...report.rows].sort((a, b) => (ROW_RANK[a.id] ?? 9) - (ROW_RANK[b.id] ?? 9)),
    findings: [...report.findings].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1))),
    checks: [...report.checks].sort((a, b) => a.id.localeCompare(b.id)),
    coverage: { checked: [...report.coverage.checked].sort(), missing: [...report.coverage.missing].sort() },
    exceptions: [...report.exceptions].sort((a, b) => a.id.localeCompare(b.id)),
    provenance: { ...report.provenance, runIds: [...report.provenance.runIds].sort() },
  };
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

export async function writeReport(path: string, report: VerifyReport): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeJsonAtomic(path, report);
  return path;
}
