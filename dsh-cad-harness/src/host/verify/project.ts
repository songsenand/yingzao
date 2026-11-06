// Load the read-only inputs one V1 run needs: project stores, assembly, current
// versions, rule pack (optional) and the rule pack's make policy.
//
// No writes, no pearl-profile requirement: a profile is read only as an optional
// pointer to the rule pack (`rulePack`), never as a template/pearl selection.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { loadAssemblyManifest, flattenParts, type AssemblyManifest } from '../manifest.ts';
import { listVersions } from '../version.ts';
import { projectStores, type ProjectStores } from '../project.ts';
import { loadRulePack, type LoadedRulePack, type RulePackMake } from '../pearls/rulepack.ts';

export interface ProjectVersion {
  id: string;
  version: string;
  name: string;
}

export interface LoadedVerifyProject {
  root: string;
  stores: ProjectStores | null;
  assemblyPath: string;
  assembly: AssemblyManifest | null;
  currentVersions: ProjectVersion[];
  currentVersionSet: string[];
  versionTimes: Map<string, string>;
  rulepack: LoadedRulePack | null;
  make: RulePackMake | null;
  undeclaredExplanations: { a: string; b: string; reason: string }[];
  undeclaredPolicy: 'warn' | 'block';
  rulepackSource: 'profile' | 'flag' | 'inferred' | null;
  rulepackWarning?: string;
  hasCorpus: boolean;
  hasRuns: boolean;
  issues: string[];
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

export async function loadVerifyProject(
  projectRoot: string,
  options: { rulepack?: string } = {},
): Promise<LoadedVerifyProject> {
  const root = resolve(projectRoot);
  const assemblyPath = join(root, 'assembly/assembly.json');
  const cadData = join(root, 'cad-data');
  const hasCorpus = existsSync(cadData);
  const hasRuns = existsSync(join(cadData, 'runs/manifest.json'));
  const issues: string[] = [];

  let stores: ProjectStores | null = null;
  if (hasCorpus) {
    try {
      stores = projectStores(root);
    } catch (e) {
      issues.push(`project stores unavailable: ${String((e as Error)?.message ?? e)}`);
    }
  }

  let assembly: AssemblyManifest | null = null;
  try {
    assembly = await loadAssemblyManifest(assemblyPath);
  } catch (e) {
    issues.push(`assembly manifest: ${String((e as Error)?.message ?? e)}`);
  }

  let currentVersions: ProjectVersion[] = [];
  if (assembly) {
    currentVersions = flattenParts(assembly.root)
      .filter((p) => p.node.kind === 'part' && p.node.source !== 'stock' && typeof p.node.version === 'string' && p.node.version.length > 0)
      .map((p) => ({ id: p.id, version: p.node.version as string, name: p.node.name }));
  }
  const currentVersionSet = [...new Set(currentVersions.map((p) => p.version))].sort();

  const versionTimes = new Map<string, string>();
  if (stores) {
    try {
      for (const v of await listVersions(stores.store)) {
        if (typeof v.id === 'string' && typeof v.timestamp === 'string') versionTimes.set(v.id, v.timestamp);
      }
    } catch (e) {
      issues.push(`version store: ${String((e as Error)?.message ?? e)}`);
    }
  }

  let rulepack: LoadedRulePack | null = null;
  let make: RulePackMake | null = null;
  let rulepackSource: LoadedVerifyProject['rulepackSource'] = null;
  let rulepackWarning: string | undefined;

  if (options.rulepack) {
    try {
      rulepack = await loadRulePack(isAbsolute(options.rulepack) ? options.rulepack : resolve(options.rulepack));
      make = rulepack.manifest.make ?? null;
      rulepackSource = 'flag';
    } catch (e) {
      rulepackWarning = `rule pack "${options.rulepack}" could not be loaded: ${String((e as Error)?.message ?? e)}`;
    }
  } else {
    const profilePath = join(root, 'pearl-profile.json');
    if (existsSync(profilePath)) {
      try {
        const profile = await readJson<{ rulePack?: unknown }>(profilePath);
        if (typeof profile.rulePack === 'string' && profile.rulePack.length > 0) {
          rulepack = await loadRulePack(resolve(root, profile.rulePack));
          make = rulepack.manifest.make ?? null;
          rulepackSource = 'profile';
        } else {
          rulepackWarning = 'pearl-profile.json has no rulePack; continuing without a rule pack';
        }
      } catch (e) {
        rulepackWarning = `rule pack from pearl-profile.json could not be loaded: ${String((e as Error)?.message ?? e)}`;
      }
    } else if (existsSync(join(root, 'assembly/cutlist.json'))) {
      // A cutlist without a rule pack is still evidence of a wood build; the
      // stock size is missing, so the make row reports it instead of guessing.
      make = { kind: 'wood', cutlist: 'assembly/cutlist.json' };
      rulepackSource = 'inferred';
    }
  }

  const undeclaredExplanations = rulepack?.manifest.undeclaredExplanations ?? [];
  const undeclaredPolicy = rulepack?.manifest.undeclaredPolicy ?? 'warn';

  return {
    root,
    stores,
    assemblyPath,
    assembly,
    currentVersions,
    currentVersionSet,
    versionTimes,
    rulepack,
    make,
    undeclaredExplanations,
    undeclaredPolicy,
    rulepackSource,
    ...(rulepackWarning ? { rulepackWarning } : {}),
    hasCorpus,
    hasRuns,
    issues,
  };
}
