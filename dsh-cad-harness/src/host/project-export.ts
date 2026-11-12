// Whole-project export: every part of the corpus in one download.
//
// WHY NOT JUST LOOP THE PER-VERSION ROUTE. `/api/cad/export?v=` answers "give me
// this one revision", and the panel can only ask it one at a time. What a human
// actually hands to a colleague or a slicer is the PROJECT — all printed parts,
// their current revisions, and the assembly that says where they go. Doing that
// as N downloads loses the assembly contract and makes the file names look like
// unrelated revisions.
//
// TWO OUTPUTS, because they answer different questions:
//   * ZIP  — parts/<part>_<version>.stl + assembly/assembly.json + README
//            (+ assembly.stl). This is the hand-off / archive.
//   * STL  — the assembly at its declared placements, as one multi-shell mesh.
//            This is the "show me the whole thing in one file" reference. It is
//            deliberately NOT a boolean union: parts keep their own shells, so
//            a printer still sees separate bodies and clearances stay visible.
//
// Version policy: when assembly/assembly.json exists it PINS the revisions that
// make up the machine, and those are what gets exported (a newer draft that is
// not in the assembly is not "the project"). Parts the manifest does not name
// are still included at their newest revision, so work-in-progress parts are not
// silently dropped.

import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { safeFileStem } from '../shared/download-name.ts';
import { axisAngleAffine, eulerMatrix, type Mat3 } from './assembly-check.ts';
import { newestVersionPerPart } from './latest.ts';
import {
  DEFAULT_MANIFEST_REL, flattenParts, loadAssemblyManifest, resolveAssemblyManifestPath,
  type ManifestNode, type PartTransform,
} from './manifest.ts';
import { parseStl, transformMesh, writeBinaryStl, type ParsedMesh } from './mesh.ts';
import { listParts } from './parts.ts';
import type { ProjectStores } from './project.ts';
import { listVersions, readVersionDatums, type VersionManifestEntry } from './version.ts';
import { buildZip, type ZipEntry } from './zip.ts';

type Vec3 = [number, number, number];

const IDENTITY: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

const mul = (a: Mat3, b: Mat3): Mat3 => [0, 1, 2].map((r) =>
  [0, 1, 2].map((c) =>
    a[r]![0]! * b[0]![c]! + a[r]![1]! * b[1]![c]! + a[r]![2]! * b[2]![c]!,
  ) as unknown as readonly [number, number, number],
) as unknown as Mat3;

const apply = (m: Mat3, v: Vec3): Vec3 => [
  m[0]![0]! * v[0] + m[0]![1]! * v[1] + m[0]![2]! * v[2],
  m[1]![0]! * v[0] + m[1]![1]! * v[1] + m[1]![2]! * v[2],
  m[2]![0]! * v[0] + m[2]![1]! * v[1] + m[2]![2]! * v[2],
];

export interface ProjectPartFile {
  /** File stem inside the archive (`parts/<stem>.stl`). */
  stem: string;
  /** Human-facing part name. */
  label: string;
  versionId: string;
  stl: Uint8Array;
}

export interface ProjectAssemblyInstance {
  nodeId: string;
  label: string;
  versionId: string;
  stl: Uint8Array;
  /** world = matrix·p + translate, the manifest convention used everywhere. */
  matrix: Mat3;
  translate: Vec3;
}

export interface ProjectExportPlan {
  project: string;
  title: string;
  manifestPath: string | null;
  manifestText: string | null;
  manifestHash: string | null;
  files: ProjectPartFile[];
  instances: ProjectAssemblyInstance[];
  skipped: { label: string; reason: string }[];
  warnings: string[];
}

/** Local→world placement of one manifest node, including the feature-axis pose. */
async function nodePlacement(
  project: ProjectStores,
  transform: PartTransform | undefined,
  versionId: string,
  warnings: string[],
): Promise<{ matrix: Mat3; translate: Vec3 }> {
  const rotate = transform?.rotate;
  const translate: Vec3 = (transform?.translate ?? [0, 0, 0]) as Vec3;
  const rotM = rotate ? eulerMatrix(rotate) : IDENTITY;
  const pose = transform?.pose;
  if (!pose || typeof pose.angleDeg !== 'number' || pose.angleDeg === 0) {
    return { matrix: rotM, translate };
  }

  const datums = await readVersionDatums(project.store, versionId);
  let anchor: Vec3 | null = null;
  let dir: Vec3 | null = pose.axis ?? null;
  for (const d of datums.axes) if (d.name === pose.datum) { anchor = d.point as Vec3; dir = d.dir as Vec3; }
  for (const d of datums.cylinders) if (d.name === pose.datum) { anchor = d.point as Vec3; dir = d.dir as Vec3; }
  for (const d of datums.planes) if (d.name === pose.datum) { anchor = d.point as Vec3; dir = d.normal as Vec3; }
  for (const d of datums.points) if (d.name === pose.datum) anchor = d.point as Vec3;
  if (!anchor || !dir) {
    warnings.push(`pose datum "${pose.datum ?? '?'}" not found in ${versionId}; exported unposed`);
    return { matrix: rotM, translate };
  }

  const poseA = axisAngleAffine(anchor, dir, pose.angleDeg);
  // world = translate ∘ rotate(Euler) ∘ pose
  return {
    matrix: mul(rotM, poseA.m),
    translate: apply(rotM, poseA.t).map((v, i) => v + translate[i]!) as Vec3,
  };
}

