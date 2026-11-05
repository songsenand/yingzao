// Project profile: the project-level selector that binds a project to a pearl,
// template, and rule pack. Pearls stay generic; profiles supply the domain.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PEARL_IDS, loadPearl, validateBudget, type LoadedPearl } from './registry.ts';
import type { PearlBudget } from './types.ts';
import { loadRulePack, type LoadedRulePack } from './rulepack.ts';

const ID_RE = /^[a-z][a-z0-9-]*$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
// Source lives at src/host/pearls, the esbuild bundle at lib/. A single
// relative constant cannot serve both; pick the first candidate that actually
// contains a pearl manifest.
const HERE = dirname(fileURLToPath(import.meta.url));
export const PEARLS_ROOT = [
  resolve(HERE, '../../../pearls'),
  resolve(HERE, '../pearls'),
  resolve(process.cwd(), 'pearls'),
].find((p) => existsSync(join(p, 'fit/pearl.json'))) ?? resolve(HERE, '../pearls');

export interface ProjectProfileManifest {
  schemaVersion: 1;
  id: string;
  version: string;
  /** Project root, relative to the profile file (default: "."). */
  project?: string;
  pearl: string;
  template: string;
  /** Rule pack directory, relative to the profile file. */
  rulePack: string;
  /** Optional override; otherwise rule pack / pearl decides. */
  undeclaredPolicy?: 'warn' | 'block';
  budget?: Partial<PearlBudget>;
  /** Opt-in probe template id; not mounted unless declared. */
  probe?: string;
  /** Constraints passed to the probe's checker/v1 input. */
  probeConfig?: Record<string, unknown>;
}

export interface LoadedProjectProfile {
  manifest: ProjectProfileManifest;
  dir: string;
  projectRoot: string;
  pearl: LoadedPearl;
  template: string;
  rulePack: LoadedRulePack;
  undeclaredPolicy: 'warn' | 'block';
  effectiveBudget: PearlBudget;
  budgetSource: 'profile' | 'rulepack' | 'pearl-default';
  pearlsRoot: string;
  probe?: string;
  probeConfig?: Record<string, unknown>;
}

export function validateProjectProfile(value: unknown): string[] {
  const errors: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ['profile must be an object'];
  const p = value as Partial<ProjectProfileManifest>;
  if (p.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (typeof p.id !== 'string' || !ID_RE.test(p.id)) errors.push('id must match ^[a-z][a-z0-9-]*$');
  if (typeof p.version !== 'string' || !VERSION_RE.test(p.version)) errors.push('version must be semver');
  if (p.project !== undefined && (typeof p.project !== 'string' || p.project.length < 1)) errors.push('project must be a relative path');
  if (typeof p.pearl !== 'string' || !PEARL_IDS.includes(p.pearl as any)) errors.push(`pearl must be one of: ${PEARL_IDS.join(', ')}`);
  if (typeof p.template !== 'string' || !ID_RE.test(p.template)) errors.push('template must be a template id');
  if (typeof p.rulePack !== 'string' || p.rulePack.length < 1) errors.push('rulePack must be a relative directory');
  if (p.undeclaredPolicy !== undefined && p.undeclaredPolicy !== 'warn' && p.undeclaredPolicy !== 'block') errors.push('undeclaredPolicy must be warn|block');
  if (p.budget !== undefined) errors.push(...validateBudget(p.budget, true));
  return errors;
}

/** Load `pearl-profile.json` from a project directory. */
export async function loadProjectProfile(dir: string): Promise<LoadedProjectProfile> {
  const root = resolve(dir);
  const manifest = JSON.parse(await readFile(join(root, 'pearl-profile.json'), 'utf8')) as unknown;
  const errors = validateProjectProfile(manifest);
  if (errors.length) throw new Error(`project profile ${dir} invalid:\n- ${errors.join('\n- ')}`);
  const p = manifest as ProjectProfileManifest;
  const pearl = await loadPearl(join(PEARLS_ROOT, p.pearl));
  if (!pearl.templates.some((t) => t.manifest.id === p.template)) {
    throw new Error(`profile ${p.id}: pearl ${p.pearl} has no template "${p.template}"`);
  }
  const rulePack = await loadRulePack(resolve(root, p.rulePack));
  const undeclaredPolicy = p.undeclaredPolicy
    ?? rulePack.manifest.undeclaredPolicy
    ?? pearl.manifest.undeclaredPolicy
    ?? 'warn';
  const budgetSource: LoadedProjectProfile['budgetSource'] = p.budget ? 'profile' : rulePack.manifest.budget ? 'rulepack' : 'pearl-default';
  const effectiveBudget: PearlBudget = {
    ...pearl.manifest.budget,
    ...(rulePack.manifest.budget ?? {}),
    ...(p.budget ?? {}),
    maxProbe: 1,
  };
  return {
    manifest: p,
    dir: root,
    projectRoot: resolve(root, p.project ?? '.'),
    pearl,
    template: p.template,
    rulePack,
    undeclaredPolicy,
    effectiveBudget,
    budgetSource,
    pearlsRoot: PEARLS_ROOT,
    ...(p.probe ? { probe: p.probe } : {}),
    ...(p.probeConfig ? { probeConfig: p.probeConfig } : {}),
  };
}
