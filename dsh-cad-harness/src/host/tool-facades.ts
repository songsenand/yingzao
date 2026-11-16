// The 9 model-facing job facades (proposal: docs/dev/TOOL-SURFACE-PLAN.md).
//
// Phase 0 of the tool-surface compression is deliberately data-only: this table
// names the CURRENT tools each future facade will own. It registers nothing and
// changes no behaviour. `scripts/audit-tool-surface.mjs` fails if a registered
// tool is missing from the table, if a table member is not registered, or if a
// name is claimed twice.
//
// The table is the migration ledger. When Phase 1 starts, a facade implementation
// is added next to its row; the old tool names stay listed here until the cutover
// so coverage remains auditable.

export const CAD_FACADE_IDS = [
  'session',
  'part',
  'assembly',
  'check',
  'simulate',
  'inspect',
  'see',
  'python',
  'deliver',
] as const;

export type CadFacadeId = (typeof CAD_FACADE_IDS)[number];

export interface CadFacadeSpec {
  /** Stable facade id; also the future tool suffix: cad_<id>. */
  readonly id: CadFacadeId;
  /** One-line human description; not model-facing copy. */
  readonly title: string;
  /** Current top-level tool names this facade will absorb. */
  readonly members: readonly string[];
  /** True when the facade owns a delivery gate; gates stay top-level. */
  readonly gate?: boolean;
}

export const CAD_FACADES: Record<CadFacadeId, CadFacadeSpec> = {
  session: {
    id: 'session',
    title: 'Project selection, session binding and the human review queue',
    members: ['project_info', 'init_project', 'bind_project', 'request_review'],
  },
  part: {
    id: 'part',
    title: 'Create, generate, import, merge, role and appearance',
    members: [
      'create_part',
      'generate_part',
      'import_part',
      'merge_parts',
      'set_part_role',
      'attach_appearance',
    ],
  },
  assembly: {
    id: 'assembly',
    title: 'Datums, assembly contract, static and assembly validation',
    members: ['set_datums', 'write_assembly', 'validate_assembly', 'check_assembly'],
  },
  check: {
    id: 'check',
    title: 'Manufacturing and process screens',
    members: [
      'check_sheet2d',
      'check_turning',
      'check_cnc_access',
      'check_edm_access',
      'check_printability',
      'check_parts',
      'check_appearance',
    ],
  },
  simulate: {
    id: 'simulate',
    title: 'Rigid body, mechanism, fluid, LBM and stress simulations',
    members: ['simulate_physics', 'simulate_motion', 'simulate_fluid', 'simulate_lbm', 'simulate_stress'],
  },
  inspect: {
    id: 'inspect',
    title: 'Measurements, features, attention map and analysis',
    members: ['measure', 'list_features', 'scan_attention', 'analyze'],
  },
  see: {
    id: 'see',
    title: 'Render, visual review and reference-image recall',
    members: ['render_part', 'review_visual', 'recall_reference_image'],
  },
  python: {
    id: 'python',
    title: 'The pinned Python runtime and run_python',
    members: ['run_python', 'python_runtime'],
  },
  deliver: {
    id: 'deliver',
    title: 'Delivery audit, preflight, delivery plan and the legacy pearl gate',
    members: ['delivery_audit', 'preflight', 'deliver', 'pearl_run'],
    gate: true,
  },
};

/** Flat list of every name the nine facades will absorb. */
export const CAD_FACADE_MEMBERS: readonly string[] = CAD_FACADE_IDS.flatMap(
  (id) => CAD_FACADES[id].members,
);

const MEMBER_TO_FACADE = new Map<string, CadFacadeId>();
for (const id of CAD_FACADE_IDS) {
  for (const name of CAD_FACADES[id].members) MEMBER_TO_FACADE.set(name, id);
}

/** The facade that will own a current tool, or null when the table is stale. */
export function facadeForTool(name: string): CadFacadeId | null {
  return MEMBER_TO_FACADE.get(name) ?? null;
}

/** Current tool names owned by one facade. */
export function toolsInFacade(id: CadFacadeId): readonly string[] {
  return CAD_FACADES[id].members;
}

export interface FacadeCoverage {
  /** Registered tools the table does not mention. */
  missing: string[];
  /** Table members that are not registered right now. */
  absent: string[];
  /** Names claimed by more than one facade (should never happen). */
  duplicates: string[];
}

/**
 * Compare the registered catalogue with the frozen facade table.
 *
 * This is the Phase-0 invariant: the migration ledger cannot drift silently.
 */
export function facadeCoverage(registered: readonly string[]): FacadeCoverage {
  const registeredSet = new Set(registered);
  const seen = new Map<string, number>();
  for (const name of CAD_FACADE_MEMBERS) seen.set(name, (seen.get(name) ?? 0) + 1);

  const missing = registered.filter((name) => !MEMBER_TO_FACADE.has(name));
  const absent = CAD_FACADE_MEMBERS.filter((name) => !registeredSet.has(name));
  const duplicates = [...seen.entries()].filter(([, count]) => count > 1).map(([name]) => name);
  return { missing, absent, duplicates };
}
