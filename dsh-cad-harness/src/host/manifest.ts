// Assembly manifest: the BOM + executable-ICD artifact (schema v0.1, see
// docs/archive/ASSEMBLY-SCHEMA-PROPOSAL.md). JSON is the single source of truth and is
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

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STANDARD_SPRINGS, STANDARD_SPRING_IDS } from './standard-parts.ts';

// ---------- types ----------

export type InterfaceType = '贴合' | '间隙' | '紧固' | '转动副' | '滑动副' | '弹簧' | '卡扣' | '流道';
export type Quantity = '距离' | '直径' | '同轴度' | '角度' | '预紧力' | '弹簧力' | '插入力';
export type Severity = 'hard' | 'intent';
export type VerdictLayer = 'L0' | 'L1' | 'L2';

/**
 * The general elastic-behaviour declaration. Deliberately NOT a "spring product":
 * the same envelope carries an axial spring, a torsion spring, a flexure, a snap
 * fit or a pad; the operator dispatches on `behavior`. `params` stays the legacy
 * numeric bag (`freeLengthMm`, `stiffnessNPerMm`, ...) so old manifests keep
 * working; when both are present, `elastic` is authoritative.
 */
export type ElasticBehavior = 'axial-spring' | 'torsion-spring' | 'flexure-beam' | 'snap-fit' | 'pad';
export type ElasticDirection = 'compression' | 'tension';
export type ElasticSource = 'catalog' | 'measured' | 'estimated' | 'declared';

export interface ElasticInterfaceSpec {
  /** Default: axial-spring. Unimplemented behaviours are skipped by name, never guessed. */
  behavior?: ElasticBehavior;
  /** Optional seed-catalog id; fills only fields not declared explicitly. */
  standardId?: string;
  /** Compression vs tension. Omitted = the sign is reported but not enforced. */
  direction?: ElasticDirection;
  /** Free (unloaded) length along the a→b line, mm. */
  freeLengthMm?: number;
  /** Axial rate, N/mm. */
  stiffnessNPerMm?: number;
  /** Solid height (coils touching), mm. Omit if unknown — the check says so. */
  solidHeightMm?: number;
  /** Outer diameter, mm; only used for a slenderness ATTENTION, never a hard fail. */
  outerDiameterMm?: number;
  /** Guided compression spring: suppresses the slenderness attention. */
  guided?: boolean;
  /** User-declared acceptance threshold, N. The venue does not invent this. */
  forceBudgetN?: number;
  /** User-declared travel requirement, mm. */
  requiredTravelMm?: number;
  /** User-declared maximum travel, mm (tension springs have no solid height). */
  maxTravelMm?: number;
  /** Display-band half-width on k, percent. 0/absent = point force, no band. */
  stiffnessTolerancePct?: number;
  /** snap-fit: number of elastic lobes (1 = single cantilever). */
  lobeCount?: number;
  /** snap-fit: width of one lobe at its root, mm. */
  lobeWidthMm?: number;
  /** snap-fit: wall thickness of the lobe, mm. */
  lobeThicknessMm?: number;
  /** snap-fit: root-to-bead lever arm, mm. */
  leverArmMm?: number;
  /** snap-fit: radial interference at the bead/undercut, mm. */
  radialInterferenceMm?: number;
  /** snap-fit: Young's modulus, MPa (beam force; strain does not need it). */
  youngModulusMPa?: number;
  /** snap-fit: lead/insertion face angle from the insertion axis, degrees. */
  leadAngleDeg?: number;
  /** snap-fit: coefficient of friction on the lead face. */
  frictionCoeff?: number;
  /** snap-fit: same wedge model for the retention face; default = leadAngleDeg. */
  retentionAngleDeg?: number;
  /** snap-fit: user-declared allowable root strain, percent. */
  maxStrainPct?: number;
  /** snap-fit: user-declared required retention load, N. */
  retentionLoadN?: number;
  /** Where k / E came from; reported, not judged. */
  source?: ElasticSource;
}

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
  params?: Record<string, number>;  // legacy numeric bag: spring freeLength/stiffness; flow inlet/outlet
  /** General elastic-behaviour declaration; takes precedence over `params`. */
  elastic?: ElasticInterfaceSpec;
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
  /**
   * Appearance ownership (schema 2026-10-30). `purchased` and `reference` parts are
   * never judged: you cannot change a bought screw, and vendor geometry kept for
   * fit checking must still occlude. Omitted -> source=stock means purchased,
   * anything else means printed (the checker reports `roleAssumed`).
   */
  role?: 'printed' | 'purchased' | 'reference';
  /**
   * Functional group (功能区). A PARTITION OF PARTS, not a spatial region: at most
   * one group per part, and a small part may have none. A group's envelope is the
   * union of its members' bboxes; budgets attach to groups (assembly/budget.json),
   * never to parts — a per-part budget is what makes a design rigid.
   */
  group?: string;
  material?: string;
  /**
   * Manufacturing process for this part, or the default for an assembly's children.
   * `source: user` is a settled decision; `source: agent` is a recommendation that
   * still needs user confirmation. The delivery plan treats an unconfirmed agent
   * recommendation as unobserved — it never becomes the process behind a verdict.
   */
  process?: {
    id: string;
    source: 'user' | 'policy' | 'agent';
    rationale?: string;
    confirmedBy?: string;
    confirmedAt?: string;
  };
  qty?: number;
  stockRef?: string;                // source=stock: identification of the physical part
  transform?: PartTransform;        // placement in the parent frame (v1: parts only)
  datums?: ManifestDatumDecl[];     // documentation index; truth lives in datums.json
  children?: ManifestNode[];
  interfaces?: ManifestInterface[];
}

