// write_assembly: the typed writer for assembly/assembly.json.
//
// It is NOT a generic file writer and NOT a checker. It validates the manifest
// structure, child versions, datum endpoints, direct-child ownership and hash
// preconditions, then writes atomically. Geometry/clearance stays in
// validate_assembly; verdicts stay in check_assembly.

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, dirname } from 'node:path';
import type { ProjectStores } from './project.ts';
import { versionExists, readVersionDatums } from './version.ts';
import {
  validateManifest,
  loadAssemblyManifest,
  type AssemblyManifest,
  type ManifestInterface,
  type ManifestNode,
  type Quantity,
} from './manifest.ts';

export type WriteAssemblyMode = 'create' | 'merge' | 'replace';

export interface WriteAssemblyInput {
  manifestPath?: string;
  mode?: WriteAssemblyMode;
  expectedHash?: string;
  root?: Partial<ManifestNode> & { id?: string };
  remove?: { children?: string[]; interfaces?: string[] };
}

export interface WriteAssemblyResult {
  manifestPath: string;
  manifestHash: string;
  mode: WriteAssemblyMode;
  changed: boolean;
  counts: { children: number; interfaces: number };
  warnings: string[];
}

const DEFAULT_PATH = 'assembly/assembly.json';

function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

function textOf(manifest: AssemblyManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function expectedToNominal(iface: ManifestInterface & { expected?: unknown }): string | null {
  if (iface.expected === undefined) return null;
  if (typeof iface.expected !== 'number' || !Number.isFinite(iface.expected)) {
    throw new Error(`interface ${iface.id}: expected must be a finite number`);
  }
  if (iface.nominal) {
    throw new Error(`interface ${iface.id}: give nominal or expected, not both`);
  }
  const q: Quantity = iface.check === 'coaxial' ? '同轴度'
    : iface.check === 'diameter-match' ? '直径'
      : iface.check === 'spring-preload' ? '预紧力' : iface.check === 'spring-behaviour' ? '弹簧力' : iface.check === 'snap-fit' ? '插入力'
        : '距离';
  iface.nominal = { quantity: q, value: iface.expected };
  delete iface.expected;
  return `interface ${iface.id}: normalized expected -> nominal.${q}`;
}

function normalizeExpected(root: ManifestNode, warnings: string[]): void {
  const walk = (node: ManifestNode) => {
    for (const iface of node.interfaces ?? []) {
      const warning = expectedToNominal(iface as ManifestInterface & { expected?: unknown });
      if (warning) warnings.push(warning);
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
}

function mergeNode(existing: ManifestNode, patch: Partial<ManifestNode>): ManifestNode {
  const out: ManifestNode = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'id' || key === 'children' || key === 'interfaces') continue;
    if (value !== undefined) (out as unknown as Record<string, unknown>)[key] = value;
  }
  if (patch.children) {
    const byId = new Map((out.children ?? []).map((c) => [c.id, c]));
    for (const p of patch.children as ManifestNode[]) {
      const old = byId.get(p.id);
      byId.set(p.id, old ? mergeNode(old, p) : structuredClone(p));
    }
    out.children = [...byId.values()];
  }
  if (patch.interfaces) {
    const byId = new Map((out.interfaces ?? []).map((i) => [i.id, i]));
    for (const p of patch.interfaces as ManifestInterface[]) {
      byId.set(p.id, { ...(byId.get(p.id) ?? {}), ...structuredClone(p) } as ManifestInterface);
    }
    out.interfaces = [...byId.values()];
  }
  return out;
}

function countNodes(node: ManifestNode): { children: number; interfaces: number } {
  let children = 0;
  let interfaces = (node.interfaces ?? []).length;
  for (const child of node.children ?? []) {
    children++;
    const c = countNodes(child);
    children += c.children;
    interfaces += c.interfaces;
  }
  return { children, interfaces };
}

export async function validateEndpoints(project: ProjectStores, root: ManifestNode): Promise<string[]> {
  const errors: string[] = [];
  const datumCache = new Map<string, Awaited<ReturnType<typeof readVersionDatums>>>();
  const namesOf = async (version: string) => {
    if (!datumCache.has(version)) datumCache.set(version, await readVersionDatums(project.store, version));
    const d = datumCache.get(version)!;
    return [...d.points, ...d.axes, ...d.planes, ...d.cylinders].map((x) => x.name);
  };

  const walk = async (owner: ManifestNode, path: string[]) => {
    const ids = new Set<string>();
    for (const iface of owner.interfaces ?? []) {
      if (ids.has(iface.id)) errors.push(`${path.join('/')}: duplicate interface id "${iface.id}"`);
      ids.add(iface.id);
      for (const side of ['a', 'b'] as const) {
        const address = iface[side];
        const dot = address.indexOf('.');
        if (dot <= 0 || dot === address.length - 1) {
          errors.push(`${path.join('/')} ${iface.id}: malformed endpoint "${address}"`);
          continue;
        }
        const childId = address.slice(0, dot);
        const datum = address.slice(dot + 1);
        const child = owner.children?.find((c) => c.id === childId);
        if (!child) {
          errors.push(`${path.join('/')} ${iface.id}: "${childId}" is not a direct child of "${owner.id}"`);
          continue;
        }
        if (child.kind === 'assembly') {
          if (!(child.datums ?? []).some((d) => d.name === datum)) {
            errors.push(`${path.join('/')} ${iface.id}: assembly child "${childId}" has no declared datum "${datum}"`);
          }
          continue;
        }
        if (!child.version) {
          errors.push(`${path.join('/')} ${iface.id}: child "${childId}" has no version (stock parts cannot be interface endpoints)`);
          continue;
        }
        if (!(await versionExists(project.store, child.version))) {
          errors.push(`${path.join('/')} ${iface.id}: child "${childId}" version ${child.version} does not exist`);
          continue;
        }
        const names = await namesOf(child.version);
        if (iface.tolerance && iface.tolerance.min > iface.tolerance.max) {
          errors.push(`${path.join('/')} ${iface.id}: tolerance.min > tolerance.max`);
        }
        if (!names.includes(datum)) {
          errors.push(`${path.join('/')} ${iface.id}: datum "${datum}" not found in ${childId} ${child.version}` +
            (names.length ? ` (available: ${names.slice(0, 12).join(', ')}${names.length > 12 ? ', …' : ''})` : ' (version declares no datums)'));
        }
      }
    }
    for (const child of owner.children ?? []) await walk(child, [...path, child.id]);
  };
  await walk(root, [root.id]);
  return errors;
}

function normalizeHash(value: string): string {
  const v = value.trim();
  return v.startsWith('sha256:') ? v : `sha256:${v}`;
}

export interface AssemblyContractInspection {
  manifestPath: string;
  counts: { children: number; interfaces: number } | null;
  issues: string[];
}

/** Read-only validation used by the model pearl; never writes. */
export async function inspectAssemblyContract(
  project: ProjectStores,
  manifestPath = DEFAULT_PATH,
): Promise<AssemblyContractInspection> {
  const target = isAbsolute(manifestPath) ? manifestPath : join(project.cwd, manifestPath);
  const rel = relative(project.cwd, target);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { manifestPath: target, counts: null, issues: [`manifestPath escapes the project workspace: ${manifestPath}`] };
  }
  let manifest: AssemblyManifest;
  try {
    manifest = await loadAssemblyManifest(target);
  } catch (e) {
    return { manifestPath: target, counts: null, issues: [String(e)] };
  }
  const endpointErrors = await validateEndpoints(project, manifest.root);
  return {
    manifestPath: target,
    counts: countNodes(manifest.root),
    issues: endpointErrors,
  };
}

