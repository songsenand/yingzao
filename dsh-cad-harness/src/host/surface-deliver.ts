// cad_deliver: generated from tools that declare surface.id = cad_deliver.
import { buildSurfaceFromToolMeta, type LegacyTool } from './surface.ts';

export const DELIVER_SURFACE_NAME = 'cad_deliver';
export const DELIVER_SURFACE_DESCRIPTION =
  'Delivery plan, audit and gate. action="catalog" lists the {n} ops; this surface owns the delivery gate.';

export function buildCadDeliverSurface(tools: ReadonlyMap<string, LegacyTool>) {
  return buildSurfaceFromToolMeta(DELIVER_SURFACE_NAME, DELIVER_SURFACE_DESCRIPTION, tools, { gate: true });
}
