// Probe: does the fused risk map point at the toy-balance pan's elbow notches?
//
// Positive control v069 (4 V-notch gaps at x=+-37, z=42) must produce peaks there; the
// repaired v077 must not. The control lives in scripts/lib/analyze-control.mjs so the
// acceptance asserts exactly the same thing (SKIPs when the corpus is absent).
import { runControl, atElbow, ROOT } from './analyze-control.mjs';

const out = await runControl(undefined, (m) => console.error(m));
for (const [vid, r] of Object.entries(out)) {
  const elbows = r.peaks.filter((p) => atElbow(p));
  console.log(`${vid}: peaks=${r.peaks.length} elbowPeaks=${elbows.length} layers=${JSON.stringify(r.layers)}`);
  for (const p of r.peaks.slice(0, 3)) {
    console.log(`   risk=${p.risk.toFixed(2)} count=${p.count} at=[${p.atMm.map((x) => x.toFixed(1))}] ${p.layers.join('+')}`);
  }
  if (elbows.length) console.log(`   elbow@ ${elbows.map((p) => `[${p.atMm.map((x) => x.toFixed(1))}]`).join(' ')}`);
}

// ---- --write-run: persist the map so the PANEL can draw it --------------------
// Same API the `analyze` tool uses (beginRun + json + commit), so this is not a second
// code path: the run it writes is exactly the one the tool would write.
if (process.argv.includes('--write-run')) {
  const t0 = Date.now();
  const step = (m) => console.error(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
  step('write-run: start');
  const { projectStores } = await import('../src/host/project.ts');
  const { checkPrintability } = await import('../src/host/inspect.ts');
  const { analyzeVersion } = await import('../src/host/analyze.ts');
  const { beginRun } = await import('../src/host/runs.ts');
  const { pickHeatLayer } = await import('../src/client/heat.ts');
  const { resolve } = await import('node:path');
  step('imports done');
  const project = await projectStores(resolve(ROOT, '../examples/toy-balance'));
  step('projectStores done');
  const wallBand = { id: 'wall', quantity: 'wall-thickness', units: 'mm', lo: 1.2, hi: 4.0, scaleLo: 1.2, scaleHi: 4.0, source: 'wallMinMm 1.2 / wallMaxMm 4.0 (declared)' };
  for (const vid of ['v069', 'v077']) {
    step(`${vid}: checkPrintability begin`);
    const rep = await checkPrintability(project.store, { versionId: vid, withSampleField: true });
    step(`${vid}: checkPrintability done`);
    const { scanAttention } = await import('./analyze-control.mjs');
    const suspects = await scanAttention(resolve(project.store.root, 'versions', vid, 'model.stl'));
    step(`${vid}: scan done (${suspects.length} suspects)`);
    const out = analyzeVersion({ suspects, field: rep.field, wallBand });
    step(`${vid}: beginRun`);
    const run = await beginRun(project.runStore, {
      kind: 'analyze', title: `风险图 · ${vid}`, sourceVersionIds: [vid], subject: `analyze:${vid}`,
    });
    await run.json('report.json', { peaks: out.peaks.slice(0, 50), layers: out.layers, notMapped: out.notMapped });
    await run.json('attention.json', {
      id: 'analyze', versionId: vid,
      normalization: { fused: { mode: 'absolute', warnAt: 0.5, badAt: 1.0, source: "each quantity's declared band" } },
      samples: { fused: out.samples.fused },
    });
    // sourceVersionIds MUST be repeated here: beginRun's fields do not reach run.json,
    // and without them the panel's route cannot find the run for this version.
    step(`${vid}: json written, commit`);
    await run.commit({
      status: out.peaks.length > 0 ? 'check' : 'pass',
      summary: `${out.peaks.length} 处风险峰 · 最高 |u| ${out.peaks[0]?.risk.toFixed(2) ?? '—'}`,
      title: `风险图 · ${vid}`,
      sourceVersionIds: [vid],
      subject: `analyze:${vid}`,
    });
    step(`${vid}: committed`);
    console.log(`${vid}: run ${run.id} written (${out.samples.fused.length} fused samples)`);
  }
}
