// cad_part: generated from tools that declare surface.id = cad_part.
import { buildSurfaceFromToolMeta, type LegacyTool } from './surface.ts';

export const PART_SURFACE_NAME = 'cad_part';
export const PART_SURFACE_DESCRIPTION =
  'Part generation/import/merge and identity. action="catalog" lists the {n} ops.';

export function buildCadPartSurface(tools: ReadonlyMap<string, LegacyTool>) {
  return buildSurfaceFromToolMeta(PART_SURFACE_NAME, PART_SURFACE_DESCRIPTION, tools);
}
