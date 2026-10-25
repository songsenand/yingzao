// The appearance sidecar for a version.
//
// A version's `model.stl` is geometry truth: measurements, printability and every
// downstream numeric check read it. A color design is not geometry truth. It is a
// GLB whose materials are the design intent, and it must not silently replace the
// STL (that would make a pretty preview the source of truth).
//
// So a version may carry `appearance.glb` + `appearance.json` next to `model.stl`.
// There is no bpy/Blender render path: the sidecar is stored for external viewers
// and future panel work; the panel still previews model.stl. The attachment is
// deliberately small and self-contained:
// a GLB v2 with at least one material, no external buffer/image URIs, and a size
// cap. Geometry identity is NOT claimed: the GLB is checked as a container, not
// matched against the STL's triangles.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { versionExists, type VersionStore } from './version.ts';

export const APPEARANCE_FILE = 'appearance.glb';
export const APPEARANCE_RECORD = 'appearance.json';
export const MAX_APPEARANCE_BYTES = 256 * 1024 * 1024;

const GLB_MAGIC = 0x46546c67; // "glTF" little-endian
const GLB_JSON_CHUNK = 0x4e4f534a; // "JSON"

export interface GlbInfo {
  generator: string | null;
  meshes: number;
  materials: string[];
  extensionsUsed: string[];
}

export interface AppearanceRecord {
  versionId: string;
  file: typeof APPEARANCE_FILE;
  sha256: string;
  bytes: number;
  materials: string[];
  meshes: number;
  generator: string | null;
  note?: string;
  attachedAt: string;
}

export interface AttachAppearanceResult {
  record: AppearanceRecord;
  replaced: boolean;
}

export class AppearanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppearanceError';
  }
}

export function appearancePath(storeRoot: string, versionId: string): string {
  return join(storeRoot, 'versions', versionId, APPEARANCE_FILE);
}

export function appearanceRecordPath(storeRoot: string, versionId: string): string {
  return join(storeRoot, 'versions', versionId, APPEARANCE_RECORD);
}

function checkExternalUris(json: Record<string, unknown>): void {
  for (const key of ['buffers', 'images']) {
    const value = json[key];
    if (!Array.isArray(value)) continue;
    for (const [index, item] of value.entries()) {
      if (!item || typeof item !== 'object') continue;
      const uri = (item as { uri?: unknown }).uri;
      if (typeof uri !== 'string') continue;
      if (uri.startsWith('data:')) continue;
      throw new AppearanceError(
        `the GLB has an external ${key.slice(0, -1)} URI at ${key}[${index}] (${uri.slice(0, 80)}). ` +
        'Export a self-contained .glb so the color design cannot depend on files outside the version.',
      );
    }
  }
}

/** Parse and validate the parts of a GLB this harness is willing to store. */
export function parseGlb(data: Buffer): GlbInfo {
  if (data.length < 20) throw new AppearanceError('not a GLB: fewer than 20 bytes');
  if (data.length > MAX_APPEARANCE_BYTES) {
    throw new AppearanceError(
      `the GLB is ${data.length} bytes; the appearance cap is ${MAX_APPEARANCE_BYTES} bytes`,
    );
  }
  if (data.readUInt32LE(0) !== GLB_MAGIC) throw new AppearanceError('not a GLB: bad "glTF" magic');
  const version = data.readUInt32LE(4);
  if (version !== 2) throw new AppearanceError(`unsupported GLB version ${version}; expected 2`);
  const declaredLength = data.readUInt32LE(8);
  if (declaredLength !== data.length) {
    throw new AppearanceError(`GLB is truncated or padded: header says ${declaredLength}, file is ${data.length}`);
  }

  let offset = 12;
  let json: Record<string, unknown> | null = null;
  while (offset + 8 <= data.length) {
    const chunkLength = data.readUInt32LE(offset);
    const chunkType = data.readUInt32LE(offset + 4);
    offset += 8;
    if (chunkLength % 4 !== 0) throw new AppearanceError('GLB chunk length is not 4-byte aligned');
    if (offset + chunkLength > data.length) throw new AppearanceError('GLB chunk runs past the end of the file');
    if (chunkType === GLB_JSON_CHUNK) {
      const text = data.subarray(offset, offset + chunkLength).toString('utf8').replace(/\0+$/g, '');
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch (error) {
        throw new AppearanceError(`GLB JSON chunk is not valid JSON: ${String(error)}`);
      }
    }
    offset += chunkLength;
  }
  if (!json) throw new AppearanceError('GLB has no JSON chunk');
  checkExternalUris(json);

  const materials = Array.isArray(json.materials)
    ? json.materials.map((material, index) => {
      const name = material && typeof material === 'object' ? (material as { name?: unknown }).name : null;
      return typeof name === 'string' && name.trim() ? name.trim() : `material-${index}`;
    })
    : [];
  const meshes = Array.isArray(json.meshes) ? json.meshes.length : 0;
  if (meshes === 0) throw new AppearanceError('the GLB has no meshes');
  if (materials.length === 0) {
    throw new AppearanceError(
      'the GLB has no materials. A color design needs at least one material slot; ' +
      'exporting STL or a materialless GLB would only repeat geometry.',
    );
  }
  const asset = json.asset && typeof json.asset === 'object' ? (json.asset as Record<string, unknown>) : {};
  const extensionsUsed = Array.isArray(json.extensionsUsed)
    ? json.extensionsUsed.filter((value): value is string => typeof value === 'string')
    : [];
  return {
    generator: typeof asset.generator === 'string' ? asset.generator : null,
    meshes,
    materials,
    extensionsUsed,
  };
}

/** Read the record only if both the record and the GLB exist. */
export async function readAppearance(storeRoot: string, versionId: string): Promise<AppearanceRecord | null> {
  if (!existsSync(appearancePath(storeRoot, versionId))) return null;
  try {
    const parsed = JSON.parse(await readFile(appearanceRecordPath(storeRoot, versionId), 'utf8')) as AppearanceRecord;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Copy a validated GLB into the version directory and record its digest.
 *
 * `source` is the already-resolved workspace file. The caller owns workspace
 * containment; this function owns GLB validation and version-directory writes.
 */
export async function attachAppearance(
  storeRoot: string,
  versionId: string,
  source: string,
  options: { note?: string; sourceName?: string } = {},
): Promise<AttachAppearanceResult> {
  const store = { root: storeRoot } as VersionStore;
  if (!(await versionExists(store, versionId))) {
    throw new AppearanceError(`unknown version "${versionId}"`);
  }
  const data = await readFile(source);
  const info = parseGlb(data);
  const dest = appearancePath(storeRoot, versionId);
  const replaced = existsSync(dest);
  await writeFile(dest, data);
  const record: AppearanceRecord = {
    versionId,
    file: APPEARANCE_FILE,
    sha256: createHash('sha256').update(data).digest('hex'),
    bytes: data.length,
    materials: info.materials,
    meshes: info.meshes,
    generator: info.generator,
    ...(options.note?.trim() ? { note: options.note.trim() } : {}),
    attachedAt: new Date().toISOString(),
  };
  await writeFile(appearanceRecordPath(storeRoot, versionId), `${JSON.stringify(record, null, 2)}\n`);
  return { record, replaced };
}
