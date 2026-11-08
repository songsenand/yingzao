// Observe-only fit pearl: read the project's latest assembly + assembly-check runs
// and decide fit status without executing any tool.
//
// This is the M2 bridge: it proves the fit template's exit criteria can be mapped to
// real evidence, and it makes the "0 interfaces = not covered" case visible instead of
// reporting a green check.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadAssemblyManifest, flattenParts } from '../manifest.ts';
import { interfaceLocation, manifestLocation, pairLocation, type PearlFailure, type SpatialLocation } from './failure.ts';

interface RunEntry {
  id: string;
  kind: string;
  timestamp: string;
  status?: string;
  judgement?: string;
  summary?: string;
  sourceVersionIds?: string[];
}

interface RunManifest { schemaVersion: number; runs: RunEntry[] }

export type FitTemplate = 'static' | 'mechanism';

export interface FitObservation {
  pearl: 'fit';
  template: FitTemplate;
  status: 'pass' | 'fail' | 'blocked';
  coverage: { interference: boolean; interfaces: boolean; complete: boolean; probe: boolean };
  budgetUsed: { distinctTools: number; calls: number; probe: number };
  sourceRuns: { assembly?: string; contract?: string };
  counts: { interfaces: number | null; undeclared: number | null; hard: number | null };
  findings: {
    code: string;
    severity: 'hard' | 'warn' | 'info';
    message: string;
    witness?: Record<string, unknown>;
    attention?: string[];
  }[];
  failures: PearlFailure[];
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

function latest(runs: RunEntry[], kind: string): RunEntry | undefined {
  return runs
    .filter((r) => r.kind === kind)
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
    .at(-1);
}

function whyFor(code: string): string[] {
  switch (code) {
    case 'interference':
      return ['two solids overlap at the current placement', 'transform/pose is wrong', 'joint clearance is smaller than the mesh residual', 'contact is designed but not tolerated'];
    case 'hard-interface':
      return ['datum point/direction does not match the mate', 'placement is wrong', 'tolerance is tighter than the actual fit', 'wrong operator (distance vs coaxial)'];
    case 'undeclared-adjacency':
      return ['a real joint was not declared', 'the pair is a non-structural contact', 'adjacency threshold is broader than the contract', 'the part is misplaced and came close accidentally'];
    case 'stale-contract':
      return ['manifest was checked before the latest version', 'a child version changed after the contract run'];
    case 'no-declared-interfaces':
      return ['manifest is BOM-only', 'the contract was never authored', 'interfaces were skipped because datums are missing'];
    case 'missing-assembly':
      return ['validate_assembly was never run for this project', 'the run is in another project/store'];
    case 'missing-contract':
      return ['check_assembly was never run', 'the manifest was never written'];
    default:
      return ['evidence or contract precondition is missing'];
  }
}

function locationForFinding(f: { code: string; witness?: Record<string, unknown> }, assemblyReport: any, contractReport: any): SpatialLocation {
  const w = f.witness ?? {};
  if (f.code === 'interference') {
    const offenders = Array.isArray(w.offenders) ? w.offenders as any[] : [];
    const p = offenders[0];
    if (p?.partA && p?.partB) return pairLocation(assemblyReport, String(p.partA), String(p.partB));
  }
  if (f.code === 'undeclared-adjacency') {
    const pairs = Array.isArray(w.undeclaredPairs) ? w.undeclaredPairs as any[] : [];
    const p = pairs[0];
    if (p?.partA && p?.partB) return pairLocation(assemblyReport, String(p.partA), String(p.partB));
  }
  if (f.code === 'hard-interface') {
    const violations = Array.isArray(w.violations) ? w.violations as any[] : [];
    const v = violations[0];
    if (v) return interfaceLocation(assemblyReport, v);
  }
  if (f.code === 'stale-contract') return manifestLocation('assembly/assembly.json', 'version set differs; no single geometric point');
  if (f.code === 'no-declared-interfaces') return manifestLocation('assembly/assembly.json', 'empty contract; no declared feature to locate');
  if (f.code.startsWith('missing')) return manifestLocation('assembly/assembly.json', 'missing evidence; no geometry to locate');
  return manifestLocation('assembly/assembly.json');
}

function failureFor(f: { code: string; severity: 'hard' | 'warn' | 'info'; message: string; witness?: Record<string, unknown>; attention?: string[] }, assemblyReport: any, contractReport: any): PearlFailure {
  return {
    code: f.code,
    severity: f.severity === 'warn' ? 'warn' : 'hard',
    what: f.message,
    why: whyFor(f.code),
    location: locationForFinding(f, assemblyReport, contractReport),
    evidence: f.witness ?? {},
    next: f.attention ?? [],
  };
}

/** Read a project's cad-data/runs and observe the fit pearl. */
export interface ObserveFitOptions {
  /** Treat undeclared contact pairs as a hard failure instead of a warning. */
  requireUndeclaredZero?: boolean;
  /** Pairs explicitly accepted by the rule pack; these are not unexplained. */
  explainedUndeclared?: { a: string; b: string; reason: string }[];
  /** Which fit template this observation is for (default: static). */
  template?: FitTemplate;
}

/**
 * Versions intentionally left out of static assembly runs. A flexible part
 * (leaf spring, flexure, snap) has no single static pose, so the assembly run
 * omits it while the contract check may still declare its interface. The
 * declaration lives in `assembly/static-scope.json`, next to the assembly.
 */
async function staticOmittedVersions(cadData: string): Promise<Set<string>> {
  const projectRoot = dirname(cadData);
  try {
    const raw = JSON.parse(
      await readFile(join(projectRoot, 'assembly/static-scope.json'), 'utf8'),
    ) as { parts?: unknown; versions?: unknown };
    const omitted = new Set<string>();
    if (Array.isArray(raw.versions)) {
      for (const v of raw.versions) if (typeof v === 'string' && v.length > 0) omitted.add(v);
    }
    const parts = Array.isArray(raw.parts) ? raw.parts.filter((x): x is string => typeof x === 'string') : [];
    if (parts.length > 0) {
      const manifest = await loadAssemblyManifest(join(projectRoot, 'assembly/assembly.json'));
      const omittedNodes = new Set(parts);
      for (const p of flattenParts(manifest.root)) {
        if (omittedNodes.has(p.id) && typeof p.node.version === 'string') omitted.add(p.node.version);
      }
    }
    return omitted;
  } catch {
    return new Set();
  }
}

export async function observeFit(cadData: string, options: ObserveFitOptions = {}): Promise<FitObservation> {
  const strictUndeclared = options.requireUndeclaredZero === true;
  const template = options.template ?? 'static';
  const explained = new Set((options.explainedUndeclared ?? []).map((e) => [e.a, e.b].sort().join('\u0000')));
  const omittedVersions = await staticOmittedVersions(cadData);
  const manifest = await readJson<RunManifest>(join(cadData, 'runs/manifest.json'));
  const assembly = latest(manifest.runs, 'assembly');
  const contract = latest(manifest.runs, 'assembly-check');
  const findings: FitObservation['findings'] = [];
  const sourceRuns: FitObservation['sourceRuns'] = {};
  const counts: FitObservation['counts'] = { interfaces: null, undeclared: null, hard: null };
  let assemblyReport: any = null;
  let contractReport: any = null;

  let interferenceOk = false;
  if (!assembly) {
    findings.push({
      code: 'missing-assembly',
      severity: 'hard',
      message: 'no assembly run; fit has no interference evidence',
      attention: ['run validate_assembly first'],
    });
  } else {
    sourceRuns.assembly = assembly.id;
    const report = await readJson<any>(join(cadData, 'runs', assembly.id, 'report.json'));
    assemblyReport = report;
    const pairs: any[] = Array.isArray(report.pairs) ? report.pairs : [];
    const epsilon = Number(report.interferenceEpsilonMm3 ?? 0);
    const offenders = pairs.filter((p) => Number(p.intersectionVolume ?? 0) > epsilon).slice(0, 10)
      .map((p) => ({ partA: p.partA, partB: p.partB, intersectionVolume: p.intersectionVolume, minDistance: p.minDistance }));
    const tightPairs = pairs.filter((p) => p.status === 'too-tight' || p.status === 'tight').slice(0, 10)
      .map((p) => ({ partA: p.partA, partB: p.partB, minDistance: p.minDistance, status: p.status }));
    const interference = pairs.filter((p) => Number(p.intersectionVolume ?? 0) > epsilon).length;
    const tight = pairs.filter((p) => p.status === 'too-tight' || p.status === 'tight').length;
    interferenceOk = report.overallStatus === 'pass' && interference === 0 && tight === 0;
    if (!interferenceOk) {
      findings.push({
        code: 'interference',
        severity: 'hard',
        message: `assembly ${assembly.id}: overall=${String(report.overallStatus)} interference=${interference} too-tight=${tight}`,
        witness: { run: assembly.id, overallStatus: report.overallStatus, interference, tight, pairCount: pairs.length, offenders, tightPairs, epsilonMm3: epsilon },
        attention: ['inspect the pair list in the run report'],
      });
    }
  }

  let interfacesCovered = false;
  if (!contract) {
    findings.push({
      code: 'missing-contract',
      severity: 'hard',
      message: 'no assembly-check run; interface coverage is unknown',
      attention: ['run check_assembly with declared interfaces'],
    });
  } else {
    sourceRuns.contract = contract.id;
    const report = await readJson<any>(join(cadData, 'runs', contract.id, 'report.json'));
    contractReport = report;
    const summary = report.summary ?? {};
    const interfaces = Number(summary.interfaces ?? 0);
    const hard = Number(summary.hardViolations ?? 0);
    const undeclared = Number(summary.undeclared ?? 0);
    const undeclaredPairs = Array.isArray(report.undeclared) ? report.undeclared as any[] : [];
    const explainedPairs = undeclaredPairs.filter((p) => explained.has([String(p.partA), String(p.partB)].sort().join('\u0000')));
    const unexplained = Math.max(0, undeclared - explainedPairs.length);
    counts.interfaces = interfaces;
    counts.undeclared = unexplained;
    counts.hard = hard;
    const aVersions = (assembly?.sourceVersionIds ?? []).filter((v) => !omittedVersions.has(v));
    const cVersions = (contract.sourceVersionIds ?? []).filter((v) => !omittedVersions.has(v));
    if (aVersions.length && cVersions.length) {
      const a = [...aVersions].sort().join(',');
      const c = [...cVersions].sort().join(',');
      if (a !== c) {
        findings.push({
          code: 'stale-contract',
          severity: 'hard',
          message: `assembly-check ${contract.id} cites a different version set than assembly ${assembly?.id}; re-run the contract`,
          witness: {
            assembly: assembly?.id,
            assemblyVersions: assembly?.sourceVersionIds,
            contract: contract.id,
            contractVersions: contract.sourceVersionIds,
            omittedVersions: [...omittedVersions],
          },
          attention: [
            're-run check_assembly on the current assembly versions',
            'if a flexible part is intentionally omitted from static assembly, declare it in assembly/static-scope.json',
          ],
        });
      }
    }
    if (explainedPairs.length > 0) {
      findings.push({
        code: 'explained-undeclared',
        severity: 'info',
        message: `assembly-check ${contract.id}: ${explainedPairs.length} contact pair(s) are explicitly explained by the rule pack`,
        witness: { run: contract.id, explained: explainedPairs.slice(0, 10) },
        attention: ['no action; keep the explanation current'],
      });
    }
    if (unexplained > 0) {
      findings.push({
        code: 'undeclared-adjacency',
        severity: strictUndeclared && interfaces > 0 ? 'hard' : 'warn',
        message: interfaces > 0
          ? `assembly-check ${contract.id}: ${interfaces} declared interfaces pass, but ${unexplained} contact pairs are still undeclared`
          : `assembly-check ${contract.id}: no declared interfaces, and ${unexplained} contact pairs are undiscovered/uncontracted`,
        witness: { run: contract.id, interfaces, hard, undeclared, explained: explainedPairs.length, unexplained, undeclaredPairs: undeclaredPairs.slice(0, 10) },
        attention: ['review undeclared pairs; declare the ones that are structural joints'],
      });
    }
    interfacesCovered = interfaces > 0 && !findings.some((f) => f.code === 'stale-contract')
      && (!strictUndeclared || unexplained === 0);
    if (interfaces === 0) {
      findings.push({
        code: 'no-declared-interfaces',
        severity: 'hard',
        message: `assembly-check ${contract.id} has 0 declared interfaces (${undeclared} undeclared adjacencies); "0 hard violations" is vacuous`,
        witness: { run: contract.id, interfaces, hard, undeclared },
        attention: ['declare interfaces in the assembly manifest', 'then re-run check_assembly'],
      });
    } else if (hard > 0) {
      findings.push({
        code: 'hard-interface',
        severity: 'hard',
        message: `assembly-check ${contract.id}: ${hard} hard violation(s)`,
        witness: { run: contract.id, interfaces, hard, undeclared, violations: (report.hardViolations ?? []).slice(0, 10) },
        attention: ['open the failing interface rows'],
      });
    }
  }

  const blocked = findings.some((f) => f.severity === 'hard' && (f.code.startsWith('missing') || f.code === 'no-declared-interfaces' || f.code === 'stale-contract' || (strictUndeclared && f.code === 'undeclared-adjacency')));
  const failed = findings.some((f) => f.severity === 'hard' && (f.code === 'interference' || f.code === 'hard-interface'));
  const status: FitObservation['status'] = blocked ? 'blocked' : failed ? 'fail' : 'pass';
  return {
    pearl: 'fit',
    template,
    status,
    coverage: { interference: interferenceOk, interfaces: interfacesCovered, complete: interferenceOk && interfacesCovered, probe: false },
    budgetUsed: { distinctTools: 2, calls: 2, probe: 0 },
    sourceRuns,
    counts,
    findings,
    failures: findings.map((f) => failureFor(f, assemblyReport, contractReport)),
  };
}
