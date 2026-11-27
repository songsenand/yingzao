// Thin, data-free surface builder for the 9 job entries.
//
// A surface owns no lifecycle, no status and no second report. It only:
//   1. lists its ops (catalog),
//   2. explains one op's legacy parameters (help),
//   3. delegates an op to the already-wrapped legacy tool.
//
// This is intentionally one shared implementation, not nine bespoke modules.

import { defineTool } from '@deepseek-ai/dsh-tools';
import { argError } from './arg-error.ts';
import { callableProse } from './legacy-route.ts';

export interface SurfaceMeta {
  /** Future surface id, e.g. "cad_inspect". */
  readonly id: string;
  /** Action name inside that surface, e.g. "measure". */
  readonly action: string;
  /** Optional short catalog line; falls back to the legacy description. */
  readonly summary?: string;
}

export interface LegacyTool {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: Record<string, unknown>;
  readonly execute?: (args: unknown, exec: unknown) => unknown;
  /** Phase-4 prototype: a tool declares its own route instead of a hand table. */
  readonly surface?: SurfaceMeta;
}

export interface SurfaceOp {
  /** Action name exposed by the surface. */
  readonly op: string;
  /** Legacy tool that owns the implementation. */
  readonly tool: string;
  /** One line for catalog(); not a replacement for the legacy description. */
  readonly summary: string;
}

/**
 * A placeholder for one required argument, chosen by declared type.
 *
 * `catalog`/`help` used to list the required NAMES only, so a caller still had
 * to guess the shape of the call. Every op now carries a runnable-looking
 * example; the values are deliberately placeholders (a quoted `<name>` for a
 * string, 0/[]/{}/false for the containers), because a made-up plausible value
 * (a real version id, a real datum) would read as advice and be wrong half the
 * time. Type-appropriate, so a number field never receives a quoted string.
 */
function placeholderValue(type: string, name: string): unknown {
  switch (type) {
    case 'number': return 0;
    case 'boolean': return false;
    case 'array': return [];
    case 'json': return {};
    default: return `<${name}>`;
  }
}

/** Build `{ surface, action, args }` for one op from its required parameters. */
export function exampleArgs(tool: LegacyTool | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of paramRows(tool?.parameters)) {
    if (row.required) out[row.name] = placeholderValue(row.type, row.name);
  }
  return out;
}

/** The one call a caller can paste: `cad_x({ action, args })`, JSON-encoded. */
export function exampleCall(surfaceName: string, action: string, tool: LegacyTool | undefined): string {
  return `${surfaceName}({ action: ${JSON.stringify(action)}, args: ${JSON.stringify(exampleArgs(tool))} })`;
}

export interface SurfaceSpec {
  readonly name: string;
  readonly description: string;
  readonly ops: readonly SurfaceOp[];
  readonly timeoutMs?: number;
  /** True when this surface owns a delivery gate. */
  readonly gate?: boolean;
}

const RESERVED = new Set(['catalog', 'help']);

/** Op → legacy-tool wiring, attached for tests (never serialized to the model). */
export const SURFACE_OPS = Symbol.for('dsh-cad-harness.surface-ops');

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

/**
 * `args` is declared as JSON, but models routinely send it as a JSON string.
 * Accept both: a nested-object-only reader silently dropped every stringified
 * call and produced "missing required property dir"/"needs code or script".
 */
function parseSurfaceArgs(raw: unknown): Record<string, unknown> | undefined {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
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

function missingTools(spec: SurfaceSpec, tools: ReadonlyMap<string, LegacyTool>): string[] {
  return spec.ops.filter((entry) => !tools.has(entry.tool)).map((entry) => entry.tool);
}

/** Derive a surface from the tools that declared `surface.id`. */
export function buildSurfaceFromToolMeta(
  name: string,
  description: string,
  tools: ReadonlyMap<string, LegacyTool>,
  opts?: { timeoutMs?: number; gate?: boolean },
) {
  const ops: SurfaceOp[] = [];
  for (const tool of tools.values()) {
    if (tool.surface?.id !== name) continue;
    ops.push({
      op: tool.surface.action,
      tool: tool.name,
      summary: tool.surface.summary ?? (tool.description ?? '').split('\n')[0].slice(0, 160),
    });
  }
  if (ops.length === 0) throw new Error(`${name}: no tool declares this surface`);
  return buildSurface({ name, description, ops, timeoutMs: opts?.timeoutMs, gate: opts?.gate }, tools);
}

export function buildSurface(spec: SurfaceSpec, tools: ReadonlyMap<string, LegacyTool>) {
  const names = spec.ops.map((entry) => entry.op);
  for (const name of names) {
    if (RESERVED.has(name)) throw new Error(`${spec.name}: op "${name}" is reserved for catalog/help`);
  }
  if (new Set(names).size !== names.length) throw new Error(`${spec.name}: duplicate op name`);
  const missing = missingTools(spec, tools);
  if (missing.length) throw new Error(`${spec.name}: missing legacy tool(s): ${missing.join(', ')}`);

  const byOp = new Map(spec.ops.map((entry) => [entry.op, entry]));

  // The op COUNT in the description is derived, never typed: "lists the four
  // ops" was wrong for five of the nine surfaces (deliver had six, check eight)
  // and every new op made it wronger. `{n}` is substituted from the ledger the
  // surface is actually built from, so the text cannot drift again.
  const described = spec.description.replaceAll('{n}', String(spec.ops.length));

  const definition = defineTool({
    name: spec.name,
    description: described,
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
      const inner = parseSurfaceArgs(args.args);

      if (action === 'catalog') {
        return {
          surface: spec.name,
          gate: Boolean(spec.gate),
          count: spec.ops.length,
          ops: spec.ops.map((entry) => ({
            op: entry.op,
            summary: callableProse(entry.summary),
            required: paramRows(tools.get(entry.tool)?.parameters)
              .filter((row) => row.required)
              .map((row) => row.name),
            example: exampleCall(spec.name, entry.op, tools.get(entry.tool)),
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
          summary: callableProse(entry.summary),
          description: callableProse(tool.description ?? ''),
          parameters: paramRows(tool.parameters).map((row) => ({ ...row, description: callableProse(row.description) })),
          example: exampleCall(spec.name, entry.op, tool),
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
  // Wiring metadata for acceptance: the model must not see the legacy op names
  // (they are not callable), but the surface→legacy mapping still has to be
  // auditable. A symbol keeps it off the JSON the model receives.
  Object.defineProperty(definition, SURFACE_OPS, { value: spec.ops, enumerable: true });
  return definition;
}
