#!/usr/bin/env node
// V1 evidence verification CLI. Read-only: no CAD, no runs written.
//
//   verify <project-dir> [--claims <file>] [--policy <file>]
//          [--json] [--out <file>] [--block | --advisory] [--strict]
//          [--require-claims] [--rulepack <dir>]

import { parseArgs } from 'node:util';
import { verify } from '../src/host/verify/index.ts';
import { canonicalJson, renderText, writeReport } from '../src/host/verify/report.ts';

const USAGE = `usage: verify <project-dir> [options]

  --claims <file>      claims JSON (default: <project>/claims.json)
  --policy <file>      evidence policy JSON (default: <project>/evidence-policy.json)
  --rulepack <dir>     override the rule pack directory
  --json               print the JSON report instead of the text summary
  --out <file>         also write the JSON report to this path
  --block              blocking mode (exit 1/2 on warn/blocked|fail)
  --advisory           advisory mode (exit 0; still reports the verdict)
  --strict             blocking mode: warn also exits 2
  --require-claims     block when no claims are declared
  -h, --help           show this help

Exit: 0 pass (advisory always 0) · 1 warn (blocking) · 2 blocked/fail · 3 usage/error`;

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        claims: { type: 'string' },
        policy: { type: 'string' },
        rulepack: { type: 'string' },
        json: { type: 'boolean' },
        out: { type: 'string' },
        block: { type: 'boolean' },
        advisory: { type: 'boolean' },
        strict: { type: 'boolean' },
        'require-claims': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    console.error(`verify: ${String(e?.message ?? e)}`);
    console.error(USAGE);
    process.exitCode = 3;
    return;
  }

  const { values, positionals } = parsed;
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const projectRoot = positionals[0];
  if (!projectRoot) {
    console.error(USAGE);
    process.exitCode = 3;
    return;
  }

  try {
    const result = await verify({
      projectRoot,
      ...(values.claims ? { claimsPath: values.claims } : {}),
      ...(values.policy ? { policyPath: values.policy } : {}),
      ...(values.rulepack ? { rulepack: values.rulepack } : {}),
      ...(values.block ? { block: true } : {}),
      ...(values.advisory ? { advisory: true } : {}),
      ...(values.strict ? { strict: true } : {}),
      ...(values['require-claims'] ? { requireClaims: true } : {}),
    });

    if (values.out) await writeReport(values.out, result.report);
    if (values.json) process.stdout.write(canonicalJson(result.report));
    else console.log(renderText(result.report));
    process.exitCode = result.exitCode;
  } catch (e) {
    console.error(`verify: ${String(e?.message ?? e)}`);
    process.exitCode = 3;
  }
}

await main();
