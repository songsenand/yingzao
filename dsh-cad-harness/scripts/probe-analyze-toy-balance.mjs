// Probe: does the fused risk map point at the toy-balance pan's elbow notches?
//
// Positive control v069 (4 V-notch gaps at x=+-37, z=42) must produce peaks there;
// negative control v077 (repaired) must not. Measured 2026-10-20: v069 -> risk 1.00
// count 2 at [-37,8,42] and [37,8,42] (reentrant-corner + wall); v077 -> those peaks
// gone, its own new corners sit at the top centre (z=71.5).
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const t0 = Date.now(); const log = (m) => console.error(`[${((Date.now()-t0)/1000).toFixed(1)}s] ${m}`);
import { projectStores } from '../src/host/project.ts';
import { checkPrintability } from '../src/host/inspect.ts';
import { analyzeVersion } from '../src/host/analyze.ts';

const PY = resolve(ROOT, '.tmp-cad-runtime/venv/bin/python');
function scanAttention(path) {
  return new Promise((res, rej) => {
    const p = spawn(PY, ['-I', 'python/cad_worker/worker.py'], { stdio: ['pipe', 'pipe', 'inherit'] });
    let buf = '';
    const timer = setTimeout(() => { p.kill(); rej(new Error('scan timeout')); }, 120000);
    p.stdout.on('data', (d) => {
      buf += d;
      for (const line of buf.split('\n').filter((l) => l.trim())) {
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg && ('result' in msg || 'ok' in msg)) {
          clearTimeout(timer); p.kill();
          if (msg.ok === false) rej(new Error(msg.error ?? 'worker error')); else res(msg.result);
          return;
        }
      }
    });
    p.on('error', rej);
    p.stdin.write(JSON.stringify({ id: 1, op: 'scan_attention', params: { path } }) + '\n');
  });
}
const project = await projectStores(resolve(ROOT, '../examples/toy-balance'));
const wallBand = { id: 'wall', quantity: 'wall-thickness', units: 'mm', lo: 1.2, hi: 4.0, scaleLo: 1.2, scaleHi: 4.0, source: 'profile wallMinMm 1.2 + thick-wall bound 4.0 (declared heuristic)' };
for (const vid of ['v069', 'v077']) {
  const rep = await checkPrintability(project.store, { versionId: vid, withSampleField: true });
  const scan = await scanAttention(join(project.store.root, 'versions', vid, 'model.stl'));
  const out = analyzeVersion({ suspects: scan.suspects, field: rep.field, wallBand });
  const corner = out.peaks.filter((p) => p.layers.includes('corner'));
  log(`${vid}: peaks=${out.peaks.length} cornerPeaks=${corner.length} layers=${JSON.stringify(out.layers)}`);
  for (const p of out.peaks.slice(0, 3)) log(`   risk=${p.risk.toFixed(2)} count=${p.count} at=[${p.atMm.map((x)=>x.toFixed(1))}] ${p.layers.join('+')}`);
  if (corner.length) log(`   corner@ ${corner.slice(0,4).map((p)=>`[${p.atMm.map((x)=>x.toFixed(1))}]`).join(' ')}`);
}
