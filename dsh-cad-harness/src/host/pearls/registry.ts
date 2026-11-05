// Load and validate the fixed pearl set + templates. Additive to the existing tool layer.

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CAD_TOOL_GROUPS } from '../tool-groups.ts';
import type { PearlBudget, PearlManifest, PearlTemplate, TemplateStep } from './types.ts';

const ID_RE = /^[a-z][a-z0-9-]*$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
export const PEARL_IDS = ['brief', 'model', 'fit', 'make', 'review', 'deliver'] as const;

const KNOWN_TOOLS = new Set(Object.values(CAD_TOOL_GROUPS).flat());

export function validateBudget(value: unknown, partial = false): string[] {
  const errors: string[] = [];
  if (typeof value !== 'object' || value === null) return ['budget must be an object'];
  const b = value as Partial<PearlBudget>;
  for (const key of ['maxDistinctTools', 'maxCalls', 'maxCostSeconds'] as const) {
    if (partial && b[key] === undefined) continue;
    if (typeof b[key] !== 'number' || !Number.isFinite(b[key]) || b[key]! <= 0) {
      errors.push(`budget.${key} must be a positive number`);
    }
  }
  if (b.maxProbe !== undefined && b.maxProbe !== 1) errors.push('budget.maxProbe must be 1');
  return errors;
}

