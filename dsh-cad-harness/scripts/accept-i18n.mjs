#!/usr/bin/env node
// Plan A acceptance: the high-traffic zh/en dictionaries are complete, the
// English copy is actually English, and the notice/dialog helpers switch.

import { en, installCadLocale, setCadTranslator, t, zh } from '../src/client/i18n.ts';
import { cadMissingToolsNotice, environmentNotice } from '../src/client/project.ts';

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function fill(dict, key, vars = {}) {
  return String(dict[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`));
}

const zhKeys = Object.keys(zh).sort();
const enKeys = Object.keys(en).sort();
check('zh/en key sets are identical', JSON.stringify(zhKeys) === JSON.stringify(enKeys), `${zhKeys.length}/${enKeys.length}`);
check('every key has non-empty zh', zhKeys.every((k) => zh[k].length > 0));
check('every key has non-empty en', enKeys.every((k) => en[k].length > 0));
check('English copy contains no CJK', enKeys.every((k) => !/[\u4e00-\u9fff]/.test(en[k])), enKeys.filter((k) => /[\u4e00-\u9fff]/.test(en[k])).join(', '));

setCadTranslator((key, vars) => fill(en, key, vars));
check('English translator is active', t('tab.title') === 'CAD preview');
check('missing-preset notice translates', cadMissingToolsNotice({ toolScope: 'preset', presets: ['cad'], names: { cad: 'Yingzao mode', standard: 'Standard' } }, 'standard', true)?.includes('Preset not active'));
check('runtime notice translates', environmentNotice({ toolScope: 'global', presets: [], runtime: { state: 'absent' } })?.includes('400 MB'));
check('interpolation works in English', t('export.more', { count: 3 }) === '3 more finding(s); see the export manifest.');
check('kernel notice names the CLI', environmentNotice({ toolScope: 'global', presets: [], backend: { kernel: 'cadquery', compileBackend: 'auto' } })?.includes('dsh-cad-backend'));

const seen = [];
const fakeCtx = {
  effect(fn) { fn(); },
  locale: {
    register(ns, locale, dict) { seen.push(`${ns}:${locale}`); return () => {}; },
    bind() { return (key, vars) => fill(en, key, vars); },
    subscribe() { return () => {}; },
  },
};
installCadLocale(fakeCtx);
check('locale registers zh and en', seen.includes('cad:zh') && seen.includes('cad:en'), seen.join(','));
check('locale binding is active', t('tab.title') === 'CAD preview');

setCadTranslator((key, vars) => fill(zh, key, vars));
check('Chinese translator restores', t('tab.title') === 'CAD 预览');
check('Chinese runtime notice is back', environmentNotice({ toolScope: 'global', presets: [], runtime: { state: 'absent' } })?.includes('400 MB'));

console.log(`\naccept-i18n: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
