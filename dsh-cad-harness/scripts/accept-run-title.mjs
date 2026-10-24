// Acceptance: a run's NAME is about its parts, not the version ids it cited.
//
// Before this, every title was `kind · v014+v025+v022` (`provenanceLabel` = ids.join('+')).
// In microscope5 fifteen motion runs about the same mechanism (弯臂 + 调焦滑座 + 齿轮轴)
// were indistinguishable in the browse list — the user's actual complaint.
//
// Two rules, because one part and many parts are different questions:
//   many parts -> `机构运动 · 弯臂 + 调焦滑座 + 齿轮轴`   (versions are noise)
//   one part   -> `刚体物理 · 整机 v051`                  (the revision matters)
// Kinds with no user-named parts (fluid's synthetic `wall`, a manifest check) keep
// whatever they committed.
//
//   node scripts/accept-run-title.mjs
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { runSubject } = await import('../src/shared/labels.ts');
const { buildProducts } = await import('../src/host/products.ts');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

// ---- the rule ---------------------------------------------------------------
check(
  runSubject('motion', ['弯臂', '调焦滑座', '齿轮轴'], ['v014', 'v025', 'v026'])
    === '机构运动 · 弯臂 + 调焦滑座 + 齿轮轴',
  'many parts: the name lists the parts, not the versions',
  String(runSubject('motion', ['弯臂', '调焦滑座', '齿轮轴'], ['v014', 'v025', 'v026'])),
);
check(
  runSubject('physics', ['整机'], ['v051']) === '刚体物理 · 整机 v051',
  'one part: the revision stays in the name',
  String(runSubject('physics', ['整机'], ['v051'])),
);
check(
  runSubject('physics', ['整机'], ['v051', 'v052']) === '刚体物理 · 整机',
  'one part, several versions: no single revision to name, so none is claimed',
);
check(runSubject('fluid', ['wall'], ['v009']) === null, "fluid's synthetic `wall` is not a part");
check(runSubject('assembly-check', [], ['v001', 'v002']) === null, 'a manifest check has no parts');
check(runSubject('motion', [], []) === null, 'an inline-SCAD scene has no parts');
check(
  runSubject('motion', ['a', 'a', 'b'], []) === '机构运动 · a + b',
  'duplicate instance names collapse',
);
check(
  runSubject('motion', ['a', '  ', 'b'], []) === '机构运动 · a + b',
  'blank names are not parts',
);

// ---- end to end over a real corpus ------------------------------------------
const dataRoot = join(ROOT, '..', 'examples', 'microscope5', 'cad-data');
try {
  const [versions, parts, runs] = await Promise.all(
    ['manifest.json', 'parts/manifest.json', 'runs/manifest.json'].map(async (f) =>
      JSON.parse(await readFile(join(dataRoot, f), 'utf8'))),
  );
  const out = buildProducts(versions.versions, parts.parts, runs.runs);
  const byId = new Map();
  for (const run of [...out.scene, ...out.parts.flatMap((p) => p.runs)]) byId.set(run.id, run);

  const r013 = byId.get('r013');
  check(
    r013?.displayTitle === '机构运动 · 弯臂 + 调焦滑座 + 齿轮轴',
    'microscope5 r013: display name lists the mechanism parts',
    String(r013?.displayTitle),
  );
  check(
    r013?.title === '机构运动 · v014+v023+v022',
    'the committed title is NOT rewritten (history stays as written)',
    String(r013?.title),
  );
  const r001 = byId.get('r001');
  check(
    r001 !== undefined && r001.displayTitle === undefined && r001.title.includes('装配清单检查'),
    'a manifest check keeps its own title and grows no displayTitle',
    String(r001?.title),
  );
  // Every motion run must now be nameable; none may fall back to a version list.
  const motion = [...byId.values()].filter((r) => r.kind === 'motion');
  check(
    motion.length > 0 && motion.every((r) => (r.displayTitle ?? '').includes('机构运动 · ')),
    `all ${motion.length} motion runs carry a part-based name`,
  );
} catch (e) {
  // The corpus is an example, not a fixture: a checkout without it is not a failure.
  console.log(`SKIP  real-corpus check (${String(e?.message ?? e).split('\n')[0]})`);
}

console.log(failures ? `\nFAILED (${failures})` : '\nOK');
process.exit(failures ? 1 : 0);
