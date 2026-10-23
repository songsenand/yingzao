// The tool-output contract, enforced at REGISTRATION time (2026-10-23 audit, FIX-A1/A3).
//
// WHY THIS EXISTS
// ---------------
// A tool declares `output.schema`, and the harness validates the body's value against it
// at the runtime boundary (`ToolRuntime.createSuccessResult`). The value never reaches
// the model if it violates the schema — so a schema that disagrees with its own body is
// not a cosmetic defect, it is a broken tool.
//
// That property was not being tested anywhere: every `scripts/accept-*.mjs` calls
// `def.execute()` directly, i.e. below the boundary. Four tools shipped with a schema
// disagreeing with their body (validate_assembly required two keys it never returned;
// check_assembly returned two keys it never declared; preflight returned `timings` it
// never declared; check_printability required `profiles[].timings` that its profile
// entries never carry) and every acceptance run stayed green.
//
// WHAT THIS DOES
// --------------
// Wraps a definition's `execute` so the value is validated against the SAME compiled
// schema the runtime uses, and fails with the tool name and the exact JSON paths. Tests
// and direct callers therefore enforce the contract too, instead of discovering it in a
// live session.
//
// Cost: one JSON-Schema walk over a value the tool already serialises for the model —
// sub-millisecond beside a compile or a simulation.
//
// The marker exists so an acceptance can prove the wrapper is actually installed on every
// registered tool (a silently-not-applied wrapper would reproduce the original bug).

import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';

/** Attached to a wrapped execute so `accept-tool-output.mjs` can see the guard is live. */
export const OUTPUT_CHECKED = Symbol.for('dsh-cad-harness.outputChecked');

interface ContractDefinition {
  name: string;
  execute?: unknown;
  output?: { schema?: unknown };
}

/**
 * Return `definition` with its `execute` guarded by its own declared output schema.
 *
 * A definition without an execute or without a schema is returned untouched: this is a
 * self-check, not a place to invent contracts for tools that declare none (the audit
 * enforces "every tool declares an output schema" separately).
 */
export function withOutputContract<T extends ContractDefinition>(definition: T): T {
  const execute = definition.execute;
  const schema = definition.output?.schema;
  if (typeof execute !== 'function' || !schema) return definition;

  const guarded = async (args: unknown, exec: unknown): Promise<unknown> => {
    const value = await (execute as (a: unknown, e: unknown) => Promise<unknown>)(args, exec);
    const violations = validateJsonSchemaValue(schema as never, value, 'value');
    if (violations.length > 0) {
      throw new Error(
        `${definition.name}: the body's value does not match its declared output schema ` +
        `(the runtime would reject it before the model sees it):\n  - ${violations.join('\n  - ')}`,
      );
    }
    return value;
  };
  Object.defineProperty(guarded, OUTPUT_CHECKED, { value: true });
  return { ...definition, execute: guarded };
}
