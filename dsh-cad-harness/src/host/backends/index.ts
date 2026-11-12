// Kernel registry: one available adapter in 0.1.0-preview. Planned kernels are
// refused with `backend_not_available`, never silently replaced by OpenSCAD.

import { listBackends, type CadBackend } from '../backend.ts';
import { OPENSCAD_ADAPTER } from './openscad.ts';

export function backendAdapter(kernel: string): CadBackend {
  const meta = listBackends().find((b) => b.id === kernel);
  if (!meta) throw new Error(`backend_not_available: unknown kernel "${kernel}" (available: openscad)`);
  if (meta.status !== 'available') throw new Error(`backend_not_available: "${kernel}" is ${meta.status} in this build`);
  if (kernel === 'openscad') return OPENSCAD_ADAPTER;
  throw new Error(`backend_not_available: no adapter for "${kernel}" in this build`);
}
