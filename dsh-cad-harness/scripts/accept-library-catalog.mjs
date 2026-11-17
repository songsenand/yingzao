// Acceptance for the v0 standard-parts catalog.
//
// The catalog is data-only: no STEP/STL yet. This script pins the things that
// would silently rot before geometry exists:
//   * the 99-spec core budget (<100) and stable IDs;
//   * package membership is metadata, never part of the ID;
//   * fit/visual are both present, and visual is explicitly render-only;
//   * frequency is labelled assumed, not observed.
//
//   node scripts/accept-library-catalog.mjs
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const catalogPath = join(ROOT, 'library', 'catalog.json');
const schemaPath = join(ROOT, 'library', 'catalog.schema.json');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
const schema = JSON.parse(await readFile(schemaPath, 'utf8'));

check(catalog.schemaVersion === 1, 'catalog declares schemaVersion 1', String(catalog.schemaVersion));
check(typeof catalog.library === 'string' && catalog.library.length > 0, 'catalog has a library id');
check(typeof catalog.catalogVersion === 'string' && catalog.catalogVersion.length > 0, 'catalog has a version', catalog.catalogVersion);
check(catalog.units === 'mm', 'catalog is in mm', catalog.units);
check(schema.$schema?.includes('2020-12'), 'schema is JSON Schema 2020-12', schema.$schema);
check(typeof catalog.dimensionPolicy === 'string' && catalog.dimensionPolicy.length > 0, 'catalog states the dimension policy');

const families = catalog.families ?? {};
const specs = catalog.specs ?? [];
const familyIds = Object.keys(families);
check(familyIds.length === 14, 'v0 has 14 families', String(familyIds.length));
check(specs.length === 99, 'v0 has 99 specs', String(specs.length));

const ids = new Set();
const core = specs.filter((s) => s.package === 'core');
const full = specs.filter((s) => s.package === 'full');
check(core.length <= (catalog.packages?.core?.maxSpecs ?? 100), 'core stays within its spec budget', `${core.length}/${catalog.packages?.core?.maxSpecs}`);
check(core.length + full.length === specs.length, 'every spec belongs to exactly one package');
check(core.length === 99 && full.length === 0, 'v0 puts all 99 specs in core; full is the future optional bundle', `${core.length} core / ${full.length} full`);

for (const spec of specs) {
  check(!ids.has(spec.id), `id is unique: ${spec.id}`);
  ids.add(spec.id);
  check(typeof spec.id === 'string' && spec.id.startsWith(`${spec.family}.`), `id is family-scoped: ${spec.id}`);
  check(!/^(core|full)\./.test(spec.id), `id has no package prefix: ${spec.id}`);
  check(!spec.id.includes('/'), `id has no path: ${spec.id}`);
  check(families[spec.family] !== undefined, `family exists: ${spec.id}`, spec.family);
  check(spec.standard === families[spec.family]?.standard, `spec inherits the family standard: ${spec.id}`, spec.standard);
  check(spec.status === 'planned', `v0 is data-only (planned): ${spec.id}`, spec.status);
  check(spec.source === 'purchased', `v0 specs are purchased: ${spec.id}`, spec.source);
  check(spec.frequency?.source === 'assumed', `frequency is explicitly assumed: ${spec.id}`, spec.frequency?.source);
  check(spec.frequency?.score === null, `assumed frequency has no invented score: ${spec.id}`);
  check(typeof spec.frequency?.note === 'string' && spec.frequency.note.includes('v0'), `assumed frequency says v0: ${spec.id}`);

  check(spec.lod?.fit?.role === 'fit', `fit role is fit: ${spec.id}`);
  check(spec.lod?.fit?.status === 'planned' && spec.lod.fit.model === null, `fit is planned (no geometry yet): ${spec.id}`);
  check(spec.lod?.visual?.role === 'render', `visual role is render: ${spec.id}`);
  check(spec.lod?.visual?.status === 'planned' && spec.lod.visual.model === null, `visual is planned (no geometry yet): ${spec.id}`);
  check(['distinct', 'alias-fit'].includes(spec.lod?.visual?.mode), `visual mode is explicit: ${spec.id}`, spec.lod?.visual?.mode);
  check(spec.lod?.visual?.mode === families[spec.family]?.visualDefault, `spec follows family visual mode: ${spec.id}`);

  check(spec.params && typeof spec.params === 'object' && !Array.isArray(spec.params), `params is an object: ${spec.id}`);
  check(!JSON.stringify(spec.params).includes('null'), `params stores no placeholder nulls: ${spec.id}`);
  check(Array.isArray(spec.datums) && spec.datums.length > 0, `spec has datums: ${spec.id}`);
  check(Array.isArray(spec.compatibleWith), `compatibleWith is an array: ${spec.id}`);
  for (const other of spec.compatibleWith ?? []) {
    check(families[other] !== undefined, `compatibleWith names a real family: ${spec.id} → ${other}`);
  }
  check(Array.isArray(spec.tags) && spec.tags.length > 0, `spec has tags: ${spec.id}`);
}

const familyCounts = Object.fromEntries(familyIds.map((id) => [id, specs.filter((s) => s.family === id).length]));
for (const id of familyIds) {
  check(familyCounts[id] > 0, `family is represented in v0: ${id}`, String(familyCounts[id]));
  check(typeof families[id].fitRule === 'string' && families[id].fitRule.length > 0, `family has fit rule: ${id}`);
  check(typeof families[id].visualRule === 'string' && families[id].visualRule.length > 0, `family has visual rule: ${id}`);
  check(families[id].defaultLod === 'fit', `family default LOD is fit: ${id}`);
  for (const other of families[id].compatibleWith ?? []) {
    check(families[other] !== undefined, `family compatibility is resolvable: ${id} → ${other}`);
  }
}

check(!specs.some((s) => s.lod?.fit?.model || s.lod?.visual?.model), 'no geometry paths are invented before generation');
check(!specs.some((s) => s.package !== 'core' && s.package !== 'full'), 'package is only core/full');

if (failures) {
  console.log(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nfamily counts:', JSON.stringify(familyCounts));
console.log('OK');
