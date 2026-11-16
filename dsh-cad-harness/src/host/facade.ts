// Thin, data-free facade builder for the 9 job entries.
//
// A facade owns no lifecycle, no status and no second report. It only:
//   1. lists its ops (catalog),
//   2. explains one op's legacy parameters (help),
//   3. delegates an op to the already-wrapped legacy tool.
//
// This is intentionally one shared implementation, not nine bespoke modules.

import { defineTool } from '@deepseek-ai/dsh-tools';
import { argError } from './arg-error.ts';

export interface LegacyTool {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: Record<string, unknown>;
  readonly execute?: (args: unknown, exec: unknown) => unknown;
}

export interface FacadeOp {
  /** Action name exposed by the facade. */
  readonly op: string;
  /** Legacy tool that owns the implementation. */
  readonly tool: string;
  /** One line for catalog(); not a replacement for the legacy description. */
  readonly summary: string;
}

export interface FacadeSpec {
  readonly name: string;
  readonly description: string;
  readonly ops: readonly FacadeOp[];
  readonly timeoutMs?: number;
  /** True when this facade owns a delivery gate. */
  readonly gate?: boolean;
}

const RESERVED = new Set(['catalog', 'help']);

/** Convert either the original flat declaration or defineTool's JSON schema. */
export function paramRows(parameters: Record<string, unknown> | undefined) {
  const schema = (parameters ?? {}) as Record<string, unknown>;
  const source = schema.properties && typeof schema.properties === 'object'
    ? schema.properties as Record<string, unknown>
    : schema;
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  return Object.entries(source)
    .filter(([name]) => !['type', 'properties', 'required', 'additionalProperties'].includes(name))
    .map(([name, raw]) => {
      const spec = (raw ?? {}) as Record<string, unknown>;
      return {
        name,
        type: typeof spec.type === 'string' ? spec.type : 'json',
        required: spec.required === true || required.has(name),
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
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
    }
  }
  return rows[a.length][b.length];
}

function nearest(names: readonly string[], name: string): string | null {
  const lower = name.toLowerCase();
  const prefix = names.find((candidate) => candidate.startsWith(lower));
  if (prefix) return prefix;
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of names) {
    const distance = editDistance(candidate, lower);
    if (distance < bestDistance) { best = candidate; bestDistance = distance; }
  }
  return bestDistance <= 3 ? best : null;
}

function missingTools(spec: FacadeSpec, tools: ReadonlyMap<string, LegacyTool>): string[] {
  return spec.ops.filter((entry) => !tools.has(entry.tool)).map((entry) => entry.tool);
}

export function buildFacade(spec: FacadeSpec, tools: ReadonlyMap<string, LegacyTool>) {
  const names = spec.ops.map((entry) => entry.op);
  for (const name of names) {
    if (RESERVED.has(name)) throw new Error(`${spec.name}: op "${name}" is reserved for catalog/help`);
  }
  if (new Set(names).size !== names.length) throw new Error(`${spec.name}: duplicate op name`);
  const missing = missingTools(spec, tools);
  if (missing.length) throw new Error(`${spec.name}: missing legacy tool(s): ${missing.join(', ')}`);

  const byOp = new Map(spec.ops.map((entry) => [entry.op, entry]));

  return defineTool({
    name: spec.name,
    description: spec.description,
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: `catalog | help | ${names.join(' | ')}`,
      },
      args: {
        type: 'json',
        description: 'Op arguments; for help use { op: "<op>" }. Same fields as the legacy tool.',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => false,
    timeoutMs: spec.timeoutMs ?? 600_000,
    async execute(rawArgs: unknown, exec: unknown) {
      const args = (rawArgs ?? {}) as { action?: unknown; args?: unknown };
      const action = typeof args.action === 'string' ? args.action : '';
      const inner = args.args && typeof args.args === 'object' && !Array.isArray(args.args)
        ? args.args as Record<string, unknown>
        : undefined;

      if (action === 'catalog') {
        return {
          facade: spec.name,
          gate: Boolean(spec.gate),
          ops: spec.ops.map((entry) => ({
            op: entry.op,
            summary: entry.summary,
            required: paramRows(tools.get(entry.tool)?.parameters)
              .filter((row) => row.required)
              .map((row) => row.name),
          })),
        } as never;
      }

      if (action === 'help') {
        const wanted = typeof inner?.op === 'string' ? inner.op : '';
        const entry = byOp.get(wanted);
        if (!entry) {
          const suggestion = nearest(names, wanted);
          throw argError(
            spec.name,
            'args.op',
            `unknown op "${wanted}"${suggestion ? `; did you mean "${suggestion}"?` : ''}`,
            `one of ${names.join(' | ')}`,
            { received: wanted || undefined, example: `${spec.name}({ action: "help", args: { op: "${names[0]}" } })` },
          );
        }
        const tool = tools.get(entry.tool) as LegacyTool;
        return {
          op: entry.op,
          tool: entry.tool,
          summary: entry.summary,
          description: tool.description ?? '',
          parameters: paramRows(tool.parameters),
        } as never;
      }

      const entry = byOp.get(action);
      if (!entry) {
        const suggestion = nearest(names, action);
        throw argError(
          spec.name,
          'action',
          `unknown action "${action}"${suggestion ? `; did you mean "${suggestion}"?` : ''}`,
          `catalog | help | ${names.join(' | ')}`,
          { received: action, example: `${spec.name}({ action: "catalog" })` },
        );
      }
      const tool = tools.get(entry.tool);
      if (typeof tool?.execute !== 'function') {
        throw new Error(`${spec.name}: legacy tool "${entry.tool}" has no execute()`);
      }
      return tool.execute(inner ?? {}, exec) as never;
    },
  });
}
