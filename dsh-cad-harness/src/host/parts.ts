// Part store: a stable identity for "the thing being designed".
//
// Why this exists: `generate_part` used to produce a bare `vNNN` with no notion
// of *which part* it belonged to. Measured on the corpus that shipped with the
// plugin: 32 of 33 versions had no `parentVersion` at all, the same part was
// re-created as five unrelated roots (调焦轴 v011/v016/v021/v026/v031), and the
// single existing parent link pointed at a different part (shaft ← base). With
// no part entity the panel could only offer a flat artifact log — "选择零件，
// 一个零件对应数个版本" was not expressible.
//
// So identity is *declared*, not inferred: `generate_part` takes a `part` name
// (an agent that omits it inherits the parent version's part, or starts a new
// one). Versions stay immutable; the part is the browse axis above them.
//
//   parts/manifest.json  (inside the project directory)
//     { schemaVersion: 1,
//       parts: [{ id, name, nameSource, createdAt, lastActiveAt, versionIds }] }

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface PartEntry {
  id: string;
  /** Display name as declared (trimmed, inner whitespace collapsed). */
  name: string;
  /** How the name was obtained — a migrated bucket must not look declared. */
  nameSource: 'agent' | 'intent';
  createdAt: string;
  lastActiveAt: string;
  /** Version ids in creation order. */
  versionIds: string[];
}

export interface PartManifest {
  schemaVersion: 1;
  parts: PartEntry[];
}

export interface PartStore {
  root: string;
}

/** @param dataRoot the plugin's `data/` directory (same root versions live in). */
export function openPartStore(dataRoot: string): PartStore {
  return { root: join(dataRoot, 'parts') };
}

const MANIFEST = 'manifest.json';

/** Lookup key: case- and whitespace-insensitive, so "调焦轴 " == "调焦轴". */
export function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

export async function readPartManifest(store: PartStore): Promise<PartManifest> {
  try {
    const raw = JSON.parse(await readFile(join(store.root, MANIFEST), 'utf8')) as PartManifest;
    return { schemaVersion: 1, parts: Array.isArray(raw.parts) ? raw.parts : [] };
  } catch {
    return { schemaVersion: 1, parts: [] };
  }
}

/** Parts by most recent activity (the order the picker wants). */
export async function listParts(store: PartStore): Promise<PartEntry[]> {
  return (await readPartManifest(store)).parts
    .slice()
    .sort((a, b) => (a.lastActiveAt < b.lastActiveAt ? 1 : a.lastActiveAt > b.lastActiveAt ? -1 : 0));
}

export async function findPartByName(store: PartStore, name: string): Promise<PartEntry | null> {
  const key = normalizeName(name);
  return (await readPartManifest(store)).parts.find((p) => normalizeName(p.name) === key) ?? null;
}

export async function findPartById(store: PartStore, id: string): Promise<PartEntry | null> {
  return (await readPartManifest(store)).parts.find((p) => p.id === id) ?? null;
}

async function nextPartId(store: PartStore): Promise<string> {
  const parts = (await readPartManifest(store)).parts;
  const max = parts.reduce((m, p) => {
    const match = /^p(\d{3,})$/.exec(p.id);
    return match ? Math.max(m, parseInt(match[1]!, 10)) : m;
  }, 0);
  return `p${String(max + 1).padStart(3, '0')}`;
}

async function writeManifest(store: PartStore, manifest: PartManifest): Promise<void> {
  await mkdir(store.root, { recursive: true });
  const tmp = join(store.root, `${MANIFEST}.tmp`);
  await writeFile(tmp, JSON.stringify(manifest, null, 2));
  await rename(tmp, join(store.root, MANIFEST));
}

/**
 * Fallback name when nothing was declared: the intent's leading label, or the
 * full intent when that label is too generic to identify anything ("负样本").
 * One rule, shared by the tool fallback and the corpus migration.
 */
export function derivePartName(intent: string): string {
  const text = String(intent ?? '').trim();
  const head = (text.split(/[:：,，。;；]/)[0] ?? '').trim();
  return (head.length >= 4 ? head : text || '未命名零件').slice(0, 24);
}

/**
 * Create a part. A name collision gets a numeric suffix instead of merging:
 * two different buckets must not silently become one part.
 */
export async function createUniquePart(
  store: PartStore,
  name: string,
  nameSource: PartEntry['nameSource'] = 'agent',
): Promise<PartEntry> {
  const base = name.trim().replace(/\s+/g, ' ');
  let candidate = base;
  for (let n = 2; await findPartByName(store, candidate); n++) {
    candidate = `${base} ${n}`;
    if (n > 50) throw new Error(`cannot find a free part name for "${base}"`);
  }
  return createPart(store, candidate, nameSource);
}

/** Create a part whose name is not taken yet (the caller decides the name). */
export async function createPart(
  store: PartStore,
  name: string,
  nameSource: PartEntry['nameSource'] = 'agent',
): Promise<PartEntry> {
  const manifest = await readPartManifest(store);
  const clean = name.trim().replace(/\s+/g, ' ');
  const now = new Date().toISOString();
  const entry: PartEntry = {
    id: await nextPartId(store),
    name: clean,
    nameSource,
    createdAt: now,
    lastActiveAt: now,
    versionIds: [],
  };
  manifest.parts.push(entry);
  await writeManifest(store, manifest);
  return entry;
}

/** Find by name or create — the normal path for a declared part. */
export async function ensurePart(
  store: PartStore,
  name: string,
  nameSource: PartEntry['nameSource'] = 'agent',
): Promise<PartEntry> {
  return (await findPartByName(store, name)) ?? createPart(store, name, nameSource);
}

/** Record that a version belongs to a part, and touch its activity time. */
export async function attachVersion(store: PartStore, partId: string, versionId: string): Promise<void> {
  const manifest = await readPartManifest(store);
  const part = manifest.parts.find((p) => p.id === partId);
  if (!part) throw new Error(`no such part: ${partId}`);
  if (!part.versionIds.includes(versionId)) part.versionIds.push(versionId);
  part.lastActiveAt = new Date().toISOString();
  await writeManifest(store, manifest);
}

/** Rename a part (kept for migrations and future UI); name collisions are rejected. */
export async function renamePart(store: PartStore, partId: string, name: string): Promise<void> {
  const manifest = await readPartManifest(store);
  const key = normalizeName(name);
  if (manifest.parts.some((p) => p.id !== partId && normalizeName(p.name) === key)) {
    throw new Error(`part name already taken: ${name}`);
  }
  const part = manifest.parts.find((p) => p.id === partId);
  if (!part) throw new Error(`no such part: ${partId}`);
  part.name = name.trim().replace(/\s+/g, ' ');
  await writeManifest(store, manifest);
}
