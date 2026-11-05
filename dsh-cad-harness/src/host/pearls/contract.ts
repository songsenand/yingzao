// Necklace contract: the thin thread that binds the six pearls.
//
// It is NOT the assembly contract. `assembly/assembly.json` remains the geometry
// interface contract; this file records per-pearl status, evidence and failures,
// and carries the assembly hash so a stale contract is visible.
//
// The contract is a derived index first; writing it is explicit and atomic.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { writeJsonAtomic } from '../file-lock.ts';
import { dirname, join } from 'node:path';
import type { PearlFailure } from './failure.ts';
import type { LedgerEntry, PearlStatus } from './ledger.ts';
import { runPearl, type PearlRunReport } from './run.ts';
import { decideRepair, MAX_REPAIR_ROUNDS, type RepairAction } from './repair.ts';

export type ContractPearl = 'brief' | 'model' | 'fit' | 'make' | 'review' | 'deliver';
export const CONTRACT_PEARLS: ContractPearl[] = ['brief', 'model', 'fit', 'make', 'review', 'deliver'];

/** Dependency order, not a serial script: each stage is parallel-safe. */
export const CONTRACT_STAGES: ContractPearl[][] = [
  ['brief'],
  ['model'],
  ['fit', 'make', 'review'],
  ['deliver'],
];

export interface ContractSection {
  status: PearlStatus;
  evidence: Record<string, unknown>;
  failures: PearlFailure[];
  note?: string;
}

export interface NecklaceContract {
  schemaVersion: 1;
  id: string;
  project: string;
  generatedAt: string;
  rulePack: string | null;
  template: string | null;
  status: PearlStatus;
  /** Every section has some evidence (not necessarily pass). */
  complete: boolean;
  assembly: { path: string; hash: string | null; counts: { children: number; interfaces: number } | null } | null;
  sections: Record<ContractPearl, ContractSection>;
  failures: PearlFailure[];
  repair: { round: number; maxRounds: number; action: RepairAction; signatures: string[]; reason: string };
  /** Which pearls to revisit first, derived from failure codes. */
  next: ContractPearl[];
}

async function fileHash(path: string): Promise<string | null> {
  try { return `sha256:${createHash('sha256').update(await readFile(path)).digest('hex')}`; }
  catch { return null; }
}

function section(entry: LedgerEntry): ContractSection {
  return { status: entry.status, evidence: entry.evidence, failures: entry.failures, ...(entry.note ? { note: entry.note } : {}) };
}

function ownerOf(code: string): ContractPearl {
  if (code.startsWith('make.')) return 'make';
  if (code.startsWith('review.')) return 'review';
  if (code.startsWith('deliver.')) return 'deliver';
  if (code.startsWith('brief.')) return 'brief';
  if (code.startsWith('model.')) return 'model';
  if (code === 'interference' || code === 'hard-interface' || code === 'no-declared-interfaces' || code === 'stale-contract') return 'model';
  if (code.startsWith('fit.') || code === 'undeclared-adjacency') return 'fit';
  if (code.startsWith('pearl.')) return 'model';
  return 'fit';
}

/** Build the derived necklace contract from the current evidence. */
export async function buildNecklaceContract(projectRoot: string): Promise<NecklaceContract> {
  const run: PearlRunReport = await runPearl(projectRoot);
  const ledger = run.ledger;
  const sections = {} as Record<ContractPearl, ContractSection>;
  if (ledger) {
    for (const p of CONTRACT_PEARLS) sections[p] = section(ledger[p]);
  } else {
    for (const p of CONTRACT_PEARLS) sections[p] = { status: 'unobserved', evidence: {}, failures: [] };
  }
  const model = sections.model;
  const assemblyPath = join(projectRoot, 'assembly/assembly.json');
  const counts = model.evidence.counts as { children: number; interfaces: number } | null | undefined;
  const failures = run.failures;
  const assemblyHash = await fileHash(assemblyPath);
  const repair = decideRepair(0, failures, [], { ...(assemblyHash ? { assemblyHash } : {}) }, MAX_REPAIR_ROUNDS);
  const ordered = [...failures].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'hard' ? -1 : 1));
  const next = [...new Set(ordered.map((f) => ownerOf(f.code)))];
  const complete = CONTRACT_PEARLS.every((p) => sections[p].status !== 'unobserved');
  return {
    schemaVersion: 1,
    id: `necklace-${run.profile ?? 'unprofiled'}`,
    project: projectRoot,
    generatedAt: new Date().toISOString(),
    rulePack: run.rulePack,
    template: run.template,
    status: run.status,
    complete,
    assembly: { path: assemblyPath, hash: assemblyHash, counts: counts ?? null },
    sections,
    failures,
    repair: { round: repair.round, maxRounds: repair.maxRounds, action: repair.action, signatures: repair.signatures, reason: repair.reason },
    next,
  };
}

const STATUSES = new Set<PearlStatus>(['pass', 'warn', 'fail', 'blocked', 'unobserved', 'not-applicable']);

