// Assembly manifest: the BOM + executable-ICD artifact (schema v0.1, see
// ASSEMBLY-SCHEMA-PROPOSAL.md). JSON is the single source of truth and is
// deliberately language-neutral; every consumer (engine checks, panel, LLM
// scripts) goes through this module or reads the JSON directly.
//
// Conventions (adjudicated 2026-09-28):
// - node.id: English kebab-case, immutable (version graph references it)
// - node.name / datum names: human-facing, may be Chinese
// - interface endpoints are ADDRESSES "<childId>.<datumName>" resolved against
//   the node that owns the interface — never array indices
// - interfaces live on the node whose DIRECT children they connect; a node's
//   external (port) interfaces appear in its parent's interfaces list
// - mm / z-up everywhere

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

// ---------- types ----------

export type InterfaceType = '贴合' | '间隙' | '紧固' | '转动副' | '滑动副' | '弹簧' | '流道';
export type Quantity = '距离' | '直径' | '同轴度' | '角度' | '预紧力';
export type Severity = 'hard' | 'intent';
export type VerdictLayer = 'L0' | 'L1' | 'L2';

export interface ManifestInterface {
  id: string;                       // stable, unique within the manifest
  a: string;                        // "<childId>.<datumName>"
  b: string;
  type: InterfaceType;
  nominal?: { quantity: Quantity; value: number };
  tolerance?: { min: number; max: number };
  severity: Severity;               // hard = engine error; intent = flag for human
  layer?: VerdictLayer;             // defaults derived from type
  check?: string;                   // operator name; defaults derived from type
  params?: Record<string, number>;  // spring: freeLength/stiffness/damping; flow: inlet/outlet
  note?: string;                    // design intent — human- and LLM-readable
}

export interface ManifestDatumDecl {
  name: string;
  kind: 'point' | 'axis' | 'plane' | 'cylinder';
}

export interface PartPose {
  /**
   * Name of a datum in the version's datums.json that anchors the rotation
   * axis: axis/cylinder → its dir through its point, plane → its normal
   * through its point, point → needs `axis` too. The datum itself rotates with
   * the part (a rotation about the axis fixes that axis, so it stays exact).
   */
  datum?: string;
  /** Axis direction in the part's local frame; required only for a point datum. */
  axis?: [number, number, number];
  /** Rotation about the axis, degrees, right-hand rule. */
  angleDeg: number;
}

export interface PartTransform {
  translate?: [number, number, number];
  rotate?: [number, number, number]; // degrees XYZ, matching Manifold rotate
  /**
   * THE ASSEMBLY POSE. Applied in the part's LOCAL frame, first (rightmost) —
   *
   *   world = translate ∘ rotate(euler) ∘ pose
   *
   * This exists because a meshing angle is not a placement: microscope3's gear
   * needed −40.1° to engage its rack, but writing that as a whole-part `rotate`
   * also dragged the D-flat on the shaft end and every datum with it. A pose is
   * a rotation about a named feature axis, and the datums follow the part.
   */
  pose?: PartPose;
}

export interface ManifestNode {
  id: string;
  name: string;
  kind: 'part' | 'assembly';
  version?: string;                 // part: version id in the version store
  /**
   * Where the part came from.
   *
   * `stock` = a purchased/existing part with NO version: no geometry, so it is
   * skipped by the geometric checks and its influence must be folded into the
   * datums of the parts around it. `imported` is deliberately a separate value:
   * an imported part HAS a version directory with a measured mesh, so it is
   * checked exactly like a generated one — it is an interface endpoint, not a
   * hole in the manifest. Anything without a `version` is what `stock` means.
   */
  source?: 'generated' | 'imported' | 'stock';
  material?: string;
  qty?: number;
  stockRef?: string;                // source=stock: identification of the physical part
  transform?: PartTransform;        // placement in the parent frame (v1: parts only)
  datums?: ManifestDatumDecl[];     // documentation index; truth lives in datums.json
  children?: ManifestNode[];
  interfaces?: ManifestInterface[];
}

export interface AssemblyManifest {
  schemaVersion: 1;
  name: string;
  unit: 'mm';
  up: 'z';
  root: ManifestNode;
}

/** An interface together with the path of the node that owns it. */
export interface OwnedInterface {
  ownerPath: string[];              // node ids from root to the owning node
  iface: ManifestInterface;
}

// ---------- IO ----------

export function defaultManifestPath(dataRoot: string): string {
  return join(dataRoot, 'assembly', 'assembly.json');
}

/** Where a manifest relative path is looked for, in order. */
export interface ManifestSearchRoots {
  /** The session workspace (the project cwd the agent can actually write to). */
  workspace: string;
  /** The plugin data root (`$DSH_HOME/cad/<key>`) — where corpora used to live. */
  dataRoot: string;
}

export interface ResolvedManifest {
  /** Absolute path the manifest was read from (or the one that was searched for). */
  path: string;
  /** Which root won. `workspace-default` = nothing existed, this is where to write it. */
  origin: 'absolute' | 'workspace' | 'data-root' | 'workspace-default';
  /** Every candidate that was tried, in order — echoed into errors and reports. */
  searched: string[];
}

export const DEFAULT_MANIFEST_REL = 'assembly/assembly.json';

const exists = async (path: string): Promise<boolean> => {
  try { await access(path); return true; } catch { return false; }
};

