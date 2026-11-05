// Print the runtime prompt card for a pearl template (manifest + guide).
import { loadPearl } from '../src/host/pearls/registry.ts';
import { buildPearlPrompt } from '../src/host/pearls/prompt.ts';

const [id, template] = process.argv.slice(2);
if (!id || !template) {
  console.error('usage: node scripts/pearl-prompt.mjs <pearl-id> <template-id>');
  process.exit(2);
}
const pearl = await loadPearl(new URL(`../pearls/${id}`, import.meta.url).pathname);
console.log(await buildPearlPrompt(pearl, template));
