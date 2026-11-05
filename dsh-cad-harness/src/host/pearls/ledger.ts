// Read-only six-pearl ledger. It never runs a tool: it maps existing runs/files
// to a status, and every missing evidence is `unobserved`, never a pass.

import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadAssemblyManifest, flattenParts } from '../manifest.ts';
import { manifestLocation, type PearlFailure } from './failure.ts';
import { observeModel, type ModelObservation } from './model.ts';
import { observeFit, type FitObservation, type FitTemplate } from './observe.ts';
import type { RulePackMake } from './rulepack.ts';

export type PearlStatus = 'pass' | 'warn' | 'fail' | 'blocked' | 'unobserved' | 'not-applicable';

export interface LedgerEntry {
  status: PearlStatus;
  failures: PearlFailure[];
  evidence: Record<string, unknown>;
  note?: string;
}

export interface PearlLedger {
  brief: LedgerEntry;
  model: LedgerEntry;
  fit: LedgerEntry;
  make: LedgerEntry;
  review: LedgerEntry;
  deliver: LedgerEntry;
  /** All failures flattened for the run gate. */
  failures: PearlFailure[];
  overall: PearlStatus;
}

interface RunEntry { id: string; kind: string; timestamp: string; status?: string; summary?: string; sourceVersionIds?: string[] }
interface RunManifest { runs: RunEntry[] }

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

async function readRuns(projectRoot: string): Promise<RunEntry[]> {
  try { return (await readJson<RunManifest>(join(projectRoot, 'cad-data/runs/manifest.json'))).runs; }
  catch { return []; }
}

async function currentVersions(projectRoot: string): Promise<{ id: string; version: string; name: string }[]> {
  try {
    const manifest = await loadAssemblyManifest(join(projectRoot, 'assembly/assembly.json'));
    return flattenParts(manifest.root)
      .filter((p) => p.node.kind === 'part' && p.node.source !== 'stock' && p.node.version)
      .map((p) => ({ id: p.id, version: p.node.version!, name: p.node.name }));
  } catch {
    return [];
  }
}

function missing(code: string, what: string, why: string[]): PearlFailure {
  return {
    code, severity: 'warn', what, why,
    location: manifestLocation('assembly/assembly.json', 'no evidence artifact for this pearl'),
    evidence: {},
    next: ['produce/record the evidence this pearl needs'],
  };
}

async function observeBrief(projectRoot: string): Promise<LedgerEntry> {
  const path = join(projectRoot, 'PROMPT.md');
  // We only check that the requirements artifact exists; its quality is human.
  try {
    await access(path);
    return { status: 'pass', failures: [], evidence: { prompt: 'PROMPT.md' }, note: 'requirements artifact present; quality not machine-judged' };
  } catch {
    return { status: 'unobserved', failures: [missing('brief.missing', 'no PROMPT.md/brief artifact', ['requirements were not written down'])], evidence: { prompt: 'PROMPT.md' } };
  }
}

