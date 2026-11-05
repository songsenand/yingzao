// Step inputs: bindings resolve from project/input, missing values are errors.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStepContext } from '../src/host/pearls/context.ts';
import { resolveStepArgs, checkStepInputs, MissingStepInput } from '../src/host/pearls/inputs.ts';
import { loadPearl } from '../src/host/pearls/registry.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (ok, label, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };

const ctx = await buildStepContext(join(ROOT, '../examples/windup-frog'));
const assembly = ctx.project?.assembly;
check(Array.isArray(assembly?.parts) && assembly.parts.length === 12, 'context exposes assembly parts', String(assembly?.parts?.length));
check(typeof assembly?.path === 'string' && assembly.path.endsWith('assembly.json'), 'context exposes assembly path');

const fit = await loadPearl(join(ROOT, 'pearls/fit'));
const staticT = fit.templates.find((t) => t.manifest.id === 'static');
const interference = staticT.manifest.steps.find((s) => s.id === 'interference');
const args = resolveStepArgs(interference, ctx);
check(Array.isArray(args.parts) && args.parts.length === 12, 'fit.interference resolves parts from project');

const gaps = staticT.manifest.steps.find((s) => s.id === 'gaps');
check(checkStepInputs(gaps, ctx).length > 0, 'missing gap input is reported');
let missing = '';
try { resolveStepArgs(gaps, ctx); } catch (e) { missing = String(e); }
check(missing.includes('gap.versionId'), 'missing input throws MissingStepInput', missing.slice(0, 80));
const withGap = resolveStepArgs(gaps, { ...ctx, input: { gap: { versionId: 'v001', aVersionId: 'v001', bVersionId: 'v002' } } });
check(withGap.versionId === 'v001' && withGap.bVersionId === 'v002', 'gap input binds when supplied');

const model = await loadPearl(join(ROOT, 'pearls/model'));
const assemblyT = model.templates.find((t) => t.manifest.id === 'assembly');
const contractStep = assemblyT.manifest.steps.find((s) => s.id === 'contract');
check(checkStepInputs(contractStep, ctx).length === 3, 'write_assembly contract requires caller input', checkStepInputs(contractStep, ctx).join(','));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