export interface ManufacturingPolicy {
  /** User-approved set of available/acceptable processes. */
  allowed: { id: string; note?: string; minQty?: number }[];
  /** Who approved the set (a name or a document like PROMPT.md). */
  approvedBy?: string;
  approvedAt?: string;
  /** Who approved the per-part assignment summary (the M:mix row). */
  mixApprovedBy?: string;
  mixApprovedAt?: string;
  /** Preferred order; advisory. */
  preference?: string[];
  /** Default true: the agent may assign a part's process from `allowed`. */
  delegate?: boolean;
}

export interface AssemblyManifest {
  schemaVersion: 1;
  name: string;
  unit: 'mm';
  up: 'z';
  root: ManifestNode;
  /** Project-level manufacturing policy (one user decision, N delegated parts). */
  manufacturing?: ManufacturingPolicy;
  /**
   * Content hash of the file this document was parsed from (8 hex chars).
   *
   * An ICD needs a revision identity: "which contract did this check audit?"
   * used to be answerable only as "the file at that path at that time", so two
   * edits at the same path were indistinguishable and a re-check silently
   * replaced the old verdict. Not part of the schema — it is attached by the
   * loader from the exact bytes it parsed.
   */
  manifestHash?: string;
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
  let raw: unknown;
  let text: string;
  try {
    text = await readFile(path, 'utf8');
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `assembly manifest is not readable JSON: ${(e as Error).message}\n` +
        `  file: ${path}\n${manifestShapeHelp()}`,
    );
  }
  const issues = validateManifest(raw);
  if (issues.length > 0) {
    throw new Error(`${formatManifestIssues(issues)}\n  file: ${path}\n${manifestShapeHelp()}`);
  }
  const manifest = raw as AssemblyManifest;
  // Hash the bytes we actually parsed (not a re-read): "which revision" must not
  // be a race with whoever edits the file next.
  manifest.manifestHash = createHash('sha256').update(text).digest('hex').slice(0, 8);
  return manifest;
}

export async function saveAssemblyManifest(path: string, manifest: AssemblyManifest): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(manifest, null, 2));
}

// ---------- validation ----------
//
// WHY THIS RETURNS ISSUES, NOT A STRING. The old validator returned prose like
// "root must be an assembly node". That sentence is true and useless: it does
// not say which field carries the discriminator, what value is legal, or what a
// legal document looks like. A real run spent 16 probe runs and ~10 rounds
// guessing `type` vs `kind`, where `interfaces` lives, and the endpoint
// separator — every guess rejected by a different sentence. The tool KNOWS the
// contract (it is the thing validating it), so the contract has to come back
// with the rejection: a path, the expected shape, what was found, and a hint
// for the mistakes we have actually seen. The published contract is
// schemas/assembly-manifest.schema.json; the minimal example below is the
// short form, because a skill cannot carry the whole schema and an error
// message must not require one.

