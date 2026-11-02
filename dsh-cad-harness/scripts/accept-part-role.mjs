// Acceptance for part roles (G4, 2026-10-29).
//
// The roberval delivery audit demanded a fresh printability run for merged
// kinematic research bodies and M3 hardware models — 12 ceremony runs
// (r025–r036) — because the corpus had no way to say "this is not a printed
// part". Roles fix that BY DECLARATION: printed is the default and everything
// falls back to it; stock/research must be declared (set_part_role, or
// merge_parts marking its output research), and the audit reports every
// exemption as an info finding instead of silently shrinking its demands.
//
// Hermetic, needs NO Python/OpenSCAD.
//
//   node scripts/accept-part-role.mjs
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'cad-role-home-'));
const workspace = await mkdtemp(join(tmpdir(), 'cad-role-work-'));
process.env.DSH_HOME = home;
await mkdir(join(workspace, 'cad-data'), { recursive: true });

const { registerCadTools } = await import('../src/host/tools.ts');
const { openVersionStore, saveVersion } = await import('../src/host/version.ts');
const { ensurePart, attachVersion, partRoleOf } = await import('../src/host/parts.ts');
const { projectStores } = await import('../src/host/project.ts');
const { auditDelivery } = await import('../src/host/delivery-audit.ts');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const tools = new Map();
const ctx = {
  tools: { register: (def) => { tools.set(def.name, def); } },
  attachments: { saveImages: async (items) => items.map((it) => ({ kind: 'stub', name: it.name })) },
  reflect: { get: () => undefined }, on: () => {},
};
registerCadTools(ctx);
const exec = { agent: { session: { header: { id: 'part-role', cwd: workspace } } } };
const call = async (name, args) => {
  const def = tools.get(name);
  if (!def) throw new Error(`tool ${name} not registered`);
  return { value: await def.execute(args, exec) };
};

// Explicit project selection is mandatory (no cwd default).
await call('bind_project', { dir: workspace });

// Corpus: two parts, one version each, NO runs — every part's newest version is
// uncited, so the baseline must flag both.
const store = openVersionStore(join(workspace, 'cad-data'));
const STL = new Uint8Array([0x53, 0x54, 0x4c, 0x20, 0x62, 0x79, 0x74, 0x65, 0x73, 0x21]);
const partStore = { root: join(workspace, 'cad-data', 'parts') };
const bracket = await ensurePart(partStore, 'bracket');
const screw = await ensurePart(partStore, 'm3_screw_20');
const vB = await saveVersion(store, { stl: STL, userIntent: 'bracket', partId: bracket.id });
const vS = await saveVersion(store, { stl: STL, userIntent: 'm3 screw model', partId: screw.id });
await attachVersion(partStore, bracket.id, vB);
await attachVersion(partStore, screw.id, vS);

const claim = { kind: 'manufacturability', statement: 'every printed part has a printability run' };
const audit = (claims) => auditDelivery(projectStores(workspace), { claims, scanPaths: [] });

// 1. baseline: no roles declared → both parts are expected to be printable
let r = await audit([claim]);
check(
  r.findings.some((f) => f.code === 'claim-without-evidence' && f.detail.includes('bracket')),
  'baseline: printed part without printability run still BLOCKS the claim',
);
check(
  r.findings.some((f) => f.code === 'newest-version-unvalidated' && f.detail.includes('m3_screw_20')),
  'baseline: uncited newest version of a default-role part blocks',
);
check(!r.findings.some((f) => f.code === 'role-exempt-parts'), 'baseline: no role exemption reported');

// 2. declare the screw stock → exempt, visibly
const set = await call('set_part_role', { part: 'm3_screw_20', role: 'stock' });
check(set.value.role === 'stock' && set.value.previousRole === 'printed', 'set_part_role declares stock (previous printed)');
check(
  String(set.value.effect).includes('exempt'),
  'the reply says what the audit will now do',
);
r = await audit([claim]);
check(
  !r.findings.some((f) => f.code === 'claim-without-evidence' && f.detail.includes('m3_screw_20')),
  'stock part no longer demanded by the manufacturability claim',
);
check(
  !r.findings.some((f) => f.code === 'newest-version-unvalidated' && f.detail.includes('m3_screw_20')),
  'stock part no longer blocked as newest-version-unvalidated',
);
check(
  r.findings.some((f) => f.code === 'claim-without-evidence' && f.detail.includes('bracket')),
  'the printed part is STILL demanded (exemption does not leak)',
);
const info = r.findings.find((f) => f.code === 'role-exempt-parts');
check(Boolean(info) && info.severity === 'info' && info.detail.includes('m3_screw_20') && info.detail.includes('stock'),
  'the exemption is VISIBLE as an info finding', info?.detail);

// 3. role back to printed → expectations return
await call('set_part_role', { part: 'm3_screw_20', role: 'printed' });
r = await audit([claim]);
check(
  r.findings.some((f) => f.code === 'newest-version-unvalidated' && f.detail.includes('m3_screw_20')),
  'role back to printed: the expectation returns',
);
check(!r.findings.some((f) => f.code === 'role-exempt-parts'), 'printed again: no exemption reported');

// 4. validation: bad role and unknown part are refused
let threw = null;
try { await call('set_part_role', { part: 'm3_screw_20', role: ' decorative' }); } catch (e) { threw = e; }
check(threw !== null && String(threw.message).includes('is not a known role'), 'a typo role is refused', threw?.message?.split('\n')[0]);
threw = null;
try { await call('set_part_role', { part: 'no_such_part', role: 'stock' }); } catch (e) { threw = e; }
check(threw !== null && String(threw.message).includes('does not match any part'), 'an unknown part is refused');
check(
  String(threw?.message ?? '').includes('knownParts'),
  'the refusal lists the parts that DO exist', String(threw?.message ?? '').split('\n')[1] ?? '',
);

// 5. partRoleOf: omission means printed
check(partRoleOf({}) === 'printed' && partRoleOf(undefined) === 'printed', 'partRoleOf defaults to printed');

await rm(home, { recursive: true, force: true });
await rm(workspace, { recursive: true, force: true });
console.log(failures === 0 ? 'OK' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
