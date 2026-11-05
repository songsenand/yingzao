// Build a prompt card for one pearl template. This is the bridge between the
// manifest (data) and the model (instructions); Phase 3b can inject it into the
// runtime, while M2 exposes it as `node scripts/pearl-prompt.mjs`.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LoadedPearl } from './registry.ts';
import { planPearl } from './plan.ts';

export async function buildPearlPrompt(pearl: LoadedPearl, templateId: string): Promise<string> {
  const plan = planPearl(pearl, templateId);
  const guide = pearl.manifest.guide
    ? await readFile(join(pearl.dir, pearl.manifest.guide), 'utf8').catch(() => '')
    : '';
  const lines: string[] = [
    `You are running pearl "${pearl.manifest.id}" / template "${templateId}".`,
    `Question: ${pearl.manifest.question}`,
    `Exit: ${pearl.manifest.exit.join('; ')}`,
    `Not this pearl: ${pearl.manifest.not.join('; ')}`,
    `Budget: tools<=${plan.budget.maxDistinctTools}, calls<=${plan.budget.maxCalls}, seconds<=${plan.budget.maxCostSeconds}, probe<=${plan.budget.maxProbe}`,
    '',
    'Steps:',
    ...plan.steps.map((s, i) => {
      const parallel = s.parallelWith.length ? ` (parallel with ${s.parallelWith.join(', ')})` : '';
      const when = s.when ? ` [when: ${s.when}]` : '';
      const args = s.args ? ` args=${JSON.stringify(s.args)}` : '';
      const bind = s.bind ? ` bind=${JSON.stringify(s.bind)}` : '';
      return `${i + 1}. ${s.id}: ${s.tool}${args}${bind}${when}${parallel}`;
    }),
    '',
    'Failure edges:',
    ...(pearl.templates.find((t) => t.manifest.id === templateId)?.manifest.on_fail ?? []).map((e) => `- ${e.when} -> ${e.goto}${e.with ? ` (${e.with})` : ''}${e.kind ? ` [${e.kind}]` : ''}`),
    '',
    'A declared subset is not coverage: a green `0 hard violations` over zero/partial interfaces is not a pass.',
    `Undeclared policy: ${pearl.manifest.undeclaredPolicy ?? 'warn'}`,
  ];
  if (guide) lines.push('', '--- GUIDE ---', guide.trim());
  return lines.join('\n');
}
