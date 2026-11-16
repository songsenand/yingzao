// cad_session: generated from tools that declare surface.id = cad_session.
import { buildSurfaceFromToolMeta, type LegacyTool } from './surface.ts';

export const SESSION_SURFACE_NAME = 'cad_session';
export const SESSION_SURFACE_DESCRIPTION =
  'Project selection/binding and the human review queue. action="catalog" lists the four ops.';

export function buildCadSessionSurface(tools: ReadonlyMap<string, LegacyTool>) {
  return buildSurfaceFromToolMeta(SESSION_SURFACE_NAME, SESSION_SURFACE_DESCRIPTION, tools);
}
