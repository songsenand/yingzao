// One contract round: observe, route failures, apply no-progress/4-round policy.
// Default is quiet on pass and loud on failure; --json for the full object.
import { executeContractRound } from '../src/host/pearls/execute.ts';
import { formatContractRound } from '../src/host/pearls/format.ts';

const args = process.argv.slice(2);
const json = args.includes('--json');
const dir = args.find((a) => !a.startsWith('--')) ?? process.cwd();
const roundArg = args.find((a) => a.startsWith('--round='));
const deadlineArg = args.find((a) => a.startsWith('--deadline-ms='));
const result = await executeContractRound(dir, {
  ...(roundArg ? { round: Number(roundArg.split('=')[1]) } : {}),
  ...(deadlineArg ? { deadlineMs: Number(deadlineArg.split('=')[1]) } : {}),
});
console.log(json ? JSON.stringify(result, null, 2) : formatContractRound(result));
