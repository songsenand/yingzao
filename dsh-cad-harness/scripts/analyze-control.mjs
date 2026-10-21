// The toy-balance attention control, shared by the probe and the acceptance.
//
// WHY a control and not a fixture: the question is whether the risk map POINTS AT the real
// defect. v069 has 4 V-notch gaps at the pan elbows (x=±37, z=42); v077 repaired them.
// So the assertion is directional and falsifiable: the elbow must light up in v069 and not
// in v077. A fixture written to match the implementation would prove nothing.
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ELBOW = { xMm: 37, zMm: 42, tolMm: 6 };

export async function controlAvailable() {
  const { existsSync } = await import('node:fs');
  return existsSync(join(ROOT, '..', 'examples', 'toy-balance', 'cad-data', 'versions', 'v069', 'model.stl'));
}

/** Run the map for the two versions and return their peaks. */
export async function runControl(versionIds = ['v069', 'v077'], onStep) {
  const t0 = Date.now();
  const step = (m) => onStep?.(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
  process.env.DSH_CAD_PYTHON_ROOT ??= join(ROOT, '.tmp-cad-runtime');
  const { projectStores } = await import('../src/host/project.ts');
  const { checkPrintability } = await import('../src/host/inspect.ts');
  const { analyzeVersion } = await import('../src/host/analyze.ts');
  step('imports done');
  const project = await projectStores(resolve(ROOT, '..', 'examples', 'toy-balance'));
  step('projectStores done');
  const wallBand = { id: 'wall', quantity: 'wall-thickness', units: 'mm', lo: 1.2, hi: 4.0, scaleLo: 1.2, scaleHi: 4.0, source: 'wallMinMm 1.2 / wallMaxMm 4.0 (declared)' };
  const out = {};
  for (const vid of versionIds) {
    step(`${vid}: checkPrintability begin (this is the bundled-runtime path)`);
    const rep = await checkPrintability(project.store, { versionId: vid, withSampleField: true });
    step(`${vid}: checkPrintability done`);
    const suspects = await scanAttention(join(project.store.root, 'versions', vid, 'model.stl'));
    step(`${vid}: scan done (${suspects.length} suspects)`);
    out[vid] = analyzeVersion({ suspects, field: rep.field, wallBand });
  }
  return out;
}

/** Is this peak at a pan elbow (either sign of x)? */
export function atElbow(p, tol = ELBOW.tolMm) {
  const [x, , z] = p.atMm;
  return Math.abs(Math.abs(x) - ELBOW.xMm) <= tol && Math.abs(z - ELBOW.zMm) <= tol;
}

export function scanAttention(path) {
  const PY = join(ROOT, '.tmp-cad-runtime', 'venv', 'bin', 'python');
  return new Promise((res, rej) => {
    const p = spawn(PY, ['-I', 'python/cad_worker/worker.py'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'inherit'] });
    let buf = '';
    const timer = setTimeout(() => { p.kill(); rej(new Error('scan_attention timeout')); }, 180000);
    p.stdout.on('data', (d) => {
      buf += d;
      for (const line of buf.split('\n').filter((l) => l.trim())) {
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m && 'result' in m) { clearTimeout(timer); p.kill(); res(m.result.suspects ?? []); return; }
        if (m && m.ok === false) { clearTimeout(timer); p.kill(); rej(new Error(String(m.error))); return; }
      }
    });
    p.on('error', rej);
    p.stdin.write(JSON.stringify({ id: 1, op: 'scan_attention', params: { path } }) + '\n');
  });
}
