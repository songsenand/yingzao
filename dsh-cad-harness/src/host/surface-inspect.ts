// cad_inspect: generated from the four tools that declare surface.id = cad_inspect.
// No hand-written op table lives here.

import { buildSurfaceFromToolMeta, type LegacyTool } from './surface.ts';

export const INSPECT_SURFACE_NAME = 'cad_inspect';
export const INSPECT_SURFACE_DESCRIPTION =
  'One entry point for geometry truth about a saved version. '
  + 'action="catalog" lists the four ops; action="help" with args.op=<op> gives the legacy parameters; '
  + 'an op delegates to the same implementation and output contract as the old tool.';

export function buildCadInspectSurface(tools: ReadonlyMap<string, LegacyTool>) {
  return buildSurfaceFromToolMeta(
    INSPECT_SURFACE_NAME,
    INSPECT_SURFACE_DESCRIPTION,
    tools,
  );
}
