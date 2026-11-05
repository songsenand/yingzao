// Rule packs are where DOMAIN knowledge lives (guides, thresholds, required
// groups, probe allowlists). Pearls stay generic; a project opts into a pack.

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PEARL_IDS, validateBudget } from './registry.ts';
import type { PearlBudget } from './types.ts';

const ID_RE = /^[a-z][a-z0-9-]*$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export interface UndeclaredExplanation {
  a: string;
  b: string;
  reason: string;
}

export interface RulePackGroup {
  id: string;
  description?: string;
  min?: number;
}

export interface RulePackMake {
  kind: 'wood' | 'fdm' | 'generic';
  stockMm?: [number, number, number];
  cutlist?: string;
}

export interface RulePackManifest {
  schemaVersion: 1;
  id: string;
  version: string;
  pearl?: string;
  guide?: string;
  thresholds?: Record<string, number>;
  requiredGroups?: RulePackGroup[];
  /** Pairs the project explicitly accepts as non-structural contact. */
  undeclaredExplanations?: UndeclaredExplanation[];
  undeclaredPolicy?: 'warn' | 'block';
  probes?: string[];
  make?: RulePackMake;
  budget?: Partial<PearlBudget>;
}

export interface LoadedRulePack {
  manifest: RulePackManifest;
  dir: string;
  guide: string | null;
}

export function validateRulePack(value: unknown): string[] {
  const errors: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ['rulepack must be an object'];
  const r = value as Partial<RulePackManifest>;
  if (r.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) errors.push('id must match ^[a-z][a-z0-9-]*$');
  if (typeof r.version !== 'string' || !VERSION_RE.test(r.version)) errors.push('version must be semver');
  if (r.pearl !== undefined && !PEARL_IDS.includes(r.pearl as any)) errors.push(`pearl must be one of: ${PEARL_IDS.join(', ')}`);
  if (r.guide !== undefined && (typeof r.guide !== 'string' || r.guide.length < 3)) errors.push('guide must be a relative path');
  if (r.thresholds !== undefined) {
    if (typeof r.thresholds !== 'object' || r.thresholds === null || Array.isArray(r.thresholds)) errors.push('thresholds must be an object');
    else for (const [k, v] of Object.entries(r.thresholds)) {
      if (typeof v !== 'number' || !Number.isFinite(v)) errors.push(`thresholds.${k} must be a finite number`);
    }
  }
  if (r.requiredGroups !== undefined) {
    if (!Array.isArray(r.requiredGroups)) errors.push('requiredGroups must be an array');
    else for (const [i, g] of r.requiredGroups.entries()) {
      if (typeof g !== 'object' || g === null) { errors.push(`requiredGroups[${i}] must be an object`); continue; }
      if (typeof g.id !== 'string' || !ID_RE.test(g.id)) errors.push(`requiredGroups[${i}].id invalid`);
      if (g.min !== undefined && (typeof g.min !== 'number' || !Number.isInteger(g.min) || g.min < 0)) errors.push(`requiredGroups[${i}].min must be a non-negative integer`);
    }
  }
  if (r.undeclaredExplanations !== undefined) {
    if (!Array.isArray(r.undeclaredExplanations)) errors.push('undeclaredExplanations must be an array');
    else for (const [i, e] of r.undeclaredExplanations.entries()) {
      if (typeof e !== 'object' || e === null) { errors.push(`undeclaredExplanations[${i}] must be an object`); continue; }
      if (typeof e.a !== 'string' || !e.a) errors.push(`undeclaredExplanations[${i}].a is required`);
      if (typeof e.b !== 'string' || !e.b) errors.push(`undeclaredExplanations[${i}].b is required`);
      if (typeof e.reason !== 'string' || e.reason.length < 3) errors.push(`undeclaredExplanations[${i}].reason is too short`);
    }
  }
  if (r.undeclaredPolicy !== undefined && r.undeclaredPolicy !== 'warn' && r.undeclaredPolicy !== 'block') errors.push('undeclaredPolicy must be warn|block');
  if (r.probes !== undefined && (!Array.isArray(r.probes) || !r.probes.every((p) => typeof p === 'string'))) errors.push('probes must be an array of strings');
  if (r.budget !== undefined) errors.push(...validateBudget(r.budget, true));
  if (r.make !== undefined) {
    if (typeof r.make !== 'object' || r.make === null) errors.push('make must be an object');
    else {
      if (!['wood', 'fdm', 'generic'].includes(r.make.kind)) errors.push('make.kind must be wood|fdm|generic');
      if (r.make.stockMm !== undefined && (!Array.isArray(r.make.stockMm) || r.make.stockMm.length !== 3 || !r.make.stockMm.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0))) errors.push('make.stockMm must be three positive numbers');
      if (r.make.cutlist !== undefined && (typeof r.make.cutlist !== 'string' || r.make.cutlist.length < 3)) errors.push('make.cutlist must be a path');
    }
  }
  return errors;
}

export async function loadRulePack(dir: string): Promise<LoadedRulePack> {
  const root = resolve(dir);
  const manifest = JSON.parse(await readFile(join(root, 'rulepack.json'), 'utf8')) as unknown;
  const errors = validateRulePack(manifest);
  if (errors.length) throw new Error(`rulepack ${dir} invalid:\n- ${errors.join('\n- ')}`);
  const rp = manifest as RulePackManifest;
  const guide = rp.guide ? await readFile(join(root, rp.guide), 'utf8') : null;
  return { manifest: rp, dir: root, guide };
}
