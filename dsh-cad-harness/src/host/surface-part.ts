// cad_part: create/generate/import/merge, role and appearance.
import { buildSurface, type SurfaceOp, type LegacyTool } from './surface.ts';

export const PART_OPS: readonly SurfaceOp[] = [
  { op: 'create', tool: 'create_part', summary: 'Name a part before geometry exists; idempotent.' },
  { op: 'generate', tool: 'generate_part', summary: 'Compile SCAD into a new immutable part version, with renders.' },
  { op: 'import', tool: 'import_part', summary: 'Import STL/STEP/3MF as a saved version.' },
  { op: 'merge', tool: 'merge_parts', summary: 'Union parts at their assembly placements into one new solid.' },
  { op: 'role', tool: 'set_part_role', summary: 'Declare printed / stock / research.' },
  { op: 'appearance', tool: 'attach_appearance', summary: 'Attach a self-contained GLB appearance sidecar.' },
];

export function buildCadPartSurface(tools: ReadonlyMap<string, LegacyTool>) {
  return buildSurface({
    name: 'cad_part',
    description: 'Part generation/import/merge and identity. action="catalog" lists the six ops.',
    ops: PART_OPS,
  }, tools);
}
