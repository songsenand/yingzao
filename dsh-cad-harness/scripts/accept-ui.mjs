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
  try {
    const products = await fetch(`${BASE}api/cad/products`).then((r) => r.json());
    newestContract = (products.runs ?? []).find((r) => r.kind === 'assembly-check') ?? null;
  } catch { /* the scenario reports the missing verdict */ }
  if (!newestContract) console.log('note: no assembly-check run in this corpus — the contract scenario needs one');
  else for (const s of chosen) if (s.resolve === 'contract') s.query = `t=${newestContract.id}&${s.query}`;
  for (const s of chosen) {
    await fetch(`${BASE}api/cad/assert-result?clear=1`).catch(() => {});
    // Give the page a window longer than the assert needs: the capture fires at
    // the load event, and a verdict posted after that would be lost with the tab.
    // NO VERDICT = the harness did not finish (cold first run), not "the UI is
    // broken" — so that case retries once with a longer window. A reported FAIL
    // never retries.
    const runShot = (slow) => {
      const query = /(^|&)slow=/.test(s.query) ? s.query : `${s.query}&slow=${slow}`;
      return spawnSync(process.execPath, [
        join(ROOT, 'sandbox', 'preview', 'shot.mjs'),
        '--name', `ui-${s.name}`,
        '--base', BASE,
        '--query', query,
      ], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
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
