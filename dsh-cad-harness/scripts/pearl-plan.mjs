// Read-only plan for one pearl template. Never calls a tool.
import { loadPearl } from '../src/host/pearls/registry.ts';
import { planPearl } from '../src/host/pearls/plan.ts';

const [id, template] = process.argv.slice(2);
if (!id || !template) {
  console.error('usage: node scripts/pearl-plan.mjs <pearl-id> <template-id>');
  process.exit(2);
}
const pearl = await loadPearl(new URL(`../pearls/${id}`, import.meta.url).pathname);
const plan = planPearl(pearl, template);
console.log(JSON.stringify(plan, null, 2));
process.exit(plan.issues.length ? 1 : 0);