function uniqueStem(label: string, versionId: string, used: Set<string>): string {
  const base = `${safeFileStem(label)}_${safeFileStem(versionId)}`;
  let stem = base;
  for (let n = 2; used.has(stem); n++) stem = `${base}-${n}`;
  used.add(stem);
  return stem;
}

/**
 * Resolve the project into the exact file set a download should contain.
 * Never writes anything; a missing manifest is a normal state, not an error.
 */
export async function planProjectExport(project: ProjectStores): Promise<ProjectExportPlan> {
  const resolved = await resolveAssemblyManifestPath(undefined, {
    workspace: project.cwd,
    dataRoot: project.root,
  });
  const hasManifest = resolved.origin !== 'workspace-default';
  let manifestText: string | null = null;
  let manifest = null;
  if (hasManifest) {
    manifest = await loadAssemblyManifest(resolved.path);
    manifestText = await readFile(resolved.path, 'utf8');
  }

  const [versions, parts] = await Promise.all([listVersions(project.store), listParts(project.partStore)]);
  const versionById = new Map(versions.map((v) => [v.id, v]));
  const partNameById = new Map(parts.map((p) => [p.id, p.name]));
  const newest = newestVersionPerPart(versions);

  const warnings: string[] = [];
  const skipped: { label: string; reason: string }[] = [];
  const stlCache = new Map<string, Uint8Array | null>();

  const stlFor = async (versionId: string): Promise<Uint8Array | null> => {
    if (stlCache.has(versionId)) return stlCache.get(versionId)!;
    let stl: Uint8Array | null = null;
    try {
      stl = new Uint8Array(await readFile(join(project.store.root, 'versions', versionId, 'model.stl')));
    } catch {
      stl = null;
    }
    stlCache.set(versionId, stl);
    return stl;
  };

  const partLabel = (node: ManifestNode, entry: VersionManifestEntry | undefined): string =>
    (entry?.partId ? partNameById.get(entry.partId) : undefined) ?? node.name ?? node.id;

  const files: ProjectPartFile[] = [];
  const instances: ProjectAssemblyInstance[] = [];
  const usedStems = new Set<string>();
  const fileByVersion = new Map<string, ProjectPartFile>();
  const coveredPartIds = new Set<string>();

  if (manifest) {
    for (const flat of flattenParts(manifest.root)) {
      const node = flat.node;
      const versionId = node.version;
      const label = node.name ?? node.id;
      if (!versionId) {
        skipped.push({
          label,
          reason: node.source === 'stock' ? '采购件（stock），没有版本几何' : '清单节点没有钉版本',
        });
        continue;
      }
      const entry = versionById.get(versionId);
      if (entry?.partId) coveredPartIds.add(entry.partId);
      const stl = await stlFor(versionId);
      if (!stl) {
        skipped.push({ label, reason: `版本 ${versionId} 没有 model.stl` });
        continue;
      }
      const display = partLabel(node, entry);
      const newestId = entry?.partId ? newest.get(entry.partId) : undefined;
      if (entry?.partId && newestId && newestId !== versionId) {
        const note = `${display}：装配清单钉 ${versionId}，该零件最新版是 ${newestId}`;
        if (!warnings.includes(note)) warnings.push(note);
      }

      let file = fileByVersion.get(versionId);
      if (!file) {
        file = {
          stem: uniqueStem(display, versionId, usedStems),
          label: display,
          versionId,
          stl,
        };
        fileByVersion.set(versionId, file);
        files.push(file);
      }

      const placement = await nodePlacement(project, flat.transform, versionId, warnings);
      instances.push({
        nodeId: node.id,
        label: display,
        versionId,
        stl,
        matrix: placement.matrix,
        translate: placement.translate,
      });
    }
  }

  // Parts the manifest does not account for (a new draft, or a project without
  // an assembly yet): include their newest revision so nothing is silently lost.
  for (const part of parts) {
    if (coveredPartIds.has(part.id)) continue;
    const versionId = newest.get(part.id);
    if (!versionId) {
      skipped.push({ label: part.name, reason: '这个零件还没有版本' });
      continue;
    }
    const stl = await stlFor(versionId);
    if (!stl) {
      skipped.push({ label: part.name, reason: `版本 ${versionId} 没有 model.stl` });
      continue;
    }
    const file: ProjectPartFile = {
      stem: uniqueStem(part.name, versionId, usedStems),
      label: part.name,
      versionId,
      stl,
    };
    fileByVersion.set(versionId, file);
    files.push(file);
  }

  return {
    project: project.cwd,
    title: manifest?.name || basename(project.cwd) || 'project',
    manifestPath: hasManifest ? resolved.path : null,
    manifestText,
    manifestHash: manifest?.manifestHash ?? null,
    files,
    instances,
    skipped,
    warnings,
  };
}

