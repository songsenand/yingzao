// Repair policy: no-progress detection + a global round cap.
//
// The old `retry: 2` per failure unit was a placeholder, not data. A repair
// round is only useful if the failure signature changes; repeating the same
// signature is not a retry, it is a loop.
//
// transient retries are separate: same input, same failure kind (timeout,
// runtime-not-ready), at most 2; they never count as repair rounds.

import type { PearlFailure } from './failure.ts';

export const MAX_REPAIR_ROUNDS = 4;
export const MAX_TRANSIENT_RETRIES = 2;

export interface RepairHashes {
  assemblyHash?: string;
  contractHash?: string;
}

/** Stable coarse signature: code + located parts + assembly/contract identity. */
export function repairSignature(failure: PearlFailure, hashes: RepairHashes = {}): string {
  const parts = (failure.location.parts ?? []).slice().sort().join('+');
  return [
    failure.code,
    parts,
    hashes.assemblyHash ?? '-',
    hashes.contractHash ?? '-',
  ].join('|');
}

export type RepairAction = 'continue' | 'no-progress' | 'exhausted';

export interface RepairDecision {
  action: RepairAction;
  round: number;
  maxRounds: number;
  signatures: string[];
  repeated: string[];
  reason: string;
}

/**
 * Decide whether another repair round is justified.
 *
 * @param round 0-based completed repair rounds (0 = first failure, no repair yet)
 * @param failures current failures
 * @param previousSignatures signatures seen in earlier rounds
 */
export function decideRepair(
  round: number,
  failures: PearlFailure[],
  previousSignatures: readonly string[],
  hashes: RepairHashes = {},
  maxRounds = MAX_REPAIR_ROUNDS,
): RepairDecision {
  const signatures = failures.map((f) => repairSignature(f, hashes));
  const seen = new Set(previousSignatures);
  const repeated = signatures.filter((s) => seen.has(s));
  if (failures.length === 0) {
    return { action: 'continue', round, maxRounds, signatures, repeated, reason: 'no failures; nothing to repair' };
  }
  if (repeated.length > 0) {
    return {
      action: 'no-progress', round, maxRounds, signatures, repeated,
      reason: `same failure signature repeated (${repeated.slice(0, 2).join(', ')}); another round would not add information`,
    };
  }
  if (round >= maxRounds) {
    return {
      action: 'exhausted', round, maxRounds, signatures, repeated,
      reason: `repair round ${round} reached global cap ${maxRounds}`,
    };
  }
  return {
    action: 'continue', round, maxRounds, signatures, repeated,
    reason: `new failure signature; repair round ${round + 1}/${maxRounds} allowed`,
  };
}
