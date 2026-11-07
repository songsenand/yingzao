// checker/v1 custom check: one declared clearance, one declared minimum.
// It reads only constraints/config; it never claims a geometry it did not measure.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  const input = JSON.parse(raw || '{}');
  const cfg = input.constraints?.checkConfig ?? input.constraints ?? {};
  const criterion = 'declared minimum clearance';
  const base = {
    apiVersion: 'checker/v1',
    checker: { id: 'fit-clearance', version: '1.0.0' },
    artifacts: [],
  };

  let measured = cfg.measuredMm;
  if (typeof measured !== 'number' && typeof cfg.measurementsFile === 'string') {
    try {
      measured = JSON.parse(readFileSync(resolve(process.cwd(), cfg.measurementsFile), 'utf8')).clearanceMm;
    } catch {
      // Missing measurement stays undefined and becomes blocked, never pass.
    }
  }

  if (typeof cfg.minClearanceMm !== 'number' || typeof measured !== 'number') {
    process.stdout.write(JSON.stringify({
      ...base,
      status: 'blocked',
      findings: [{ criterion, verdict: 'blocked', message: 'minClearanceMm and measuredMm/measurementsFile are required' }],
      coverage: { criteria: [criterion], complete: false, skipped: [{ criterion, reason: 'missing constraint' }] },
    }));
    return;
  }

  if (measured < cfg.minClearanceMm) {
    process.stdout.write(JSON.stringify({
      ...base,
      status: 'fail',
      findings: [{
        criterion,
        verdict: 'fail',
        measured,
        limit: cfg.minClearanceMm,
        unit: 'mm',
        witness: { kind: 'clearance', minDistanceMm: measured, limitMm: cfg.minClearanceMm },
        attention: [{ kind: 'part', where: [0, 0, 0], note: 'declared clearance is below the declared minimum' }],
        message: `measured ${measured}mm < required ${cfg.minClearanceMm}mm`,
      }],
      coverage: { criteria: [criterion], complete: true, skipped: [] },
    }));
    return;
  }

  process.stdout.write(JSON.stringify({
    ...base,
    status: 'pass',
    findings: [{ criterion, verdict: 'pass', measured, limit: cfg.minClearanceMm, unit: 'mm' }],
    coverage: { criteria: [criterion], complete: true, skipped: [] },
  }));
});