/** One structural problem, addressed by its JSON-pointer-like path. */
export interface ManifestIssue {
  /** e.g. "/root/kind", "/root/children/2/version", "/root/interfaces/0/a" */
  path: string;
  expected: string;
  got: string;
  hint?: string;
}

type Json = Record<string, unknown>;

/** The shortest document that passes validateManifest — carried in every error. */
export const MANIFEST_EXAMPLE = {
  schemaVersion: 1,
  name: 'example',
  unit: 'mm',
  up: 'z',
  root: {
    id: 'machine',
    kind: 'assembly',
    children: [
      { id: 'base', name: '底座', kind: 'part', version: 'v001' },
      {
        id: 'beam', name: '横梁', kind: 'part', version: 'v002',
        transform: { translate: [0, 0, 50] },
      },
    ],
    interfaces: [
      { id: 'I1', a: 'base.V轴', b: 'beam.刀口', type: '转动副', severity: 'hard', check: 'coaxial' },
    ],
  },
};

const OPERATORS = ['distance', 'diameter-match', 'coaxial', 'motion-clearance', 'spring-preload', 'spring-behaviour', 'snap-fit'];
const IFACE_TYPES = ['贴合', '间隙', '紧固', '转动副', '滑动副', '弹簧', '卡扣', '流道'];
const NODE_KINDS = ['assembly', 'part'];
const DATUM_KINDS = ['point', 'axis', 'plane', 'cylinder'];

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const got = (v: unknown): string => {
  if (v === undefined) return 'undefined (missing)';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v);
  return Array.isArray(v) ? `array(${v.length})` : `object(${Object.keys(v as Json).join(',') || 'empty'})`;
};

/** Locate the published schema from either src/host/ or the bundled lib/. */
export function manifestSchemaPath(): string | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    for (let dir = here, i = 0; i < 4; i++, dir = dirname(dir)) {
      const candidate = join(dir, 'schemas', 'assembly-manifest.schema.json');
      if (existsSync(candidate)) return candidate;
      if (dir === dirname(dir)) break;
    }
  } catch { /* not a file URL (some test runners) — the example still carries the shape */ }
  return null;
}

/** The short form of the contract, appended to every validation error. */
export function manifestShapeHelp(): string {
  const schema = manifestSchemaPath();
  return [
    'minimal valid manifest:',
    JSON.stringify(MANIFEST_EXAMPLE, null, 2),
    'endpoint syntax: "<direct child id>.<datum name>"  e.g. "base.V轴"  (a dot, NOT ":" or "/")',
    'node discriminator: `kind` ("assembly" | "part"), NOT `type`',
    'interfaces live on the node whose DIRECT children they connect: root.interfaces',
    schema ? `full schema: ${schema}` : 'full schema: schemas/assembly-manifest.schema.json',
  ].join('\n');
}

/** Render issues as a numbered, path-addressed error body. */
export function formatManifestIssues(issues: readonly ManifestIssue[]): string {
  const lines = [`invalid assembly manifest — ${issues.length} problem(s):`];
  issues.forEach((p, i) => {
    lines.push(`  ${i + 1}. ${p.path || '/'}: expected ${p.expected}, got ${p.got}`);
    if (p.hint) lines.push(`     hint: ${p.hint}`);
  });
  return lines.join('\n');
}