/**
 * Resolve `manifestPath` to a readable manifest.
 *
 * WHY THE WORKSPACE COMES FIRST. The manifest is a file the AGENT authors, and
 * the default DSH sandbox lets an agent write only inside its session workspace.
 * Resolving relative paths against the plugin data root (outside the workspace)
 * therefore made `check_assembly` unusable without escalating the whole session
 * to `danger-full-access` — observed on the microscope2 run, where the agent had
 * to reverse-engineer the hashed data-root name and escalate three times just to
 * place its own manifest. The workspace is both writable and the place a human
 * looks for the design's source of truth; the data root stays as a fallback so
 * corpora written before this existed keep working.
 *
 * Pure path arithmetic plus one existence probe per candidate; it never creates
 * anything.
 */
export async function resolveAssemblyManifestPath(
  manifestPath: string | undefined,
  roots: ManifestSearchRoots,
): Promise<ResolvedManifest> {
  const requested = manifestPath?.trim();
  if (requested && isAbsolute(requested)) {
    return { path: requested, origin: 'absolute', searched: [requested] };
  }
  const rel = requested || DEFAULT_MANIFEST_REL;
  const workspace = join(roots.workspace, rel);
  const dataRoot = join(roots.dataRoot, rel);
  if (await exists(workspace)) return { path: workspace, origin: 'workspace', searched: [workspace, dataRoot] };
  if (await exists(dataRoot)) return { path: dataRoot, origin: 'data-root', searched: [workspace, dataRoot] };
  if (requested) {
    // An explicitly named manifest that exists nowhere: say where it looked,
    // instead of letting readFile report a bare ENOENT on an undocumented path.
    throw new Error(`no assembly manifest at ${workspace} or ${dataRoot}`);
  }
  return { path: workspace, origin: 'workspace-default', searched: [workspace, dataRoot] };
}

export async function loadAssemblyManifest(path: string): Promise<AssemblyManifest> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as AssemblyManifest;
  const problems = validateManifest(raw);
  if (problems.length > 0) {
    throw new Error(`invalid assembly manifest: ${problems.join('; ')}`);
  }
  return raw;
}

export async function saveAssemblyManifest(path: string, manifest: AssemblyManifest): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(manifest, null, 2));
}

// ---------- validation ----------

function collectIds(node: ManifestNode, ids: Map<string, string[]>): void {
  if (ids.has(node.id)) throw new Error(`duplicate node id "${node.id}"`);
  ids.set(node.id, []);
  for (const child of node.children ?? []) collectIds(child, ids);
}

/**
 * Structural checks only — no geometry. Returns problem descriptions;
 * an empty list means the manifest is well-formed.
 */
export function validateManifest(m: AssemblyManifest): string[] {
  const problems: string[] = [];
  if (m.schemaVersion !== 1) problems.push(`schemaVersion must be 1, got ${m.schemaVersion}`);
  if (!m.root || m.root.kind !== 'assembly') problems.push('root must be an assembly node');

  const ids = new Map<string, string[]>();
  try { collectIds(m.root, ids); } catch (e) { problems.push((e as Error).message); }

  const walk = (node: ManifestNode, path: string[]) => {
    const childIds = new Set((node.children ?? []).map((c) => c.id));
    for (const iface of node.interfaces ?? []) {
      for (const end of [iface.a, iface.b]) {
        const childId = end.split('.')[0]!;
        if (!childIds.has(childId)) {
          problems.push(`interface ${iface.id}: endpoint "${end}" must reference a direct child of "${node.id}"`);
        }
      }
    }
    for (const child of node.children ?? []) walk(child, [...path, child.id]);
  };
  walk(m.root, [m.root.id]);
  return problems;
}

// ---------- traversal ----------

/** All interfaces in the tree, each tagged with its owner path. */
export function allInterfaces(node: ManifestNode): OwnedInterface[] {
  const out: OwnedInterface[] = [];
  const walk = (n: ManifestNode, path: string[]) => {
    for (const iface of n.interfaces ?? []) out.push({ ownerPath: path, iface });
    for (const child of n.children ?? []) walk(child, [...path, child.id]);
  };
  walk(node, [node.id]);
  return out;
}

export interface FlatPart {
  id: string;
  node: ManifestNode;
  /** Node ids from root to this part (inclusive). */
  path: string[];
  transform: PartTransform | undefined;
}

/**
 * All part leaves in the tree. v1 composes only translate along the path
 * (hierarchy transforms land with v2); rotate is taken from the leaf.
 */
export function flattenParts(root: ManifestNode): FlatPart[] {
  const parts: FlatPart[] = [];
  const sum = (a: [number, number, number] | undefined, b: [number, number, number] | undefined) =>
    b === undefined ? a : a === undefined ? b : [a[0] + b[0], a[1] + b[1], a[2] + b[2]] as [number, number, number];
  const walk = (n: ManifestNode, path: string[], acc: PartTransform | undefined) => {
    if (n.kind === 'part') {
      parts.push({
        id: n.id, node: n, path,
        // pose is leaf-only, like rotate: an assembly pose is a property of the
        // part's own feature axis, not something a parent accumulates.
        transform: acc?.translate === undefined && n.transform?.rotate === undefined && n.transform?.pose === undefined
          ? n.transform
          : {
              translate: sum(acc?.translate, n.transform?.translate),
              rotate: n.transform?.rotate ?? acc?.rotate,
              pose: n.transform?.pose,
            },
      });
      return;
    }
    for (const child of n.children ?? []) walk(child, [...path, child.id], acc);
  };
  walk(root, [root.id], undefined);
  return parts;
}

/** Find a node by id anywhere in the tree. */
export function findNode(root: ManifestNode, id: string): ManifestNode | undefined {
  if (root.id === id) return root;
  for (const child of root.children ?? []) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return undefined;
}
