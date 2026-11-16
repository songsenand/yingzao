// cad_deliver: delivery plan/audit/preflight. This is the top-level gate.
import { buildSurface, type SurfaceOp, type LegacyTool } from './surface.ts';

export const DELIVER_OPS: readonly SurfaceOp[] = [
  { op: 'plan', tool: 'deliver', summary: 'Read-only plan derived from BOM/ICD, claims and the run graph.' },
  { op: 'preflight', tool: 'preflight', summary: 'Run the mandatory delivery sequence in one call.' },
  { op: 'audit', tool: 'delivery_audit', summary: 'Audit the corpus for stale/failing/unsupported claims.' },
  { op: 'pearl', tool: 'pearl_run', summary: 'Deprecated legacy pearl gate; kept for historical projects.' },
];

export function buildCadDeliverSurface(tools: ReadonlyMap<string, LegacyTool>) {
  return buildSurface({
    name: 'cad_deliver',
    description: 'Delivery plan, audit and gate. action="catalog" lists the four ops; this surface owns the delivery gate.',
    ops: DELIVER_OPS,
    gate: true,
  }, tools);
}