function checkTransform(t: unknown, ptr: string, issues: ManifestIssue[]): void {
  if (t === undefined) return;
  if (!isObj(t)) {
    issues.push({ path: ptr, expected: 'an object {translate?, rotate?, pose?}', got: got(t) });
    return;
  }
  for (const key of ['translate', 'rotate'] as const) {
    const v = t[key];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.length !== 3 || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      issues.push({ path: `${ptr}/${key}`, expected: 'an array of 3 finite numbers (mm / degrees)', got: got(v) });
    }
  }
  const pose = t.pose;
  if (pose !== undefined) {
    if (!isObj(pose)) {
      issues.push({ path: `${ptr}/pose`, expected: 'an object {datum?, axis?, angleDeg}', got: got(pose) });
    } else if (typeof pose.angleDeg !== 'number' || !Number.isFinite(pose.angleDeg)) {
      issues.push({ path: `${ptr}/pose/angleDeg`, expected: 'a finite number of degrees', got: got(pose.angleDeg) });
    }
  }
}

const ELASTIC_BEHAVIORS = ['axial-spring', 'torsion-spring', 'flexure-beam', 'snap-fit', 'pad'] as const;
const ELASTIC_DIRECTIONS = ['compression', 'tension'] as const;
const ELASTIC_SOURCES = ['catalog', 'measured', 'estimated', 'declared'] as const;
const ELASTIC_KEYS = new Set([
  'behavior', 'direction', 'freeLengthMm', 'stiffnessNPerMm', 'solidHeightMm', 'outerDiameterMm',
  'guided', 'forceBudgetN', 'requiredTravelMm', 'maxTravelMm', 'stiffnessTolerancePct', 'source',
  'lobeCount', 'lobeWidthMm', 'lobeThicknessMm', 'leverArmMm', 'radialInterferenceMm', 'youngModulusMPa',
  'leadAngleDeg', 'frictionCoeff', 'retentionAngleDeg', 'maxStrainPct', 'retentionLoadN', 'standardId',
]);

