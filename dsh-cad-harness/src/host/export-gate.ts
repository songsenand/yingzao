// Risk-annotated export gate (C1).
//
// The gate is deliberately NOT a hard refusal: a user may still export a
// blocked corpus, but the download must carry the risk in three places that
// survive different kinds of inattention:
//
//   1. the UI dialog (the user has to acknowledge the findings),
//   2. the file name (`_UNVERIFIED`),
//   3. the export manifest + `UNVERIFIED.md` (auditable after a rename).
//
// The server never writes an export file for a blocked corpus without an
// explicit `confirm=1&reason=...`; the dialog is not a client-only decoration.

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { auditDelivery, type AuditFinding, type DeliveryAudit, type DeliveryClaim } from './delivery-audit.ts';
import { verify, type VerifyResult } from './verify/index.ts';
import type { ProjectStores } from './project.ts';

export type ExportVerdict = 'pass' | 'difficult' | 'blocked';

export interface ExportGate {
  verdict: ExportVerdict;
  audit: DeliveryAudit;
  findings: AuditFinding[];
  claims: DeliveryClaim[];
  /** The verify policy that participated in the decision (C1 §3.1). */
  policy: VerifyResult['report']['policy'];
  /** Evidence ids verify could not check; never an empty "everything checked". */
  notCovered: string[];
  /** Why the export is blocked/difficult, in the order a reader should act. */
  nextLook: string[];
}

export interface ExportManifest {
  schemaVersion: 1;
  exportId: string;
  exportedAt: string;
  project: string;
  format: string;
  verdict: ExportVerdict;
  findings: AuditFinding[];
  versions: string[];
  override?: { reason: string; confirmedAt: string; surface: 'web' | 'cli' };
  /** Present when a policy file/flag participated; shape mirrors verify. */
  policy?: VerifyResult['report']['policy'];
  files: { path: string; sha256: string; bytes: number }[];
  notCovered: string[];
}

const NEXT_LOOK: Record<ExportVerdict, string[]> = {
  blocked: [
    'run delivery_audit / preflight and read the blocked findings',
    'fix the blocked finding, or confirm the export and record the reason',
    're-export after the fix so the file name no longer says _UNVERIFIED',
  ],
  difficult: [
    'read the findings; difficult is not a pass',
    'run the missing check, or declare why the remaining risk is acceptable',
  ],
  pass: [],
};

/** Read claims.json if present; an unreadable file is a blocking finding, not silence. */
export async function readProjectClaims(project: ProjectStores): Promise<{
  claims: DeliveryClaim[];
  findings: AuditFinding[];
}> {
  const file = join(project.cwd, 'claims.json');
  try {
    const text = await readFile(file, 'utf8');
    const parsed = JSON.parse(text) as { claims?: unknown };
    if (!Array.isArray(parsed.claims)) {
      return { claims: [], findings: [{ severity: 'blocked', code: 'claims-unreadable', detail: `${file}: claims[] missing` }] };
    }
    const claims: DeliveryClaim[] = [];
    const findings: AuditFinding[] = [];
    for (const [i, raw] of parsed.claims.entries()) {
      const item = raw as { kind?: unknown; statement?: unknown };
      if (typeof item?.kind !== 'string' || typeof item?.statement !== 'string') {
        findings.push({ severity: 'blocked', code: 'claims-unreadable', detail: `${file}: claims[${i}] needs kind + statement` });
        continue;
      }
      claims.push({ kind: item.kind as DeliveryClaim['kind'], statement: item.statement });
    }
    return { claims, findings };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { claims: [], findings: [] };
    return {
      claims: [],
      findings: [{ severity: 'blocked', code: 'claims-unreadable', detail: `${file}: ${String((error as Error)?.message ?? error)}` }],
    };
  }
}

/**
 * Audit the corpus once, before any export route writes bytes.
 *
 * `blocked` wins over `difficult`; a missing claim file is not a pass. The audit
 * itself already treats unobserved evidence as a finding, so this is a
 * classification, not a second opinion.
 */
