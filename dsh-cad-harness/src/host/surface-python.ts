// cad_python: the pinned runtime and arbitrary analysis code.
import { buildSurface, type SurfaceOp, type LegacyTool } from './surface.ts';

export const PYTHON_OPS: readonly SurfaceOp[] = [
  { op: 'run', tool: 'run_python', summary: 'Run Python in the plugin-pinned runtime.' },
  { op: 'runtime', tool: 'python_runtime', summary: 'Status/repair/extension of the bundled Python runtime.' },
];

export function buildCadPythonSurface(tools: ReadonlyMap<string, LegacyTool>) {
  return buildSurface({
    name: 'cad_python',
    description: 'The pinned Python runtime. action="catalog" lists the two ops.',
    ops: PYTHON_OPS,
  }, tools);
}