function checkElastic(value: unknown, ptr: string, issues: ManifestIssue[]): void {
  if (value === undefined) return;
  if (!isObj(value)) {
    issues.push({ path: ptr, expected: 'an object with elastic fields (behavior, freeLengthMm, stiffnessNPerMm, ...)', got: got(value) });
    return;
  }
  for (const key of Object.keys(value)) {
    if (!ELASTIC_KEYS.has(key)) {
      issues.push({ path: `${ptr}/${key}`, expected: `one of ${[...ELASTIC_KEYS].join(', ')}`, got: got(value[key]), hint: 'unknown elastic keys are rejected so a typo cannot silently disable a check' });
    }
  }
  const enumField = (key: string, allowed: readonly string[]) => {
    const v = value[key];
    if (v !== undefined && !allowed.includes(v as string)) {
      issues.push({ path: `${ptr}/${key}`, expected: `one of ${allowed.join(' | ')}`, got: got(v) });
    }
  };
  enumField('behavior', ELASTIC_BEHAVIORS);
  enumField('direction', ELASTIC_DIRECTIONS);
  enumField('source', ELASTIC_SOURCES);
  if (value.standardId !== undefined) {
    if (typeof value.standardId !== 'string' || !value.standardId) {
      issues.push({ path: `${ptr}/standardId`, expected: 'a non-empty catalog id', got: got(value.standardId) });
    } else if (!STANDARD_SPRINGS[value.standardId]) {
      issues.push({
        path: `${ptr}/standardId`,
        expected: `one of ${STANDARD_SPRING_IDS.join(', ')}`,
        got: got(value.standardId),
        hint: 'the seed catalog is deliberately small; add a catalog entry or declare the spring fields explicitly',
      });
    } else if (value.behavior === 'snap-fit') {
      issues.push({ path: `${ptr}/standardId`, expected: 'not used with behavior "snap-fit"', got: got(value.standardId) });
    }
  }
  if (value.guided !== undefined && typeof value.guided !== 'boolean') {
    issues.push({ path: `${ptr}/guided`, expected: 'a boolean', got: got(value.guided) });
  }
  const positive = (key: string) => {
    const v = value[key];
    if (v === undefined) return;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      issues.push({ path: `${ptr}/${key}`, expected: 'a positive finite number', got: got(v) });
    }
  };
  for (const key of ['freeLengthMm', 'stiffnessNPerMm', 'solidHeightMm', 'outerDiameterMm', 'forceBudgetN', 'requiredTravelMm', 'maxTravelMm', 'lobeWidthMm', 'lobeThicknessMm', 'leverArmMm', 'radialInterferenceMm', 'youngModulusMPa', 'maxStrainPct', 'retentionLoadN']) {
    positive(key);
  }
  const tol = value.stiffnessTolerancePct;
  if (tol !== undefined && (typeof tol !== 'number' || !Number.isFinite(tol) || tol < 0 || tol > 100)) {
    issues.push({ path: `${ptr}/stiffnessTolerancePct`, expected: 'a finite number in [0, 100]', got: got(tol) });
  }
  if (value.lobeCount !== undefined && (!Number.isInteger(value.lobeCount) || (value.lobeCount as number) < 1)) {
    issues.push({ path: `${ptr}/lobeCount`, expected: 'a positive integer', got: got(value.lobeCount) });
  }
  for (const key of ['leadAngleDeg', 'retentionAngleDeg']) {
    const v = value[key];
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v >= 90)) {
      issues.push({ path: `${ptr}/${key}`, expected: 'a finite number in [0, 90)', got: got(v) });
    }
  }
  if (value.frictionCoeff !== undefined && (typeof value.frictionCoeff !== 'number' || !Number.isFinite(value.frictionCoeff) || value.frictionCoeff < 0)) {
    issues.push({ path: `${ptr}/frictionCoeff`, expected: 'a non-negative finite number', got: got(value.frictionCoeff) });
  }
  // A declared snap-fit needs the beam geometry; missing inputs would otherwise
  // silently become a skip (`unknown`) in the operator. The operator still
  // reports missing inputs for legacy manifests that never declared a behavior.
  if (value.behavior === 'snap-fit') {
    for (const key of ['lobeCount', 'lobeWidthMm', 'lobeThicknessMm', 'leverArmMm', 'radialInterferenceMm', 'youngModulusMPa']) {
      if (value[key] === undefined) {
        issues.push({ path: `${ptr}/${key}`, expected: `required when behavior is "snap-fit"`, got: 'undefined (missing)' });
      }
    }
  }
  if (typeof value.freeLengthMm === 'number' && typeof value.solidHeightMm === 'number'
    && value.solidHeightMm >= value.freeLengthMm) {
    issues.push({
      path: `${ptr}/solidHeightMm`, expected: '< freeLengthMm', got: got(value.solidHeightMm),
      hint: 'a spring longer at solid height than free is not a spring; fix the numbers or drop solidHeightMm',
    });
  }
  if (typeof value.requiredTravelMm === 'number' && typeof value.maxTravelMm === 'number'
    && value.requiredTravelMm > value.maxTravelMm) {
    issues.push({
      path: `${ptr}/requiredTravelMm`, expected: '<= maxTravelMm', got: got(value.requiredTravelMm),
      hint: 'the declared requirement exceeds the declared travel; one of them is wrong',
    });
  }
}

