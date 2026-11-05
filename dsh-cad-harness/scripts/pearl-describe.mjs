// Print one pearl's boundary, budget and templates as JSON.
import { loadPearl } from '../src/host/pearls/registry.ts';
import { describePearl } from '../src/host/pearls/plan.ts';

const id = process.argv[2];
if (!id) {
  console.error('usage: node scripts/pearl-describe.mjs <pearl-id>');
  process.exit(2);
}
const pearl = await loadPearl(new URL(`../pearls/${id}`, import.meta.url).pathname);
console.log(JSON.stringify(describePearl(pearl), null, 2));
