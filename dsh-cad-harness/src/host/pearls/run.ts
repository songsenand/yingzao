// Read-only pearl run/gate. It auto-loads the project profile, plans the
// template against the effective budget, and observes the six-pearl ledger.
// It does NOT execute CAD tools: "run" here means "enforce the evidence gate".
// Phase 3b can layer execution on top without changing this report.

import { join } from 'node:path';
import { loadProjectProfile, type LoadedProjectProfile } from './profile.ts';
import { planPearl } from './plan.ts';
import { observeLedger, type PearlLedger, type PearlStatus } from './ledger.ts';
import { manifestLocation, type PearlFailure } from './failure.ts';
import { mountProbe } from './probes.ts';
import { runChecker } from '../checkers/runner.ts';
import type { CheckerInput, CheckerReport } from '../checkers/types.ts';

export interface PearlRunReport {
  status: PearlStatus;
  profile: string | null;
  rulePack: string | null;
  pearl: string | null;
  template: string | null;
  budget: { maxDistinctTools: number; maxCalls: number; maxCostSeconds: number; maxProbe: 1 } | null;
  budgetSource: 'profile' | 'rulepack' | 'pearl-default' | 'missing';
  budgetUsed: { distinctTools: number; calls: number; probe: number };
  planIssues: { code: string; message: string }[];
  probe: { required: boolean; allowed: string[]; configured: number; id?: string; report?: CheckerReport };
  ledger: PearlLedger | null;
  failures: PearlFailure[];
}

export async function runPearl(projectRoot: string): Promise<PearlRunReport> {
  let profile: LoadedProjectProfile;
  try {
    profile = await loadProjectProfile(projectRoot);
  } catch (e) {
    return {
      status: 'blocked',
      profile: null, rulePack: null, pearl: null, template: null,
      budget: null, budgetSource: 'missing',
      budgetUsed: { distinctTools: 0, calls: 0, probe: 0 },
      planIssues: [], probe: { required: false, allowed: [], configured: 0 }, ledger: null,
      failures: [{
        code: 'pearl.profile-missing', severity: 'hard',
        what: `no usable pearl-profile.json: ${String(e)}`,
        why: ['the project was not opted into a rule pack/template', 'the profile references a missing rule pack'],
        location: manifestLocation(join(projectRoot, 'pearl-profile.json'), 'project profile'),
        evidence: { projectRoot },
        next: ['add/fix pearl-profile.json'],
      }],
    };
  }

  const plan = planPearl(profile.pearl, profile.template, profile.effectiveBudget);
  const ledger = await observeLedger(profile.projectRoot, {
    template: profile.template as any,
    strictUndeclared: profile.undeclaredPolicy === 'block',
    make: profile.rulePack.manifest.make,
    explainedUndeclared: profile.rulePack.manifest.undeclaredExplanations,
  });
  let probeReport: CheckerReport | undefined;
  let probeFailure: PearlFailure | null = null;
  if (profile.probe) {
    try {
      const mounted = await mountProbe(profile.pearl.manifest, profile.probe, profile.pearlsRoot);
      const input: CheckerInput = {
        apiVersion: 'checker/v1',
        run: { pearl: profile.manifest.pearl, template: profile.template },
        project: { root: profile.projectRoot, units: 'mm' },
        constraints: profile.probeConfig ?? {},
      };
      const result = await runChecker(mounted.checker.manifest, input, { cwd: mounted.checker.dir });
      probeReport = result.report;
      if (result.report.status !== 'pass') {
        probeFailure = {
          code: `probe.${result.report.status}`,
          severity: result.report.status === 'error' || result.report.status === 'blocked' ? 'hard' : 'hard',
          what: `probe ${profile.probe} ${result.report.status}: ${result.report.findings.map((f) => f.message ?? f.criterion).slice(0, 2).join('; ')}`,
          why: ['the project selected a probe and it did not pass', 'a probe is evidence, not a decoration'],
          location: manifestLocation(join(profile.projectRoot, 'pearl-profile.json'), 'probe'),
          evidence: { probe: profile.probe, report: result.report },
          next: ['inspect the probe finding', 'fix the constraint or the geometry, then re-run'],
        };
      }
    } catch (e) {
      probeFailure = {
        code: 'probe.mount-failed', severity: 'hard',
        what: `probe ${profile.probe} could not be mounted: ${String((e as Error)?.message ?? e)}`,
        why: ['probe id is not allowed/registered', 'negative samples failed', 'version/pearl mismatch'],
        location: manifestLocation(join(profile.projectRoot, 'pearl-profile.json'), 'probe'),
        evidence: { probe: profile.probe },
        next: ['check pearl.probe.allowed, probes.json and the checker manifest'],
      };
    }
  }

  const planFailures: PearlFailure[] = plan.issues.map((i) => ({
    code: `pearl.${i.code}`,
    severity: 'hard',
    what: i.message,
    why: ['the template/step set exceeds or violates the pearl contract', 'the project budget is tighter than the template'],
    location: manifestLocation(join(profile.projectRoot, 'pearl-profile.json'), 'plan/budget'),
    evidence: { pearl: profile.manifest.pearl, template: profile.template, budget: profile.effectiveBudget },
    next: ['adjust the template, budget, or project profile'],
  }));
  const budgetFailures: PearlFailure[] = profile.budgetSource === 'pearl-default'
    ? [{
        code: 'pearl.budget-undeclared', severity: 'warn',
        what: 'project profile does not declare a budget; using the pearl default as a soft ceiling',
        why: ['no measured/reference budget was recorded', 'the default is a placeholder, not a p50/p95'],
        location: manifestLocation(join(profile.projectRoot, 'pearl-profile.json'), 'project budget'),
        evidence: { budget: profile.effectiveBudget, source: profile.budgetSource },
        next: ['declare budget in pearl-profile.json from reference runs (optional at this stage)'],
      }]
    : [];
  const failures = [...planFailures, ...budgetFailures, ...(probeFailure ? [probeFailure] : []), ...ledger.failures];
  const status: PearlStatus = plan.status === 'blocked'
    ? 'blocked'
    : probeFailure ? 'blocked'
    : ledger.overall === 'blocked' || ledger.overall === 'fail' ? ledger.overall
      : (budgetFailures.length > 0 || planFailures.length > 0) && ledger.overall === 'pass' ? 'warn'
        : ledger.overall;
  return {
    status,
    profile: profile.manifest.id,
    rulePack: profile.rulePack.manifest.id,
    pearl: profile.manifest.pearl,
    template: profile.template,
    budget: profile.effectiveBudget,
    budgetSource: profile.budgetSource,
    budgetUsed: plan.budgetUsed,
    planIssues: plan.issues,
    probe: {
      required: profile.pearl.manifest.probe.required,
      allowed: [...profile.pearl.manifest.probe.allowed],
      configured: profile.pearl.manifest.probe.allowed.length,
      ...(profile.probe ? { id: profile.probe } : {}),
      ...(probeReport ? { report: probeReport } : {}),
    },
    ledger,
    failures,
  };
}