function checkInterfaces(node: Json, childIds: Map<string, Set<string>>, nodePtr: string, issues: ManifestIssue[]): void {
  const list = node.interfaces;
  if (list === undefined) return;
  if (!Array.isArray(list)) {
    issues.push({ path: `${nodePtr}/interfaces`, expected: 'an array of interface objects', got: got(list) });
    return;
  }
  const ids = new Set<string>();
  const allChildIds = new Set([...childIds.values()].flatMap((set) => [...set]));
  list.forEach((iface: unknown, i: number) => {
    const ptr = `${nodePtr}/interfaces/${i}`;
    if (!isObj(iface)) {
      issues.push({ path: ptr, expected: 'an interface object {id, a, b, type, severity}', got: got(iface) });
      return;
    }
    if (typeof iface.id !== 'string' || !iface.id) {
      issues.push({ path: `${ptr}/id`, expected: 'a unique string, e.g. "I1"', got: got(iface.id) });
    } else if (ids.has(iface.id)) {
      issues.push({ path: `${ptr}/id`, expected: 'a unique id within this node', got: got(iface.id) });
    } else ids.add(iface.id);
    for (const end of ['a', 'b'] as const) {
      const value = iface[end];
      const p = `${ptr}/${end}`;
      if (typeof value !== 'string' || !value) {
        issues.push({ path: p, expected: '"<direct child id>.<datum name>", e.g. "base.V轴"', got: got(value) });
        continue;
      }
      if (!value.includes('.')) {
        const hint = value.includes(':')
          ? `use a dot, not ":": "${value.replace(':', '.')}"`
          : value.includes('/')
            ? `use a dot, not "/": "${value.replace('/', '.')}"`
            : 'the separator is "." — child id, then the datum name that version declares';
        issues.push({ path: p, expected: '"<direct child id>.<datum name>", e.g. "base.V轴"', got: got(value), hint });
        continue;
      }
      const childId = value.slice(0, value.indexOf('.'));
      if (!allChildIds.has(childId)) {
        const isSelf = childId === node.id;
        issues.push({
          path: p,
          expected: `a direct child of "${node.id}" (children: ${[...allChildIds].join(', ') || 'none'})`,
          got: got(value),
          hint: isSelf
            ? 'endpoints are relative to the owning node; name the child, not the owner'
            : 'the part before the dot must be a DIRECT child id of this node',
        });
      }
    }
    // `type` is the FIT kind and drives the default operator. Many authors write
    // the operator here instead ("coaxial"); that is tolerated when `check` says
    // the same thing explicitly, because the checker never needs `type` then.
    // Without `check`, `type` must be a fit kind or there is no operator to run.
    if (iface.type === undefined) {
      if (iface.check === undefined) {
        issues.push({ path: `${ptr}/type`, expected: `one of ${IFACE_TYPES.join(' | ')} (or set \`check\`)`, got: 'undefined (missing)' });
      }
    } else if (!IFACE_TYPES.includes(iface.type as string)
      && !(iface.check !== undefined && OPERATORS.includes(iface.check as string))) {
      issues.push({
        path: `${ptr}/type`,
        expected: `one of ${IFACE_TYPES.join(' | ')} (or set \`check\` to an operator)`,
        got: got(iface.type),
        hint: '`type` is the fit kind; the evaluated operator is `check`',
      });
    }
    if (iface.severity === undefined) {
      issues.push({ path: `${ptr}/severity`, expected: '"hard" (engine error) or "intent" (human flag)', got: 'undefined (missing)' });
    } else if (iface.severity !== 'hard' && iface.severity !== 'intent') {
      issues.push({ path: `${ptr}/severity`, expected: '"hard" or "intent"', got: got(iface.severity) });
    }
    // An unknown operator is NOT a structural error: the checker answers it as
    // `skipped` with the operator named ("L0 check \"teleport\" is unknown"), which
    // is the useful outcome and the one the parity fixture exercises. Only the
    // shape is validated here.
    if (iface.check !== undefined && typeof iface.check !== 'string') {
      issues.push({ path: `${ptr}/check`, expected: `a string operator, normally one of ${OPERATORS.join(' | ')}`, got: got(iface.check) });
    }
    const nominal = iface.nominal;
    if (nominal !== undefined && !isObj(nominal)) {
      issues.push({ path: `${ptr}/nominal`, expected: 'an object {quantity, value}', got: got(nominal) });
    }
    const tolerance = iface.tolerance;
    if (tolerance !== undefined) {
      if (!isObj(tolerance) || typeof tolerance.min !== 'number' || typeof tolerance.max !== 'number') {
        issues.push({ path: `${ptr}/tolerance`, expected: 'an object {min: number, max: number}', got: got(tolerance) });
      }
    }
    checkElastic(iface.elastic, `${ptr}/elastic`, issues);
  });
}

