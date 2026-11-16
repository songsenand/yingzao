// cad_see: render, visual review and reference-image recall.
import { buildFacade, type FacadeOp, type LegacyTool } from './facade.ts';

export const SEE_OPS: readonly FacadeOp[] = [
  { op: 'render', tool: 'render_part', summary: 'One image of a saved version with explicit camera control.' },
  { op: 'review', tool: 'review_visual', summary: 'Mandatory visual review before delivering a printed part.' },
  { op: 'reference', tool: 'recall_reference_image', summary: 'Re-attach an earlier user reference image.' },
];

export function buildCadSeeFacade(tools: ReadonlyMap<string, LegacyTool>) {
  return buildFacade({
    name: 'cad_see',
    description: 'Rendering, visual review and reference images. action="catalog" lists the three ops.',
    ops: SEE_OPS,
  }, tools);
}
