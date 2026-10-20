// Probe: does the fused risk map point at the toy-balance pan's elbow notches?
//
// Positive control v069 (4 V-notch gaps at x=+-37, z=42) must produce peaks there; the
// repaired v077 must not. The control lives in scripts/lib/analyze-control.mjs so the
// acceptance asserts exactly the same thing (SKIPs when the corpus is absent).
import { runControl, atElbow } from './analyze-control.mjs';

const out = await runControl();
for (const [vid, r] of Object.entries(out)) {
  const elbows = r.peaks.filter((p) => atElbow(p));
  console.log(`${vid}: peaks=${r.peaks.length} elbowPeaks=${elbows.length} layers=${JSON.stringify(r.layers)}`);
  for (const p of r.peaks.slice(0, 3)) {
    console.log(`   risk=${p.risk.toFixed(2)} count=${p.count} at=[${p.atMm.map((x) => x.toFixed(1))}] ${p.layers.join('+')}`);
  }
  if (elbows.length) console.log(`   elbow@ ${elbows.map((p) => `[${p.atMm.map((x) => x.toFixed(1))}]`).join(' ')}`);
}
