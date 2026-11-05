// Read-only pearl gate: auto-load project profile, plan, budget, observe six pearls.
import { runPearl } from '../src/host/pearls/run.ts';

const dir = process.argv[2] ?? process.cwd();
console.log(JSON.stringify(await runPearl(dir), null, 2));
