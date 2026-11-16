// Phase 1 prototype: one job facade (cad_inspect) over four existing tools.
//
// The facade is deliberately NOT registered in this phase. It is built from the
// already-wrapped legacy definitions (so the output contract and origin-session
// stamping still apply), and only the acceptance script/benchmark mounts it.
// Phase 2 decides whether the model-facing registration switches over.
//
// Why a facade: the four tools are one job ("tell me the truth about this
// version") but carry four full schemas (~11 KB). The facade makes the top level
// small; the per-op details are available through catalog/help on demand, and
// the dispatcher still validates by calling the legacy tool, not a reimplementation.

import { defineTool } from '@deepseek-ai/dsh-tools';
import { argError } from './arg-error.ts';

export interface LegacyTool {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: Record<string, unknown>;
  readonly execute?: (args: unknown, exec: unknown) => unknown;
}

export interface InspectOp {
  /** Op name exposed by cad_inspect. */
  readonly op: string;
  /** Legacy tool that owns the implementation. */
  readonly tool: string;
  /** One line for catalog(); not a replacement for the legacy description. */
  readonly summary: string;
}

export const INSPECT_OPS: readonly InspectOp[] = [
  { op: 'measure', tool: 'measure', summary: 'Dimensions, volume, wall thickness, gap, section and angle of one saved version.' },
  { op: 'features', tool: 'list_features', summary: 'Planar faces, holes and their coordinates for one saved version.' },
  { op: 'attention', tool: 'scan_attention', summary: 'Mesh health plus reentrant corners: where to LOOK, never a verdict.' },
  { op: 'analyze', tool: 'analyze', summary: 'Experimental point map: thin walls, corners and optional stress peaks.' },
];

const OPS = new Map(INSPECT_OPS.map((entry) => [entry.op, entry]));

function paramRows(parameters: Record<string, unknown> | undefined) {
  return Object.entries(parameters ?? {}).map(([name, raw]) => {
    const spec = (raw ?? {}) as Record<string, unknown>;
    return {
      name,
      type: typeof spec.type === 'string' ? spec.type : 'json',
      required: spec.required === true,
      description: typeof spec.description === 'string' ? spec.description : '',
    };
  });
}

function editDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + cost,
      );
    }
  }
  return rows[a.length][b.length];
}

function nearestOp(name: string): string | null {
  const words = [...OPS.keys()];
  const lower = name.toLowerCase();
  const exactPrefix = words.find((candidate) => candidate.startsWith(lower));
  if (exactPrefix) return exactPrefix;
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of words) {
    const distance = editDistance(candidate, lower);
    if (distance < bestDistance) { best = candidate; bestDistance = distance; }
  }
  return bestDistance <= 3 ? best : null;
}

function opHelp(entry: InspectOp, tool: LegacyTool) {
  return {
    op: entry.op,
    tool: entry.tool,
    summary: entry.summary,
    description: tool.description ?? '',
    parameters: paramRows(tool.parameters),
  };
}

/**
 * Build the cad_inspect tool over already-registered legacy definitions.
 *
 * @param tools - map of the four legacy definitions, captured at registration.
 * @returns a tool definition ready for a test harness or a later registration.
 */
export function buildCadInspectFacade(tools: ReadonlyMap<string, LegacyTool>) {
  const missing = INSPECT_OPS.filter((entry) => !tools.has(entry.tool)).map((entry) => entry.tool);
  if (missing.length) throw new Error(`cad_inspect: missing legacy tool(s): ${missing.join(', ')}`);

  return defineTool({
    name: 'cad_inspect',
    description:
      'One entry point for geometry truth about a saved version. '
      + 'action="catalog" lists the four ops; action="help" with args.op=<op> gives the legacy parameters; '
      + 'action=measure|features|attention|analyze delegates to the same implementation and output contract as the old tool. '
      + 'This prototype does not replace the old tools yet.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: 'catalog | help | measure | features | attention | analyze',
      },
      args: {
        type: 'json',
        description: 'Op arguments; for help use { op: "measure" }. Same fields as the legacy tool.',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => false,
    timeoutMs: 600_000,
    async execute(rawArgs: unknown, exec: unknown) {
      const args = (rawArgs ?? {}) as { action?: unknown; args?: unknown };
      const action = typeof args.action === 'string' ? args.action : '';
      const inner = args.args && typeof args.args === 'object' && !Array.isArray(args.args)
        ? args.args as Record<string, unknown>
        : undefined;

      if (action === 'catalog') {
        return {
          facade: 'cad_inspect',
          ops: INSPECT_OPS.map((entry) => ({
            op: entry.op,
            summary: entry.summary,
            required: paramRows(tools.get(entry.tool)?.parameters).filter((row) => row.required).map((row) => row.name),
          })),
        } as never;
      }

      if (action === 'help') {
        const wanted = typeof inner?.op === 'string' ? inner.op : '';
        const entry = OPS.get(wanted);
        if (!entry) {
          const suggestion = nearestOp(wanted);
          throw argError(
            'cad_inspect',
            'args.op',
            `unknown op "${wanted}"`,
            `one of ${[...OPS.keys()].join(' | ')}`,
            {
              received: wanted || undefined,
              example: `cad_inspect({ action: "help", args: { op: "measure" } })`,
            },
          );
        }
        return opHelp(entry, tools.get(entry.tool) as LegacyTool) as never;
      }

      const entry = OPS.get(action);
      if (!entry) {
        const suggestion = nearestOp(action);
        throw argError(
          'cad_inspect',
          'action',
          `unknown action "${action}"${suggestion ? `; did you mean "${suggestion}"?` : ''}`,
          'catalog | help | measure | features | attention | analyze',
          { received: action, example: 'cad_inspect({ action: "catalog" })' },
        );
      }

      const tool = tools.get(entry.tool);
      if (typeof tool?.execute !== 'function') {
        throw new Error(`cad_inspect: legacy tool "${entry.tool}" has no execute()`);
      }
      return tool.execute(inner ?? {}, exec) as never;
    },
  });
}
