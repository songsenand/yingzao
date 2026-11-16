// cad_simulate: scenario simulations. Thin facade over the five simulate_* tools.

import { buildFacade, type FacadeOp, type LegacyTool } from './facade.ts';

export type SimulateOp = FacadeOp;

export const SIMULATE_OPS: readonly SimulateOp[] = [
  { op: 'physics', tool: 'simulate_physics', summary: 'Rigid-body simulation: penetration, toppling, joints and keyframes.' },
  { op: 'motion', tool: 'simulate_motion', summary: 'Mechanism kinematics: crank, oscillators and followers.' },
  { op: 'fluid', tool: 'simulate_fluid', summary: 'MPM flow through a pipe or cavity.' },
  { op: 'lbm', tool: 'simulate_lbm', summary: 'Lattice-Boltzmann channel-flow screen.' },
  { op: 'stress', tool: 'simulate_stress', summary: 'Static linear-elastic stress with a declared load case.' },
];

export function buildCadSimulateFacade(tools: ReadonlyMap<string, LegacyTool>) {
  return buildFacade({
    name: 'cad_simulate',
    description:
      'One entry point for simulations. action="catalog" lists the ops; '
      + 'action="help" with args.op=<op> gives the legacy parameters; an op delegates to the old tool.',
    ops: SIMULATE_OPS,
  }, tools);
}
