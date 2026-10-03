// Adopt legacy global artifacts (data/physics|fluid|assembly) into the run store
// so the panel's product list has history to browse. Existing files are copied,
// never simulated again, and their original mtime becomes the run timestamp.
//
//   node scripts/migrate-runs.mjs           # adopt (keeps the legacy dirs)
//   node scripts/migrate-runs.mjs --purge   # adopt, then delete the legacy dirs
//
// Skips anything incomplete: data/motion has parts + keyframes but no
// motion-report.json / trajectory.json, so it cannot become a playable run.
import { copyFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { beginRun, listRuns, openRunStore } from '../src/host/runs.ts';

const ROOT = join(new URL('../', import.meta.url).pathname);
const DATA = join(ROOT, 'data');
const runStore = openRunStore(DATA);
const purge = process.argv.includes('--purge');

const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };
const mtime = async (p) => (await stat(p)).mtime.toISOString();
const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));

/** Copy every file in `dir` into the run's frames/ (flat). */
async function copyFrames(run, dir) {
  if (!(await exists(dir))) return 0;
  let n = 0;
  for (const name of await readdir(dir)) {
    if (!/\.(bin|png)$/.test(name)) continue;   // skip the debug .scad keyframes
    await run.frame(name, await readFile(join(dir, name)));
    n++;
  }
  return n;
}

const created = [];

// ---- physics: report + trajectory + parts + keyframes ----------------------
{
  const dir = join(DATA, 'physics');
  if (await exists(join(dir, 'physics-report.json'))) {
    const report = await readJson(join(dir, 'physics-report.json'));
    const run = await beginRun(runStore, {
      kind: 'physics',
      title: '刚体物理 · 迁移数据',
      timestamp: await mtime(join(dir, 'physics-report.json')),
    });
    const parts = Object.keys(report.finalPositions ?? {});
    for (const name of parts) {
      const stl = join(dir, `${name}.stl`);
      if (await exists(stl)) await run.part(name, await readFile(stl));
    }
    await run.json('report.json', report);
    if (await exists(join(dir, 'trajectory.json'))) {
      await run.json('trajectory.json', await readJson(join(dir, 'trajectory.json')));
    }
    await copyFrames(run, join(dir, 'frames'));
    const svg = report.metrics ?? {};
    const fell = Object.entries(svg.fellOver ?? {}).filter(([, v]) => v === true).map(([n]) => n);
    const entry = await run.commit({
      status: svg.settledPenetrationMm > 1 || fell.length ? 'check' : 'pass',
      summary: `稳态穿透 ${svg.settledPenetrationMm ?? '—'}mm` + (fell.length ? ` · 倒下 ${fell.join(',')}` : ''),
    });
    created.push(entry);
  }
}

// ---- fluid: report + frame manifest + wall + frames ------------------------
{
  const dir = join(DATA, 'fluid');
  if (await exists(join(dir, 'frames.json'))) {
    const manifest = await readJson(join(dir, 'frames.json'));
    const report = (await exists(join(dir, 'fluid-report.json'))) ? await readJson(join(dir, 'fluid-report.json')) : {};
    const sourceVersionIds = manifest.versionId ? [manifest.versionId] : [];
    const run = await beginRun(runStore, {
      kind: 'fluid',
      title: `流体仿真 · ${sourceVersionIds.join('+') || '内联 SCAD'}`,
      timestamp: await mtime(join(dir, 'frames.json')),
    });
    if (await exists(join(dir, 'wall.stl'))) await run.part('wall', await readFile(join(dir, 'wall.stl')));
    const frames = await copyFrames(run, join(dir, 'frames'));
    await run.json('fluid-manifest.json', manifest);
    await run.json('report.json', report);
    // The legacy fluid report can disagree with the frames it sits next to (an
    // aborted run overwrote the report while the frames survived). The manifest
    // is what the viewer scrubs, so the summary follows it and only adds report
    // metrics that are actually present.
    const m = report.metrics ?? {};
    const bits = [`粒子 ${manifest.particleCount0 ?? '—'}`, `${frames} 帧`];
    if (m.outletArrivalRatio != null) bits.unshift(`到达率 ${m.outletArrivalRatio}`);
    if (m.penetrationCount) bits.push(`穿透 ${m.penetrationCount}`);
    const entry = await run.commit({
      sourceVersionIds,
      status: report.overallStatus === 'pass' ? 'pass' : 'check',
      summary: bits.join(' · '),
    });
    created.push(entry);
  }
}

// ---- assembly-check: report-only, provenance from the manifest -------------
{
  const reportPath = join(DATA, 'assembly', 'assembly-check-report.json');
  const manifestPath = join(DATA, 'assembly', 'assembly.json');
  if (await exists(reportPath)) {
    const report = await readJson(reportPath);
    const found = new Set();
    if (await exists(manifestPath)) {
      const manifest = await readJson(manifestPath);
      const walk = (node) => {
        if (!node || typeof node !== 'object') return;
        if (typeof node.version === 'string') found.add(node.version);
        for (const child of node.children ?? []) walk(child);
      };
      walk(manifest.root);
    }
    const run = await beginRun(runStore, {
      kind: 'assembly-check',
      title: `装配清单检查 · ${report.manifestName ?? '迁移数据'}`,
      timestamp: await mtime(reportPath),
    });
    await run.json('report.json', report);
    const s = report.summary ?? {};
    const entry = await run.commit({
      sourceVersionIds: [...found],
      status: report.overallStatus ?? 'check',
      summary: `${s.interfaces ?? 0} 接口 · 通过 ${s.pass ?? 0} · 硬冲突 ${s.hardViolations ?? 0} · 未声明 ${s.undeclared ?? 0}`,
    });
    created.push(entry);
  }
}

created.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
console.log(`migrated ${created.length} run(s):`);
for (const r of created) console.log(`  ${r.id}  ${r.kind.padEnd(15)} ${r.timestamp}  ${r.summary}`);
const skipped = ['physics', 'fluid'].filter((k) => !created.some((r) => r.kind === k));
if (skipped.length) console.log(`skipped (legacy files absent): ${skipped.join(', ')}`);
console.log(`(data/motion has parts but no trajectory/report — not migrated)`);

if (purge) {
  for (const dir of ['physics', 'fluid']) {
    await rm(join(DATA, dir), { recursive: true, force: true });
    console.log(`purged data/${dir}/`);
  }
  // the check report is validate_assembly's documented output file, but the
  // panel now reads runs/ — drop the duplicate so there is one source of truth
  await rm(join(DATA, 'assembly', 'assembly-check-report.json'), { force: true });
  console.log('purged data/assembly/assembly-check-report.json');
}

console.log(`manifest now has ${(await listRuns(runStore)).length} run(s)`);
