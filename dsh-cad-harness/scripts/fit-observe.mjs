// Observe-only fit: read a project's cad-data/runs, do not call any tool.
import { observeFit } from '../src/host/pearls/observe.ts';
import { loadPearl } from '../src/host/pearls/registry.ts';

const args = process.argv.slice(2);
const pearl = await loadPearl(new URL('../pearls/fit', import.meta.url).pathname);
const policyStrict = pearl.manifest.undeclaredPolicy === 'block';
const strict = args.includes('--strict') || (policyStrict && !args.includes('--allow-undeclared'));
const cadData = args.find((a) => !a.startsWith('--'));
if (!cadData) {
  console.error('usage: node scripts/fit-observe.mjs [--strict|--allow-undeclared] <cad-data>');
  process.exit(2);
}
const observation = await observeFit(cadData, { requireUndeclaredZero: strict });
console.log(JSON.stringify(observation, null, 2));
