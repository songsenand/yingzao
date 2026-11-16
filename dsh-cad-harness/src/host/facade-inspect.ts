// cad_inspect: one job entry for geometry truth about a saved version.
// All logic lives in the shared facade builder; this file is only the op table.

import { buildFacade, type FacadeOp, type LegacyTool } from './facade.ts';

export type InspectOp = FacadeOp;

export const INSPECT_OPS: readonly InspectOp[] = [
  { op: 'measure', tool: 'measure', summary: 'Dimensions, volume, wall thickness, gap, section and angle of one saved version.' },
  { op: 'features', tool: 'list_features', summary: 'Planar faces, holes and their coordinates for one saved version.' },
  { op: 'attention', tool: 'scan_attention', summary: 'Mesh health plus reentrant corners: where to LOOK, never a verdict.' },
  { op: 'analyze', tool: 'analyze', summary: 'Experimental point map: thin walls, corners and optional stress peaks.' },
];

export function buildCadInspectFacade(tools: ReadonlyMap<string, LegacyTool>) {
  return buildFacade({
    name: 'cad_inspect',
    description:
      'One entry point for geometry truth about a saved version. '
      + 'action="catalog" lists the four ops; action="help" with args.op=<op> gives the legacy parameters; '
      + 'an op delegates to the same implementation and output contract as the old tool.',
    ops: INSPECT_OPS,
  }, tools);
}
