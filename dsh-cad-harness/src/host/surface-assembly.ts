// cad_assembly: generated from tools that declare surface.id = cad_assembly.
import { buildSurfaceFromToolMeta, type LegacyTool } from './surface.ts';

export const ASSEMBLY_SURFACE_NAME = 'cad_assembly';
export const ASSEMBLY_SURFACE_DESCRIPTION =
  'BOM/ICD authoring and assembly checks. action="catalog" lists the {n} ops; BOM/ICD remains the data spine.';

export function buildCadAssemblySurface(tools: ReadonlyMap<string, LegacyTool>) {
  return buildSurfaceFromToolMeta(ASSEMBLY_SURFACE_NAME, ASSEMBLY_SURFACE_DESCRIPTION, tools);
}