/**
 * One STL holding the assembly at its declared placements. Shells are kept
 * (no boolean union): this is a reference model of the machine, not a claim
 * that the parts have been fused into one printable solid.
 */
export function buildAssemblyStl(plan: ProjectExportPlan): Uint8Array {
  if (!plan.manifestText) {
    throw new Error(
      `这个项目还没有 ${DEFAULT_MANIFEST_REL}，无法按装配位置合并。` +
      '请改用 ZIP 导出（逐零件 STL + 清单）。',
    );
  }
  if (plan.instances.length === 0) {
    throw new Error('装配清单里没有带几何的零件，无法生成整机 STL。请检查各节点的 version 是否有 model.stl。');
  }

  const meshes: ParsedMesh[] = [];
  let vertexCount = 0;
  let triangleCount = 0;
  for (const instance of plan.instances) {
    const mesh = transformMesh(parseStl(instance.stl).mesh, instance.matrix, instance.translate);
    meshes.push(mesh);
    vertexCount += mesh.vertProperties.length / 3;
    triangleCount += mesh.triVerts.length / 3;
  }

  const vertices = new Float32Array(vertexCount * 3);
  const tris = new Uint32Array(triangleCount * 3);
  let vo = 0;
  let to = 0;
  let base = 0;
  for (const mesh of meshes) {
    vertices.set(mesh.vertProperties, vo);
    for (let i = 0; i < mesh.triVerts.length; i++) tris[to + i] = mesh.triVerts[i]! + base;
    vo += mesh.vertProperties.length;
    to += mesh.triVerts.length;
    base += mesh.vertProperties.length / 3;
  }
  return writeBinaryStl(
    { vertProperties: vertices, triVerts: tris },
    `dsh-cad-harness assembly export (${plan.instances.length} placed parts, ${plan.title})`,
  );
}

/** Human-readable cover sheet inside the ZIP: units, revision policy, omissions. */
export function projectExportReadme(plan: ProjectExportPlan): string {
  const lines: string[] = [
    'ToyMarker 项目导出',
    `项目：${plan.title}`,
    `目录：${plan.project}`,
    `导出时间：${new Date().toISOString()}`,
    '',
    '单位：毫米（mm）；坐标：Z 轴向上。STL 本身不携带单位，导入切片软件时请明确选择 mm。',
    '',
  ];

  if (plan.manifestText) {
    lines.push(
      `装配清单：${DEFAULT_MANIFEST_REL}${plan.manifestHash ? `（内容哈希 ${plan.manifestHash}）` : ''}`,
      'parts/ 下每个 STL 是零件本地坐标系下的几何，未应用装配变换。',
      'assembly.stl 按清单里的 translate/rotate/pose 把各零件摆好后拼成一个多壳网格，',
      '用于整机预览/报价；它不是布尔并集，也不是可以直接打印的单个实体。',
      '装配位置以 assembly/assembly.json 为准。',
    );
  } else {
    lines.push(
      `没有 ${DEFAULT_MANIFEST_REL}：本包按各零件的最新版本导出，零件彼此没有装配位置。`,
    );
  }
  lines.push('');

  if (plan.files.length) {
    lines.push('零件：');
    for (const file of plan.files) {
      lines.push(`- ${file.label}（${file.versionId}）→ parts/${file.stem}.stl`);
    }
  } else {
    lines.push('零件：（无）');
  }
  lines.push('');

  if (plan.manifestText) {
    const placed = new Set(plan.instances.map((i) => i.versionId));
    const unplaced = plan.files.filter((f) => !placed.has(f.versionId));
    if (unplaced.length) {
      lines.push('未装配（只在 parts/，没有放进 assembly.stl）：');
      for (const file of unplaced) lines.push(`- ${file.label}（${file.versionId}）`);
      lines.push('');
    }
  }

  if (plan.skipped.length) {
    lines.push('未导出：');
    for (const item of plan.skipped) lines.push(`- ${item.label}：${item.reason}`);
    lines.push('');
  }
  if (plan.warnings.length) {
    lines.push('注意：');
    for (const warning of plan.warnings) lines.push(`- ${warning}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

/** The ZIP a human downloads: parts + manifest + README (+ placed assembly). */
export async function buildProjectZip(plan: ProjectExportPlan, extras: readonly ZipEntry[] = []): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const entries: ZipEntry[] = plan.files.map((file) => ({
    name: `parts/${file.stem}.stl`,
    data: file.stl,
  }));
  if (plan.manifestText) {
    entries.push({
      name: DEFAULT_MANIFEST_REL,
      data: encoder.encode(plan.manifestText),
    });
    if (plan.instances.length) {
      entries.push({ name: 'assembly.stl', data: buildAssemblyStl(plan) });
    }
  }
  entries.push({ name: 'README.txt', data: encoder.encode(projectExportReadme(plan)) });
  entries.push(...extras);
  return buildZip(entries);
}