function checkNode(node: unknown, ptr: string, isRoot: boolean, ids: Set<string>, issues: ManifestIssue[]): void {
  if (!isObj(node)) {
    issues.push({ path: ptr, expected: 'an assembly node object', got: got(node) });
    return;
  }
  if (typeof node.id !== 'string' || !node.id) {
    issues.push({ path: `${ptr}/id`, expected: 'a stable non-empty node id, e.g. "base"', got: got(node.id) });
  } else if (ids.has(node.id)) {
    issues.push({ path: `${ptr}/id`, expected: 'a node id unique across the whole tree', got: got(node.id) });
  } else ids.add(node.id);

  if (node.kind === undefined) {
    const hint = node.type !== undefined
      ? 'the discriminator is `kind`, not `type`: {"kind": "assembly" | "part"}'
      : 'every node needs kind: "assembly" (has children) or "part" (has version)';
    issues.push({
      path: `${ptr}/kind`,
      expected: isRoot ? '"assembly" (the root)' : '"assembly" | "part"',
      got: 'undefined (missing)',
      hint,
    });
  } else if (isRoot && node.kind !== 'assembly') {
    issues.push({
      path: `${ptr}/kind`,
      expected: '"assembly" (the root is the assembly, not a part)',
      got: got(node.kind),
      hint: 'put the parts under root.children and the contracts under root.interfaces',
    });
  } else if (!NODE_KINDS.includes(node.kind as string)) {
    issues.push({ path: `${ptr}/kind`, expected: '"assembly" | "part"', got: got(node.kind) });
  }

  if (!isRoot && node.kind === 'part') {
    if (node.version !== undefined && typeof node.version !== 'string') {
      issues.push({ path: `${ptr}/version`, expected: 'a version id like "v001"', got: got(node.version) });
    } else if (node.version === undefined && node.source !== 'stock') {
      issues.push({
        path: `${ptr}/version`,
        expected: 'a version id like "v001" (or source:"stock" for a purchased part with no geometry)',
        got: 'undefined (missing)',
      });
    }
  }

  if (node.children !== undefined && !Array.isArray(node.children)) {
    issues.push({ path: `${ptr}/children`, expected: 'an array of child nodes', got: got(node.children) });
    return;
  }
  if (node.kind === 'assembly' && !Array.isArray(node.children)) {
    issues.push({ path: `${ptr}/children`, expected: 'an array of child nodes (may be empty)', got: 'undefined (missing)' });
  }

  checkTransform(node.transform, `${ptr}/transform`, issues);

  if (node.datums !== undefined) {
    if (!Array.isArray(node.datums)) {
      issues.push({ path: `${ptr}/datums`, expected: 'an array of {name, kind} declarations', got: got(node.datums) });
    } else {
      node.datums.forEach((d: unknown, i: number) => {
        if (!isObj(d) || typeof d.name !== 'string' || !DATUM_KINDS.includes(d.kind as string)) {
          issues.push({ path: `${ptr}/datums/${i}`, expected: `{name: string, kind: ${DATUM_KINDS.join(' | ')}}`, got: got(d) });
        }
      });
    }
  }

  const childIds = new Map<string, Set<string>>();
  if (Array.isArray(node.children)) {
    const direct = new Set<string>();
    for (const child of node.children) {
      if (isObj(child) && typeof child.id === 'string' && child.id) direct.add(child.id);
    }
    childIds.set(ptr, direct);
  }
  checkInterfaces(node, childIds, ptr, issues);

  if (Array.isArray(node.children)) {
    node.children.forEach((child: unknown, i: number) => checkNode(child, `${ptr}/children/${i}`, false, ids, issues));
  }
}

/**
 * Structural checks only — no geometry. Returns path-addressed issues;
 * an empty list means the manifest is well-formed.
 */
export function validateManifest(m: unknown): ManifestIssue[] {
  const issues: ManifestIssue[] = [];
  if (!isObj(m)) {
    issues.push({ path: '/', expected: 'a manifest object', got: got(m) });
    return issues;
  }
  if (m.schemaVersion !== 1) {
    issues.push({ path: '/schemaVersion', expected: '1', got: got(m.schemaVersion) });
  }
  if (m.root === undefined) {
    issues.push({
      path: '/root',
      expected: 'the root node: {id, kind: "assembly", children: [...]}',
      got: 'undefined (missing)',
    });
    return issues;
  }
  if (!isObj(m.root)) {
    issues.push({ path: '/root', expected: 'an assembly node object', got: got(m.root) });
    return issues;
  }
  checkNode(m.root, '/root', true, new Set(), issues);
  return issues;
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
