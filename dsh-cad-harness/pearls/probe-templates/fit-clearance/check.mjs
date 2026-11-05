// checker/v1 template: one declared clearance, one declared limit.
// It reads only constraints; it never claims geometry it did not measure.
let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  const input = JSON.parse(raw || '{}');
  const c = input.constraints ?? {};
  const min = c.minClearanceMm;
  const measured = c.measuredMm;
  const base = {
    apiVersion: 'checker/v1',
    checker: { id: 'fit-clearance', version: '1.0.0' },
    artifacts: [],
  };
  if (typeof min !== 'number' || typeof measured !== 'number') {
    process.stdout.write(JSON.stringify({
      ...base,
      status: 'blocked',
      findings: [{ criterion: 'declared minimum clearance', verdict: 'blocked', message: 'minClearanceMm and measuredMm are required' }],
      coverage: { criteria: ['declared minimum clearance'], complete: false, skipped: [{ criterion: 'declared minimum clearance', reason: 'missing constraint' }] },
    }));
    return;
  }
  if (measured < min) {
    process.stdout.write(JSON.stringify({
      ...base,
      status: 'fail',
      findings: [{
        criterion: 'declared minimum clearance',
        verdict: 'fail',
        measured, limit: min, unit: 'mm',
        witness: { kind: 'clearance', minDistanceMm: measured },
        attention: [{ kind: 'pair', where: [0, 0, 0], note: 'declared clearance is below the declared minimum' }],
        message: `measured ${measured}mm < required ${min}mm`,
      }],
      coverage: { criteria: ['declared minimum clearance'], complete: true, skipped: [] },
    }));
    return;
  }
  process.stdout.write(JSON.stringify({
    ...base,
    status: 'pass',
    findings: [{ criterion: 'declared minimum clearance', verdict: 'pass', measured, limit: min, unit: 'mm' }],
    coverage: { criteria: ['declared minimum clearance'], complete: true, skipped: [] },
  }));
});
