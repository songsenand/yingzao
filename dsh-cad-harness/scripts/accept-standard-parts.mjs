// Standard-parts seed acceptance.
//
// WHAT THIS PROVES:
//   1. the seed catalog has the fields the spring operator needs;
//   2. a standardId fills only missing elastic fields (explicit wins);
//   3. unknown ids are an input error, not a silent skip;
//   4. the Python worker resolves the same id to the same installed force and
//      reports the same standardId.
//
// Run: node scripts/accept-standard-parts.mjs [--runtime <dir>]

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STANDARD_SPRINGS, standardSpring } from '../src/host/standard-parts.ts';
import { resolveStandardSpring } from '../src/host/assembly-check.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = resolve(HERE, '..');
const REPO = resolve(PLUGIN, '..');
const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const runtime = resolve(argOf('--runtime', resolve(REPO, '.tmp-measure-runtime')));
const python = process.platform === 'win32'
  ? resolve(runtime, 'venv', 'Scripts', 'python.exe')
  : resolve(runtime, 'venv', 'bin', 'python');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const id = 'comp-od5.4-w0.6-l30';
const seed = STANDARD_SPRINGS[id];
check(seed && seed.freeLengthMm === 30 && seed.stiffnessNPerMm === 0.5
  && seed.solidHeightMm === 8 && seed.source === 'estimated',
  'seed spring has free length, rate, solid height and source',
  JSON.stringify(seed));

const base = {
  id: 'std-test', a: 'a.axis', b: 'b.axis', type: '弹簧', severity: 'hard',
  elastic: { behavior: 'axial-spring', standardId: id, direction: 'compression', forceBudgetN: 2.5, requiredTravelMm: 4 },
};
const resolved = resolveStandardSpring(base);
check(!resolved.error && resolved.standard?.id === id,
  'known standardId resolves', resolved.error ?? '');
check(resolved.iface.elastic.freeLengthMm === 30
  && resolved.iface.elastic.stiffnessNPerMm === 0.5
  && resolved.iface.elastic.solidHeightMm === 8
  && resolved.iface.elastic.outerDiameterMm === 5.4
  && resolved.iface.elastic.source === 'estimated',
  'catalog fills missing spring fields and source',
  JSON.stringify(resolved.iface.elastic));

const overridden = resolveStandardSpring({
  ...base,
  elastic: { ...base.elastic, freeLengthMm: 40, stiffnessNPerMm: 2 },
});
check(overridden.iface.elastic.freeLengthMm === 40 && overridden.iface.elastic.stiffnessNPerMm === 2,
  'explicit manifest fields win over catalog', JSON.stringify(overridden.iface.elastic));

const unknown = resolveStandardSpring({ ...base, elastic: { standardId: 'no-such-spring' } });
check(typeof unknown.error === 'string' && unknown.error.includes('unknown standardId'),
  'unknown standardId returns an error', unknown.error ?? '');

check(standardSpring(undefined) === undefined, 'no id means no catalog lookup');
check(standardSpring(id)?.name.includes('pen seed'), 'standardSpring() returns the named seed');

if (!existsSync(python)) {
  console.log(`SKIP  python worker — no venv python at ${python}`);
} else {
  const pyCode = (budget) => `
import json, sys
sys.path.insert(0, ${JSON.stringify(resolve(PLUGIN, 'python', 'cad_worker'))})
import worker
iface = {
  "id": "std-test", "a": "a.axis", "b": "b.axis", "type": "弹簧", "severity": "hard",
  "elastic": {"behavior": "axial-spring", "standardId": ${JSON.stringify(id)}, "direction": "compression", "forceBudgetN": ${budget}, "requiredTravelMm": 4},
}
print(json.dumps(worker._spring_behaviour(iface, [0, 0, 0], [0, 0, 28]), ensure_ascii=False))
`;
  const pySpring = (budget) => JSON.parse(execFileSync(python, ['-c', pyCode(budget)], { encoding: 'utf8' }).trim());
  try {
    const out = pySpring(2.5);
    check(out.elastic?.standardId === id, 'python reports the same standardId', JSON.stringify(out.elastic));
    check(out.elastic?.installedLengthMm === 28 && out.elastic?.forceN === 1 && out.elastic?.forceAtTravelN === 3,
      'python computes installed 1N and full-travel 3N from the catalog', JSON.stringify(out.elastic));
    check(out.verdict === 'hard-violation' && out.elastic?.checks?.forceBudget === 'violation',
      'python flags full-travel 3N > 2.5N budget as a hard violation', out.detail);
    check(out.detail.includes('|force at travel| 3N exceeds budget 2.5N'),
      'python names the travel-endpoint force, not just the installed preload', out.detail);
    check(out.detail.startsWith(`standard ${id}`), 'python names the standard in the detail', out.detail.slice(0, 100));

    const relaxed = pySpring(4);
    check(relaxed.verdict === 'pass' && relaxed.elastic?.forceAtTravelN === 3,
      'python passes when the full-travel force is inside a 4N budget', relaxed.detail);
  } catch (err) {
    failures++;
    console.log(`FAIL  python worker standard lookup — ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log(`\n${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