export function validateNecklaceContract(value: unknown): string[] {
  const errors: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ['contract must be an object'];
  const c = value as Partial<NecklaceContract>;
  if (c.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (typeof c.id !== 'string' || !c.id) errors.push('id is required');
  if (typeof c.project !== 'string' || !c.project) errors.push('project is required');
  if (typeof c.generatedAt !== 'string' || Number.isNaN(Date.parse(c.generatedAt))) errors.push('generatedAt must be an ISO timestamp');
  if (!STATUSES.has(c.status as PearlStatus)) errors.push('status is not a pearl status');
  if (typeof c.complete !== 'boolean') errors.push('complete must be boolean');
  if (c.sections === undefined || typeof c.sections !== 'object' || c.sections === null) errors.push('sections is required');
  else for (const p of CONTRACT_PEARLS) {
    const sec = c.sections[p];
    if (!sec || typeof sec !== 'object') { errors.push(`sections.${p} is missing`); continue; }
    if (!STATUSES.has(sec.status)) errors.push(`sections.${p}.status is invalid`);
    if (typeof sec.evidence !== 'object' || sec.evidence === null || Array.isArray(sec.evidence)) errors.push(`sections.${p}.evidence must be an object`);
    if (!Array.isArray(sec.failures)) errors.push(`sections.${p}.failures must be an array`);
  }
  if (!Array.isArray(c.failures)) errors.push('failures must be an array');
  if (!Array.isArray(c.next) || !c.next.every((p) => CONTRACT_PEARLS.includes(p as ContractPearl))) errors.push('next must contain pearl ids');
  if (c.assembly !== null && c.assembly !== undefined) {
    if (typeof c.assembly !== 'object') errors.push('assembly must be an object or null');
    else if (typeof c.assembly.hash !== 'string' && c.assembly.hash !== null) errors.push('assembly.hash must be string or null');
  }
  if (!c.repair || typeof c.repair !== 'object') errors.push('repair is required');
  else {
    if (c.repair.maxRounds !== 4) errors.push('repair.maxRounds must be 4');
    if (!['continue', 'no-progress', 'exhausted'].includes(c.repair.action)) errors.push('repair.action is invalid');
    if (!Array.isArray(c.repair.signatures)) errors.push('repair.signatures must be an array');
  }
  return errors;
}

export interface ReadContractResult {
  path: string;
  contract: NecklaceContract;
  contractHash: string;
  currentAssemblyHash: string | null;
  stale: boolean;
  issues: string[];
}

/** Read and validate a written contract; compare its pinned assembly hash to current. */
export async function readNecklaceContract(projectRoot: string): Promise<ReadContractResult> {
  const path = join(projectRoot, 'necklace-contract.json');
  const text = await readFile(path, 'utf8');
  const raw = JSON.parse(text) as unknown;
  const issues = validateNecklaceContract(raw);
  if (issues.length) throw new Error(`necklace contract invalid:\n- ${issues.join('\n- ')}`);
  const contract = raw as NecklaceContract;
  const currentAssemblyHash = await fileHash(join(projectRoot, 'assembly/assembly.json'));
  return {
    path,
    contract,
    contractHash: `sha256:${createHash('sha256').update(text).digest('hex')}`,
    currentAssemblyHash,
    stale: contract.assembly?.hash !== currentAssemblyHash,
    issues: [],
  };
}

/** Write the contract atomically; `expectedHash` prevents clobbering a newer one. */
export async function writeNecklaceContract(
  projectRoot: string,
  contract: NecklaceContract,
  expectedHash?: string,
): Promise<{ path: string; hash: string; changed: boolean }> {
  const path = join(projectRoot, 'necklace-contract.json');
  const text = `${JSON.stringify(contract, null, 2)}\n`;
  const hash = `sha256:${createHash('sha256').update(text).digest('hex')}`;
  const validation = validateNecklaceContract(contract);
  if (validation.length) throw new Error(`refusing to write invalid contract:\n- ${validation.join('\n- ')}`);
  let old: string | null = null;
  try { old = await readFile(path, 'utf8'); } catch { /* create */ }
  const actual = old === null ? null : `sha256:${createHash('sha256').update(old).digest('hex')}`;
  if (old !== null && expectedHash !== undefined && expectedHash !== actual) {
    throw new Error(`contract hash mismatch: wanted ${expectedHash}, actual ${actual}`);
  }
  if (old !== null && expectedHash === undefined && old !== text) {
    throw new Error('expectedHash is required to replace an existing necklace contract');
  }
  if (old === text) return { path, hash, changed: false };
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, path);
  const historyPath = join(projectRoot, 'necklace-contract-history.json');
  let history: { schemaVersion: 1; entries: unknown[] } = { schemaVersion: 1, entries: [] };
  try { history = JSON.parse(await readFile(historyPath, 'utf8')) as typeof history; } catch { /* create */ }
  history.entries.push({ at: new Date().toISOString(), hash, status: contract.status, complete: contract.complete, next: contract.next });
  await writeJsonAtomic(historyPath, history);
  return { path, hash, changed: true };
}
