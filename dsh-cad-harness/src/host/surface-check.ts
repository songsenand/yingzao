// cad_check: generated from tools that declare surface.id = cad_check.
import { buildSurfaceFromToolMeta, type LegacyTool } from './surface.ts';

export const CHECK_SURFACE_NAME = 'cad_check';
export const CHECK_SURFACE_DESCRIPTION =
  'One entry point for process/manufacturing checks. action="catalog" lists the {n} ops; '
  + 'action="help" with args.op=<op> gives the legacy parameters; an op delegates to the old tool.';

export function buildCadCheckSurface(tools: ReadonlyMap<string, LegacyTool>) {
  return buildSurfaceFromToolMeta(CHECK_SURFACE_NAME, CHECK_SURFACE_DESCRIPTION, tools);
}
