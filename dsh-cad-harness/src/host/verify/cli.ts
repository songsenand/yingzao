// Packaged V1 evidence CLI (C2): the same report as scripts/verify.mjs, but
// bundled into lib/verify.js so a clean install does not need src/ or tsx.

import { parseArgs } from 'node:util';
import { verify } from './index.ts';
import { canonicalJson, renderText, writeReport } from './report.ts';

export const USAGE = `usage: verify <project-dir> [options]

  --claims <file>      claims JSON (default: <project>/claims.json)
  --policy <file>      evidence policy JSON (default: <project>/evidence-policy.json)
  --rulepack <dir>     override the rule pack directory
  --json               print the JSON report instead of the text summary
  --out <file>         also write the JSON report to this path
  --block              blocking mode (exit 1/2 on warn/blocked|fail)
  --advisory           advisory mode (exit 0; still reports the verdict)
  --strict             blocking mode: warn also exits 2
  --require-claims     block when no claims are declared
  --checks             enable custom checks (default: <project>/checks)
  --checks-dir <dir>   use this checks directory (implies --checks)
  --mount-checks       validate/mount checks only; no geometry run
  --no-checks          explicitly disable custom checks
  -h, --help           show this help

Exit: 0 pass (advisory always 0) · 1 warn (blocking) · 2 blocked/fail · 3 usage/error`;

export async function main(argv: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv as string[],
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
        checks: { type: 'boolean' },
        'checks-dir': { type: 'string' },
        'mount-checks': { type: 'boolean' },
        'no-checks': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    console.error(`verify: ${String((e as Error)?.message ?? e)}`);
    console.error(USAGE);
    return 3;
  }

  const { values, positionals } = parsed;
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const projectRoot = positionals[0];
  if (!projectRoot) {
    console.error(USAGE);
    return 3;
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
      ...(values.checks ? { checks: true } : {}),
      ...(values['checks-dir'] ? { checksDir: values['checks-dir'] } : {}),
      ...(values['mount-checks'] ? { mountChecks: true } : {}),
      ...(values['no-checks'] ? { noChecks: true } : {}),
    });
    if (values.out) await writeReport(values.out, result.report);
    if (values.json) process.stdout.write(canonicalJson(result.report));
    else console.log(renderText(result.report));
    return result.exitCode;
  } catch (e) {
    console.error(`verify: ${String((e as Error)?.message ?? e)}`);
    return 3;
  }
}
