// Build the derived necklace contract; optionally write it atomically.
import { buildNecklaceContract, readNecklaceContract, writeNecklaceContract } from '../src/host/pearls/contract.ts';

const args = process.argv.slice(2);
const write = args.includes('--write');
const dir = args.find((a) => !a.startsWith('--')) ?? process.cwd();
const contract = await buildNecklaceContract(dir);
if (write) {
  let expectedHash;
  try { expectedHash = (await readNecklaceContract(dir)).contractHash; } catch { /* create */ }
  const w = await writeNecklaceContract(dir, contract, expectedHash);
  console.log(JSON.stringify({ ...contract, written: w }, null, 2));
} else {
  console.log(JSON.stringify(contract, null, 2));
}
