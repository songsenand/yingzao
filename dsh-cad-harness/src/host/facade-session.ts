// cad_session: project selection, binding and the human review queue.
import { buildFacade, type FacadeOp, type LegacyTool } from './facade.ts';

export const SESSION_OPS: readonly FacadeOp[] = [
  { op: 'info', tool: 'project_info', summary: 'Read which CAD project this session has selected (never a default).' },
  { op: 'init', tool: 'init_project', summary: 'Create a project marker in an explicit directory and optionally select it.' },
  { op: 'bind', tool: 'bind_project', summary: 'Select an existing project by path before any CAD tool.' },
  { op: 'review', tool: 'request_review', summary: 'Queue a human review for a version, run or part; never a popup.' },
];

export function buildCadSessionFacade(tools: ReadonlyMap<string, LegacyTool>) {
  return buildFacade({
    name: 'cad_session',
    description: 'Project selection/binding and the human review queue. action="catalog" lists the four ops.',
    ops: SESSION_OPS,
  }, tools);
}
