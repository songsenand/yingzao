// Which CAD tools belong to which job group (DESIGN §25.7).
//
// WHY this lives HERE and not in tool-scope.ts: `accept-tool-scope.mjs` enforces the
// invariant "the scope module bakes in no tool name" — the roster must be derived
// (cadToolNames()), so a renamed or added tool cannot silently go missing. A group
// table HAS to name tools, so it sits next to the registrations instead, where a
// completeness acceptance (`accept-tool-groups.mjs`) fails the moment a registered
// CAD tool is missing from it. That keeps "cannot go stale silently" true.
//
// The groups are DECLARED, never inferred, and a tool may belong to several
// (check_printability is both a gate and a detector).

import type { CadToolGroup } from './tool-scope.ts';

export const CAD_TOOL_GROUPS: Record<CadToolGroup, readonly string[]> = {
  // gates: must run and must pass (only where no load case is needed to decide)
  deliver: ['preflight', 'deliver', 'pearl_run', 'check_assembly', 'check_printability', 'check_sheet2d', 'check_turning', 'check_cnc_access', 'check_edm_access', 'check_parts', 'review_visual', 'delivery_audit'],
  // pointers: where to look next; never gate, never silent
  detect: ['analyze', 'scan_attention', 'check_printability', 'check_sheet2d', 'check_turning', 'check_cnc_access', 'check_edm_access', 'check_appearance', 'review_visual', 'simulate_stress', 'simulate_motion', 'request_review'],
  // scenario-driven: meaningless without a declared case; produces EVIDENCE
  simulate: ['simulate_physics', 'simulate_motion', 'simulate_fluid', 'simulate_lbm', 'simulate_stress'],
  // truth: numbers + coordinates, neither gates nor points
  instrument: [
    'generate_part', 'create_part', 'import_part', 'merge_parts', 'set_datums', 'write_assembly', 'validate_assembly',
    'render_part', 'measure_part', 'measure_gap', 'measure_thickness', 'list_features',
    'measure_section', 'measure_angle', 'check_parts', 'recall_reference_image', 'attach_appearance',
    'set_part_role', 'check_appearance', 'project_info', 'init_project', 'bind_project', 'run_python', 'python_runtime',
  ],
};

/** The tool names a declared group set needs. Empty declaration = null (whole catalog). */
export function toolsInGroups(groups: readonly CadToolGroup[] | undefined | null): readonly string[] | null {
  if (!groups || groups.length === 0) return null;
  const out = new Set<string>();
  for (const g of groups) for (const n of CAD_TOOL_GROUPS[g] ?? []) out.add(n);
  return [...out];
}

/** Registered CAD tools absent from the table — the completeness check's subject. */
export function ungroupedTools(registered: readonly string[]): string[] {
  const known = new Set(Object.values(CAD_TOOL_GROUPS).flat());
  return registered.filter((n) => !known.has(n));
}
