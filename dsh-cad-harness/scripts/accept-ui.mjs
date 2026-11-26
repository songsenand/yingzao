// The UI scenario matrix (T5.3): every panel assertion, one command.
//
// Each scenario is a page load in the sandbox (`sandbox/preview/shot.mjs`) whose
// assert writes PASS/FAIL into the page. The page also POSTs that verdict to the
// sandbox server (`/api/cad/assert-result`), so this runner reads a machine
// verdict instead of looking at a screenshot — a screenshot can be green while
// the assertion never ran.
//
//   node scripts/accept-ui.mjs            # all scenarios
//   node scripts/accept-ui.mjs review     # only scenarios whose name matches
//
// Needs Firefox headless (the same binary shot.mjs uses).
import { spawn, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4183;
const BASE = `http://127.0.0.1:${PORT}/`;
const DATA = join(ROOT, '..', 'examples', 'microscope5', 'cad-data');

const SCENARIOS = [
  { name: 'layout-380', query: 'w=380&h=900&recent=p005&assert=layout' },
  { name: 'layout-320', query: 'w=320&h=900&recent=p005&assert=layout' },
  { name: 'evidence', query: 'w=380&h=900&subject=p005&assert=evidence&debug=0' },
  { name: 'history', query: 'w=380&h=900&recent=p005&assert=history&debug=0' },
  { name: 'compare', query: 'w=380&h=900&recent=p005&navpick=v030&assert=ghost&debug=0' },
  { name: 'machine', query: 'w=380&h=900&assert=machine&expect=显微镜&debug=0' },
  { name: 'deeplink', query: 'w=380&h=900&t=v030&assert=deeplink&expect=v030&debug=0' },
  { name: 'recent', query: 'w=380&h=900&recent=p005&assert=recent&expect=调焦滑座&debug=0' },
  { name: 'review', query: 'w=380&h=900&queue=1&recent=p005&assert=review&debug=0&slow=8000' },
  // `t` is filled in after the server is up: the newest contract run of whichever
  // corpus this is (the scenario must not hard-code an id from one example).
  { name: 'contract', query: 'w=520&h=1200&assert=contract&debug=0', resolve: 'contract' },
  // The playback's data strip + keyframe controls are the comprehension surface;
  // the corpus decides which motion run, never a hard-coded id.
  { name: 'playback', query: 'w=520&h=1200&assert=playback&debug=0', resolve: 'motion' },
  // The same comprehension surface at the narrow dock width: the data strip,
  // transport and timeline must not squeeze the 3D viewport out.
  { name: 'playback-380', query: 'w=380&h=900&assert=playback&debug=0', resolve: 'motion' },
  // The playback toolbar's 「▭ 标注」: a screen-space box that must survive a drag
  // (and must not steal the orbit controls while disarmed).
  { name: 'playback-ann', query: 'w=520&h=900&assert=playback-annotate&debug=0', resolve: 'motion' },
  // The panel must follow the host palette: the same page rendered under the
  // light and dark theme, each measured for washed-out labels/controls instead
  // of eyeballed in a screenshot. The playback run is the reported case (the
  // transport buttons over the viewport).
  { name: 'theme-light', query: 'w=380&h=900&recent=p005&assert=theme&debug=0' },
  { name: 'theme-dark', query: 'w=380&h=900&recent=p005&dark=1&assert=theme&debug=0' },
  { name: 'theme-dark-playback', query: 'w=520&h=1200&dark=1&assert=theme&debug=0', resolve: 'motion' },
  // A 3D-only control, exercised under Xvfb; SKIP when this box cannot give GL.
  { name: 'section', query: 'w=520&h=1200&open=剖切&assert=section&debug=0', resolve: 'motion' },
  // U21: a 6.5 MB STL throttled to ~800 KB/s — the byte-progress pill must move
  // and clear, and the mesh must be drawn when it is done.
  // A 130 KB mesh at 20 KB/s ≈ 7 s of download: the pill is observable instead of
  // a one-frame flash. (`slowstl` is a sandbox-only fetch wrapper; production
  // code only ever reads the body it was given.)
  // NOT in the matrix: `?assert=load-progress`. Firefox coalesces a throttled body
  // into 1–2 reads (measured on a 130 KB mesh over 7 s), so the pill can appear for
  // a single frame and the assertion becomes a race it sometimes loses. The
  // streaming logic is covered deterministically by `accept-stream-progress.mjs`;
  // the panel wiring is checked by hand:
  //   node sandbox/preview/shot.mjs --query 'w=520&h=900&subject=p005&slowstl=20&assert=load-progress&debug=0&slow=25000'
  // (observed: "载入 0% · 0.0/0.1 MB" while the body arrives).
  // U11: standard views, axis snap, projection toggle and 复原 — asserted as
  // camera pose facts (direction dot products), not from a picture.
  { name: 'views', query: 'w=520&h=900&subject=p005&assert=views&debug=0' },
  // U15: the viewport's measurement families (angle / section area / hole) and the
  // named, deletable history — driven through the same completion path a click uses.
  { name: 'measure-families', query: 'w=760&h=1000&subject=p010&assert=measure-families&debug=0' },
  // U19: the audit view answers "what is blocked / what has not been run" from the
  // host's own judgement, and a row leads to the run it names.
  { name: 'audit-view', query: 'w=860&h=1000&assert=audit-view&debug=0' },
  // U22: the BOM download is intercepted and read as bytes — a toast that says
  // "exported" is not evidence that a workshop could open the file.
  { name: 'bom-csv', query: 'w=760&h=1000&assert=bom-csv&debug=0' },
  // U12: per-part hide / isolate / highlight in the whole-machine preview. The
  // part list is read from the live scene, so a legend that lies cannot pass.
  { name: 'assembly-hide', query: 'w=1100&h=900&assert=assembly-hide&debug=0' },
  // U21: the WebGL context is REALLY lost and restored (WEBGL_lose_context), and
  // the frame must come back — the failure this guards is a silent blank canvas.
  { name: 'webgl-recover', query: 'w=520&h=900&subject=p005&assert=webgl-recover&debug=0' },
  // U20: an oblique cut of a TUBE must fill the cut and leave the bore as a hole.
  // p010 镜筒 is the corpus part with a through bore; the assert reads the cap
  // mesh's own triangles (area vs its convex hull), so "hollow shell" fails.
  // `freezeat` past the assert: the sandbox snapshots the canvas into an <img>,
  // so a default 2.9 s freeze would photograph the part BEFORE the cut and the
  // evidence picture would disagree with the verdict.
  { name: 'section-free', query: 'w=520&h=1200&subject=p010&assert=section-free&freezeat=9000&debug=0' },
  // The no-WebGL path must still show the run's data and keyframe strip.
  { name: 'playback-no-gl', query: 'w=520&h=1200&assert=playback&debug=0', resolve: 'motion', noXvfb: true },
];

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const chosen = only.length ? SCENARIOS.filter((s) => only.some((o) => s.name.includes(o))) : SCENARIOS;
if (!chosen.length) {
  console.error(`no scenario matches ${only.join(', ')}`);
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`${BASE}api/cad/review/queue`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  return false;
}

const server = spawn(process.execPath, [join(ROOT, 'sandbox', 'preview', 'server.mjs'), String(PORT)], {
  cwd: ROOT,
  env: { ...process.env, CAD_SANDBOX_DATA: DATA },
  stdio: 'ignore',
});

let failures = 0;
try {
  if (!await waitForServer()) {
    console.error(`sandbox server did not come up on ${BASE} (port ${PORT} busy?)`);
    process.exit(2);
  }
  console.log(`ui scenarios (corpus: ${DATA})\n`);
  // Find the run each dynamic scenario needs, from the corpus itself.
  let newestContract = null;
  let newestMotion = null;
  try {
    const products = await fetch(`${BASE}api/cad/products`).then((r) => r.json());
    newestContract = (products.runs ?? []).find((r) => r.kind === 'assembly-check') ?? null;
    newestMotion = (products.runs ?? []).find((r) => r.kind === 'motion' && r.hasGeometry) ?? null;
  } catch { /* the scenario reports the missing verdict */ }
  if (!newestContract) console.log('note: no assembly-check run in this corpus — the contract scenario needs one');
  else for (const s of chosen) if (s.resolve === 'contract') s.query = `t=${newestContract.id}&${s.query}`;
  if (!newestMotion) console.log('note: no motion run in this corpus — the playback scenario needs one');
  else for (const s of chosen) if (s.resolve === 'motion') s.query = `t=${newestMotion.id}&${s.query}`;
  for (const s of chosen) {
    // The panel now requires an explicit project; the sandbox session is the
    // corpus directory, so every scenario must stand one in front of the panel.
    if (!/(^|&)project=/.test(s.query)) s.query += `&project=${encodeURIComponent(DATA)}`;
    await fetch(`${BASE}api/cad/assert-result?clear=1`).catch(() => {});
    // Give the page a window longer than the assert needs: the capture fires at
    // the load event, and a verdict posted after that would be lost with the tab.
    // NO VERDICT = the harness did not finish (cold first run), not "the UI is
    // broken" — so that case retries once with a longer window. A reported FAIL
    // never retries.
    const runShot = (slow) => {
      const query = /(^|&)slow=/.test(s.query) ? s.query : `${s.query}&slow=${slow}`;
      const args = [
        join(ROOT, 'sandbox', 'preview', 'shot.mjs'),
        '--name', `ui-${s.name}`,
        '--base', BASE,
        '--query', query,
      ];
      if (s.noXvfb) args.push('--no-xvfb');
      return spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
    };
    const readVerdict = () => fetch(`${BASE}api/cad/assert-result`).then((x) => x.json()).catch(() => ({ ok: null }));
    let r = runShot(6000);
    let verdict = await readVerdict();
    if (verdict?.ok === null || verdict?.ok === undefined) {
      await fetch(`${BASE}api/cad/assert-result?clear=1`).catch(() => {});
      r = runShot(9000);
      verdict = await readVerdict();
    }
    const shotFail = (r.status ?? 1) !== 0;
    if (process.argv.includes('--verbose')) {
      console.log(`  [shot] status=${r.status} ${String(r.stdout ?? '').trim().split('\n').slice(-1)[0]}`);
      const err = String(r.stderr ?? '').split('\n').filter((l) => l && !/dconf|WARNING|headless|Glean/.test(l)).slice(0, 3);
      if (err.length) console.log(`  [shot:err] ${err.join(' | ')}`);
    }

    const ok = !shotFail && verdict?.ok === true;
    if (!ok) failures++;
    const firstFail = String(verdict?.text ?? '').split('\n').find((l) => l.startsWith('FAIL') && l.trim());
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${s.name.padEnd(11)} ${verdict?.ok === null || verdict?.ok === undefined
      ? '(no verdict reported: the assertion did not run)' : (firstFail ?? '')}`);
  }
} finally {
  server.kill('SIGTERM');
  await sleep(200);
  if (server.exitCode === null) server.kill('SIGKILL');
}

console.log(failures ? `\nFAILED (${failures}/${chosen.length})` : `\nOK (${chosen.length}/${chosen.length})`);
process.exit(failures ? 1 : 0);