/** Write one assembly manifest under the project workspace. */
export async function writeAssembly(project: ProjectStores, input: WriteAssemblyInput): Promise<WriteAssemblyResult> {
  const mode = input.mode ?? 'merge';
  if (!['create', 'merge', 'replace'].includes(mode)) throw new Error(`invalid mode "${String(mode)}"`);
  const requested = input.manifestPath?.trim() || DEFAULT_PATH;
  const target = isAbsolute(requested) ? requested : join(project.cwd, requested);
  const rel = relative(project.cwd, target);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`manifestPath escapes the project workspace: ${requested} -> ${target}`);
  }

  let existingText: string | null = null;
  let existing: AssemblyManifest | null = null;
  try {
    existingText = await readFile(target, 'utf8');
    existing = JSON.parse(existingText) as AssemblyManifest;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }

  if (mode === 'create' && existing) throw new Error(`manifest already exists: ${target}`);
  if (mode === 'replace' && !existing) throw new Error(`replace requires an existing manifest: ${target}`);
  if (existing && (mode === 'merge' || mode === 'replace')) {
    if (!input.expectedHash) throw new Error(`${mode} requires expectedHash (read it with check_assembly first)`);
    const actual = sha256(existingText!);
    if (normalizeHash(input.expectedHash) !== actual) {
      throw new Error(`expectedHash mismatch: wanted ${normalizeHash(input.expectedHash)}, actual ${actual}`);
    }
  }

  const warnings: string[] = [];
  let root: ManifestNode;
  if (mode === 'merge' && existing) {
    if (!input.root) throw new Error('merge requires root (children/interfaces patch)');
    if (input.root.id && input.root.id !== existing.root.id) {
      throw new Error(`root id "${input.root.id}" does not match existing "${existing.root.id}"`);
    }
    root = mergeNode(existing.root, input.root as Partial<ManifestNode>);
  } else {
    if (!input.root) throw new Error(`${mode} requires root`);
    root = structuredClone(input.root as ManifestNode);
  }

  normalizeExpected(root, warnings);

  if (input.remove) {
    for (const id of input.remove.interfaces ?? []) {
      if (!(root.interfaces ?? []).some((i) => i.id === id)) throw new Error(`remove.interfaces: "${id}" not found on root`);
    }
    for (const id of input.remove.children ?? []) {
      if (!(root.children ?? []).some((c) => c.id === id)) throw new Error(`remove.children: "${id}" not found on root`);
    }
    root.interfaces = (root.interfaces ?? []).filter((i) => !(input.remove!.interfaces ?? []).includes(i.id));
    root.children = (root.children ?? []).filter((c) => !(input.remove!.children ?? []).includes(c.id));
  }

  const next: AssemblyManifest = {
    schemaVersion: 1,
    name: existing?.name ?? root.name ?? 'assembly',
    unit: 'mm',
    up: 'z',
    root,
  };
  const issues = validateManifest(next);
  if (issues.length) {
    throw new Error(`schema validation failed:\n${issues.map((i) => `- ${i.path}: expected ${i.expected}, got ${i.got}`).join('\n')}`);
  }
  const endpointErrors = await validateEndpoints(project, root);
  if (endpointErrors.length) throw new Error(`endpoint validation failed:\n${endpointErrors.map((e) => `- ${e}`).join('\n')}`);

  const text = textOf(next);
  const changed = text !== existingText;
  if (changed) {
    await mkdir(dirname(target), { recursive: true });
    const tmp = join(dirname(target), `.${process.pid}.${randomUUID()}.assembly.tmp`);
    try {
      await writeFile(tmp, text, 'utf8');
      await rename(tmp, target);
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  }
  const counts = countNodes(root);
  return { manifestPath: target, manifestHash: sha256(text), mode, changed, counts, warnings };
}
