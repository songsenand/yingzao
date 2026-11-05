// Persistent repair history: a round is only "different" if the signature changed.
// The history is an artifact, not a gate; write failures are returned, not swallowed.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonAtomic } from '../file-lock.ts';

export interface RepairHistoryRound {
  round: number;
  at: string;
  action: 'continue' | 'no-progress' | 'exhausted';
  signatures: string[];
  repeated: string[];
  next?: string;
  reason: string;
}

export interface RepairHistory {
  schemaVersion: 1;
  rounds: RepairHistoryRound[];
}

const FILE = join('assembly', 'pearl-repair-history.json');

export async function readRepairHistory(projectRoot: string): Promise<RepairHistory> {
  try {
    const raw = JSON.parse(await readFile(join(projectRoot, FILE), 'utf8')) as Partial<RepairHistory>;
    if (raw.schemaVersion !== 1 || !Array.isArray(raw.rounds)) return { schemaVersion: 1, rounds: [] };
    return { schemaVersion: 1, rounds: raw.rounds };
  } catch {
    return { schemaVersion: 1, rounds: [] };
  }
}

export async function appendRepairHistory(projectRoot: string, round: RepairHistoryRound): Promise<string> {
  const path = join(projectRoot, FILE);
  const history = await readRepairHistory(projectRoot);
  history.rounds.push(round);
  await writeJsonAtomic(path, history);
  return path;
}
