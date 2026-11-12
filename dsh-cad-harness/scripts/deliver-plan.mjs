#!/usr/bin/env node
// Read-only delivery plan. Derives the checks from the BOM/ICD + claims + run graph
// and prints a drill-down tree. It never runs CAD and never writes a run.
//
//   deliver-plan <project-dir> [--process <profileId>] [--json]

import { parseArgs } from 'node:util';
import { buildDeliveryPlan } from '../src/host/deliver-plan.ts';

const USAGE = `usage: deliver-plan <project-dir> [options]

  --process <id>   declare the manufacturing process (e.g. injection-pp, fdm-pla-0.4)
  --json           print the plan as JSON
  -h, --help       show this help`;

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        process: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    console.error(`deliver-plan: ${String(e?.message ?? e)}`);
    console.error(USAGE);
    process.exitCode = 3;
    return;
  }
  const { values, positionals } = parsed;
  if (values.help || positionals.length === 0) {
    console.log(USAGE);
    process.exitCode = values.help ? 0 : 3;
    return;
  }
  const projectRoot = positionals[0];
  const plan = await buildDeliveryPlan(projectRoot, {
    ...(values.process ? { process: values.process } : {}),
    checks: true,
  });

  if (values.json) {
    console.log(JSON.stringify(plan, null, 1));
    return;
  }

  const order = { fail: 0, blocked: 0, unobserved: 1, warn: 2, pass: 3, exempt: 4 };
  const rows = [...plan.rows].sort((a, b) => order[a.status] - order[b.status]);
  const lines = [];
  lines.push(`deliver-plan → ${plan.planVerdict} (corpus verify: ${plan.verdict})`);
  lines.push(`project: ${plan.project}`);
  lines.push(`process: ${plan.process ?? '(undeclared)'}${plan.processSource ? ` (${plan.processSource})` : ''}`);
  lines.push(`plan: ${plan.summary.total} rows · pass ${plan.summary.pass} · warn ${plan.summary.warn} · ` +
    `fail ${plan.summary.fail} · unobserved ${plan.summary.unobserved} · exempt ${plan.summary.exempt}`);
  lines.push('');
  for (const r of rows.slice(0, 40)) {
    lines.push(`[${r.status}] ${r.id} ${r.check}`);
    lines.push(`  ${r.target}`);
    lines.push(`  why: ${r.why}`);
    if (r.evidence?.runId) lines.push(`  evidence: ${r.evidence.runId}${r.evidence.profileId ? ` (${r.evidence.profileId})` : ''}`);
    if (r.evidence?.checkId) lines.push(`  evidence: check ${r.evidence.checkId}`);
    if (r.where?.point) lines.push(`  where: [${r.where.point.join(', ')}]`);
    if (r.next) lines.push(`  next: ${r.next}`);
  }
  if (rows.length > 40) lines.push(`… ${rows.length - 40} more row(s); use --json`);
  if (plan.gaps.length) {
    lines.push('');
    lines.push('declared gaps (not established by this plan):');
    for (const g of plan.gaps) lines.push(`  - ${g.code}: ${g.what} — ${g.next}`);
  }
  lines.push('');
  lines.push('verification rows: ' + plan.verification.rows.map((r) => `${r.id}=${r.status}`).join(' · '));
  console.log(lines.join('\n'));
}

main().catch((e) => {
  console.error(`deliver-plan: ${String(e?.stack ?? e)}`);
  process.exitCode = 1;
});
