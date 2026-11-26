// cad_simulate: generated from tools that declare surface.id = cad_simulate.
import { buildSurfaceFromToolMeta, type LegacyTool } from './surface.ts';

export const SIMULATE_SURFACE_NAME = 'cad_simulate';
export const SIMULATE_SURFACE_DESCRIPTION =
  'One entry point for simulations. action="catalog" lists the {n} ops; '
  + 'action="help" with args.op=<op> gives the legacy parameters; an op delegates to the old tool.';

export function buildCadSimulateSurface(tools: ReadonlyMap<string, LegacyTool>) {
  return buildSurfaceFromToolMeta(SIMULATE_SURFACE_NAME, SIMULATE_SURFACE_DESCRIPTION, tools);
}
