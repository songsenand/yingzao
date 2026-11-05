// Output style: quiet when correct, loud when wrong.
// Pass -> one line. Warn/repair-needed -> compact issue list.
// Blocked/fail -> full what/why/where/next for each failure.

import type { ContractRoundResult } from './execute.ts';
import type { SpatialLocation } from './failure.ts';

function where(loc: SpatialLocation): string {
  if (loc.kind === 'pair' || loc.kind === 'interface') {
    const parts = loc.parts?.join(' ↔ ') ?? '?';
    const center = loc.center ? ` @ [${loc.center.map((n) => Math.round(n)).join(', ')}]` : '';
    return `${loc.kind} ${parts}${center} (approx${loc.note ? `; ${loc.note}` : ''})`;
  }
  if (loc.kind === 'part') return `part ${loc.parts?.join(', ') ?? '?'}${loc.point ? ` @ [${loc.point.map((n) => Math.round(n)).join(', ')}]` : ''}`;
  if (loc.kind === 'manifest') return `manifest${loc.note ? ` (${loc.note})` : ''}`;
  return `unknown${loc.note ? ` (${loc.note})` : ''}`;
}

export function formatContractRound(result: ContractRoundResult): string {
  const head = `pearl: ${result.status} · round ${result.round}/${result.maxRounds}${result.timedOut ? ` · deadline ${result.deadlineMs}ms` : ''}`;
  if (result.status === 'pass') return head;
  if (result.status === 'warn' || result.status === 'repair-needed') {
    const lines = [head + (result.next.length ? ` · next ${result.next.join(',')}` : '')];
    for (const f of result.failures.slice(0, 8)) lines.push(`  ! ${f.code} @ ${where(f.location)}`);
    if (result.failures.length > 8) lines.push(`  … ${result.failures.length - 8} more`);
    return lines.join('\n');
  }
  const lines = [head + (result.next.length ? ` · next ${result.next.join(',')}` : '')];
  for (const f of result.failures) {
    lines.push(`✗ ${f.code} [${f.severity}]`);
    lines.push(`  what: ${f.what}`);
    for (const why of f.why.slice(0, 3)) lines.push(`  why:  ${why}`);
    lines.push(`  where: ${where(f.location)}`);
    if (f.next.length) lines.push(`  next: ${f.next.join('; ')}`);
  }
  return lines.join('\n');
}

export interface TemplateTraceLike {
  status: string;
  next?: string;
  steps: { id: string; tool: string; status: string; durationMs: number; attempts: number; error?: string; explanationRequired?: boolean; attention?: string[] }[];
  explanations?: string[];
}

/** Quiet pass, loud failure for an actual template dispatch. */
export function formatTemplateExecution(result: TemplateTraceLike): string {
  const head = `pearl: ${result.status}${result.next ? ` · next ${result.next}` : ''} · ${result.steps.length} step(s)`;
  if (result.status === 'pass') {
    if (result.explanations?.length) return `${head} · explanation required: ${result.explanations.join('; ')}`;
    return head;
  }
  const lines = [head];
  if (result.explanations?.length) lines.push(`⚠ explanation required: ${result.explanations.join('; ')}`);
  for (const s of result.steps) {
    if (s.status === 'pass') continue;
    lines.push(`✗ ${s.id} (${s.tool}) · ${s.status} · ${s.durationMs}ms · attempts ${s.attempts}`);
    if (s.error) lines.push(`  ${s.error}`);
  }
  return lines.join('\n');
}