async function observeMake(projectRoot: string, policy?: RulePackMake): Promise<LedgerEntry> {
  if (policy?.kind === 'wood') {
    const cutlistPath = join(projectRoot, policy.cutlist ?? 'assembly/cutlist.json');
    let cutlist: any;
    try { cutlist = await readJson<any>(cutlistPath); }
    catch {
      return { status: 'unobserved', failures: [missing('make.no-cutlist', 'no wood cutlist', ['cutlist was never produced', 'the project is not a wood build'])], evidence: { cutlist: cutlistPath } };
    }
    if (!policy.stockMm) {
      return { status: 'unobserved', failures: [missing('make.no-stock', 'no declared stock size', ['rule pack did not declare stockMm'])], evidence: { cutlist: cutlistPath } };
    }
    const stock = [...policy.stockMm].sort((a, b) => b - a);
    const oversized: { name: string; rough: number[]; over: number[] }[] = [];
    const parts = Array.isArray(cutlist.parts) ? cutlist.parts : [];
    for (const part of parts) {
      const rough = Array.isArray(part?.rough) ? part.rough : null;
      if (!rough || rough.length < 3) continue;
      const r = rough.slice(0, 3).sort((a: number, b: number) => b - a);
      const over = r.map((n: number, i: number) => n - stock[i]);
      if (over.some((d: number) => d > 0)) oversized.push({ name: String(part.name ?? '?'), rough: r, over });
    }
    if (oversized.length > 0) {
      return {
        status: 'fail',
        failures: oversized.map((o) => ({
          code: 'make.stock', severity: 'hard' as const,
          what: `${o.name}: rough ${o.rough.join('×')} exceeds stock ${stock.join('×')}`,
          why: ['stock size is too small', 'rough allowance is too generous', 'cutlist is not reconciled with the design'],
          location: { kind: 'part' as const, parts: [o.name], approximate: true as const, note: `over by ${o.over.join('/')} mm` },
          evidence: { rough: o.rough, stockMm: stock },
          next: ['shrink the part or declare a larger stock'],
        })),
        evidence: { cutlist: cutlistPath, stockMm: stock, oversized },
      };
    }
    return { status: 'pass', failures: [], evidence: { cutlist: cutlistPath, stockMm: stock, parts: parts.length }, note: 'rough stock fits; grain/joinery not judged' };
  }

  const runs = await readRuns(projectRoot);
  const current = [...new Map((await currentVersions(projectRoot)).map((p) => [p.version, p])).values()];
  const byVersion = new Map<string, RunEntry>();
  for (const r of runs.filter((x) => x.kind === 'printability')) {
    const v = r.sourceVersionIds?.[0];
    if (v && (!byVersion.has(v) || Date.parse(r.timestamp) > Date.parse(byVersion.get(v)!.timestamp))) byVersion.set(v, r);
  }
  if (current.length === 0) {
    return { status: 'unobserved', failures: [missing('make.no-parts', 'no current printed parts', ['assembly manifest missing or all parts stock'])], evidence: {} };
  }
  if (byVersion.size === 0) {
    return { status: 'unobserved', failures: [missing('make.no-evidence', 'no printability run for the current print parts', ['check_printability was never run', 'parts are wood/stock, not FDM'])], evidence: { currentVersions: current.map((p) => p.version) } };
  }
  const failures: PearlFailure[] = [];
  let status: PearlStatus = 'pass';
  const reports: Record<string, unknown> = {};
  for (const p of current) {
    const run = byVersion.get(p.version);
    if (!run) {
      status = status === 'pass' ? 'warn' : status;
      failures.push({
        code: 'make.coverage', severity: 'warn',
        what: `${p.id} ${p.version} has no printability run`,
        why: ['check_printability was not run for this version', 'the part was revised after the last check'],
        location: { kind: 'part', parts: [p.id], approximate: true, note: `version ${p.version}` },
        evidence: { part: p.id, version: p.version },
        next: ['run check_printability on the current version'],
      });
      continue;
    }
    const report = await readJson<any>(join(projectRoot, 'cad-data/runs', run.id, 'report.json'));
    reports[p.version] = { run: run.id, verdict: report.verdict, minWallMm: report.minWallMm, minWallAtMm: report.minWallAtMm };
    if (report.verdict === 'excluded') {
      status = 'fail';
      failures.push({
        code: 'make.printability', severity: 'hard',
        what: `${p.id} ${p.version}: ${report.verdict} (${run.id})`,
        why: ['wall/overhang below the declared process profile', 'print orientation is not declared', 'thin feature is functional, not structural'],
        location: { kind: 'part', parts: [p.id], point: report.minWallAtMm, center: report.minWallAtMm, approximate: true, note: `min-wall location reported by ${run.id}` },
        evidence: { run: run.id, version: p.version, verdict: report.verdict, minWallMm: report.minWallMm, findings: report.findings },
        next: ['inspect the reported min-wall/overhang location', 'change orientation/profile or declare an exemption'],
      });
    } else if (report.verdict === 'difficult') {
      if (status === 'pass') status = 'warn';
      failures.push({
        code: 'make.printability', severity: 'warn',
        what: `${p.id} ${p.version}: difficult (${run.id})`,
        why: ['thin wall/overhang may need support or reorientation', 'functional thin feature is intentional'],
        location: { kind: 'part', parts: [p.id], point: report.minWallAtMm, center: report.minWallAtMm, approximate: true, note: `min-wall location reported by ${run.id}` },
        evidence: { run: run.id, version: p.version, verdict: report.verdict, minWallMm: report.minWallMm, findings: report.findings },
        next: ['inspect the reported min-wall/overhang location'],
      });
    }
  }
  return { status, failures, evidence: { reports, currentVersions: current.map((p) => p.version) } };
}

async function observeReview(projectRoot: string): Promise<LedgerEntry> {
  const current = await currentVersions(projectRoot);
  if (current.length === 0) return { status: 'unobserved', failures: [missing('review.no-parts', 'no current parts', ['assembly manifest missing'])], evidence: {} };
  const unique = [...new Map(current.map((p) => [p.version, p])).values()];
  const failures: PearlFailure[] = [];
  let reviewed = 0;
  for (const p of unique) {
    const path = join(projectRoot, 'cad-data/versions', p.version, 'visual-review.json');
    try {
      const r = await readJson<any>(path);
      const views = Array.isArray(r.views) ? r.views : [];
      const notes = Array.isArray(r.notes) ? r.notes : [];
      if (views.includes('top') && views.includes('iso') && notes.length > 0) reviewed++;
      else {
        failures.push({
          code: 'review.incomplete', severity: 'warn',
          what: `${p.version} review lacks top+iso or a note`,
          why: ['review was superficial', 'only one view was rendered'],
          location: { kind: 'part', parts: [p.id], approximate: true, note: `version ${p.version}` },
          evidence: { version: p.version, views, notes },
          next: ['render top+iso and add a substantive note'],
        });
      }
    } catch {
      failures.push({
        code: 'review.missing', severity: 'warn',
        what: `${p.version} has no visual-review record`,
        why: ['review_visual was never run on this version', 'the part was revised after review'],
        location: { kind: 'part', parts: [p.id], approximate: true, note: `version ${p.version}` },
        evidence: { version: p.version },
        next: ['run review_visual with top+iso and a note'],
      });
    }
  }
  if (reviewed === 0 && failures.length === 0) return { status: 'unobserved', failures: [missing('review.no-evidence', 'no visual-review records', ['review_visual was never run'])], evidence: {} };
  const status: PearlStatus = reviewed === unique.length ? 'pass' : reviewed === 0 ? 'unobserved' : 'warn';
  return { status, failures, evidence: { reviewed, total: unique.length } };
}

