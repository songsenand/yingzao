// cad_python: generated from tools that declare surface.id = cad_python.
import { buildSurfaceFromToolMeta, type LegacyTool } from './surface.ts';

export const PYTHON_SURFACE_NAME = 'cad_python';
export const PYTHON_SURFACE_DESCRIPTION =
  'The pinned Python runtime. action="catalog" lists the {n} ops. The pre-cutover per-op '
  + 'names are not callable; use this tool with action="run" or action="runtime".';

export function buildCadPythonSurface(tools: ReadonlyMap<string, LegacyTool>) {
  return buildSurfaceFromToolMeta(PYTHON_SURFACE_NAME, PYTHON_SURFACE_DESCRIPTION, tools);
}
