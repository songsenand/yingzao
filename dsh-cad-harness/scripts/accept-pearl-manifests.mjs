// Acceptance for the fixed pearl set: six pearls, 1–3 templates each, valid budgets,
// valid failure edges, and a probe slot.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { loadPearlSet, validatePearl, validateTemplate, PEARL_IDS } from '../src/host/pearls/registry.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (ok, label, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };

const pearls = await loadPearlSet(join(ROOT, 'pearls'));
check(pearls.length === PEARL_IDS.length, 'exactly the six fixed pearls load', pearls.map((p) => p.manifest.id).join(','));
check(new Set(pearls.map((p) => p.manifest.id)).size === PEARL_IDS.length, 'pearl ids are unique');

let templateCount = 0;
for (const p of pearls) {
  check(p.templates.length >= 1 && p.templates.length <= 3, `${p.manifest.id}: 1–3 templates`, `${p.templates.length}`);
  check(p.manifest.budget.maxProbe === 1, `${p.manifest.id}: exactly one probe slot`);
  check(Array.isArray(p.manifest.probe.allowed), `${p.manifest.id}: probe allowlist is declared`);
  check(!p.manifest.probe.required || p.manifest.probe.allowed.length > 0, `${p.manifest.id}: required probe has an allowlist`);
  check(p.manifest.probe.criteria.length > 0, `${p.manifest.id}: probe criteria declared`);
  check(p.manifest.exit.length > 0 && p.manifest.not.length > 0, `${p.manifest.id}: boundary has exit and not`);
  templateCount += p.templates.length;
}
check(templateCount >= 6 && templateCount <= 18, 'template count stays bounded', `${templateCount}`);

const model = pearls.find((p) => p.manifest.id === 'model');
check(model.templates.some((t) => t.manifest.id === 'assembly' && t.manifest.retry === 4), 'model owns an assembly contract template with explicit retry');
check(typeof model.manifest.guide === 'string', 'model names its contract guide');

const fit = pearls.find((p) => p.manifest.id === 'fit');
check(typeof fit.manifest.guide === 'string', 'fit names its interface guide');
check(fit.manifest.undeclaredPolicy !== 'block', 'fit does not hard-block undeclared contacts by default');
if (fit.manifest.guide) {
  const guide = await readFile(join(fit.dir, fit.manifest.guide), 'utf8');
  check(guide.includes('set_datums') && guide.includes('root.interfaces'), 'fit guide covers datum + interface steps', `${guide.length} bytes`);
  check(!/腿|边框|牙板|穿带|八仙桌/.test(guide), 'core fit guide contains no furniture-specific groups');
  const example = await readFile(join(ROOT, '../examples/rulepacks/wood-furniture/INTERFACE-GUIDE.md'), 'utf8');
  check(/腿|边框|牙板|穿带/.test(example), 'the wood-furniture rule pack keeps the domain groups');
}

const four = {
  ...pearls[0].manifest,
  id: 'brief',
  templates: ['a', 'b', 'c', 'd'],
};
check(validatePearl(four).some((e) => e.includes('1–3')), 'a fourth template is rejected');

const seventh = { ...pearls[0].manifest, id: 'explore' };
check(validatePearl(seventh).some((e) => e.includes('id must be one of')), 'a seventh pearl is rejected');

const zeroBudget = { ...pearls[0].manifest, budget: { ...pearls[0].manifest.budget, maxCalls: 0 } };
check(validatePearl(zeroBudget).some((e) => e.includes('maxCalls')), 'zero call budget is rejected');

const badTool = {
  ...pearls[2].templates[0].manifest,
  steps: [{ id: 'x', tool: 'not_a_tool' }],
  on_fail: [{ when: 'x.fail', goto: 'model' }],
};
check(validateTemplate(badTool, pearls[2].manifest).some((e) => e.includes('not a registered CAD tool')), 'unknown tool is rejected');

const selfGoto = {
  ...pearls[2].templates[0].manifest,
  on_fail: [{ when: 'interference.fail', goto: 'fit' }],
};
check(validateTemplate(selfGoto, pearls[2].manifest).some((e) => e.includes('retry')), 'self-goto without retry is rejected');
check(validateTemplate({ ...selfGoto, retry: 2 }, pearls[2].manifest).length === 0, 'self-goto is allowed only with explicit retry');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
