// Acceptance for the prompt card: manifest + guide actually reach the model-facing text.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPearl } from '../src/host/pearls/registry.ts';
import { buildPearlPrompt } from '../src/host/pearls/prompt.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (ok, label, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };

const fit = await loadPearl(join(ROOT, 'pearls/fit'));
const prompt = await buildPearlPrompt(fit, 'static');
check(prompt.includes('pearl "fit"'), 'prompt names the pearl');
check(prompt.includes('validate_assembly') && prompt.includes('check_assembly'), 'prompt includes the template steps');
check(prompt.includes('INTERFACE-GUIDE') || prompt.includes('fit / 通用装配接口指南'), 'prompt includes the generic guide content', `${prompt.length} chars`);
check(prompt.includes('Undeclared policy: warn'), 'prompt carries the default undeclared policy');
check(prompt.includes('declared subset is not coverage'), 'prompt states the coverage rule');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