export async function observeDeliver(projectRoot: string): Promise<LedgerEntry> {
  // delivery_audit returns a report but does not create a run in this corpus.
  // The first-class artifact is therefore an explicit JSON file when present;
  // a delivery-* run is accepted for future writers.
  let report: any = null;
  let source: string | null = null;
  for (const rel of ['assembly/delivery-audit.json', 'delivery-audit.json']) {
    try { report = await readJson<any>(join(projectRoot, rel)); source = rel; break; } catch { /* next */ }
  }
  if (!report) {
    const runs = await readRuns(projectRoot);
    const latest = runs.filter((r) => r.kind === 'delivery-audit').sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)).at(-1);
    if (latest) {
      report = await readJson<any>(join(projectRoot, 'cad-data/runs', latest.id, 'report.json'));
      source = `run:${latest.id}`;
    }
  }
  if (!report) {
    return {
      status: 'unobserved',
      failures: [missing('deliver.no-evidence', 'no delivery-audit artifact', [
        'run delivery_audit to write assembly/delivery-audit.json',
        'claims have no fresh witness',
      ])],
      evidence: {},
    };
  }
  const verdict = String(report.verdict ?? report.judgement ?? '');
  const blocked = Array.isArray(report.findings) ? report.findings.filter((f: any) => f.severity === 'blocked').length : 0;
  const warnings = Array.isArray(report.findings) ? report.findings.filter((f: any) => f.severity === 'warn').length : 0;
  const evidence = { source, verdict, blocked, warnings, summary: report.summary };
  if (blocked > 0 || verdict === 'excluded') {
    return {
      status: 'fail',
      failures: [{
        code: 'deliver.blocked', severity: 'hard',
        what: `delivery audit ${source}: ${blocked} blocked finding(s)`,
        why: ['a claim has no fresh witness', 'a required check is missing', 'a contract/evidence is stale'],
        location: manifestLocation('assembly/assembly.json', 'audit finding; inspect the audit artifact'),
        evidence,
        next: ['open the audit artifact and resolve each blocked finding'],
      }],
      evidence,
    };
  }
  if (warnings > 0 || verdict === 'difficult') {
    return {
      status: 'warn',
      failures: [{
        code: 'deliver.warn', severity: 'warn',
        what: `delivery audit ${source}: ${warnings} warning finding(s)`,
        why: ['a claim is backed by weaker evidence than requested', 'the corpus has an attention item'],
        location: manifestLocation('assembly/assembly.json', 'audit warning; inspect the audit artifact'),
        evidence,
        next: ['inspect the audit warnings before delivery'],
      }],
      evidence,
    };
  }
  return { status: 'pass', failures: [], evidence };
}

function overall(entries: PearlStatus[]): PearlStatus {
  for (const s of ['blocked', 'fail', 'warn', 'unobserved', 'pass'] as PearlStatus[]) if (entries.includes(s)) return s;
  return 'pass';
}

export interface LedgerOptions { template?: FitTemplate; strictUndeclared?: boolean; make?: RulePackMake; explainedUndeclared?: { a: string; b: string; reason: string }[] }

export async function observeLedger(projectRoot: string, options: LedgerOptions = {}): Promise<PearlLedger> {
  const [brief, model, fit, make, review, deliver] = await Promise.all([
    observeBrief(projectRoot),
    observeModel(projectRoot),
    observeFit(join(projectRoot, 'cad-data'), { template: options.template ?? 'static', requireUndeclaredZero: options.strictUndeclared === true, explainedUndeclared: options.explainedUndeclared }),
    observeMake(projectRoot, options.make),
    observeReview(projectRoot),
    observeDeliver(projectRoot),
  ]);
  const modelEntry: LedgerEntry = { status: model.status, failures: model.failures, evidence: { manifestPath: model.manifestPath, counts: model.counts } };
  const fitEntry: LedgerEntry = { status: fit.status, failures: fit.failures, evidence: { counts: fit.counts, sourceRuns: fit.sourceRuns } };
  return {
    brief, model: modelEntry, fit: fitEntry, make, review, deliver,
    failures: [brief, modelEntry, fitEntry, make, review, deliver].flatMap((e) => e.failures),
    overall: overall([brief.status, model.status, fit.status, make.status, review.status, deliver.status]),
  };
}
