// cad_see: generated from tools that declare surface.id = cad_see.
import { buildSurfaceFromToolMeta, type LegacyTool } from './surface.ts';

export const SEE_SURFACE_NAME = 'cad_see';
export const SEE_SURFACE_DESCRIPTION =
  'Rendering, visual review and reference images. action="catalog" lists the three ops.';

export function buildCadSeeSurface(tools: ReadonlyMap<string, LegacyTool>) {
  return buildSurfaceFromToolMeta(SEE_SURFACE_NAME, SEE_SURFACE_DESCRIPTION, tools);
}
