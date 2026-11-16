// cad_check: manufacturing/process screens. Thin facade over the seven checks.

import { buildFacade, type FacadeOp, type LegacyTool } from './facade.ts';

export type CheckOp = FacadeOp;

export const CHECK_OPS: readonly CheckOp[] = [
  { op: 'printability', tool: 'check_printability', summary: 'Wall thickness, overhang area and printability findings for a saved version.' },
  { op: 'sheet2d', tool: 'check_sheet2d', summary: '2D sheet cut screen: kerf-adjusted holes and wall spacing.' },
  { op: 'turning', tool: 'check_turning', summary: 'Turning screen: bar stock, L/D limit and rotational symmetry.' },
  { op: 'cnc', tool: 'check_cnc_access', summary: 'CNC 3-axis access: reachable area and minimum principal setups.' },
  { op: 'edm', tool: 'check_edm_access', summary: 'EDM sinker access along one burn axis.' },
  { op: 'parts', tool: 'check_parts', summary: 'Batch mesh/printability screen for up to 12 saved versions.' },
  { op: 'appearance', tool: 'check_appearance', summary: 'Appearance relations across an assembly set.' },
];

export function buildCadCheckFacade(tools: ReadonlyMap<string, LegacyTool>) {
  return buildFacade({
    name: 'cad_check',
    description:
      'One entry point for process/manufacturing checks. action="catalog" lists the ops; '
      + 'action="help" with args.op=<op> gives the legacy parameters; an op delegates to the old tool.',
    ops: CHECK_OPS,
  }, tools);
}
