// Acceptance for the generated v0 standard-parts library.
//
// This checks both the catalog and the artifacts:
//   * 99 core specs / 14 families / core budget;
//   * stable IDs and package metadata;
//   * fit + visual models exist, hashes match, visual bbox stays in fit;
//   * alias-fit visuals reuse the fit files (no duplicate geometry);
//   * 286 geometry files + 99 part.json = 385 files.
//
//   node scripts/accept-library-catalog.mjs
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIB = join(ROOT, 'library');
const catalogPath = join(LIB, 'catalog.json');
const schemaPath = join(LIB, 'catalog.schema.json');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const sha256 = async (path) => {
  const h = createHash('sha256');
  h.update(await readFile(path));
  return h.digest('hex');
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
check(catalog.packages?.core?.status === 'active', 'core package is active');
check(catalog.packages?.full?.status === 'planned', 'full package is still planned');

const geometryFiles = new Set();
let aliasCount = 0;
let distinctCount = 0;

const inside = (inner, outer, tolerance = 0.3) =>
  ['min', 'max'].every((edge) =>
    [0, 1, 2].every((i) => inner?.[edge]?.[i] !== undefined && inner[edge][i] >= outer[edge][i] - tolerance && inner[edge][i] <= outer[edge][i] + tolerance),
  );

for (const spec of specs) {
  check(!ids.has(spec.id), `id is unique: ${spec.id}`);
  ids.add(spec.id);
  check(spec.id.startsWith(`${spec.family}.`), `id is family-scoped: ${spec.id}`);
  check(!/^(core|full)\./.test(spec.id), `id has no package prefix: ${spec.id}`);
  check(!spec.id.includes('/') && !spec.id.includes('..'), `id is a safe path segment: ${spec.id}`);
  check(families[spec.family] !== undefined, `family exists: ${spec.id}`, spec.family);
  check(spec.standard === families[spec.family]?.standard, `spec inherits the family standard: ${spec.id}`, spec.standard);
  check(spec.status === 'generated', `spec is generated: ${spec.id}`, spec.status);
  check(spec.source === 'purchased', `v0 specs are purchased: ${spec.id}`, spec.source);
  check(spec.frequency?.source === 'assumed', `frequency is explicitly assumed: ${spec.id}`, spec.frequency?.source);
  check(spec.frequency?.score === null, `assumed frequency has no invented score: ${spec.id}`);
  check(typeof spec.frequency?.note === 'string' && spec.frequency.note.includes('v0'), `assumed frequency says v0: ${spec.id}`);

  const fit = spec.lod?.fit;
  const visual = spec.lod?.visual;
  check(fit?.role === 'fit' && fit?.status === 'generated', `fit is generated: ${spec.id}`);
  check(visual?.role === 'render' && visual?.status === 'generated', `visual is generated: ${spec.id}`);
  check(['distinct', 'alias-fit'].includes(visual?.mode), `visual mode is explicit: ${spec.id}`, visual?.mode);
  check(visual?.mode === families[spec.family]?.visualDefault, `spec follows family visual mode: ${spec.id}`);

  for (const [name, model] of [['fit', fit?.model], ['visual', visual?.model]]) {
    check(model && typeof model === 'object', `${name} has a model: ${spec.id}`);
    if (!model) continue;
    for (const kind of ['step', 'stl']) {
      const rel = model[kind];
      check(typeof rel === 'string' && rel.startsWith('parts/') && !rel.includes('..'), `${name}.${kind} is a safe relative path: ${spec.id}`, rel);
      const abs = join(LIB, rel);
      let size = 0;
      try { size = (await stat(abs)).size; } catch { size = 0; }
      check(size > 0, `${name}.${kind} exists and is non-empty: ${spec.id}`, `${size} bytes`);
      if (size > 0) check((await sha256(abs)) === model[`${kind}Sha256`], `${name}.${kind} hash matches: ${spec.id}`);
      geometryFiles.add(abs);
    }
    check(/^[a-f0-9]{64}$/.test(model.stepSha256) && /^[a-f0-9]{64}$/.test(model.stlSha256), `${name} has sha256 hashes: ${spec.id}`);
  }

  const partPath = join(LIB, 'parts', spec.id, 'part.json');
  let part = null;
  try { part = JSON.parse(await readFile(partPath, 'utf8')); } catch { part = null; }
  check(part !== null, `part.json exists: ${spec.id}`);
  if (part) {
    check(part.id === spec.id, `part.json id matches: ${spec.id}`);
    check(part.fit?.step === fit.model.step && part.fit?.stl === fit.model.stl, `part.json fit paths match catalog: ${spec.id}`);
    check(part.visual?.step === visual.model.step && part.visual?.stl === visual.model.stl, `part.json visual paths match catalog: ${spec.id}`);
    check(part.fit?.triangles > 0 && part.visual?.triangles > 0, `part.json carries triangle counts: ${spec.id}`);
    check(Array.isArray(part.datums ? Object.keys(part.datums) : []) && Object.keys(part.datums ?? {}).length > 0, `part.json carries datums: ${spec.id}`);
    check(inside(part.visual?.bboxMm, part.bboxMm), `visual bbox is inside fit bbox: ${spec.id}`, JSON.stringify(part.visual?.bboxMm));
  }

  if (visual.mode === 'alias-fit') {
    aliasCount++;
    check(fit.model.step === visual.model.step && fit.model.stl === visual.model.stl, `alias visual reuses fit files: ${spec.id}`);
  } else {
    distinctCount++;
    check(fit.model.step !== visual.model.step && fit.model.stl !== visual.model.stl, `distinct visual has its own files: ${spec.id}`);
  }

  check(spec.params && typeof spec.params === 'object' && !Array.isArray(spec.params), `params is an object: ${spec.id}`);
  check(Array.isArray(spec.datums) && spec.datums.length > 0, `spec has datums: ${spec.id}`);
  check(Array.isArray(spec.compatibleWith), `compatibleWith is an array: ${spec.id}`);
  for (const other of spec.compatibleWith ?? []) {
    check(families[other] !== undefined, `compatibleWith names a real family: ${spec.id} → ${other}`);
  }
  check(Array.isArray(spec.tags) && spec.tags.length > 0, `spec has tags: ${spec.id}`);
}

check(aliasCount === 55, '55 specs use alias-fit visual (no duplicate geometry)', String(aliasCount));
check(distinctCount === 44, '44 specs have distinct visual geometry', String(distinctCount));
check(geometryFiles.size === 286, '286 geometry files (143 STEP + 143 STL)', String(geometryFiles.size));
check(geometryFiles.size + specs.length === 385, '385 total files including part.json', String(geometryFiles.size + specs.length));

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

if (failures) {
  console.log(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nfamily counts:', JSON.stringify(familyCounts));
console.log('OK');
