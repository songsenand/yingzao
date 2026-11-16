// cad_python: the pinned runtime and arbitrary analysis code.
import { buildFacade, type FacadeOp, type LegacyTool } from './facade.ts';

export const PYTHON_OPS: readonly FacadeOp[] = [
  { op: 'run', tool: 'run_python', summary: 'Run Python in the plugin-pinned runtime.' },
  { op: 'runtime', tool: 'python_runtime', summary: 'Status/repair/extension of the bundled Python runtime.' },
];

export function buildCadPythonFacade(tools: ReadonlyMap<string, LegacyTool>) {
  return buildFacade({
    name: 'cad_python',
    description: 'The pinned Python runtime. action="catalog" lists the two ops.',
    ops: PYTHON_OPS,
  }, tools);
}
