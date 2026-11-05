// Validate a written necklace contract and compare its assembly hash to current.
import { readNecklaceContract } from '../src/host/pearls/contract.ts';

const dir = process.argv[2] ?? process.cwd();
try {
  const r = await readNecklaceContract(dir);
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.stale ? 1 : 0);
} catch (e) {
  console.error(String(e));
  process.exit(2);
}
