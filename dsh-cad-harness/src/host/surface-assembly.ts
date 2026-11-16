// cad_assembly: BOM/ICD contract and assembly checks.
import { buildSurface, type SurfaceOp, type LegacyTool } from './surface.ts';

export const ASSEMBLY_OPS: readonly SurfaceOp[] = [
  { op: 'datums', tool: 'set_datums', summary: 'Read or declare datum anchors of a version.' },
  { op: 'write', tool: 'write_assembly', summary: 'Write/update the typed BOM/ICD manifest.' },
  { op: 'validate', tool: 'validate_assembly', summary: 'Static watertightness/interference/clearance checks.' },
  { op: 'check', tool: 'check_assembly', summary: 'Check the BOM/ICD interfaces, tolerances and declared mechanisms.' },
];

export function buildCadAssemblySurface(tools: ReadonlyMap<string, LegacyTool>) {
  return buildSurface({
    name: 'cad_assembly',
    description: 'BOM/ICD authoring and assembly checks. action="catalog" lists the four ops; BOM/ICD remains the data spine.',
    ops: ASSEMBLY_OPS,
  }, tools);
}
