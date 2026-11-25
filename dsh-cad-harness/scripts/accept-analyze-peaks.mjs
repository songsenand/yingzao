// Acceptance: every fused `analyze` peak carries a runnable probe + look.
//
// A peak without a next action is a coordinate, not attention guidance. The fused
// peak may come from wall/corner/strength, each with its own normal, so the generic
// honest next step is a Z-section at the peak: measure(section) + render_part(section).
//
//   node --experimental-strip-types scripts/accept-analyze-peaks.mjs

const { withPeakActions } = await import('../src/host/analyze.ts');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const input = [
  { atMm: [3.2, -4.4, 12.3456], risk: 0.92, count: 2, layers: ['wall', 'corner'] },
  { atMm: [-8, 0, 0], risk: 0.55, count: 1, layers: ['strength'] },
];
const out = withPeakActions('v042', input);

check(out.length === 2, 'the helper keeps every peak', String(out.length));
check(input.every((p) => p.probe === undefined), 'the helper does not mutate the input');
for (const [i, p] of out.entries()) {
  check(p.probe?.tool === 'measure', `peak ${i} probe is measure`, JSON.stringify(p.probe));
  check(p.probe?.args?.versionId === 'v042', `peak ${i} probe cites the version`, JSON.stringify(p.probe?.args));
  check(p.probe?.args?.kind === 'section' && p.probe?.args?.axis === 'z', `peak ${i} probe is a Z-section`, JSON.stringify(p.probe?.args));
  check(p.look?.tool === 'render_part', `peak ${i} look is render_part`, JSON.stringify(p.look));
  check(p.look?.args?.section?.axis === 'z', `peak ${i} look is a Z-section`, JSON.stringify(p.look?.args));
}
check(out[0].probe?.args?.atMm === 12.346, 'the Z coordinate is rounded to 3 decimals', String(out[0].probe?.args?.atMm));
check(out[1].probe?.args?.atMm === 0, 'a peak on the Z=0 plane stays 0', String(out[1].probe?.args?.atMm));

console.log(failures === 0 ? '\nOK' : `\nFAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