/** Pure classification so the route, tests, and any future CLI agree. */
export function classifyExport(
  findings: readonly AuditFinding[],
  auditVerdict: DeliveryAudit['verdict'] | VerifyResult['report']['verdict'],
): ExportVerdict {
  if (findings.some((f) => f.severity === 'blocked') || auditVerdict === 'excluded' || auditVerdict === 'blocked' || auditVerdict === 'fail') return 'blocked';
  if (auditVerdict === 'difficult' || auditVerdict === 'warn' || auditVerdict === 'unobserved' || findings.some((f) => f.severity === 'warn')) return 'difficult';
  return 'pass';
}

export async function auditExport(project: ProjectStores): Promise<ExportGate> {
  const { claims } = await readProjectClaims(project);
  // C1 §3.1: the gate is auditDelivery + verify's policy. Calling verify also
  // runs the audit; do it once and read both halves from the same report.
  const verified = await verify({ projectRoot: project.cwd, noChecks: true });
  const audit = verified.audit ?? await auditDelivery(project, { claims });
  const findings: AuditFinding[] = verified.report.findings
    .filter((f) => f.severity !== 'info')
    .map((f) => ({ severity: f.severity, code: f.code, detail: `${f.what}${f.why?.length ? ` — ${f.why.join('; ')}` : ''}` }));
  const verdict = classifyExport(findings, verified.report.verdict);
  return {
    verdict,
    audit,
    findings,
    claims,
    policy: verified.report.policy,
    notCovered: verified.report.coverage.missing,
    nextLook: NEXT_LOOK[verdict],
  };
}

/** `part_v012.stl` -> `part_v012_UNVERIFIED.stl`; idempotent. */
export function annotateDownloadName(name: string): string {
  if (/_UNVERIFIED(\.[^.]+)?$/.test(name)) return name;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return `${name}_UNVERIFIED`;
  return `${name.slice(0, dot)}_UNVERIFIED${name.slice(dot)}`;
}

export function newExportId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  return `exp-${stamp}-${randomBytes(3).toString('hex')}`;
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function buildExportManifest(input: {
  exportId: string;
  project: ProjectStores;
  format: string;
  gate: ExportGate;
  files: { path: string; bytes: Uint8Array }[];
  versions?: string[];
  override?: { reason: string; surface: 'web' | 'cli' };
  now?: Date;
}): ExportManifest {
  const now = input.now ?? new Date();
  return {
    schemaVersion: 1,
    exportId: input.exportId,
    exportedAt: now.toISOString(),
    project: input.project.cwd,
    format: input.format,
    verdict: input.gate.verdict,
    findings: input.gate.findings,
    versions: input.versions ?? [],
    override: input.override ? { ...input.override, confirmedAt: now.toISOString() } : undefined,
    policy: input.gate.policy,
    files: input.files.map((f) => ({ path: f.path, sha256: sha256(f.bytes), bytes: f.bytes.byteLength })),
    notCovered: input.gate.notCovered,
  };
}

/** Human-readable companion that survives a renamed download. */
export function buildUnverifiedReadme(manifest: ExportManifest): string {
  const lines = [
    '# 未验证导出 / UNVERIFIED EXPORT',
    '',
    `- 导出 ID: ${manifest.exportId}`,
    `- 导出时间: ${manifest.exportedAt}`,
    `- 判定: ${manifest.verdict}`,
    `- 格式: ${manifest.format}`,
    '',
    '这个文件来自一个交付审计未通过的语料。文件名里的 `_UNVERIFIED` 是提示，',
    '不是合格证；改名不会让风险消失。',
    '',
  ];
  if (manifest.findings.length) {
    lines.push('## 阻塞/警告项', '');
    for (const f of manifest.findings) lines.push(`- [${f.severity}] ${f.code}: ${f.detail}`);
    lines.push('');
  }
  if (manifest.override) {
    lines.push('## 用户确认', '', `- 原因: ${manifest.override.reason}`, `- 时间: ${manifest.override.confirmedAt}`, '');
  }
  lines.push('修复后用同一路径重新导出；通过的导出不会带 `_UNVERIFIED`。', '');
  return lines.join('\n');
}

/** Persist the audit trail next to the project, not just in the tool reply. */
export async function writeExportRecord(
  project: ProjectStores,
  manifest: ExportManifest,
  readme?: string,
): Promise<string> {
  const dir = join(project.cwd, 'exports', manifest.exportId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  if (readme) await writeFile(join(dir, 'UNVERIFIED.md'), readme, 'utf8');
  return dir;
}
