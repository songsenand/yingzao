#!/usr/bin/env node
// Acceptance: a section cut can be given in mm, the way drawings state it.
//
// WHY (2026-11-27): `cad_see render` accepted only `section.fraction` (0..1), while
// `cad_inspect measure` already accepted `section.atMm`. A model asked to cut at
// y=18 passed `position: 18` and was rejected; converting mm→fraction was left to
// the caller, who does not know the bbox. The two tools now take the same shape.
//
//   node scripts/accept-render-section.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'cad-render-section-'));

const { sectionFraction } = await import('../src/host/inspect.ts');
const { registerCadTools } = await import('../src/host/tools.ts');

let passed = 0;
let failed = 0;
const check = (ok, label, detail = '') => {
  if (ok) { passed++; console.log(`  PASS ${label}`); }
  else { failed++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

const bb = { min: [0, 0, 0], max: [10, 20, 100] };

console.log('--- mm → fraction ---');
check(sectionFraction(bb, { axis: 'y', atMm: 18 }) === 0.9, 'y=18mm on a 0..20 box is 0.9',
  String(sectionFraction(bb, { axis: 'y', atMm: 18 })));
check(sectionFraction(bb, { axis: 'z', atMm: 25 }) === 0.25, 'z=25mm on a 0..100 box is 0.25');
check(sectionFraction(bb, { axis: 'y', fraction: 0.25 }) === 0.25, 'fraction is passed through');
check(sectionFraction(bb, { axis: 'y', atMm: 5, fraction: 0.9 }) === 0.25, 'atMm wins over fraction');
check(sectionFraction(bb, { axis: 'y', atMm: -5 }) === 0, 'a cut below the box clamps to 0');
check(sectionFraction(bb, { axis: 'y', atMm: 500 }) === 1, 'a cut above the box clamps to 1');
check(sectionFraction({ min: [0, 0, 0], max: [0, 0, 0] }, { axis: 'x', atMm: 3 }) === 0.5,
  'a zero-span axis falls back to the middle instead of dividing by zero');

console.log('--- both tools declare the same shape ---');
const tools = new Map();
const ctx = {
  tools: { register: (def) => { tools.set(def.name, def); return () => {}; } },
  on: () => {}, effect: (fn) => fn(),
  reflect: { get: () => undefined },
};
registerCadTools(ctx, { toolScope: 'preset', presets: ['cad'] });
const sectionSchema = (name) => {
  const def = tools.get(name);
  const params = def?.parameters?.section ? def.parameters : def?.parameters?.properties;
  return params?.section ?? null;
};
for (const tool of ['render_part', 'review_visual']) {
  const section = sectionSchema(tool);
  check(Boolean(section), `${tool} declares a section object`);
  check(Boolean(section?.properties?.atMm), `${tool} accepts section.atMm`);
  check(section?.properties?.fraction?.required !== true, `${tool} no longer forces section.fraction`);
  check(section?.properties?.axis, `${tool} still requires section.axis`);
}

console.log('--- a section with neither field is refused with a fix ---');
const renderError = await (async () => {
  try { await tools.get('render_part').execute({ versionId: 'v001', section: { axis: 'y' } }, {}); return ''; }
  catch (error) { return String(error?.message ?? error); }
})();
check(/needs fraction \(0\.\.1\) or atMm \(mm\)/.test(renderError), 'render_part names both accepted forms', renderError.slice(0, 160));
check(/atMm: 18/.test(renderError), 'and shows an atMm example', renderError);

const reviewError = await (async () => {
  try {
    await tools.get('review_visual').execute({
      items: [{ versionId: 'v001', note: '检查底面与旋扣的配合' }],
      section: { axis: 'y' },
    }, {});
    return '';
  } catch (error) { return String(error?.message ?? error); }
})();
check(/needs fraction \(0\.\.1\) or atMm \(mm\)/.test(reviewError), 'review_visual refuses the same way', reviewError.slice(0, 160));

console.log(`\naccept-render-section: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
