// cad_see: render, visual review and reference-image recall.
import { buildSurface, type SurfaceOp, type LegacyTool } from './surface.ts';

export const SEE_OPS: readonly SurfaceOp[] = [
  { op: 'render', tool: 'render_part', summary: 'One image of a saved version with explicit camera control.' },
  { op: 'review', tool: 'review_visual', summary: 'Mandatory visual review before delivering a printed part.' },
  { op: 'reference', tool: 'recall_reference_image', summary: 'Re-attach an earlier user reference image.' },
];

export function buildCadSeeSurface(tools: ReadonlyMap<string, LegacyTool>) {
  return buildSurface({
    name: 'cad_see',
    description: 'Rendering, visual review and reference images. action="catalog" lists the three ops.',
    ops: SEE_OPS,
  }, tools);
}