export function validatePearl(value: unknown): string[] {
  const errors: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ['pearl must be an object'];
  const p = value as Partial<PearlManifest>;
  if (p.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (typeof p.id !== 'string' || !ID_RE.test(p.id)) errors.push('id must match ^[a-z][a-z0-9-]*$');
  if (!PEARL_IDS.includes(p.id as any)) errors.push(`id must be one of: ${PEARL_IDS.join(', ')}`);
  if (typeof p.version !== 'string' || !VERSION_RE.test(p.version)) errors.push('version must be semver');
  if (p.guide !== undefined && (typeof p.guide !== 'string' || p.guide.length < 3)) errors.push('guide must be a path string when present');
  if (p.undeclaredPolicy !== undefined && p.undeclaredPolicy !== 'warn' && p.undeclaredPolicy !== 'block') errors.push('undeclaredPolicy must be warn|block');
  if (typeof p.question !== 'string' || p.question.length < 4) errors.push('question must be a sentence');
  if (!Array.isArray(p.exit) || p.exit.length === 0 || !p.exit.every((x) => typeof x === 'string' && x.length > 0)) {
    errors.push('exit must be a non-empty array of strings');
  }
  if (!Array.isArray(p.not) || p.not.length === 0 || !p.not.every((x) => typeof x === 'string' && x.length > 0)) {
    errors.push('not must be a non-empty array of strings');
  }
  if (!Array.isArray(p.templates) || p.templates.length < 1 || p.templates.length > 3 || !p.templates.every((x) => typeof x === 'string')) {
    errors.push('templates must contain 1–3 template paths');
  }
  errors.push(...validateBudget(p.budget));
  if (typeof p.probe !== 'object' || p.probe === null) {
    errors.push('probe must be an object');
  } else {
    if (typeof p.probe.required !== 'boolean') errors.push('probe.required must be boolean');
    if (!Array.isArray(p.probe.criteria) || !p.probe.criteria.every((x) => typeof x === 'string')) {
      errors.push('probe.criteria must be an array of strings');
    }
    if (!Array.isArray(p.probe.allowed) || !p.probe.allowed.every((x) => typeof x === 'string')) {
      errors.push('probe.allowed must be an array of strings');
    }
  }
  return errors;
}

export function validateTemplate(value: unknown, pearl?: PearlManifest): string[] {
  const errors: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ['template must be an object'];
  const t = value as Partial<PearlTemplate>;
  if (t.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (typeof t.id !== 'string' || !ID_RE.test(t.id)) errors.push('id must match ^[a-z][a-z0-9-]*$');
  if (typeof t.pearl !== 'string') errors.push('pearl must be a string');
  if (pearl && t.pearl !== pearl.id) errors.push(`pearl "${t.pearl}" does not match manifest "${pearl.id}"`);
  if (typeof t.version !== 'string' || !VERSION_RE.test(t.version)) errors.push('version must be semver');
  if (typeof t.when !== 'string' || t.when.length < 4) errors.push('when must explain when to use this template');
  if (!Array.isArray(t.steps) || t.steps.length === 0) {
    errors.push('steps must be a non-empty array');
  } else {
    const ids = new Set<string>();
    for (const [i, s] of t.steps.entries()) {
      if (typeof s !== 'object' || s === null) { errors.push(`steps[${i}] must be an object`); continue; }
      const step = s as Partial<TemplateStep>;
      if (typeof step.id !== 'string' || !ID_RE.test(step.id)) errors.push(`steps[${i}].id invalid`);
      else if (ids.has(step.id)) errors.push(`steps[${i}].id "${step.id}" is duplicated`);
      else ids.add(step.id);
      if (typeof step.tool !== 'string' || !KNOWN_TOOLS.has(step.tool)) {
        errors.push(`steps[${i}].tool "${String(step.tool)}" is not a registered CAD tool`);
      }
      if (step.bind !== undefined) {
        if (typeof step.bind !== 'object' || step.bind === null || Array.isArray(step.bind)) errors.push(`steps[${i}].bind must be an object`);
        else for (const [field, b] of Object.entries(step.bind)) {
          if (!b || typeof b !== 'object') { errors.push(`steps[${i}].bind.${field} must be an object`); continue; }
          if (!['project', 'input', 'step', 'contract', 'failure'].includes(b.from)) errors.push(`steps[${i}].bind.${field}.from is invalid`);
          if (typeof b.path !== 'string' || !b.path) errors.push(`steps[${i}].bind.${field}.path is required`);
          if (b.optional !== undefined && typeof b.optional !== 'boolean') errors.push(`steps[${i}].bind.${field}.optional must be boolean`);
        }
      }
    }
  }
  if (t.parallel !== undefined) {
    if (!Array.isArray(t.parallel)) errors.push('parallel must be an array of step-id arrays');
    else for (const group of t.parallel) {
      if (!Array.isArray(group) || group.length < 2) errors.push('each parallel group needs ≥2 step ids');
      else for (const id of group) {
        if (!t.steps?.some((s) => s.id === id)) errors.push(`parallel id "${id}" is not a step`);
      }
    }
  }
  if (typeof t.exit !== 'string' || t.exit.length < 4) errors.push('exit must be a sentence');
  if (t.retry !== undefined && (!Number.isInteger(t.retry) || t.retry < 0 || t.retry > 4)) errors.push('retry must be 0..4 when present');
  if (!Array.isArray(t.on_fail) || t.on_fail.length === 0) {
    errors.push('on_fail must be a non-empty array');
  } else {
    const ids = new Set((t.steps ?? []).map((s) => s.id));
    for (const [i, e] of t.on_fail.entries()) {
      if (typeof e !== 'object' || e === null) { errors.push(`on_fail[${i}] must be an object`); continue; }
      if (typeof e.when !== 'string' || typeof e.goto !== 'string') errors.push(`on_fail[${i}] needs when+goto`);
      if (e.kind !== undefined && !['transient', 'repair', 'unrecoverable'].includes(e.kind)) errors.push(`on_fail[${i}].kind must be transient|repair|unrecoverable`);
      if (typeof e.goto === 'string' && !PEARL_IDS.includes(e.goto as any)) errors.push(`on_fail[${i}].goto "${e.goto}" is not a pearl`);
      if (typeof e.goto === 'string' && e.goto === t.pearl && !(typeof t.retry === 'number' && t.retry > 0)) {
        errors.push(`on_fail[${i}] self-goto requires retry > 0`);
      }
      if (typeof e.when === 'string' && ids.size > 0 && ![...ids].some((id) => e.when.startsWith(`${id}.`))) {
        errors.push(`on_fail[${i}].when must reference a step id`);
      }
    }
  }
  return errors;
}

export interface LoadedPearl {
  manifest: PearlManifest;
  dir: string;
  templates: { manifest: PearlTemplate; path: string }[];
}

/** Load one pearl directory and its templates. */
export async function loadPearl(dir: string): Promise<LoadedPearl> {
  const root = resolve(dir);
  const manifest = JSON.parse(await readFile(join(root, 'pearl.json'), 'utf8')) as unknown;
  const errors = validatePearl(manifest);
  if (errors.length) throw new Error(`pearl ${dir} invalid:\n- ${errors.join('\n- ')}`);
  const p = manifest as PearlManifest;
  const templates: LoadedPearl['templates'] = [];
  for (const rel of p.templates) {
    const path = resolve(root, rel);
    const t = JSON.parse(await readFile(path, 'utf8')) as unknown;
    const te = validateTemplate(t, p);
    if (te.length) throw new Error(`template ${rel} invalid:\n- ${te.join('\n- ')}`);
    templates.push({ manifest: t as PearlTemplate, path });
  }
  return { manifest: p, dir: root, templates };
}

/** Load all six fixed pearls from a root directory. */
export async function loadPearlSet(root: string): Promise<LoadedPearl[]> {
  const pearls = await Promise.all(PEARL_IDS.map((id) => loadPearl(join(root, id))));
  const ids = new Set(pearls.map((p) => p.manifest.id));
  for (const id of PEARL_IDS) if (!ids.has(id)) throw new Error(`missing pearl ${id}`);
  return pearls;
}
