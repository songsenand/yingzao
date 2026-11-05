// Contract-round executor. It runs the six observers as one round, applies the
// no-progress/4-round repair policy, and returns a repair route. It does NOT
// call CAD tools: each pearl's evidence is still produced by the tools/agents
// inside that pearl. This is the execution seam, not a fake tool runner.

import { withDeadline } from '../deadline.ts';
import { loadProjectProfile } from './profile.ts';
import { buildNecklaceContract, CONTRACT_STAGES, type ContractPearl, type NecklaceContract } from './contract.ts';
import { decideRepair, MAX_REPAIR_ROUNDS, type RepairAction } from './repair.ts';
import { manifestLocation, type PearlFailure } from './failure.ts';
import type { PearlStatus } from './ledger.ts';

export type ExecutionStatus = PearlStatus | 'repair-needed';

export interface ContractRoundResult {
  status: ExecutionStatus;
  round: number;
  maxRounds: number;
  deadlineMs: number;
  timedOut: boolean;
  stages: { stage: number; pearls: ContractPearl[]; status: Partial<Record<ContractPearl, PearlStatus>> }[];
  contract: NecklaceContract | null;
  repair: Pick<ReturnType<typeof decideRepair>, 'action' | 'signatures' | 'repeated' | 'reason'>;
  next: ContractPearl[];
  failures: PearlFailure[];
}

export interface ContractRoundOptions {
  round?: number;
  previousSignatures?: string[];
  deadlineMs?: number;
}

export async function executeContractRound(
  projectRoot: string,
  options: ContractRoundOptions = {},
): Promise<ContractRoundResult> {
  let deadlineMs = options.deadlineMs;
  if (deadlineMs === undefined) {
    try { deadlineMs = (await loadProjectProfile(projectRoot)).effectiveBudget.maxCostSeconds * 1000; }
    catch { deadlineMs = 900_000; }
  }
  const round = options.round ?? 0;
  const started = await withDeadline(buildNecklaceContract(projectRoot), deadlineMs, 'pearl contract round');
  if (!started.ok) {
    const failure: PearlFailure = {
      code: 'pearl.deadline', severity: 'hard',
      what: `contract round exceeded ${deadlineMs} ms`,
      why: ['a step or evidence read is hung', 'the pearl budget is too tight for this project'],
      location: manifestLocation('necklace-contract.json', 'deadline; inspect the last step log'),
      evidence: { deadlineMs, round },
      next: ['inspect run-events/tool logs', 'raise the deadline or fix the hung step'],
    };
    return {
      status: 'blocked', round, maxRounds: MAX_REPAIR_ROUNDS, deadlineMs, timedOut: true,
      stages: [], contract: null,
      repair: { action: 'exhausted', signatures: [], repeated: [], reason: 'deadline exceeded' },
      next: ['model'], failures: [failure],
    };
  }
  const contract = started.value;
  const repair = decideRepair(
    round,
    contract.failures,
    options.previousSignatures ?? [],
    { ...(contract.assembly?.hash ? { assemblyHash: contract.assembly.hash } : {}) },
    MAX_REPAIR_ROUNDS,
  );
  const status: ExecutionStatus = contract.status === 'blocked' || contract.status === 'fail'
    ? contract.status
    : contract.failures.length === 0
      ? contract.status
      : repair.action === 'continue' ? 'repair-needed' : 'blocked';
  const stages = CONTRACT_STAGES.map((pearls, stage) => ({
    stage,
    pearls,
    status: Object.fromEntries(pearls.map((p) => [p, contract.sections[p].status])) as Partial<Record<ContractPearl, PearlStatus>>,
  }));
  return {
    status, round, maxRounds: MAX_REPAIR_ROUNDS, deadlineMs, timedOut: false,
    stages, contract,
    repair: { action: repair.action, signatures: repair.signatures, repeated: repair.repeated, reason: repair.reason },
    next: contract.next,
    failures: contract.failures,
  };
}
